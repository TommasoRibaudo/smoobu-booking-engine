import { createBookingApiHandler } from "./app";
import { clearCalendarRatesCache } from "./calendar";
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
};

const originalFetch = global.fetch;

beforeEach(() => {
  clearCalendarRatesCache();
});

afterEach(() => {
  global.fetch = originalFetch;
  jest.restoreAllMocks();
  clearCalendarRatesCache();
});

function makeCalendarEvent(slug = "SunsetVilla", month = "2099-06", language = "en"): LambdaHttpRequest {
  return {
    version: "2.0",
    rawPath: `/api/calendar/${slug}`,
    queryStringParameters: {
      month,
      language,
    },
    headers: {
      origin: "https://booking.test",
      "user-agent": "Jest Browser",
      "x-booking-device-id": "device-calendar-123",
    },
    requestContext: {
      http: {
        method: "GET",
        path: `/api/calendar/${slug}`,
        sourceIp: "203.0.113.30",
        userAgent: "Jest Browser",
      },
    },
  };
}

function makeSmoobuWebhookEvent(body: unknown): LambdaHttpRequest {
  return {
    version: "2.0",
    rawPath: "/api/webhooks/smoobu",
    headers: {
      "content-type": "application/json",
      "x-smoobu-webhook-secret": "smoobu-webhook-secret-value",
      "user-agent": "Smoobu Webhook",
    },
    body: JSON.stringify(body),
    requestContext: {
      http: {
        method: "POST",
        path: "/api/webhooks/smoobu",
        sourceIp: "203.0.113.40",
        userAgent: "Smoobu Webhook",
      },
    },
  };
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init.headers as Record<string, string> | undefined),
    },
  });
}

test("GET /api/calendar/:apartmentSlug returns full-month Smoobu rates with stats and price dots", async () => {
  const fetchFn = jest.fn(async (_url: string | URL, _init?: RequestInit) =>
    jsonResponse({
      data: {
        "100001": {
          "2099-06-01": { price: 100, min_length_of_stay: 2, available: 1 },
          "2099-06-02": { price: 120, min_length_of_stay: null, available: 1 },
          "2099-06-03": { price: 150, min_length_of_stay: 3, available: 1 },
          "2099-06-04": { price: null, min_length_of_stay: null, available: 1 },
          "2099-06-05": { price: 200, min_length_of_stay: 4, available: 0 },
        },
      },
    })
  );
  global.fetch = fetchFn as typeof fetch;
  const handler = createBookingApiHandler(config);

  const response = await handler(makeCalendarEvent("SunsetVillaES", "2099-06", "es"));

  expect(response.statusCode).toBe(200);
  const body = JSON.parse(response.body);
  expect(body.property).toEqual({
    propertyId: "11111111-0000-4000-8000-000000000001",
    slug: "SunsetVilla",
    name: "Sunset Villa",
  });
  expect(body.month).toBe("2099-06");
  expect(body.currency).toBe("USD");
  expect(body.days).toHaveLength(30);
  expect(body.stats).toEqual({
    availableNightCount: 3,
    minPriceCents: 10000,
    maxPriceCents: 15000,
    averagePriceCents: 12333,
  });
  expect(body.days.slice(0, 6)).toEqual([
    {
      date: "2099-06-01",
      available: true,
      priceCents: 10000,
      minStay: 2,
      dot: "green",
      ariaLabelKey: "calendar.priceLow",
    },
    {
      date: "2099-06-02",
      available: true,
      priceCents: 12000,
      minStay: null,
      dot: "yellow",
      ariaLabelKey: "calendar.priceAverage",
    },
    {
      date: "2099-06-03",
      available: true,
      priceCents: 15000,
      minStay: 3,
      dot: "red",
      ariaLabelKey: "calendar.priceHigh",
    },
    {
      date: "2099-06-04",
      available: true,
      priceCents: null,
      minStay: null,
      dot: "grey",
      ariaLabelKey: "calendar.unavailable",
    },
    {
      date: "2099-06-05",
      available: false,
      priceCents: 20000,
      minStay: 4,
      dot: "grey",
      ariaLabelKey: "calendar.unavailable",
    },
    {
      date: "2099-06-06",
      available: false,
      priceCents: null,
      minStay: null,
      dot: "grey",
      ariaLabelKey: "calendar.unavailable",
    },
  ]);
  expect(body.cache).toMatchObject({
    status: "miss",
    ttlSeconds: 300,
  });
  expect(JSON.stringify(body)).not.toContain("smoobuApartmentId");

  const [url, init] = fetchFn.mock.calls[0];
  const parsedUrl = new URL(url.toString());
  expect(parsedUrl.pathname).toBe("/api/rates");
  expect(parsedUrl.searchParams.getAll("apartments[]")).toEqual(["100001"]);
  expect(parsedUrl.searchParams.get("start_date")).toBe("2099-06-01");
  expect(parsedUrl.searchParams.get("end_date")).toBe("2099-06-30");
  expect((init?.headers as Record<string, string>)["X-API-Key"]).toBe("smoobu-secret-value");
});

