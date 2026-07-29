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

// ─── Fake HTTP responses ──────────────────────────────────────────────────────

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
const PAYPAL_CAPTURE_RESPONSE = {
  id: "PAY-ORDER-123",
  status: "COMPLETED",
  purchase_units: [
    {
      payments: {
        captures: [{ id: "PAY-CAP-456", status: "COMPLETED", amount: { currency_code: "USD", value: "510.00" } }],
      },
    },
  ],
};
const PAYPAL_VERIFY_SUCCESS = { verification_status: "SUCCESS" };
const PAYPAL_VERIFY_FAILURE = { verification_status: "FAILURE" };

function makeHappyPathFetch(verifyResponse = PAYPAL_VERIFY_SUCCESS): jest.Mock {
  return jest.fn(async (url: string | URL) => {
    const { hostname, pathname } = new URL(url.toString());

    if (hostname === "login.smoobu.com") {
      if (pathname === "/booking/checkApartmentAvailability") return jsonResp(SMOOBU_AVAILABILITY_RESPONSE);
      if (pathname === "/api/reservations") return jsonResp(SMOOBU_RESERVATION_RESPONSE);
    }

    if (hostname === "api-m.sandbox.paypal.com") {
      if (pathname === "/v1/oauth2/token") return jsonResp(PAYPAL_TOKEN_RESPONSE);
      if (pathname === "/v2/checkout/orders") return jsonResp(PAYPAL_ORDER_RESPONSE);
      if (pathname.includes("/capture")) return jsonResp(PAYPAL_CAPTURE_RESPONSE);
      if (pathname === "/v1/notifications/verify-webhook-signature") return jsonResp(verifyResponse);
    }

    return jsonResp({ detail: "unexpected" }, { status: 500 });
  });
}

// ─── Event builders ───────────────────────────────────────────────────────────

const WEBHOOK_HEADERS = {
  "content-type": "application/json",
  origin: "https://booking.test",
  "paypal-auth-algo": "SHA256withRSA",
  "paypal-cert-url": "https://api.paypal.com/v1/notifications/certs/CERT-360caa42-fca2a594-1d93a270",
  "paypal-transmission-id": "69cd13f0-d67a-11e5-baa3-778b53f4ae55",
  "paypal-transmission-sig": "lmI95/M2K5XFnGMlkBj0ql7EXAMPLE==",
  "paypal-transmission-time": "2026-04-15T18:00:00Z",
};

function makeWebhookEvent(body: unknown, headers: Record<string, string> = WEBHOOK_HEADERS): LambdaHttpRequest {
  return {
    version: "2.0",
    rawPath: "/api/webhooks/paypal",
    headers,
    body: JSON.stringify(body),
    requestContext: { http: { method: "POST", path: "/api/webhooks/paypal", sourceIp: "66.211.170.66" } },
  };
}

function makeCaptureCompletedEvent(bookingSessionId: string, captureId = "PAY-CAP-456"): object {
  return {
    id: "WH-EVT-CAPTURE-COMPLETED-001",
    event_type: "PAYMENT.CAPTURE.COMPLETED",
    resource: {
      purchase_units: [
        {
          reference_id: bookingSessionId,
          payments: {
            captures: [{ id: captureId, status: "COMPLETED", amount: { currency_code: "USD", value: "510.00" } }],
          },
        },
      ],
    },
  };
}

// Real PAYPAL PAYMENT.CAPTURE.COMPLETED webhooks have no purchase_units at
// all — the resource IS the capture, and custom_id sits directly on it,
// carrying the reservationPublicId (not the bookingSessionId). Confirmed
// against a real PayPal sandbox event during the live-acceptance-test.md pass.
function makeRealShapeCaptureCompletedEvent(reservationPublicId: string, captureId = "72Y09143HH2073016"): object {
  return {
    id: "WH-EVT-CAPTURE-COMPLETED-REAL-SHAPE",
    event_type: "PAYMENT.CAPTURE.COMPLETED",
    resource: {
      id: captureId,
      status: "COMPLETED",
      amount: { currency_code: "USD", value: "119.00" },
      custom_id: reservationPublicId,
      supplementary_data: { related_ids: { order_id: "7NX848339D737724P" } },
    },
  };
}

function makeCaptureDeniedEvent(bookingSessionId: string): object {
  return {
    id: "WH-EVT-CAPTURE-DENIED-001",
    event_type: "PAYMENT.CAPTURE.DENIED",
    resource: {
      id: "PAY-CAP-DENIED",
      purchase_units: [{ reference_id: bookingSessionId }],
    },
  };
}

