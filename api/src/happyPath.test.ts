/**
 * C22 — Happy-path smoke test (in-process)
 *
 * Drives the complete booking flow end-to-end using the Lambda handler with
 * in-memory repositories and mocked Smoobu / PayPal HTTP calls.
 *
 * Steps covered:
 *   1. GET  /api/health
 *   2. POST /api/search
 *   3. POST /api/holds
 *   4. POST /api/bookings/:id/paypal/create-order
 *   5. POST /api/bookings/:id/paypal/capture
 *   6. POST /api/portal/login
 *   7. GET  /api/portal/reservation/:reservationPublicId
 */

import { createBookingApiHandler } from "./app";
import { InMemoryBookingSessionRepository } from "./bookingSessions";
import { InMemoryHoldRepository } from "./holds";
import { InMemoryPaymentRepository } from "./payments";
import { InMemoryWebhookEventRepository } from "./paypalWebhooks";
import { InMemoryPortalSessionRepository } from "./portalSessions";
import { StaticSecretProvider } from "./secrets";
import { BookingApiConfig, LambdaHttpRequest } from "./types";

// ── constants ─────────────────────────────────────────────────────────────────

const PORTAL_SECRET = "portal-session-secret-happy-path";

const SMOOBU_AVAILABILITY = {
  availableApartments: [100001],
  prices: { "100001": { price: 510, currency: "USD" } },
  errorMessages: {},
};
const SMOOBU_RESERVATION = { id: 9900001 };
const PAYPAL_TOKEN = { access_token: "pp-happy-token", expires_in: 3600 };
const PAYPAL_ORDER = {
  id: "HP-ORDER-001",
  status: "CREATED",
  links: [
    { rel: "approve", href: "https://www.sandbox.paypal.com/checkoutnow?token=HP-ORDER-001", method: "GET" },
    { rel: "self", href: "https://api-m.sandbox.paypal.com/v2/checkout/orders/HP-ORDER-001", method: "GET" },
  ],
};
const PAYPAL_CAPTURE = {
  id: "HP-ORDER-001",
  status: "COMPLETED",
  purchase_units: [
    {
      payments: {
        captures: [
          {
            id: "HP-CAP-001",
            status: "COMPLETED",
            amount: { currency_code: "USD", value: "510.00" },
          },
        ],
      },
    },
  ],
};

// ── test config ───────────────────────────────────────────────────────────────

let bookingSessions: InMemoryBookingSessionRepository;
let holds: InMemoryHoldRepository;
let payments: InMemoryPaymentRepository;
let webhookEvents: InMemoryWebhookEventRepository;
let portalSessions: InMemoryPortalSessionRepository;
let config: BookingApiConfig;

const originalFetch = global.fetch;

function createTestConfig(): BookingApiConfig {
  bookingSessions = new InMemoryBookingSessionRepository();
  holds = new InMemoryHoldRepository();
  payments = new InMemoryPaymentRepository();
  webhookEvents = new InMemoryWebhookEventRepository();
  portalSessions = new InMemoryPortalSessionRepository();
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
      portalSessionSecret: PORTAL_SECRET,
      rdsConnectionString: "postgres://booking_user:pw@db.test:5432/booking_engine",
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
      orderCancelUrl: "https://booking.test/book/cancel",
    },
    bookingSessions,
    holds,
    payments,
    webhookEvents,
    portalSessions,
    hold: {
      defaultTtlMinutes: 60,
      idempotencyTtlMinutes: 1440,
      staleIdempotencyLockSeconds: 120,
    },
    abuseProtection: { enabled: false, captchaChallengesEnabled: false, maxTrackedBuckets: 100 },
    email: { fromAddress: "test@example.com", region: "us-east-1", disabled: true },
    observability: { serviceName: "booking-api", environment: "test", logLevel: "silent", metricsEnabled: false },
  };
}

