import { createBookingApiHandler } from "./app";
import { InMemoryBookingSessionRepository } from "./bookingSessions";
import { InMemoryHoldRepository } from "./holds";
import { InMemoryPaymentRepository } from "./payments";
import { InMemoryWebhookEventRepository } from "./paypalWebhooks";
import { StaticSecretProvider } from "./secrets";
import { BookingApiConfig, LambdaHttpRequest } from "./types";

// ─── Test wiring ─────────────────────────────────────────────────────────────

let bookingSessions: InMemoryBookingSessionRepository;
let holds: InMemoryHoldRepository;
let payments: InMemoryPaymentRepository;
let webhookEvents: InMemoryWebhookEventRepository;
let config: BookingApiConfig;

function createTestConfig(): BookingApiConfig {
  bookingSessions = new InMemoryBookingSessionRepository();
  holds = new InMemoryHoldRepository();
  payments = new InMemoryPaymentRepository();
  webhookEvents = new InMemoryWebhookEventRepository();
  return {
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
      orderReturnUrl: "https://booking.test/booking/return",
      orderCancelUrl: "https://booking.test/booking/cancel",
    },
    bookingSessions,
    holds,
    payments,
    webhookEvents,
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
}

const originalFetch = global.fetch;

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date("2026-04-15T18:00:00Z"));
  config = createTestConfig();
});

afterEach(() => {
  jest.useRealTimers();
  global.fetch = originalFetch;
  jest.restoreAllMocks();
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function jsonResp(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init.headers as Record<string, string> | undefined),
    },
  });
}

const SMOOBU_AVAILABILITY_RESPONSE = {
  availableApartments: [100001],
  prices: { "100001": { price: 510, currency: "USD" } },
  errorMessages: {},
};
const SMOOBU_RESERVATION_RESPONSE = { id: 987654 };
const PAYPAL_TOKEN_RESPONSE = { access_token: "pp-access-token", expires_in: 3600 };
const PAYPAL_ORDER_RESPONSE = {
  id: "PAY-ORDER-123",
  status: "CREATED",
  links: [
    { rel: "approve", href: "https://www.sandbox.paypal.com/checkoutnow?token=PAY-ORDER-123", method: "GET" },
  ],
};

function makeHappyPathFetch(): jest.Mock {
  return jest.fn(async (url: string | URL) => {
    const { hostname, pathname } = new URL(url.toString());
    if (hostname === "login.smoobu.com") {
      if (pathname === "/booking/checkApartmentAvailability") return jsonResp(SMOOBU_AVAILABILITY_RESPONSE);
      if (pathname === "/api/reservations") return jsonResp(SMOOBU_RESERVATION_RESPONSE);
    }
    if (hostname === "api-m.sandbox.paypal.com") {
      if (pathname === "/v1/oauth2/token") return jsonResp(PAYPAL_TOKEN_RESPONSE);
      if (pathname === "/v2/checkout/orders") return jsonResp(PAYPAL_ORDER_RESPONSE);
    }
    return jsonResp({ detail: "unexpected" }, { status: 500 });
  });
}

function makeSmoobuWebhookRequest(body: unknown): LambdaHttpRequest {
  return {
    version: "2.0",
    rawPath: "/api/webhooks/smoobu",
    headers: {
      "content-type": "application/json",
      "x-smoobu-webhook-secret": "smoobu-webhook-secret-value",
    },
    body: JSON.stringify(body),
    requestContext: { http: { method: "POST", path: "/api/webhooks/smoobu", sourceIp: "52.29.0.1" } },
  };
}

