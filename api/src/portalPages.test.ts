/**
 * Tests for task 6.4: Portal pages
 *
 * Covers:
 * - GET /api/portal/reservation/:id — returns full reservation details
 * - GET /api/portal/reservation/:id — 401 without token
 * - GET /api/portal/reservation/:id — 403 when token sub ≠ path param
 * - GET /api/portal/reservation/:id — 404 for unknown reservation
 * - POST /api/portal/reservation/:id/help-request — 200 with EN/ES strings
 * - POST /api/portal/reservation/:id/help-request — 401 without token
 * - POST /api/portal/reservation/:id/cancellation-request — 200 for confirmed booking
 * - POST /api/portal/reservation/:id/cancellation-request — 409 for non-confirmed booking
 * - POST /api/portal/reservation/:id/cancellation-request — 401 without token
 */

import { createBookingApiHandler } from "./app";
import { InMemoryBookingSessionRepository } from "./bookingSessions";
import { InMemoryHoldRepository } from "./holds";
import { InMemoryPaymentRepository } from "./payments";
import { StaticSecretProvider } from "./secrets";
import { InMemoryPortalSessionRepository, issuePortalSessionToken } from "./portalSessions";
import { BookingApiConfig, LambdaHttpRequest } from "./types";

// ── test helpers ──────────────────────────────────────────────────────────────

let bookingSessions: InMemoryBookingSessionRepository;
let holds: InMemoryHoldRepository;
let payments: InMemoryPaymentRepository;
let config: BookingApiConfig;
let handler: ReturnType<typeof createBookingApiHandler>;

const PORTAL_SECRET = "portal-session-secret-for-6-4-tests";

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
      portalSessionSecret: PORTAL_SECRET,
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

/** Seed a confirmed booking session and return its reservationPublicId. */
async function seedConfirmedSession(language: "en" | "es" = "en"): Promise<string> {
  const { scrypt: scryptCallback, randomUUID } = await import("crypto");
  const salt = randomUUID().replace(/-/g, "");
  const derived = await new Promise<Buffer>((resolve, reject) => {
    scryptCallback("test-password-123", salt, 64, { N: 16384, r: 8, p: 1 }, (err, key) => {
      if (err) reject(err);
      else resolve(key);
    });
  });
  const hash = `scryptN16384r8p1${salt}${derived.toString("base64")}`;

  const session = await bookingSessions.createQuotedSession({
    arrivalDate: "2026-07-01",
    departureDate: "2026-07-05",
    guests: 2,
    language,
  });

  await bookingSessions.markHoldCreating({
    bookingSessionId: session.id,
    propertyId: "11111111-0000-4000-8000-000000000001", // Sunset Villa
    paymentMethod: "paypal",
    ratePlan: "flexible",
    price: {
      propertyId: "11111111-0000-4000-8000-000000000001",
      currency: "USD",
      totalAmountCents: 50000,
      nightlyAverageCents: 12500,
      nights: 4,
      includesTaxes: false,
      rateSource: "smoobu",
    },
    guest: { firstName: "Ana", lastName: "García", email: "ana@example.com" },
    portalPasswordHash: hash,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  });
  await bookingSessions.markHoldActive({
    bookingSessionId: session.id,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  });
  await bookingSessions.markPaypalOrderCreated({
    bookingSessionId: session.id,
    paypalOrderId: "PAYPAL-ORDER-TEST",
  });
  await bookingSessions.markBookingConfirmed({
    bookingSessionId: session.id,
    confirmedAt: new Date().toISOString(),
  });

  // Seed a payment record
  await payments.createOrderPayment({
    bookingSessionId: session.id,
    paypalOrderId: "PAYPAL-ORDER-TEST",
    paypalRequestIdOrder: "req-order-123",
    paypalRequestIdCapture: "req-capture-123",
    currency: "USD",
    totalAmountCents: 50000,
  });
  await payments.markCaptured({
    bookingSessionId: session.id,
    paypalCaptureId: "PAYPAL-CAPTURE-TEST",
    capturedAt: new Date().toISOString(),
  });

  return session.reservationPublicId;
}

