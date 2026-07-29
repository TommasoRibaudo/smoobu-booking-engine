import { createBookingApiHandler } from "./app";
import { InMemoryBookingSessionRepository } from "./bookingSessions";
import { InMemoryHoldRepository } from "./holds";
import { InMemoryPaymentRepository } from "./payments";
import { StaticSecretProvider } from "./secrets";
import { BookingApiConfig, LambdaHttpRequest } from "./types";
import { SITE_NAME } from "./branding";

// ─── Test wiring ─────────────────────────────────────────────────────────────

let bookingSessions: InMemoryBookingSessionRepository;
let holds: InMemoryHoldRepository;
let payments: InMemoryPaymentRepository;
let config: BookingApiConfig;

function createTestConfig(): BookingApiConfig {
  bookingSessions = new InMemoryBookingSessionRepository();
  holds = new InMemoryHoldRepository();
  payments = new InMemoryPaymentRepository();
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
      orderReturnUrl: "https://booking.test/book/return",
      orderCancelUrl: "https://booking.test/book",
    },
    bookingSessions,
    holds,
    payments,
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
const PAYPAL_TOKEN_RESPONSE = {
  access_token: "pp-access-token",
  expires_in: 3600,
};
const PAYPAL_ORDER_RESPONSE = {
  id: "PAY-ORDER-123",
  status: "CREATED",
  links: [
    { rel: "approve", href: "https://www.sandbox.paypal.com/checkoutnow?token=PAY-ORDER-123", method: "GET" },
    { rel: "self", href: "https://api-m.sandbox.paypal.com/v2/checkout/orders/PAY-ORDER-123", method: "GET" },
  ],
};
const PAYPAL_CAPTURE_RESPONSE = {
  id: "PAY-ORDER-123",
  status: "COMPLETED",
  purchase_units: [
    {
      payments: {
        captures: [
          {
            id: "PAY-CAP-456",
            status: "COMPLETED",
            amount: { currency_code: "USD", value: "510.00" },
          },
        ],
      },
    },
  ],
};

/** Default fetch mock that handles the full happy-path sequence */
function makeHappyPathFetch(): jest.Mock {
  return jest.fn(async (url: string | URL) => {
    const { hostname, pathname } = new URL(url.toString());

    // Smoobu
    if (hostname === "login.smoobu.com") {
      if (pathname === "/booking/checkApartmentAvailability") {
        return jsonResp(SMOOBU_AVAILABILITY_RESPONSE);
      }
      if (pathname === "/api/reservations") {
        return jsonResp(SMOOBU_RESERVATION_RESPONSE);
      }
    }

    // PayPal
    if (hostname === "api-m.sandbox.paypal.com") {
      if (pathname === "/v1/oauth2/token") {
        return jsonResp(PAYPAL_TOKEN_RESPONSE);
      }
      if (pathname === "/v2/checkout/orders") {
        return jsonResp(PAYPAL_ORDER_RESPONSE);
      }
      if (pathname.includes("/capture")) {
        return jsonResp(PAYPAL_CAPTURE_RESPONSE);
      }
    }

    return jsonResp({ detail: "unexpected" }, { status: 500 });
  });
}

// ─── Event builders ───────────────────────────────────────────────────────────

function makeSearchEvent(): LambdaHttpRequest {
  return {
    version: "2.0",
    rawPath: "/api/search",
    headers: {
      "content-type": "application/json",
      origin: "https://booking.test",
      "x-booking-device-id": "device-pp-test",
    },
    body: JSON.stringify({
      arrivalDate: "2099-06-10",
      departureDate: "2099-06-14",
      guests: 2,
      language: "en",
    }),
    requestContext: {
      http: { method: "POST", path: "/api/search", sourceIp: "203.0.113.30" },
    },
  };
}

function makeHoldEvent(body: unknown, idempotencyKey = "idem-hold-pp-test-001"): LambdaHttpRequest {
  return {
    version: "2.0",
    rawPath: "/api/holds",
    headers: {
      "content-type": "application/json",
      "idempotency-key": idempotencyKey,
      origin: "https://booking.test",
      "x-booking-device-id": "device-pp-test",
    },
    body: JSON.stringify(body),
    requestContext: {
      http: { method: "POST", path: "/api/holds", sourceIp: "203.0.113.30" },
    },
  };
}

