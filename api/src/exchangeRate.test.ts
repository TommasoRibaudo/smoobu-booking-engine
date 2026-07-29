import { createBookingApiHandler } from "./app";
import { extractRate, resetExchangeRateCache } from "./exchangeRate";
import { StaticSecretProvider } from "./secrets";
import { BookingApiConfig, LambdaHttpRequest } from "./types";

const config: BookingApiConfig = {
  allowedOrigins: ["https://booking.test"],
  maxBodyBytes: 64 * 1024,
  secrets: new StaticSecretProvider({
    smoobuApiKey: "smoobu-secret-value",
    smoobuApiSecret: "smoobu-api-secret-value",
    smoobuWebhookSecret: "smoobu-webhook-secret-value",
    paypalClientId: "paypal-client-id-value",
    paypalClientSecret: "paypal-client-secret-value",
    paypalWebhookId: "paypal-webhook-id-value",
    bookingEncryptionKeyBase64: Buffer.alloc(32, 7).toString("base64"),
    portalSessionSecret: "portal-session-secret-value",
    rdsConnectionString: "postgres://booking_user:booking_password@db.example.com:5432/booking_engine",
  }),
  smoobu: {
    baseUrl: "https://login.smoobu.com",
    customerId: 9,
    timeoutMs: 8_000,
    maxRetries: 0,
    baseBackoffMs: 250,
    maxBackoffMs: 2_000,
    maxRateLimitDelayMs: 60_000,
    holdChannelId: 11,
  },
  paypal: {
    baseUrl: "https://api-m.sandbox.paypal.com",
    timeoutMs: 10_000,
    orderReturnUrl: "",
    orderCancelUrl: "",
  },
  hold: {
    defaultTtlMinutes: 60,
    idempotencyTtlMinutes: 1440,
    staleIdempotencyLockSeconds: 120,
  },
  abuseProtection: {
    enabled: false,
    captchaChallengesEnabled: false,
    maxTrackedBuckets: 100,
  },
  email: {
    fromAddress: "test@example.com",
    region: "us-east-1",
    disabled: true,
  },
  observability: {
    serviceName: "booking-api",
    environment: "test",
    logLevel: "silent",
    metricsEnabled: false,
  },
  exchangeRate: {
    providerUrls: ["https://primary.test/usd", "https://fallback.test/usd"],
  },
};

const originalFetch = global.fetch;

beforeEach(() => {
  resetExchangeRateCache();
});

afterEach(() => {
  global.fetch = originalFetch;
  jest.restoreAllMocks();
  resetExchangeRateCache();
});

function makeExchangeRateEvent(): LambdaHttpRequest {
  return {
    version: "2.0",
    rawPath: "/api/exchange-rate",
    headers: {
      origin: "https://booking.test",
      "user-agent": "Jest Browser",
      "x-booking-device-id": "device-fx-123",
    },
    requestContext: {
      http: {
        method: "GET",
        path: "/api/exchange-rate",
        sourceIp: "203.0.113.55",
        userAgent: "Jest Browser",
      },
    },
  };
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    ...init,
    headers: { "content-type": "application/json", ...(init.headers as Record<string, string> | undefined) },
  });
}

test("GET /api/exchange-rate returns the USD to CRC rate from the first provider", async () => {
  const fetchFn = jest.fn(async () => jsonResponse({ rates: { CRC: 512.35, EUR: 0.92 } }));
  global.fetch = fetchFn as unknown as typeof fetch;

  const handler = createBookingApiHandler(config);
  const response = await handler(makeExchangeRateEvent());
  const body = JSON.parse(response.body);

  expect(response.statusCode).toBe(200);
  expect(body).toMatchObject({ base: "USD", quote: "CRC", rate: 512.35, stale: false, source: "primary.test" });
  expect(body.cache.status).toBe("miss");
  expect(typeof body.fetchedAt).toBe("string");
  expect(fetchFn).toHaveBeenCalledTimes(1);
});