function happyPathFetch(): jest.Mock {
  return jest.fn(async (url: string | URL) => {
    const { hostname, pathname } = new URL(url.toString());

    if (hostname === "login.smoobu.com") {
      if (pathname === "/booking/checkApartmentAvailability") {
        return jsonResp(SMOOBU_AVAILABILITY);
      }
      if (pathname === "/api/reservations") {
        return jsonResp(SMOOBU_RESERVATION);
      }
    }

    if (hostname === "api-m.sandbox.paypal.com") {
      if (pathname === "/v1/oauth2/token") {
        return jsonResp(PAYPAL_TOKEN);
      }
      if (pathname === "/v2/checkout/orders") {
        return jsonResp(PAYPAL_ORDER);
      }
      if (pathname.endsWith("/capture")) {
        return jsonResp(PAYPAL_CAPTURE);
      }
    }

    return jsonResp({ detail: "unexpected call to " + pathname }, { status: 500 });
  });
}

function jsonResp(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    ...init,
    headers: { "content-type": "application/json", ...(init.headers as Record<string, string> | undefined) },
  });
}

// ── event builders ────────────────────────────────────────────────────────────

function healthEvent(): LambdaHttpRequest {
  return {
    version: "2.0",
    rawPath: "/api/health",
    headers: { origin: "https://booking.test" },
    requestContext: { http: { method: "GET", path: "/api/health", sourceIp: "203.0.113.1" } },
  };
}

function searchEvent(): LambdaHttpRequest {
  return {
    version: "2.0",
    rawPath: "/api/search",
    headers: { "content-type": "application/json", origin: "https://booking.test", "x-booking-device-id": "hp-device" },
    body: JSON.stringify({ arrivalDate: "2099-08-01", departureDate: "2099-08-05", guests: 2, language: "en", source: "booking_page" }),
    requestContext: { http: { method: "POST", path: "/api/search", sourceIp: "203.0.113.1" } },
  };
}

function holdEvent(body: unknown): LambdaHttpRequest {
  return {
    version: "2.0",
    rawPath: "/api/holds",
    headers: {
      "content-type": "application/json",
      "idempotency-key": "hp-hold-idem-key-0001",
      origin: "https://booking.test",
      "x-booking-device-id": "hp-device",
    },
    body: JSON.stringify(body),
    requestContext: { http: { method: "POST", path: "/api/holds", sourceIp: "203.0.113.1" } },
  };
}

function orderEvent(bookingSessionId: string): LambdaHttpRequest {
  return {
    version: "2.0",
    rawPath: `/api/bookings/${bookingSessionId}/paypal/create-order`,
    headers: {
      "idempotency-key": "hp-order-idem-key-0001",
      origin: "https://booking.test",
      "x-booking-device-id": "hp-device",
    },
    requestContext: {
      http: { method: "POST", path: `/api/bookings/${bookingSessionId}/paypal/create-order`, sourceIp: "203.0.113.1" },
    },
  };
}

function captureEvent(bookingSessionId: string): LambdaHttpRequest {
  return {
    version: "2.0",
    rawPath: `/api/bookings/${bookingSessionId}/paypal/capture`,
    headers: {
      "content-type": "application/json",
      "idempotency-key": "hp-capture-idem-key-0001",
      origin: "https://booking.test",
      "x-booking-device-id": "hp-device",
    },
    body: JSON.stringify({ paypalOrderId: "HP-ORDER-001" }),
    requestContext: {
      http: { method: "POST", path: `/api/bookings/${bookingSessionId}/paypal/capture`, sourceIp: "203.0.113.1" },
    },
  };
}

function loginEvent(reservationPublicId: string): LambdaHttpRequest {
  return {
    version: "2.0",
    rawPath: "/api/portal/login",
    headers: { "content-type": "application/json", origin: "https://booking.test" },
    body: JSON.stringify({ reservationPublicId, password: "hunter2-horse-battery", language: "en" }),
    requestContext: { http: { method: "POST", path: "/api/portal/login", sourceIp: "203.0.113.2" } },
  };
}