function makeOrderEvent(body: unknown, idempotencyKey = "idem-order-pp-test-001"): LambdaHttpRequest {
  return {
    version: "2.0",
    rawPath: "/api/paypal/order",
    headers: {
      "content-type": "application/json",
      "idempotency-key": idempotencyKey,
      origin: "https://booking.test",
      "x-booking-device-id": "device-pp-test",
    },
    body: JSON.stringify(body),
    requestContext: {
      http: { method: "POST", path: "/api/paypal/order", sourceIp: "203.0.113.30" },
    },
  };
}

function makeScopedOrderEvent(bookingSessionId: string, idempotencyKey = "idem-order-scoped-pp-test-001"): LambdaHttpRequest {
  return {
    version: "2.0",
    rawPath: `/api/bookings/${bookingSessionId}/paypal/create-order`,
    headers: {
      "idempotency-key": idempotencyKey,
      origin: "https://booking.test",
      "x-booking-device-id": "device-pp-test",
    },
    requestContext: {
      http: {
        method: "POST",
        path: `/api/bookings/${bookingSessionId}/paypal/create-order`,
        sourceIp: "203.0.113.30",
      },
    },
  };
}

function makeCaptureEvent(body: unknown, idempotencyKey = "idem-capture-pp-test-001"): LambdaHttpRequest {
  return {
    version: "2.0",
    rawPath: "/api/paypal/capture",
    headers: {
      "content-type": "application/json",
      "idempotency-key": idempotencyKey,
      origin: "https://booking.test",
      "x-booking-device-id": "device-pp-test",
    },
    body: JSON.stringify(body),
    requestContext: {
      http: { method: "POST", path: "/api/paypal/capture", sourceIp: "203.0.113.30" },
    },
  };
}