/** Seed a hold-active (not yet confirmed) session. */
async function seedHoldActiveSession(): Promise<string> {
  const { scrypt: scryptCallback, randomUUID } = await import("crypto");
  const salt = randomUUID().replace(/-/g, "");
  const derived = await new Promise<Buffer>((resolve, reject) => {
    scryptCallback("test-password-123", salt, 64, { N: 16384, r: 8, p: 1 }, (err, key) => {
      if (err) reject(err);
      else resolve(key);
    });
  });
  const hash = `scryptN16384r8p1${salt}${derived.toString("base64")}`;

  const session = await bookingSessions.createQuotedSession({
    arrivalDate: "2026-08-01",
    departureDate: "2026-08-05",
    guests: 2,
    language: "en",
  });

  await bookingSessions.markHoldCreating({
    bookingSessionId: session.id,
    propertyId: "11111111-0000-4000-8000-000000000001",
    paymentMethod: "paypal",
    ratePlan: "flexible",
    price: {
      propertyId: "11111111-0000-4000-8000-000000000001",
      currency: "USD",
      totalAmountCents: 50000,
      nightlyAverageCents: 12500,
      nights: 4,
      includesTaxes: false,
      rateSource: "smoobu",
    },
    guest: { firstName: "Bob", lastName: "Smith", email: "bob@example.com" },
    portalPasswordHash: hash,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  });
  await bookingSessions.markHoldActive({
    bookingSessionId: session.id,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  });

  return session.reservationPublicId;
}

function bearerToken(reservationPublicId: string): string {
  return `Bearer ${issuePortalSessionToken(reservationPublicId, PORTAL_SECRET)}`;
}

function getReservationRequest(reservationPublicId: string, token?: string): LambdaHttpRequest {
  return {
    requestContext: {
      http: {
        method: "GET",
        path: `/api/portal/reservation/${reservationPublicId}`,
        sourceIp: "1.2.3.4",
      },
    },
    headers: {
      origin: "https://booking.test",
      ...(token ? { authorization: token } : {}),
    },
  };
}

function helpRequest(
  reservationPublicId: string,
  body: unknown,
  token?: string
): LambdaHttpRequest {
  return {
    requestContext: {
      http: {
        method: "POST",
        path: `/api/portal/reservation/${reservationPublicId}/help-request`,
        sourceIp: "1.2.3.4",
      },
    },
    headers: {
      "content-type": "application/json",
      origin: "https://booking.test",
      "idempotency-key": "idem-help-request-001",
      ...(token ? { authorization: token } : {}),
    },
    body: JSON.stringify(body),
  };
}

function cancellationRequest(
  reservationPublicId: string,
  body: unknown,
  token?: string
): LambdaHttpRequest {
  return {
    requestContext: {
      http: {
        method: "POST",
        path: `/api/portal/reservation/${reservationPublicId}/cancellation-request`,
        sourceIp: "1.2.3.4",
      },
    },
    headers: {
      "content-type": "application/json",
      origin: "https://booking.test",
      "idempotency-key": "idem-cancel-request-001",
      ...(token ? { authorization: token } : {}),
    },
    body: JSON.stringify(body),
  };
}

// ── setup ─────────────────────────────────────────────────────────────────────

const originalFetch = global.fetch;

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date("2026-04-15T18:00:00Z"));
  config = createTestConfig();
  handler = createBookingApiHandler(config);
});

afterEach(() => {
  jest.useRealTimers();
  global.fetch = originalFetch;
  jest.restoreAllMocks();
});

// ── GET /api/portal/reservation/:id ──────────────────────────────────────────