async function setupSessionWithActiveHold(handler: ReturnType<typeof createBookingApiHandler>) {
  const searchResp = await handler({
    version: "2.0",
    rawPath: "/api/search",
    headers: { "content-type": "application/json", origin: "https://booking.test", "x-booking-device-id": "dev-smoobu-test" },
    body: JSON.stringify({ arrivalDate: "2099-06-10", departureDate: "2099-06-14", guests: 2, language: "en" }),
    requestContext: { http: { method: "POST", path: "/api/search", sourceIp: "203.0.113.30" } },
  });
  const searchBody = JSON.parse(searchResp.body);

  await handler({
    version: "2.0",
    rawPath: "/api/holds",
    headers: { "content-type": "application/json", "idempotency-key": "idem-hold-smoobu-001", origin: "https://booking.test", "x-booking-device-id": "dev-smoobu-test" },
    body: JSON.stringify({
      quoteId: searchBody.quoteId,
      bookingSessionId: searchBody.bookingSessionId,
      propertyId: searchBody.properties[0].propertyId,
      paymentMethod: "paypal",
      guest: { firstName: "Ana", lastName: "Mora", email: "ana@example.com" },
      portalPassword: "correct horse battery staple",
      termsAccepted: true,
    }),
    requestContext: { http: { method: "POST", path: "/api/holds", sourceIp: "203.0.113.30" } },
  });

  const session = await bookingSessions.getById(searchBody.bookingSessionId);
  const hold = await holds.getByBookingSessionId(searchBody.bookingSessionId);
  return { bookingSessionId: searchBody.bookingSessionId, session: session!, hold: hold! };
}

// ─── Tests: Payload validation ────────────────────────────────────────────────

test("POST /api/webhooks/smoobu returns 400 when action field is missing", async () => {
  const handler = createBookingApiHandler(config);
  const response = await handler(makeSmoobuWebhookRequest({ data: { id: 123 } }));
  expect(response.statusCode).toBe(400);
  const body = JSON.parse(response.body);
  expect(body.error.code).toBe("invalid_webhook_payload");
});

// ─── Tests: updateRates ───────────────────────────────────────────────────────

test("POST /api/webhooks/smoobu updateRates returns 200 with cache invalidation info", async () => {
  const handler = createBookingApiHandler(config);
  const response = await handler(makeSmoobuWebhookRequest({
    action: "updateRates",
    data: { apartmentId: 1 },
  }));
  expect(response.statusCode).toBe(200);
  const body = JSON.parse(response.body);
  expect(body.received).toBe(true);
  expect(body.action).toBe("updateRates");
  expect(typeof body.cache.invalidatedEntries).toBe("number");
});

// ─── Tests: cancelReservation ─────────────────────────────────────────────────

test("POST /api/webhooks/smoobu cancelReservation cancels a managed hold and fails the session", async () => {
  global.fetch = makeHappyPathFetch() as typeof fetch;
  const handler = createBookingApiHandler(config);
  const { bookingSessionId, hold } = await setupSessionWithActiveHold(handler);

  const response = await handler(makeSmoobuWebhookRequest({
    action: "cancelReservation",
    data: { reservationId: hold.smoobuReservationId },
  }));

  expect(response.statusCode).toBe(200);
  const body = JSON.parse(response.body);
  expect(body.received).toBe(true);

  const updatedHold = await holds.getByBookingSessionId(bookingSessionId);
  expect(updatedHold?.status).toBe("cancelled");

  const updatedSession = await bookingSessions.getById(bookingSessionId);
  expect(updatedSession?.status).toBe("failed");
  expect(updatedSession?.failureReason).toBe("smoobu_cancellation");
});

test("POST /api/webhooks/smoobu cancelReservation for unknown reservation is acknowledged and ignored", async () => {
  const handler = createBookingApiHandler(config);
  const response = await handler(makeSmoobuWebhookRequest({
    action: "cancelReservation",
    data: { reservationId: 999999 },
  }));
  expect(response.statusCode).toBe(200);
  const body = JSON.parse(response.body);
  expect(body.received).toBe(true);
});

test("POST /api/webhooks/smoobu cancelReservation without reservationId is acknowledged and ignored", async () => {
  const handler = createBookingApiHandler(config);
  const response = await handler(makeSmoobuWebhookRequest({
    action: "cancelReservation",
    data: { apartmentId: 1 },
  }));
  expect(response.statusCode).toBe(200);
});

test("POST /api/webhooks/smoobu cancelReservation is idempotent for already-cancelled hold", async () => {
  global.fetch = makeHappyPathFetch() as typeof fetch;
  const handler = createBookingApiHandler(config);
  const { hold } = await setupSessionWithActiveHold(handler);

  // First cancellation
  await handler(makeSmoobuWebhookRequest({
    action: "cancelReservation",
    data: { reservationId: hold.smoobuReservationId },
  }));

  // Second cancellation with slightly different payload (different dedupe key)
  const response = await handler(makeSmoobuWebhookRequest({
    action: "cancelReservation",
    data: { reservationId: hold.smoobuReservationId, extra: "field" },
  }));

  expect(response.statusCode).toBe(200);
  const updatedHold = await holds.getByBookingSessionId(hold.bookingSessionId);
  expect(updatedHold?.status).toBe("cancelled");
});