function makeScopedCaptureEvent(
  bookingSessionId: string,
  body: unknown,
  idempotencyKey = "idem-capture-scoped-pp-test-001"
): LambdaHttpRequest {
  return {
    version: "2.0",
    rawPath: `/api/bookings/${bookingSessionId}/paypal/capture`,
    headers: {
      "content-type": "application/json",
      "idempotency-key": idempotencyKey,
      origin: "https://booking.test",
      "x-booking-device-id": "device-pp-test",
    },
    body: JSON.stringify(body),
    requestContext: {
      http: {
        method: "POST",
        path: `/api/bookings/${bookingSessionId}/paypal/capture`,
        sourceIp: "203.0.113.30",
      },
    },
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

// A valid UUID v4 format that will not match any real session
const NONEXISTENT_SESSION_ID = "b8a1f2e7-0000-4000-8000-000000000000";

/** Drives the full search → hold flow and returns the IDs needed for the PayPal steps. */
async function setupSessionWithActiveHold(handler: ReturnType<typeof createBookingApiHandler>) {
  const searchResp = await handler(makeSearchEvent());
  expect(searchResp.statusCode).toBe(200);
  const searchBody = JSON.parse(searchResp.body);
  const { bookingSessionId, properties } = searchBody;
  const propertyId = properties[0].propertyId;

  const holdResp = await handler(
    makeHoldEvent({
      quoteId: searchBody.quoteId,
      bookingSessionId,
      propertyId,
      paymentMethod: "paypal",
      guest: { firstName: "Ana", lastName: "Mora", email: "ana@example.com" },
      portalPassword: "correct horse battery staple",
      termsAccepted: true,
    })
  );
  expect(holdResp.statusCode).toBe(200);

  return { bookingSessionId, propertyId };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

test("POST /api/paypal/order creates a PayPal order and returns orderId + approvalUrl", async () => {
  const fetchFn = makeHappyPathFetch();
  global.fetch = fetchFn as typeof fetch;
  const handler = createBookingApiHandler(config);
  const { bookingSessionId } = await setupSessionWithActiveHold(handler);

  const response = await handler(makeOrderEvent({ bookingSessionId }));

  expect(response.statusCode).toBe(200);
  const body = JSON.parse(response.body);
  expect(body).toMatchObject({
    booking: {
      bookingSessionId,
      status: "paypal_order_created",
      language: "en",
      arrivalDate: "2099-06-10",
      departureDate: "2099-06-14",
    },
    paypal: {
      orderId: "PAY-ORDER-123",
      approvalUrl: "https://www.sandbox.paypal.com/checkoutnow?token=PAY-ORDER-123",
    },
    nextAction: "approve_paypal_order",
  });
  expect(body.booking.reservationPublicId).toMatch(/^KWL-[A-Z2-9]{8}$/);
});

test("POST /api/bookings/:bookingSessionId/paypal/create-order creates a PayPal order from the path session ID", async () => {
  const fetchFn = makeHappyPathFetch();
  global.fetch = fetchFn as typeof fetch;
  const handler = createBookingApiHandler(config);
  const { bookingSessionId } = await setupSessionWithActiveHold(handler);

  const response = await handler(makeScopedOrderEvent(bookingSessionId));

  expect(response.statusCode).toBe(200);
  const body = JSON.parse(response.body);
  expect(body).toMatchObject({
    booking: {
      bookingSessionId,
      status: "paypal_order_created",
    },
    paypal: {
      orderId: "PAY-ORDER-123",
      approvalUrl: "https://www.sandbox.paypal.com/checkoutnow?token=PAY-ORDER-123",
    },
    nextAction: "approve_paypal_order",
  });
});

test("POST /api/paypal/order sends PayPal-Request-Id header and correct order payload to PayPal", async () => {
  const fetchFn = makeHappyPathFetch();
  global.fetch = fetchFn as typeof fetch;
  const handler = createBookingApiHandler(config);
  const { bookingSessionId } = await setupSessionWithActiveHold(handler);

  await handler(makeOrderEvent({ bookingSessionId }));

  // OAuth token call
  const tokenCall = fetchFn.mock.calls.find(([url]) =>
    new URL(url.toString()).pathname === "/v1/oauth2/token"
  );
  expect(tokenCall).toBeDefined();
  const tokenInit = tokenCall?.[1];
  expect(tokenInit?.headers).toMatchObject({
    Authorization: `Basic ${Buffer.from("paypal-client-id-value:paypal-client-secret-value").toString("base64")}`,
    "Content-Type": "application/x-www-form-urlencoded",
  });

  // Order creation call
  const orderCall = fetchFn.mock.calls.find(([url]) =>
    new URL(url.toString()).pathname === "/v2/checkout/orders"
  );
  expect(orderCall).toBeDefined();
  const orderInit = orderCall?.[1];

  // PayPal-Request-Id must be set and be a UUID
  expect(orderInit?.headers).toMatchObject({
    Authorization: "Bearer pp-access-token",
  });
  const paypalRequestId = (orderInit?.headers as Record<string, string>)["PayPal-Request-Id"];
  expect(paypalRequestId).toMatch(/^[0-9a-f-]{36}$/i);

  // Order payload correctness
  const orderPayload = JSON.parse(orderInit?.body as string);
  expect(orderPayload).toMatchObject({
    intent: "CAPTURE",
    purchase_units: [
      {
        reference_id: bookingSessionId,
        amount: { currency_code: "USD", value: "510.00" },
      },
    ],
    application_context: {
      brand_name: SITE_NAME,
      locale: "en-US",
      shipping_preference: "NO_SHIPPING",
      user_action: "PAY_NOW",
      return_url: "https://booking.test/book/return",
      cancel_url: "https://booking.test/book",
    },
  });
  expect(orderPayload.purchase_units[0].description).toContain("Sunset Villa");
  expect(orderPayload.purchase_units[0].custom_id).toMatch(/^KWL-[A-Z2-9]{8}$/);
});

test("POST /api/paypal/order advances session status to paypal_order_created", async () => {
  global.fetch = makeHappyPathFetch() as typeof fetch;
  const handler = createBookingApiHandler(config);
  const { bookingSessionId } = await setupSessionWithActiveHold(handler);

  await handler(makeOrderEvent({ bookingSessionId }));

  const session = await bookingSessions.getById(bookingSessionId);
  expect(session?.status).toBe("paypal_order_created");
  expect(session?.paypalOrderId).toBe("PAY-ORDER-123");

  const payment = await payments.getByBookingSessionId(bookingSessionId);
  expect(payment?.status).toBe("order_created");
  expect(payment?.paypalOrderId).toBe("PAY-ORDER-123");
  expect(payment?.paypalRequestIdOrder).toMatch(/^[0-9a-f-]{36}$/i);
  expect(payment?.paypalRequestIdCapture).toMatch(/^[0-9a-f-]{36}$/i);
  // The two request IDs must be different
  expect(payment?.paypalRequestIdOrder).not.toBe(payment?.paypalRequestIdCapture);
});

test("POST /api/paypal/order is idempotent: second call returns the same orderId without re-calling PayPal", async () => {
  const fetchFn = makeHappyPathFetch();
  global.fetch = fetchFn as typeof fetch;
  const handler = createBookingApiHandler(config);
  const { bookingSessionId } = await setupSessionWithActiveHold(handler);

  const first = await handler(makeOrderEvent({ bookingSessionId }, "idem-order-0000000001"));
  const second = await handler(makeOrderEvent({ bookingSessionId }, "idem-order-0000000002"));

  expect(first.statusCode).toBe(200);
  expect(second.statusCode).toBe(200);
  const firstBody = JSON.parse(first.body);
  const secondBody = JSON.parse(second.body);
  expect(secondBody.paypal.orderId).toBe(firstBody.paypal.orderId);

  // PayPal create order called only once
  const orderCalls = fetchFn.mock.calls.filter(([url]) =>
    new URL(url.toString()).pathname === "/v2/checkout/orders"
  );
  expect(orderCalls).toHaveLength(1);
});

test("POST /api/paypal/order returns 409 when session is not hold_active", async () => {
  global.fetch = makeHappyPathFetch() as typeof fetch;
  const handler = createBookingApiHandler(config);

  // Get a session in quoted state (no hold)
  const searchResp = await handler(makeSearchEvent());
  const { bookingSessionId } = JSON.parse(searchResp.body);

  const response = await handler(makeOrderEvent({ bookingSessionId }));

  expect(response.statusCode).toBe(409);
  const body = JSON.parse(response.body);
  expect(body.error.code).toBe("invalid_booking_state");
});

test("POST /api/paypal/order returns 409 when the hold has expired", async () => {
  global.fetch = makeHappyPathFetch() as typeof fetch;
  const handler = createBookingApiHandler(config);
  const { bookingSessionId } = await setupSessionWithActiveHold(handler);

  // Advance time past the 60-minute hold TTL
  jest.setSystemTime(new Date("2026-04-15T19:01:00Z"));

  const response = await handler(makeOrderEvent({ bookingSessionId }));

  expect(response.statusCode).toBe(409);
  const body = JSON.parse(response.body);
  expect(body.error.code).toBe("hold_expired");
});

test("POST /api/paypal/order returns 404 when session does not exist", async () => {
  global.fetch = makeHappyPathFetch() as typeof fetch;
  const handler = createBookingApiHandler(config);

  const response = await handler(
    makeOrderEvent({ bookingSessionId: NONEXISTENT_SESSION_ID })
  );

  expect(response.statusCode).toBe(404);
});

test("POST /api/paypal/order returns 422 when body is missing bookingSessionId", async () => {
  const handler = createBookingApiHandler(config);
  const response = await handler(makeOrderEvent({}));
  expect(response.statusCode).toBe(422);
});

// ─── Capture tests ────────────────────────────────────────────────────────────

test("POST /api/paypal/capture captures payment and transitions to booking_confirmed", async () => {
  global.fetch = makeHappyPathFetch() as typeof fetch;
  const handler = createBookingApiHandler(config);
  const { bookingSessionId } = await setupSessionWithActiveHold(handler);

  await handler(makeOrderEvent({ bookingSessionId }));

  const captureResp = await handler(
    makeCaptureEvent({ bookingSessionId, paypalOrderId: "PAY-ORDER-123" })
  );

  expect(captureResp.statusCode).toBe(200);
  const body = JSON.parse(captureResp.body);
  expect(body).toMatchObject({
    booking: {
      bookingSessionId,
      status: "booking_confirmed",
      language: "en",
      arrivalDate: "2099-06-10",
      departureDate: "2099-06-14",
    },
    payment: {
      method: "paypal",
      status: "captured",
      paypalOrderId: "PAY-ORDER-123",
      paypalCaptureId: "PAY-CAP-456",
    },
  });
  expect(body.booking.reservationPublicId).toMatch(/^KWL-[A-Z2-9]{8}$/);
  expect(body.payment.capturedAt).toBe("2026-04-15T18:00:00.000Z");
});

test("POST /api/bookings/:bookingSessionId/paypal/capture captures using the path session ID", async () => {
  global.fetch = makeHappyPathFetch() as typeof fetch;
  const handler = createBookingApiHandler(config);
  const { bookingSessionId } = await setupSessionWithActiveHold(handler);

  await handler(makeOrderEvent({ bookingSessionId }));

  const captureResp = await handler(
    makeScopedCaptureEvent(bookingSessionId, { paypalOrderId: "PAY-ORDER-123" })
  );

  expect(captureResp.statusCode).toBe(200);
  const body = JSON.parse(captureResp.body);
  expect(body).toMatchObject({
    booking: {
      bookingSessionId,
      status: "booking_confirmed",
    },
    payment: {
      method: "paypal",
      status: "captured",
      paypalOrderId: "PAY-ORDER-123",
      paypalCaptureId: "PAY-CAP-456",
    },
  });
});

test("POST /api/paypal/capture sends stored PayPal-Request-Id (capture key) to PayPal", async () => {
  const fetchFn = makeHappyPathFetch();
  global.fetch = fetchFn as typeof fetch;
  const handler = createBookingApiHandler(config);
  const { bookingSessionId } = await setupSessionWithActiveHold(handler);

  await handler(makeOrderEvent({ bookingSessionId }));

  const storedPayment = await payments.getByBookingSessionId(bookingSessionId);
  const expectedCaptureRequestId = storedPayment?.paypalRequestIdCapture;

  await handler(makeCaptureEvent({ bookingSessionId, paypalOrderId: "PAY-ORDER-123" }));

  const captureCall = fetchFn.mock.calls.find(([url]) =>
    new URL(url.toString()).pathname.endsWith("/capture")
  );
  expect(captureCall).toBeDefined();
  const captureHeaders = captureCall?.[1]?.headers as Record<string, string>;
  expect(captureHeaders["PayPal-Request-Id"]).toBe(expectedCaptureRequestId);
});

test("POST /api/paypal/capture persists booking_confirmed state", async () => {
  global.fetch = makeHappyPathFetch() as typeof fetch;
  const handler = createBookingApiHandler(config);
  const { bookingSessionId } = await setupSessionWithActiveHold(handler);

  await handler(makeOrderEvent({ bookingSessionId }));
  await handler(makeCaptureEvent({ bookingSessionId, paypalOrderId: "PAY-ORDER-123" }));

  const session = await bookingSessions.getById(bookingSessionId);
  expect(session?.status).toBe("booking_confirmed");
  expect(session?.confirmedAt).toBe("2026-04-15T18:00:00.000Z");

  const payment = await payments.getByBookingSessionId(bookingSessionId);
  expect(payment?.status).toBe("captured");
  expect(payment?.paypalCaptureId).toBe("PAY-CAP-456");
});

test("POST /api/paypal/capture is idempotent: second call returns the same result without re-calling PayPal capture", async () => {
  const fetchFn = makeHappyPathFetch();
  global.fetch = fetchFn as typeof fetch;
  const handler = createBookingApiHandler(config);
  const { bookingSessionId } = await setupSessionWithActiveHold(handler);

  await handler(makeOrderEvent({ bookingSessionId }));

  const first = await handler(
    makeCaptureEvent({ bookingSessionId, paypalOrderId: "PAY-ORDER-123" }, "idem-capture-00000001")
  );
  const second = await handler(
    makeCaptureEvent({ bookingSessionId, paypalOrderId: "PAY-ORDER-123" }, "idem-capture-00000002")
  );

  expect(first.statusCode).toBe(200);
  expect(second.statusCode).toBe(200);
  const firstBody = JSON.parse(first.body);
  const secondBody = JSON.parse(second.body);
  expect(secondBody.payment.paypalCaptureId).toBe(firstBody.payment.paypalCaptureId);

  // PayPal capture called only once
  const captureCalls = fetchFn.mock.calls.filter(([url]) =>
    new URL(url.toString()).pathname.endsWith("/capture")
  );
  expect(captureCalls).toHaveLength(1);
});

test("POST /api/paypal/capture returns 409 when paypalOrderId does not match stored value", async () => {
  global.fetch = makeHappyPathFetch() as typeof fetch;
  const handler = createBookingApiHandler(config);
  const { bookingSessionId } = await setupSessionWithActiveHold(handler);
  await handler(makeOrderEvent({ bookingSessionId }));

  const response = await handler(
    makeCaptureEvent({ bookingSessionId, paypalOrderId: "WRONG-ORDER-ID" })
  );

  expect(response.statusCode).toBe(409);
  const body = JSON.parse(response.body);
  expect(body.error.code).toBe("paypal_order_id_mismatch");
});

test("POST /api/paypal/capture returns 409 when session is not in paypal_order_created state", async () => {
  global.fetch = makeHappyPathFetch() as typeof fetch;
  const handler = createBookingApiHandler(config);

  // Hold created but order not yet created — session is still hold_active
  const { bookingSessionId } = await setupSessionWithActiveHold(handler);

  const response = await handler(
    makeCaptureEvent({ bookingSessionId, paypalOrderId: "PAY-ORDER-123" })
  );

  expect(response.statusCode).toBe(409);
  // No payment record for this session yet
  const body = JSON.parse(response.body);
  expect(body.error.code).toBe("invalid_booking_state");
});

test("POST /api/paypal/capture returns 402 and marks payment failed when PayPal declines", async () => {
  const fetchFn = jest.fn(async (url: string | URL) => {
    const { hostname, pathname } = new URL(url.toString());

    if (hostname === "login.smoobu.com") {
      if (pathname === "/booking/checkApartmentAvailability") return jsonResp(SMOOBU_AVAILABILITY_RESPONSE);
      if (pathname === "/api/reservations") return jsonResp(SMOOBU_RESERVATION_RESPONSE);
    }

    if (hostname === "api-m.sandbox.paypal.com") {
      if (pathname === "/v1/oauth2/token") return jsonResp(PAYPAL_TOKEN_RESPONSE);
      if (pathname === "/v2/checkout/orders") return jsonResp(PAYPAL_ORDER_RESPONSE);
      if (pathname.includes("/capture")) {
        return jsonResp(
          {
            name: "UNPROCESSABLE_ENTITY",
            details: [{ issue: "INSTRUMENT_DECLINED", description: "The instrument presented was declined." }],
          },
          { status: 422 }
        );
      }
    }

    return jsonResp({ detail: "unexpected" }, { status: 500 });
  });
  global.fetch = fetchFn as typeof fetch;
  const handler = createBookingApiHandler(config);
  const { bookingSessionId } = await setupSessionWithActiveHold(handler);
  await handler(makeOrderEvent({ bookingSessionId }));

  const response = await handler(
    makeCaptureEvent({ bookingSessionId, paypalOrderId: "PAY-ORDER-123" })
  );

  expect(response.statusCode).toBe(402);
  const body = JSON.parse(response.body);
  expect(body.error.code).toBe("payment_instrument_declined");

  // Payment and session must be marked failed
  const payment = await payments.getByBookingSessionId(bookingSessionId);
  const session = await bookingSessions.getById(bookingSessionId);
  expect(payment?.status).toBe("failed");
  expect(session?.status).toBe("failed");
});

test("POST /api/paypal/capture returns 409 when buyer has not yet approved the order (ORDER_NOT_APPROVED)", async () => {
  const fetchFn = jest.fn(async (url: string | URL) => {
    const { hostname, pathname } = new URL(url.toString());

    if (hostname === "login.smoobu.com") {
      if (pathname === "/booking/checkApartmentAvailability") return jsonResp(SMOOBU_AVAILABILITY_RESPONSE);
      if (pathname === "/api/reservations") return jsonResp(SMOOBU_RESERVATION_RESPONSE);
    }

    if (hostname === "api-m.sandbox.paypal.com") {
      if (pathname === "/v1/oauth2/token") return jsonResp(PAYPAL_TOKEN_RESPONSE);
      if (pathname === "/v2/checkout/orders") return jsonResp(PAYPAL_ORDER_RESPONSE);
      if (pathname.includes("/capture")) {
        return jsonResp(
          {
            name: "UNPROCESSABLE_ENTITY",
            details: [{ issue: "ORDER_NOT_APPROVED", description: "Order not approved." }],
          },
          { status: 422 }
        );
      }
    }

    return jsonResp({ detail: "unexpected" }, { status: 500 });
  });
  global.fetch = fetchFn as typeof fetch;
  const handler = createBookingApiHandler(config);
  const { bookingSessionId } = await setupSessionWithActiveHold(handler);
  await handler(makeOrderEvent({ bookingSessionId }));

  const response = await handler(
    makeCaptureEvent({ bookingSessionId, paypalOrderId: "PAY-ORDER-123" })
  );

  expect(response.statusCode).toBe(409);
  const body = JSON.parse(response.body);
  expect(body.error.code).toBe("paypal_order_not_approved");

  // ORDER_NOT_APPROVED is retryable — payment must NOT be marked failed
  const payment = await payments.getByBookingSessionId(bookingSessionId);
  expect(payment?.status).toBe("order_created");
});

test("POST /api/paypal/capture returns 404 when session does not exist", async () => {
  const handler = createBookingApiHandler(config);
  const response = await handler(
    makeCaptureEvent({
      bookingSessionId: NONEXISTENT_SESSION_ID,
      paypalOrderId: "PAY-ORDER-123",
    })
  );
  expect(response.statusCode).toBe(404);
});

test("POST /api/paypal/capture returns 422 when body is missing paypalOrderId", async () => {
  const handler = createBookingApiHandler(config);
  const response = await handler(makeCaptureEvent({ bookingSessionId: "00000000-0000-0000-0000-000000000000" }));
  expect(response.statusCode).toBe(422);
});

test("POST /api/paypal/order requires Idempotency-Key header", async () => {
  const handler = createBookingApiHandler(config);
  const event: LambdaHttpRequest = {
    version: "2.0",
    rawPath: "/api/paypal/order",
    headers: {
      "content-type": "application/json",
      origin: "https://booking.test",
      // No idempotency-key header
    },
    body: JSON.stringify({ bookingSessionId: "00000000-0000-0000-0000-000000000000" }),
    requestContext: { http: { method: "POST", path: "/api/paypal/order", sourceIp: "1.2.3.4" } },
  };

  const response = await handler(event);
  expect(response.statusCode).toBe(400);
  const body = JSON.parse(response.body);
  expect(body.error.code).toBe("missing_idempotency_key");
});

test("POST /api/paypal/capture requires Idempotency-Key header", async () => {
  const handler = createBookingApiHandler(config);
  const event: LambdaHttpRequest = {
    version: "2.0",
    rawPath: "/api/paypal/capture",
    headers: {
      "content-type": "application/json",
      origin: "https://booking.test",
    },
    body: JSON.stringify({ bookingSessionId: "00000000-0000-0000-0000-000000000000", paypalOrderId: "X" }),
    requestContext: { http: { method: "POST", path: "/api/paypal/capture", sourceIp: "1.2.3.4" } },
  };

  const response = await handler(event);
  expect(response.statusCode).toBe(400);
  const body = JSON.parse(response.body);
  expect(body.error.code).toBe("missing_idempotency_key");
});