function makeCaptureReversedEvent(bookingSessionId: string): object {
  return {
    id: "WH-EVT-CAPTURE-REVERSED-001",
    event_type: "PAYMENT.CAPTURE.REVERSED",
    resource: {
      id: "PAY-CAP-REVERSED",
      purchase_units: [{ reference_id: bookingSessionId }],
    },
  };
}

function makeOrderApprovedEvent(bookingSessionId: string): object {
  return {
    id: "WH-EVT-ORDER-APPROVED-001",
    event_type: "CHECKOUT.ORDER.APPROVED",
    resource: {
      id: "PAY-ORDER-123",
      purchase_units: [{ reference_id: bookingSessionId }],
    },
  };
}

// ─── Setup helpers ────────────────────────────────────────────────────────────

async function setupSessionWithPaypalOrder(handler: ReturnType<typeof createBookingApiHandler>) {
  // Search
  const searchResp = await handler({
    version: "2.0",
    rawPath: "/api/search",
    headers: { "content-type": "application/json", origin: "https://booking.test", "x-booking-device-id": "dev-wh-test" },
    body: JSON.stringify({ arrivalDate: "2099-06-10", departureDate: "2099-06-14", guests: 2, language: "en" }),
    requestContext: { http: { method: "POST", path: "/api/search", sourceIp: "203.0.113.30" } },
  });
  const searchBody = JSON.parse(searchResp.body);
  const { bookingSessionId, properties } = searchBody;

  // Hold
  await handler({
    version: "2.0",
    rawPath: "/api/holds",
    headers: { "content-type": "application/json", "idempotency-key": "idem-hold-wh-001", origin: "https://booking.test", "x-booking-device-id": "dev-wh-test" },
    body: JSON.stringify({
      quoteId: searchBody.quoteId,
      bookingSessionId,
      propertyId: properties[0].propertyId,
      paymentMethod: "paypal",
      guest: { firstName: "Ana", lastName: "Mora", email: "ana@example.com" },
      portalPassword: "correct horse battery staple",
      termsAccepted: true,
    }),
    requestContext: { http: { method: "POST", path: "/api/holds", sourceIp: "203.0.113.30" } },
  });

  // Create PayPal order
  await handler({
    version: "2.0",
    rawPath: "/api/paypal/order",
    headers: { "content-type": "application/json", "idempotency-key": "idem-order-wh-001", origin: "https://booking.test", "x-booking-device-id": "dev-wh-test" },
    body: JSON.stringify({ bookingSessionId }),
    requestContext: { http: { method: "POST", path: "/api/paypal/order", sourceIp: "203.0.113.30" } },
  });

  return { bookingSessionId };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

test("POST /api/webhooks/paypal returns 400 when PayPal signature headers are missing", async () => {
  const handler = createBookingApiHandler(config);
  const response = await handler(
    makeWebhookEvent(makeCaptureCompletedEvent("00000000-0000-4000-8000-000000000001"), {
      "content-type": "application/json",
      origin: "https://booking.test",
      // No PayPal signature headers
    })
  );
  expect(response.statusCode).toBe(400);
  const body = JSON.parse(response.body);
  expect(body.error.code).toBe("invalid_webhook_headers");
});

test("POST /api/webhooks/paypal returns 400 when PayPal cert URL is not a paypal.com domain", async () => {
  const handler = createBookingApiHandler(config);
  const response = await handler(
    makeWebhookEvent(makeCaptureCompletedEvent("00000000-0000-4000-8000-000000000001"), {
      ...WEBHOOK_HEADERS,
      "paypal-cert-url": "https://evil.example.com/cert",
    })
  );
  expect(response.statusCode).toBe(400);
  const body = JSON.parse(response.body);
  expect(body.error.code).toBe("invalid_webhook_headers");
});

test("POST /api/webhooks/paypal returns 400 when signature verification fails", async () => {
  global.fetch = makeHappyPathFetch(PAYPAL_VERIFY_FAILURE) as typeof fetch;
  const handler = createBookingApiHandler(config);
  const response = await handler(makeWebhookEvent(makeCaptureCompletedEvent("00000000-0000-4000-8000-000000000001")));
  expect(response.statusCode).toBe(400);
  const body = JSON.parse(response.body);
  expect(body.error.code).toBe("webhook_signature_invalid");
});

test("POST /api/webhooks/paypal calls PayPal verify-webhook-signature with correct payload", async () => {
  const fetchFn = makeHappyPathFetch();
  global.fetch = fetchFn as typeof fetch;
  const handler = createBookingApiHandler(config);
  const { bookingSessionId } = await setupSessionWithPaypalOrder(handler);

  await handler(makeWebhookEvent(makeCaptureCompletedEvent(bookingSessionId)));

  const verifyCall = fetchFn.mock.calls.find(([url]) =>
    new URL(url.toString()).pathname === "/v1/notifications/verify-webhook-signature"
  );
  expect(verifyCall).toBeDefined();
  const verifyPayload = JSON.parse(verifyCall?.[1]?.body as string);
  expect(verifyPayload).toMatchObject({
    auth_algo: "SHA256withRSA",
    cert_url: "https://api.paypal.com/v1/notifications/certs/CERT-360caa42-fca2a594-1d93a270",
    transmission_id: "69cd13f0-d67a-11e5-baa3-778b53f4ae55",
    transmission_sig: "lmI95/M2K5XFnGMlkBj0ql7EXAMPLE==",
    transmission_time: "2026-04-15T18:00:00Z",
    webhook_id: "paypal-webhook-id-value",
  });
  expect(verifyPayload.webhook_event).toBeDefined();
});

test("POST /api/webhooks/paypal PAYMENT.CAPTURE.COMPLETED transitions session to booking_confirmed", async () => {
  global.fetch = makeHappyPathFetch() as typeof fetch;
  const handler = createBookingApiHandler(config);
  const { bookingSessionId } = await setupSessionWithPaypalOrder(handler);

  const response = await handler(makeWebhookEvent(makeCaptureCompletedEvent(bookingSessionId)));

  expect(response.statusCode).toBe(200);
  const body = JSON.parse(response.body);
  expect(body.received).toBe(true);

  const session = await bookingSessions.getById(bookingSessionId);
  expect(session?.status).toBe("booking_confirmed");
  expect(session?.confirmedAt).toBe("2026-04-15T18:00:00.000Z");

  const payment = await payments.getByBookingSessionId(bookingSessionId);
  expect(payment?.status).toBe("captured");
  expect(payment?.paypalCaptureId).toBe("PAY-CAP-456");
});

test("POST /api/webhooks/paypal PAYMENT.CAPTURE.COMPLETED resolves the session from the real capture-resource shape (no purchase_units, custom_id = reservationPublicId)", async () => {
  global.fetch = makeHappyPathFetch() as typeof fetch;
  const handler = createBookingApiHandler(config);
  const { bookingSessionId } = await setupSessionWithPaypalOrder(handler);
  const { reservationPublicId } = (await bookingSessions.getById(bookingSessionId))!;

  const response = await handler(
    makeWebhookEvent(makeRealShapeCaptureCompletedEvent(reservationPublicId))
  );

  expect(response.statusCode).toBe(200);
  const body = JSON.parse(response.body);
  expect(body.received).toBe(true);

  const session = await bookingSessions.getById(bookingSessionId);
  expect(session?.status).toBe("booking_confirmed");

  const payment = await payments.getByBookingSessionId(bookingSessionId);
  expect(payment?.status).toBe("captured");
  expect(payment?.paypalCaptureId).toBe("72Y09143HH2073016");
});

test("POST /api/webhooks/paypal PAYMENT.CAPTURE.COMPLETED is idempotent: duplicate event returns 200 without re-processing", async () => {
  global.fetch = makeHappyPathFetch() as typeof fetch;
  const handler = createBookingApiHandler(config);
  const { bookingSessionId } = await setupSessionWithPaypalOrder(handler);

  const event = makeCaptureCompletedEvent(bookingSessionId);
  const first = await handler(makeWebhookEvent(event));
  const second = await handler(makeWebhookEvent(event));

  expect(first.statusCode).toBe(200);
  expect(second.statusCode).toBe(200);
  const secondBody = JSON.parse(second.body);
  expect(secondBody.duplicate).toBe(true);

  // Session should still be confirmed (not double-processed)
  const session = await bookingSessions.getById(bookingSessionId);
  expect(session?.status).toBe("booking_confirmed");
});

test("POST /api/webhooks/paypal PAYMENT.CAPTURE.COMPLETED is idempotent when session is already booking_confirmed", async () => {
  global.fetch = makeHappyPathFetch() as typeof fetch;
  const handler = createBookingApiHandler(config);
  const { bookingSessionId } = await setupSessionWithPaypalOrder(handler);

  // First event confirms the booking
  await handler(makeWebhookEvent(makeCaptureCompletedEvent(bookingSessionId)));

  // Second event with a different event ID (not a duplicate by ID, but session already confirmed)
  const secondEvent = { ...makeCaptureCompletedEvent(bookingSessionId), id: "WH-EVT-CAPTURE-COMPLETED-002" };
  const response = await handler(makeWebhookEvent(secondEvent));

  expect(response.statusCode).toBe(200);
  // Session remains confirmed
  const session = await bookingSessions.getById(bookingSessionId);
  expect(session?.status).toBe("booking_confirmed");
});

test("POST /api/webhooks/paypal PAYMENT.CAPTURE.DENIED transitions session to failed", async () => {
  global.fetch = makeHappyPathFetch() as typeof fetch;
  const handler = createBookingApiHandler(config);
  const { bookingSessionId } = await setupSessionWithPaypalOrder(handler);

  const response = await handler(makeWebhookEvent(makeCaptureDeniedEvent(bookingSessionId)));

  expect(response.statusCode).toBe(200);

  const session = await bookingSessions.getById(bookingSessionId);
  expect(session?.status).toBe("failed");
  expect(session?.failureReason).toBe("payment.capture.denied");

  const payment = await payments.getByBookingSessionId(bookingSessionId);
  expect(payment?.status).toBe("failed");
});

test("POST /api/webhooks/paypal CHECKOUT.ORDER.APPROVED is acknowledged and ignored (no state change)", async () => {
  global.fetch = makeHappyPathFetch() as typeof fetch;
  const handler = createBookingApiHandler(config);
  const { bookingSessionId } = await setupSessionWithPaypalOrder(handler);

  const response = await handler(makeWebhookEvent(makeOrderApprovedEvent(bookingSessionId)));

  expect(response.statusCode).toBe(200);

  // Session should remain in paypal_order_created — capture is triggered by the frontend
  const session = await bookingSessions.getById(bookingSessionId);
  expect(session?.status).toBe("paypal_order_created");
});

test("POST /api/webhooks/paypal unknown event type is acknowledged and ignored", async () => {
  global.fetch = makeHappyPathFetch() as typeof fetch;
  const handler = createBookingApiHandler(config);

  const response = await handler(
    makeWebhookEvent({
      id: "WH-EVT-UNKNOWN-001",
      event_type: "BILLING.SUBSCRIPTION.CREATED",
      resource: {},
    })
  );

  expect(response.statusCode).toBe(200);
  const body = JSON.parse(response.body);
  expect(body.received).toBe(true);
});

test("POST /api/webhooks/paypal returns 400 when event body is missing id", async () => {
  global.fetch = makeHappyPathFetch() as typeof fetch;
  const handler = createBookingApiHandler(config);

  const response = await handler(
    makeWebhookEvent({ event_type: "PAYMENT.CAPTURE.COMPLETED", resource: {} })
  );

  expect(response.statusCode).toBe(400);
  const body = JSON.parse(response.body);
  expect(body.error.code).toBe("invalid_webhook_payload");
});

test("POST /api/webhooks/paypal PAYMENT.CAPTURE.COMPLETED with unknown session is acknowledged and ignored", async () => {
  global.fetch = makeHappyPathFetch() as typeof fetch;
  const handler = createBookingApiHandler(config);

  const response = await handler(
    makeWebhookEvent(makeCaptureCompletedEvent("00000000-0000-4000-8000-000000000099"))
  );

  expect(response.statusCode).toBe(200);
});

test("POST /api/webhooks/paypal PAYMENT.CAPTURE.DENIED with unknown session is acknowledged and ignored", async () => {
  global.fetch = makeHappyPathFetch() as typeof fetch;
  const handler = createBookingApiHandler(config);

  const response = await handler(
    makeWebhookEvent(makeCaptureDeniedEvent("00000000-0000-4000-8000-000000000099"))
  );

  expect(response.statusCode).toBe(200);
});

test("POST /api/webhooks/paypal PAYMENT.CAPTURE.DENIED does not re-fail an already-failed session", async () => {
  global.fetch = makeHappyPathFetch() as typeof fetch;
  const handler = createBookingApiHandler(config);
  const { bookingSessionId } = await setupSessionWithPaypalOrder(handler);

  // First denied event
  await handler(makeWebhookEvent(makeCaptureDeniedEvent(bookingSessionId)));

  // Second denied event with different ID
  const secondEvent = { ...makeCaptureDeniedEvent(bookingSessionId), id: "WH-EVT-CAPTURE-DENIED-002" };
  const response = await handler(makeWebhookEvent(secondEvent));

  expect(response.statusCode).toBe(200);
  const session = await bookingSessions.getById(bookingSessionId);
  expect(session?.status).toBe("failed");
});

test("POST /api/webhooks/paypal returns 503 when PayPal verify-webhook-signature API returns 5xx", async () => {
  const fetchFn = jest.fn(async (url: string | URL) => {
    const { hostname, pathname } = new URL(url.toString());

    if (hostname === "login.smoobu.com") {
      if (pathname === "/booking/checkApartmentAvailability") return jsonResp(SMOOBU_AVAILABILITY_RESPONSE);
      if (pathname === "/api/reservations") return jsonResp(SMOOBU_RESERVATION_RESPONSE);
    }

    if (hostname === "api-m.sandbox.paypal.com") {
      if (pathname === "/v1/oauth2/token") return jsonResp(PAYPAL_TOKEN_RESPONSE);
      if (pathname === "/v2/checkout/orders") return jsonResp(PAYPAL_ORDER_RESPONSE);
      if (pathname.includes("/capture")) return jsonResp(PAYPAL_CAPTURE_RESPONSE);
      if (pathname === "/v1/notifications/verify-webhook-signature") {
        return jsonResp({ message: "Internal Server Error" }, { status: 500 });
      }
    }

    return jsonResp({ detail: "unexpected" }, { status: 500 });
  });
  global.fetch = fetchFn as typeof fetch;
  const handler = createBookingApiHandler(config);

  const response = await handler(
    makeWebhookEvent(makeCaptureCompletedEvent("00000000-0000-4000-8000-000000000001"))
  );

  expect(response.statusCode).toBe(503);
  const body = JSON.parse(response.body);
  expect(body.error.code).toBe("webhook_verify_unavailable");
});

test("POST /api/webhooks/paypal returns 503 when PayPal verify-webhook-signature throws network error", async () => {
  const fetchFn = jest.fn(async (url: string | URL) => {
    const { hostname, pathname } = new URL(url.toString());

    if (hostname === "login.smoobu.com") {
      if (pathname === "/booking/checkApartmentAvailability") return jsonResp(SMOOBU_AVAILABILITY_RESPONSE);
      if (pathname === "/api/reservations") return jsonResp(SMOOBU_RESERVATION_RESPONSE);
    }

    if (hostname === "api-m.sandbox.paypal.com") {
      if (pathname === "/v1/oauth2/token") return jsonResp(PAYPAL_TOKEN_RESPONSE);
      if (pathname === "/v2/checkout/orders") return jsonResp(PAYPAL_ORDER_RESPONSE);
      if (pathname.includes("/capture")) return jsonResp(PAYPAL_CAPTURE_RESPONSE);
      if (pathname === "/v1/notifications/verify-webhook-signature") {
        throw new Error("ECONNREFUSED");
      }
    }

    return jsonResp({ detail: "unexpected" }, { status: 500 });
  });
  global.fetch = fetchFn as typeof fetch;
  const handler = createBookingApiHandler(config);

  const response = await handler(
    makeWebhookEvent(makeCaptureCompletedEvent("00000000-0000-4000-8000-000000000001"))
  );

  expect(response.statusCode).toBe(503);
  const body = JSON.parse(response.body);
  expect(body.error.code).toBe("webhook_verify_unavailable");
});

test("POST /api/webhooks/paypal PAYMENT.CAPTURE.REVERSED transitions session to failed", async () => {
  global.fetch = makeHappyPathFetch() as typeof fetch;
  const handler = createBookingApiHandler(config);
  const { bookingSessionId } = await setupSessionWithPaypalOrder(handler);

  const response = await handler(makeWebhookEvent(makeCaptureReversedEvent(bookingSessionId)));

  expect(response.statusCode).toBe(200);

  const session = await bookingSessions.getById(bookingSessionId);
  expect(session?.status).toBe("failed");
  expect(session?.failureReason).toBe("payment.capture.reversed");

  const payment = await payments.getByBookingSessionId(bookingSessionId);
  expect(payment?.status).toBe("failed");
});

test("POST /api/webhooks/paypal PAYMENT.CAPTURE.DENIED does not affect a booking_confirmed session", async () => {
  global.fetch = makeHappyPathFetch() as typeof fetch;
  const handler = createBookingApiHandler(config);
  const { bookingSessionId } = await setupSessionWithPaypalOrder(handler);

  // Confirm the booking via CAPTURE.COMPLETED
  await handler(makeWebhookEvent(makeCaptureCompletedEvent(bookingSessionId)));
  const confirmedSession = await bookingSessions.getById(bookingSessionId);
  expect(confirmedSession?.status).toBe("booking_confirmed");

  // Now a DENIED event arrives (out-of-order or stale) — should not change state
  const deniedEvent = { ...makeCaptureDeniedEvent(bookingSessionId), id: "WH-EVT-CAPTURE-DENIED-LATE" };
  const response = await handler(makeWebhookEvent(deniedEvent));

  expect(response.statusCode).toBe(200);
  const session = await bookingSessions.getById(bookingSessionId);
  expect(session?.status).toBe("booking_confirmed");

  const payment = await payments.getByBookingSessionId(bookingSessionId);
  expect(payment?.status).toBe("captured");
});

// ─── Replay protection ────────────────────────────────────────────────────────

import { isPayPalTransmissionTimeValid, PAYPAL_WEBHOOK_MAX_AGE_MS } from "./paypalWebhooks";

test("isPayPalTransmissionTimeValid: accepts a timestamp within the allowed window", () => {
  const now = Date.now();
  const recent = new Date(now - 30_000).toISOString(); // 30 seconds ago — well within 4 days
  expect(isPayPalTransmissionTimeValid(recent, now)).toBe(true);
});

test("isPayPalTransmissionTimeValid: accepts a timestamp exactly at the boundary", () => {
  const now = Date.now();
  const boundary = new Date(now - PAYPAL_WEBHOOK_MAX_AGE_MS).toISOString(); // exactly 4 days ago
  expect(isPayPalTransmissionTimeValid(boundary, now)).toBe(true);
});

test("isPayPalTransmissionTimeValid: rejects a timestamp older than the allowed window", () => {
  const now = Date.now();
  const old = new Date(now - PAYPAL_WEBHOOK_MAX_AGE_MS - 1).toISOString(); // 4 days + 1ms ago
  expect(isPayPalTransmissionTimeValid(old, now)).toBe(false);
});

test("isPayPalTransmissionTimeValid: rejects a future timestamp beyond the allowed window", () => {
  const now = Date.now();
  const future = new Date(now + PAYPAL_WEBHOOK_MAX_AGE_MS + 1).toISOString();
  expect(isPayPalTransmissionTimeValid(future, now)).toBe(false);
});

test("isPayPalTransmissionTimeValid: rejects undefined", () => {
  expect(isPayPalTransmissionTimeValid(undefined)).toBe(false);
});

test("isPayPalTransmissionTimeValid: rejects an invalid date string", () => {
  expect(isPayPalTransmissionTimeValid("not-a-date")).toBe(false);
});

test("POST /api/webhooks/paypal returns 400 when transmission-time is outside the replay window", async () => {
  global.fetch = makeHappyPathFetch() as typeof fetch;
  const handler = createBookingApiHandler(config);

  // Use a timestamp 5 days in the past — outside the 4-day window
  const staleTime = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
  const response = await handler(
    makeWebhookEvent(makeCaptureCompletedEvent("00000000-0000-4000-8000-000000000001"), {
      ...WEBHOOK_HEADERS,
      "paypal-transmission-time": staleTime,
    })
  );

  // Stale-but-verified events return 200 (not 400) so PayPal stops retrying gracefully
  expect(response.statusCode).toBe(200);
  const body = JSON.parse(response.body);
  expect(body.stale).toBe(true);
});

test("POST /api/webhooks/paypal accepts a transmission-time within the replay window", async () => {
  global.fetch = makeHappyPathFetch() as typeof fetch;
  const handler = createBookingApiHandler(config);
  const { bookingSessionId } = await setupSessionWithPaypalOrder(handler);

  // Use a dynamic timestamp 30 seconds ago — always within the 4-day window
  const recentTime = new Date(Date.now() - 30_000).toISOString();
  const response = await handler(
    makeWebhookEvent(makeCaptureCompletedEvent(bookingSessionId), {
      ...WEBHOOK_HEADERS,
      "paypal-transmission-time": recentTime,
    })
  );

  expect(response.statusCode).toBe(200);
  const session = await bookingSessions.getById(bookingSessionId);
  expect(session?.status).toBe("booking_confirmed");
});