test("GET /api/calendar/:apartmentSlug never offers nights that have already passed", async () => {
  // Smoobu has no notion of "now" and keeps reporting available: 1 for nights
  // that are already gone; serving those advertises a stay nobody can book.
  global.fetch = jest.fn(async () =>
    jsonResponse({
      data: {
        "100001": {
          "2020-01-01": { price: 100, min_length_of_stay: 1, available: 1 },
          "2020-01-02": { price: 120, min_length_of_stay: 1, available: 1 },
          "2020-01-03": { price: 150, min_length_of_stay: 1, available: 1 },
        },
      },
    })
  ) as typeof fetch;
  const handler = createBookingApiHandler(config);

  const response = await handler(makeCalendarEvent("SunsetVilla", "2020-01"));

  expect(response.statusCode).toBe(200);
  const body = JSON.parse(response.body);
  expect(body.days.every((day: { available: boolean }) => day.available === false)).toBe(true);
  expect(body.days.every((day: { dot: string }) => day.dot === "grey")).toBe(true);
  // Past nights must not drag the month average either — it drives dot colours.
  expect(body.stats).toEqual({
    availableNightCount: 0,
    minPriceCents: null,
    maxPriceCents: null,
    averagePriceCents: null,
  });
  // The raw Smoobu price survives for display; only bookability is revoked.
  expect(body.days[0]).toMatchObject({ date: "2020-01-01", priceCents: 10000, available: false });
});

test("GET /api/calendar/:apartmentSlug re-masks past nights when serving a cached month", async () => {
  jest.useFakeTimers().setSystemTime(new Date("2099-06-15T12:00:00Z"));
  try {
    global.fetch = jest.fn(async () =>
      jsonResponse({
        data: {
          "100001": {
            "2099-06-14": { price: 100, min_length_of_stay: 1, available: 1 },
            "2099-06-16": { price: 100, min_length_of_stay: 1, available: 1 },
            "2099-06-17": { price: 100, min_length_of_stay: 1, available: 1 },
          },
        },
      })
    ) as typeof fetch;
    const handler = createBookingApiHandler(config);

    const first = await handler(makeCalendarEvent("SunsetVilla", "2099-06"));
    expect(JSON.parse(first.body).stats.availableNightCount).toBe(2);

    // A day later the cache entry is still warm, but the 16th is now history.
    jest.setSystemTime(new Date("2099-06-17T12:00:00Z"));
    const second = await handler(makeCalendarEvent("SunsetVilla", "2099-06"));

    const body = JSON.parse(second.body);
    expect(body.cache.status).toBe("hit");
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(body.stats.availableNightCount).toBe(1);
    expect(body.days.find((day: { date: string }) => day.date === "2099-06-16")).toMatchObject({
      available: false,
      dot: "grey",
    });
    expect(body.days.find((day: { date: string }) => day.date === "2099-06-17")).toMatchObject({
      available: true,
    });
  } finally {
    jest.useRealTimers();
  }
});

test("GET /api/calendar/:apartmentSlug caches responses per apartment and month", async () => {
  global.fetch = jest.fn(async () =>
    jsonResponse({
      data: {
        "100001": {
          "2099-07-01": { price: 100, min_length_of_stay: 2, available: 1 },
        },
      },
    })
  ) as typeof fetch;
  const handler = createBookingApiHandler(config);

  const first = await handler(makeCalendarEvent("SunsetVilla", "2099-07"));
  const second = await handler(makeCalendarEvent("SunsetVilla", "2099-07"));

  expect(first.statusCode).toBe(200);
  expect(second.statusCode).toBe(200);
  expect(global.fetch).toHaveBeenCalledTimes(1);
  expect(JSON.parse(first.body).cache.status).toBe("miss");
  expect(JSON.parse(second.body).cache.status).toBe("hit");
});

test("POST /api/webhooks/smoobu updateRates invalidates cached calendar rates", async () => {
  const fetchFn = jest.fn(async () =>
    jsonResponse({
      data: {
        "100001": {
          "2099-08-01": { price: 100, min_length_of_stay: 2, available: 1 },
        },
      },
    })
  );
  global.fetch = fetchFn as typeof fetch;
  const handler = createBookingApiHandler(config);

  await handler(makeCalendarEvent("SunsetVilla", "2099-08"));
  await handler(makeCalendarEvent("SunsetVilla", "2099-08"));
  expect(fetchFn).toHaveBeenCalledTimes(1);

  const webhookResponse = await handler(
    makeSmoobuWebhookEvent({
      action: "updateRates",
      data: {
        apartmentId: 100001,
        date: "2099-08-12",
      },
    })
  );

  expect(webhookResponse.statusCode).toBe(200);
  expect(JSON.parse(webhookResponse.body)).toEqual({
    received: true,
    action: "updateRates",
    cache: {
      invalidatedEntries: 1,
    },
  });

  await handler(makeCalendarEvent("SunsetVilla", "2099-08"));
  expect(fetchFn).toHaveBeenCalledTimes(2);
});

test("GET /api/calendar/:apartmentSlug rejects unknown public property slugs", async () => {
  const handler = createBookingApiHandler(config);

  const response = await handler(makeCalendarEvent("Unknown", "2099-06"));

  expect(response.statusCode).toBe(404);
  expect(JSON.parse(response.body).error).toMatchObject({
    code: "property_not_found",
  });
});