// ─── Tests: newReservation ────────────────────────────────────────────────────

test("POST /api/webhooks/smoobu newReservation for known apartment is acknowledged and invalidates cache", async () => {
  const handler = createBookingApiHandler(config);
  const response = await handler(makeSmoobuWebhookRequest({
    action: "newReservation",
    data: { id: 111222, apartmentId: 1, arrival: "2099-07-01", departure: "2099-07-05" },
  }));
  expect(response.statusCode).toBe(200);
  const body = JSON.parse(response.body);
  expect(body.received).toBe(true);
});

test("POST /api/webhooks/smoobu newReservation for unknown apartment is acknowledged", async () => {
  const handler = createBookingApiHandler(config);
  const response = await handler(makeSmoobuWebhookRequest({
    action: "newReservation",
    data: { id: 111333, apartmentId: 99999 },
  }));
  expect(response.statusCode).toBe(200);
});

// ─── Tests: updateReservation ─────────────────────────────────────────────────

test("POST /api/webhooks/smoobu updateReservation for managed hold is acknowledged", async () => {
  global.fetch = makeHappyPathFetch() as typeof fetch;
  const handler = createBookingApiHandler(config);
  const { hold } = await setupSessionWithActiveHold(handler);

  const response = await handler(makeSmoobuWebhookRequest({
    action: "updateReservation",
    data: { reservationId: hold.smoobuReservationId, apartmentId: 1 },
  }));
  expect(response.statusCode).toBe(200);
  const body = JSON.parse(response.body);
  expect(body.received).toBe(true);
});

test("POST /api/webhooks/smoobu updateReservation for unknown reservation is acknowledged", async () => {
  const handler = createBookingApiHandler(config);
  const response = await handler(makeSmoobuWebhookRequest({
    action: "updateReservation",
    data: { reservationId: 888888 },
  }));
  expect(response.statusCode).toBe(200);
});

test("POST /api/webhooks/smoobu updateReservation without reservationId is acknowledged", async () => {
  const handler = createBookingApiHandler(config);
  const response = await handler(makeSmoobuWebhookRequest({
    action: "updateReservation",
    data: { apartmentId: 1 },
  }));
  expect(response.statusCode).toBe(200);
});

// ─── Tests: Dedupe ────────────────────────────────────────────────────────────

test("POST /api/webhooks/smoobu duplicate event returns 200 with duplicate flag", async () => {
  const handler = createBookingApiHandler(config);
  const payload = { action: "newReservation", data: { id: 555666, apartmentId: 2 } };

  const first = await handler(makeSmoobuWebhookRequest(payload));
  const second = await handler(makeSmoobuWebhookRequest(payload));

  expect(first.statusCode).toBe(200);
  expect(second.statusCode).toBe(200);
  const secondBody = JSON.parse(second.body);
  expect(secondBody.duplicate).toBe(true);
});

test("markProcessed is provider-scoped: Smoobu dedupe key does not affect PayPal records", async () => {
  // Insert a PayPal event and a Smoobu event that share the same externalEventId string
  const sharedId = "shared-id-collision-test";
  await webhookEvents.insertIfNew({ provider: "paypal", externalEventId: sharedId, eventType: "PAYMENT.CAPTURE.COMPLETED", payloadHash: "aaa" });
  await webhookEvents.insertIfNew({ provider: "smoobu", externalEventId: sharedId, eventType: "cancelReservation", payloadHash: "bbb" });

  // Mark only the Smoobu one as processed
  await webhookEvents.markProcessed("smoobu", sharedId, "processed");

  // PayPal record should still be pending
  const paypalRecord = await webhookEvents.insertIfNew({ provider: "paypal", externalEventId: sharedId, eventType: "PAYMENT.CAPTURE.COMPLETED", payloadHash: "aaa" });
  expect(paypalRecord.inserted).toBe(false);
  expect(paypalRecord.record.status).toBe("pending");
});