describe("GET /api/portal/reservation/:reservationPublicId", () => {
  it("returns 200 with full reservation details for a confirmed booking", async () => {
    const reservationPublicId = await seedConfirmedSession("en");
    const token = bearerToken(reservationPublicId);

    const response = await handler(getReservationRequest(reservationPublicId, token));

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);

    expect(body.reservation.reservationPublicId).toBe(reservationPublicId);
    expect(body.reservation.status).toBe("booking_confirmed");
    expect(body.reservation.arrivalDate).toBe("2026-07-01");
    expect(body.reservation.departureDate).toBe("2026-07-05");
    expect(body.reservation.guests).toBe(2);
    expect(body.reservation.language).toBe("en");
    expect(body.reservation.confirmedAt).toBeDefined();

    // Property details
    expect(body.reservation.property.name).toBe("Sunset Villa");
    expect(body.reservation.property.slug).toBe("SunsetVilla");
    expect(body.reservation.property.listingUrl).toBe("/SunsetVilla");

    // Price
    expect(body.reservation.price.currency).toBe("USD");
    expect(body.reservation.price.totalAmountCents).toBe(50000);

    // Guest (first name + last name + email only)
    expect(body.reservation.guest.firstName).toBe("Ana");
    expect(body.reservation.guest.email).toBe("ana@example.com");

    // Payment
    expect(body.payment.status).toBe("captured");
    expect(body.payment.paypalOrderId).toBe("PAYPAL-ORDER-TEST");
    expect(body.payment.capturedAt).toBeDefined();
  });

  it("rejects a validly signed token when persisted portal session storage has no active record", async () => {
    const reservationPublicId = await seedConfirmedSession("en");
    config.portalSessions = new InMemoryPortalSessionRepository();
    const strictHandler = createBookingApiHandler(config);
    const token = bearerToken(reservationPublicId);

    const response = await strictHandler(getReservationRequest(reservationPublicId, token));

    expect(response.statusCode).toBe(401);
    expect(JSON.parse(response.body).error.code).toBe("unauthorized");
  });

  it("fails closed in production when portal session storage is not configured", async () => {
    const prodConfig = createTestConfig();
    prodConfig.observability = { ...prodConfig.observability, environment: "prod" };
    const prodHandler = createBookingApiHandler(prodConfig);
    const reservationPublicId = await seedConfirmedSession("en");
    const token = bearerToken(reservationPublicId);

    const response = await prodHandler(getReservationRequest(reservationPublicId, token));

    expect(response.statusCode).toBe(503);
    expect(JSON.parse(response.body).error).toMatchObject({
      code: "database_unavailable",
      retryable: true,
    });
  });

  it("returns Spanish listing URL when language is es", async () => {
    const reservationPublicId = await seedConfirmedSession("es");
    const token = bearerToken(reservationPublicId);

    const response = await handler(getReservationRequest(reservationPublicId, token));

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.reservation.property.listingUrl).toBe("/SunsetVillaES");
  });

  it("returns 401 when no Authorization header is provided", async () => {
    const reservationPublicId = await seedConfirmedSession();

    const response = await handler(getReservationRequest(reservationPublicId));

    expect(response.statusCode).toBe(401);
    const body = JSON.parse(response.body);
    expect(body.error.code).toBe("unauthorized");
  });

  it("returns 403 when token sub does not match path param", async () => {
    const reservationPublicId = await seedConfirmedSession();
    // Issue a token for a different reservation
    const wrongToken = bearerToken("KWL-WRONGID1");

    const response = await handler(getReservationRequest(reservationPublicId, wrongToken));

    expect(response.statusCode).toBe(403);
    const body = JSON.parse(response.body);
    expect(body.error.code).toBe("forbidden");
  });

  it("returns 404 when reservation does not exist", async () => {
    // Token for a reservation that was never created
    const fakeId = "KWL-FAKEID12";
    const token = bearerToken(fakeId);

    const response = await handler(getReservationRequest(fakeId, token));

    expect(response.statusCode).toBe(404);
    const body = JSON.parse(response.body);
    expect(body.error.code).toBe("not_found");
  });

  it("returns 401 for an expired token", async () => {
    const reservationPublicId = await seedConfirmedSession();
    // Issue a token that expired 1 second ago
    const expiredToken = `Bearer ${issuePortalSessionToken(
      reservationPublicId,
      PORTAL_SECRET,
      Math.floor(Date.now() / 1000) - 24 * 60 * 60 - 1
    )}`;

    const response = await handler(getReservationRequest(reservationPublicId, expiredToken));

    expect(response.statusCode).toBe(401);
    const body = JSON.parse(response.body);
    expect(body.error.code).toBe("session_expired");
  });

  it("initializes missing hold storage from RDS and returns 503 when the database is unavailable", async () => {
    const reservationPublicId = await seedConfirmedSession();
    const token = bearerToken(reservationPublicId);

    // Remove holds from config to exercise lazy RDS repository initialization.
    const brokenConfig: BookingApiConfig = { ...config, holds: undefined };
    const brokenHandler = createBookingApiHandler(brokenConfig);

    const response = await brokenHandler(getReservationRequest(reservationPublicId, token));

    expect(response.statusCode).toBe(503);
    const body = JSON.parse(response.body);
    expect(body.error.code).toBe("database_health_check_failed");
  });

  it("initializes missing payment storage from RDS and returns 503 when the database is unavailable", async () => {
    const reservationPublicId = await seedConfirmedSession();
    const token = bearerToken(reservationPublicId);

    const brokenConfig: BookingApiConfig = { ...config, payments: undefined };
    const brokenHandler = createBookingApiHandler(brokenConfig);

    const response = await brokenHandler(getReservationRequest(reservationPublicId, token));

    expect(response.statusCode).toBe(503);
    const body = JSON.parse(response.body);
    expect(body.error.code).toBe("database_health_check_failed");
  });
});