function reservationEvent(reservationPublicId: string, token: string): LambdaHttpRequest {
  return {
    version: "2.0",
    rawPath: `/api/portal/reservation/${reservationPublicId}`,
    headers: { authorization: `Bearer ${token}`, origin: "https://booking.test" },
    requestContext: {
      http: { method: "GET", path: `/api/portal/reservation/${reservationPublicId}`, sourceIp: "203.0.113.2" },
    },
  };
}

// ── setup / teardown ──────────────────────────────────────────────────────────

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date("2026-06-01T10:00:00Z"));
  config = createTestConfig();
});

afterEach(() => {
  jest.useRealTimers();
  global.fetch = originalFetch;
  jest.restoreAllMocks();
});

// ── smoke test ────────────────────────────────────────────────────────────────

test("happy path: health → search → hold → paypal order → capture → portal login → reservation fetch", async () => {
  global.fetch = happyPathFetch() as typeof fetch;
  const handler = createBookingApiHandler(config);

  // 1. Health check
  const healthResp = await handler(healthEvent());
  expect(healthResp.statusCode).toBe(200);
  expect(JSON.parse(healthResp.body)).toMatchObject({ status: "ok", service: "booking-api" });

  // 2. Search
  const searchResp = await handler(searchEvent());
  expect(searchResp.statusCode).toBe(200);
  const { bookingSessionId, quoteId, properties } = JSON.parse(searchResp.body);
  expect(bookingSessionId).toBeDefined();
  expect(quoteId).toBeDefined();
  expect(properties.length).toBeGreaterThan(0);
  const propertyId = properties[0].propertyId;

  // 3. Hold creation
  const holdResp = await handler(
    holdEvent({
      quoteId,
      bookingSessionId,
      propertyId,
      paymentMethod: "paypal",
      guest: {
        firstName: "Smoke",
        lastName: "Test",
        email: "smoke@booking.test",
        phone: "+50688000001",
        country: "CR",
      },
      portalPassword: "hunter2-horse-battery",
      termsAccepted: true,
    })
  );
  expect(holdResp.statusCode).toBe(200);
  const holdBody = JSON.parse(holdResp.body);
  expect(holdBody).toMatchObject({
    booking: { bookingSessionId, status: "hold_active" },
    nextAction: "create_paypal_order",
  });
  expect(holdBody.booking.hold.status).toBe("active");
  expect(holdBody.booking.hold.expiresAt).toBeDefined();
  const reservationPublicId: string = holdBody.booking.reservationPublicId;
  expect(reservationPublicId).toMatch(/^KWL-[A-Z2-9]{8}$/);

  // 4. PayPal order creation
  const orderResp = await handler(orderEvent(bookingSessionId));
  expect(orderResp.statusCode).toBe(200);
  const orderBody = JSON.parse(orderResp.body);
  expect(orderBody).toMatchObject({
    booking: { bookingSessionId, status: "paypal_order_created" },
    paypal: { orderId: "HP-ORDER-001" },
    nextAction: "approve_paypal_order",
  });
  expect(orderBody.paypal.approvalUrl).toContain("HP-ORDER-001");

  // 5. PayPal capture (mock — simulates buyer returning from PayPal approval)
  const captureResp = await handler(captureEvent(bookingSessionId));
  expect(captureResp.statusCode).toBe(200);
  const captureBody = JSON.parse(captureResp.body);
  expect(captureBody).toMatchObject({
    booking: { bookingSessionId, status: "booking_confirmed" },
    payment: { method: "paypal", status: "captured", paypalOrderId: "HP-ORDER-001", paypalCaptureId: "HP-CAP-001" },
  });
  expect(captureBody.booking.reservationPublicId).toBe(reservationPublicId);

  // Verify persisted state
  const confirmedSession = await bookingSessions.getById(bookingSessionId);
  expect(confirmedSession?.status).toBe("booking_confirmed");
  const confirmedHold = await holds.getByBookingSessionId(bookingSessionId);
  expect(confirmedHold?.status).toBe("active");
  const confirmedPayment = await payments.getByBookingSessionId(bookingSessionId);
  expect(confirmedPayment?.status).toBe("captured");
  expect(confirmedPayment?.paypalCaptureId).toBe("HP-CAP-001");

  // 6. Portal login
  const loginResp = await handler(loginEvent(reservationPublicId));
  expect(loginResp.statusCode).toBe(200);
  const loginBody = JSON.parse(loginResp.body);
  expect(loginBody.token).toBeDefined();
  expect(loginBody.reservationPublicId).toBe(reservationPublicId);
  expect(loginBody.expiresIn).toBeGreaterThan(0);
  const sessionToken: string = loginBody.token;

  // 7. Portal reservation fetch
  const reservationResp = await handler(reservationEvent(reservationPublicId, sessionToken));
  expect(reservationResp.statusCode).toBe(200);
  const reservationBody = JSON.parse(reservationResp.body);
  expect(reservationBody).toMatchObject({
    reservation: {
      reservationPublicId,
      status: "booking_confirmed",
      arrivalDate: "2099-08-01",
      departureDate: "2099-08-05",
      guests: 2,
      language: "en",
    },
    payment: { method: "paypal", status: "captured" },
  });
  expect(reservationBody.reservation.property).toBeDefined();
  expect(reservationBody.reservation.property.name).toBe("Sunset Villa");
});