// ─── Tests: Unknown action ────────────────────────────────────────────────────

test("POST /api/webhooks/smoobu unknown action is acknowledged and ignored", async () => {
  const handler = createBookingApiHandler(config);
  const response = await handler(makeSmoobuWebhookRequest({
    action: "someUnknownAction",
    data: { id: 123 },
  }));
  expect(response.statusCode).toBe(200);
  const body = JSON.parse(response.body);
  expect(body.received).toBe(true);
});

// ─── Tests: Query string secret rejection ─────────────────────────────────────

test("POST /api/webhooks/smoobu rejects query-string secrets", async () => {
  const handler = createBookingApiHandler(config);
  const response = await handler({
    version: "2.0",
    rawPath: "/api/webhooks/smoobu",
    rawQueryString: "secret=some-secret",
    queryStringParameters: { secret: "some-secret" },
    headers: {
      "content-type": "application/json",
      "x-smoobu-webhook-secret": "smoobu-webhook-secret-value",
    },
    body: JSON.stringify({ action: "updateRates", data: {} }),
    requestContext: { http: { method: "POST", path: "/api/webhooks/smoobu", sourceIp: "52.29.0.1" } },
  });
  // The route has rejectQuerySecrets: true, so any query params with secret-like keys should be rejected
  expect(response.statusCode).toBe(400);
});

// ─── Tests: Webhook authentication ────────────────────────────────────────────

test("POST /api/webhooks/smoobu returns 401 when webhook secret header is missing", async () => {
  const handler = createBookingApiHandler(config);
  const response = await handler({
    version: "2.0",
    rawPath: "/api/webhooks/smoobu",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({ action: "updateRates", data: {} }),
    requestContext: { http: { method: "POST", path: "/api/webhooks/smoobu", sourceIp: "52.29.0.1" } },
  });
  expect(response.statusCode).toBe(401);
  const body = JSON.parse(response.body);
  expect(body.error.code).toBe("webhook_unauthorized");
});

test("POST /api/webhooks/smoobu returns 401 when webhook secret is wrong", async () => {
  const handler = createBookingApiHandler(config);
  const response = await handler({
    version: "2.0",
    rawPath: "/api/webhooks/smoobu",
    headers: {
      "content-type": "application/json",
      "x-smoobu-webhook-secret": "wrong-secret-value",
    },
    body: JSON.stringify({ action: "updateRates", data: {} }),
    requestContext: { http: { method: "POST", path: "/api/webhooks/smoobu", sourceIp: "52.29.0.1" } },
  });
  expect(response.statusCode).toBe(401);
  const body = JSON.parse(response.body);
  expect(body.error.code).toBe("webhook_unauthorized");
});

// ─── Race-condition regression: webhook reprocess gate (R8) ───────────────────

test("R8: a redelivery of an event left un-processed is reprocessed, not swallowed as duplicate", async () => {
  const handler = createBookingApiHandler(config);
  const payload = { action: "newReservation", data: { id: 778899, apartmentId: 2 } };

  // Simulate the first delivery crashing after insertIfNew but before markProcessed:
  // the stored webhook_event row is left 'pending'.
  jest.spyOn(webhookEvents, "markProcessed").mockImplementationOnce(async () => {});

  const first = await handler(makeSmoobuWebhookRequest(payload));
  expect(first.statusCode).toBe(200);
  expect(JSON.parse(first.body).duplicate).toBeUndefined();

  // Redelivery: because the stored event is still 'pending', the handler must
  // reprocess it rather than short-circuit it as a duplicate. (Old behavior would
  // return { duplicate: true } and silently drop the work.)
  const second = await handler(makeSmoobuWebhookRequest(payload));
  expect(second.statusCode).toBe(200);
  expect(JSON.parse(second.body).duplicate).toBeUndefined();

  // Now that it has been processed, a further redelivery IS a duplicate — the gate
  // still dedupes and does not reprocess forever.
  const third = await handler(makeSmoobuWebhookRequest(payload));
  expect(third.statusCode).toBe(200);
  expect(JSON.parse(third.body).duplicate).toBe(true);
});