// ── POST /api/portal/reservation/:id/help-request ────────────────────────────

describe("POST /api/portal/reservation/:reservationPublicId/help-request", () => {
  it("returns 200 with English acknowledgement message", async () => {
    const reservationPublicId = await seedConfirmedSession("en");
    const token = bearerToken(reservationPublicId);

    const response = await handler(
      helpRequest(
        reservationPublicId,
        { message: "I need help with my booking." },
        token
      )
    );

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.status).toBe("received");
    expect(body.message).toContain("team");
  });

  it("returns 200 with Spanish acknowledgement message", async () => {
    const reservationPublicId = await seedConfirmedSession("es");
    const token = bearerToken(reservationPublicId);

    const response = await handler(
      helpRequest(
        reservationPublicId,
        { message: "Necesito ayuda con mi reserva." },
        token
      )
    );

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.status).toBe("received");
    expect(body.message).toContain("equipo");
  });

  it("returns 401 without Authorization header", async () => {
    const reservationPublicId = await seedConfirmedSession();

    const response = await handler(
      helpRequest(reservationPublicId, { message: "Help me." })
    );

    expect(response.statusCode).toBe(401);
  });

  it("returns 403 when token sub does not match path param", async () => {
    const reservationPublicId = await seedConfirmedSession();
    const wrongToken = bearerToken("KWL-WRONGID2");

    const response = await handler(
      helpRequest(reservationPublicId, { message: "Help me." }, wrongToken)
    );

    expect(response.statusCode).toBe(403);
  });

  it("returns 422 when message is missing", async () => {
    const reservationPublicId = await seedConfirmedSession();
    const token = bearerToken(reservationPublicId);

    const response = await handler(
      helpRequest(reservationPublicId, { type: "general" }, token)
    );

    expect(response.statusCode).toBe(422);
  });
});

// ── POST /api/portal/reservation/:id/cancellation-request ────────────────────

describe("POST /api/portal/reservation/:reservationPublicId/cancellation-request", () => {
  it("returns 200 with English acknowledgement for a confirmed booking", async () => {
    const reservationPublicId = await seedConfirmedSession("en");
    const token = bearerToken(reservationPublicId);

    const response = await handler(
      cancellationRequest(
        reservationPublicId,
        { reason: "Change of plans", message: "Please cancel my booking." },
        token
      )
    );

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.status).toBe("received");
    expect(body.message).toContain("cancellation");
  });

  it("returns 200 with Spanish acknowledgement for a confirmed booking", async () => {
    const reservationPublicId = await seedConfirmedSession("es");
    const token = bearerToken(reservationPublicId);

    const response = await handler(
      cancellationRequest(
        reservationPublicId,
        { reason: "Cambio de planes" },
        token
      )
    );

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.status).toBe("received");
    expect(body.message).toContain("cancelación");
  });

  it("returns 409 when booking is not yet confirmed (hold_active)", async () => {
    const reservationPublicId = await seedHoldActiveSession();
    const token = bearerToken(reservationPublicId);

    const response = await handler(
      cancellationRequest(
        reservationPublicId,
        { reason: "Changed my mind" },
        token
      )
    );

    expect(response.statusCode).toBe(409);
    const body = JSON.parse(response.body);
    expect(body.error.code).toBe("invalid_booking_state");
  });

  it("returns 401 without Authorization header", async () => {
    const reservationPublicId = await seedConfirmedSession();

    const response = await handler(
      cancellationRequest(reservationPublicId, { reason: "Cancel please." })
    );

    expect(response.statusCode).toBe(401);
  });

  it("returns 403 when token sub does not match path param", async () => {
    const reservationPublicId = await seedConfirmedSession();
    const wrongToken = bearerToken("KWL-WRONGID3");

    const response = await handler(
      cancellationRequest(
        reservationPublicId,
        { reason: "Cancel please." },
        wrongToken
      )
    );

    expect(response.statusCode).toBe(403);
  });

  it("returns 422 when reason is missing", async () => {
    const reservationPublicId = await seedConfirmedSession();
    const token = bearerToken(reservationPublicId);

    const response = await handler(
      cancellationRequest(reservationPublicId, { message: "No reason given" }, token)
    );

    expect(response.statusCode).toBe(422);
  });
});