test("a cached rate is reused instead of refetching on the next request", async () => {
  const fetchFn = jest.fn(async () => jsonResponse({ rates: { CRC: 512.35 } }));
  global.fetch = fetchFn as unknown as typeof fetch;

  const handler = createBookingApiHandler(config);
  await handler(makeExchangeRateEvent());
  const second = JSON.parse((await handler(makeExchangeRateEvent())).body);

  expect(fetchFn).toHaveBeenCalledTimes(1);
  expect(second.cache.status).toBe("hit");
  expect(second.rate).toBe(512.35);
});

test("a failing primary provider falls through to the next one", async () => {
  const fetchFn = jest.fn(async (url: string | URL) =>
    String(url).startsWith("https://primary.test")
      ? new Response("gateway timeout", { status: 504 })
      : jsonResponse({ usd: { crc: 505.5 } })
  );
  global.fetch = fetchFn as unknown as typeof fetch;

  const handler = createBookingApiHandler(config);
  const body = JSON.parse((await handler(makeExchangeRateEvent())).body);

  expect(body.rate).toBe(505.5);
  expect(body.source).toBe("fallback.test");
  expect(fetchFn).toHaveBeenCalledTimes(2);
});

test("an implausible rate is rejected rather than quoted to guests", async () => {
  // An inverted rate (dollars per colón) would otherwise render as "₡0" totals.
  const fetchFn = jest.fn(async () => jsonResponse({ rates: { CRC: 0.00195 } }));
  global.fetch = fetchFn as unknown as typeof fetch;

  const handler = createBookingApiHandler(config);
  const response = await handler(makeExchangeRateEvent());

  expect(response.statusCode).toBe(503);
  expect(JSON.parse(response.body).error.code).toBe("exchange_rate_unavailable");
});

test("the last known good rate is served, marked stale, when every provider fails", async () => {
  const fetchFn = jest
    .fn()
    .mockResolvedValueOnce(jsonResponse({ rates: { CRC: 512.35 } }))
    .mockResolvedValue(new Response("nope", { status: 500 }));
  global.fetch = fetchFn as unknown as typeof fetch;

  const handler = createBookingApiHandler(config);
  await handler(makeExchangeRateEvent());

  // Force the cached entry past its TTL so the next call has to refetch.
  const staleConfig: BookingApiConfig = { ...config, exchangeRate: { ...config.exchangeRate, ttlSeconds: 0 } };
  const staleHandler = createBookingApiHandler(staleConfig);
  const response = await staleHandler(makeExchangeRateEvent());
  const body = JSON.parse(response.body);

  expect(response.statusCode).toBe(200);
  expect(body.rate).toBe(512.35);
  expect(body.stale).toBe(true);
});

test("the response is cacheable by the browser, unlike guest-scoped routes", async () => {
  global.fetch = (async () => jsonResponse({ rates: { CRC: 512.35 } })) as unknown as typeof fetch;

  const handler = createBookingApiHandler(config);
  const response = await handler(makeExchangeRateEvent());

  expect(response.headers?.["Cache-Control"]).toMatch(/^public, max-age=\d+$/);
});

describe("extractRate", () => {
  test.each([
    [{ rates: { CRC: 512.35 } }, 512.35],
    [{ conversion_rates: { CRC: 512.35 } }, 512.35],
    [{ usd: { crc: 512.35 } }, 512.35],
    [{ data: { CRC: "512.35" } }, 512.35],
    [{ CRC: 512.35 }, 512.35],
  ])("reads colones per dollar out of %p", (body, expected) => {
    expect(extractRate(body)).toBe(expected);
  });

  test.each([
    [{ rates: { EUR: 0.92 } }],
    [{ rates: { CRC: 0.00195 } }],
    [{ rates: { CRC: 9_999 } }],
    [{ rates: { CRC: "not a number" } }],
    [null],
    ["512.35"],
  ])("rejects %p", (body) => {
    expect(extractRate(body)).toBeNull();
  });

  test("rounds to the two decimals providers actually publish", () => {
    expect(extractRate({ rates: { CRC: 512.3456789 } })).toBe(512.35);
  });
});