/**
 * Attribution identifiers must survive from the search that created the session
 * all the way to the confirmed booking, because that is the record
 * serverConversions.ts reads when it reports the sale to GA4 and Meta. A guest
 * who reaches the confirmation page with the identifiers lost is a sale that
 * gets attributed to Direct/None.
 */
test("tracking identifiers captured at search survive through to the hold", async () => {
  global.fetch = happyPathFetch() as typeof fetch;
  const handler = createBookingApiHandler(config);

  const search = await handler({
    ...searchEvent(),
    body: JSON.stringify({
      arrivalDate: "2099-08-01",
      departureDate: "2099-08-05",
      guests: 2,
      language: "en",
      source: "booking_page",
      marketingConsent: true,
      tracking: {
        gaClientId: "686566830.1785166389",
        gaSessionId: "1785166389",
        fbp: "fb.1.1700000000000.1234567890",
      },
    }),
  });
  expect(search.statusCode).toBe(200);

  const searchBody = JSON.parse(search.body as string);
  const stored = await bookingSessions.getById(searchBody.bookingSessionId);

  expect(stored?.marketingConsent).toBe(true);
  expect(stored?.tracking).toEqual({
    gaClientId: "686566830.1785166389",
    gaSessionId: "1785166389",
    fbp: "fb.1.1700000000000.1234567890",
  });

  // The checkout re-sends identifiers because consent may have been granted
  // after the search. A later request must merge on top, never blank what was
  // already captured — `fbc` arrives now, `fbp` must survive from the search.
  const hold = await handler(
    holdEvent({
      quoteId: searchBody.quoteId,
      bookingSessionId: searchBody.bookingSessionId,
      propertyId: searchBody.properties[0].propertyId,
      paymentMethod: "paypal",
      guest: {
        firstName: "Ada",
        lastName: "Lovelace",
        email: "ada@example.com",
        phone: "+50600000000",
        country: "CR",
      },
      portalPassword: "correct horse battery",
      termsAccepted: true,
      marketingConsent: true,
      tracking: { fbc: "fb.1.1700000000000.abc123" },
    })
  );
  expect(hold.statusCode).toBe(200);

  const afterHold = await bookingSessions.getById(searchBody.bookingSessionId);
  expect(afterHold?.tracking).toEqual({
    gaClientId: "686566830.1785166389",
    gaSessionId: "1785166389",
    fbp: "fb.1.1700000000000.1234567890",
    fbc: "fb.1.1700000000000.abc123",
  });
});
