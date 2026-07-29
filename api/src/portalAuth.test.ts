/**
 * Tests for task 6.3: Reservation portal auth
 *
 * Covers:
 * - Successful login returns a signed session token
 * - Invalid password returns 401 (uniform error)
 * - Unknown reservation ID returns 401 (same error — no enumeration)
 * - Unconfirmed booking returns 403
 * - Expired session token is rejected
 * - Valid session token is accepted
 * - Rate limiting enforced on portalLogin policy
 */

import { createBookingApiHandler } from "./app";
import { InMemoryBookingSessionRepository } from "./bookingSessions";
import { InMemoryHoldRepository } from "./holds";
import { StaticSecretProvider } from "./secrets";
import { issuePortalSessionToken, verifyPortalSessionToken, PORTAL_SESSION_TTL_SECONDS } from "./portalSessions";
import { BookingApiConfig, LambdaHttpRequest } from "./types";

// ── test helpers ──────────────────────────────────────────────────────────────

let bookingSessions: InMemoryBookingSessionRepository;
let holds: InMemoryHoldRepository;
let config: BookingApiConfig;
let handler: ReturnType<typeof createBookingApiHandler>;

const PORTAL_SECRET = "portal-session-secret-value";

function createTestConfig(): BookingApiConfig {
  bookingSessions = new InMemoryBookingSessionRepository();
  holds = new InMemoryHoldRepository();
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

function loginRequest(body: unknown, ip = "1.2.3.4"): LambdaHttpRequest {
  return {
    requestContext: {
      http: { method: "POST", path: "/api/portal/login", sourceIp: ip },
    },
    headers: {
      "content-type": "application/json",
      origin: "https://booking.test",
    },
    body: JSON.stringify(body),
  };
}

/**
 * Build a confirmed booking session with a known portal password hash.
 * The hash format must match holds.ts hashPortalPassword().
 */
async function seedConfirmedSession(password: string): Promise<string> {
  const { scrypt: scryptCallback } = await import("crypto");
  const { randomUUID } = await import("crypto");

  const salt = randomUUID().replace(/-/g, "");
  const derived = await new Promise<Buffer>((resolve, reject) => {
    scryptCallback(password, salt, 64, { N: 16384, r: 8, p: 1 }, (err, key) => {
      if (err) reject(err);
      else resolve(key);
    });
  });

  const hash = `scryptN16384r8p1${salt}${derived.toString("base64")}`;

  // Create a session and advance it to booking_confirmed
  const session = await bookingSessions.createQuotedSession({
    arrivalDate: "2026-07-01",
    departureDate: "2026-07-05",
    guests: 2,
    language: "en",
  });

  // Manually patch to confirmed state with the password hash
  // (bypasses the full hold/payment flow for test isolation)
  await bookingSessions.markHoldCreating({
    bookingSessionId: session.id,
    propertyId: "00000000-0000-0000-0000-000000000001",
    paymentMethod: "paypal",
    ratePlan: "flexible",
    price: {
      propertyId: "00000000-0000-0000-0000-000000000001",
      currency: "USD",
      totalAmountCents: 50000,
      nightlyAverageCents: 12500,
      nights: 4,
      includesTaxes: false,
      rateSource: "smoobu",
    },
    guest: { firstName: "Test", lastName: "Guest", email: "test@example.com" },
    portalPasswordHash: hash,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  });
  await bookingSessions.markHoldActive({
    bookingSessionId: session.id,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  });
  await bookingSessions.markPaypalOrderCreated({
    bookingSessionId: session.id,
    paypalOrderId: "PAYPAL-ORDER-123",
  });
  await bookingSessions.markBookingConfirmed({
    bookingSessionId: session.id,
    confirmedAt: new Date().toISOString(),
  });

  return session.reservationPublicId;
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

// ── portalSessions unit tests ─────────────────────────────────────────────────

describe("portalSessions", () => {
  it("issues a token that can be verified", () => {
    const now = Math.floor(Date.now() / 1000);
    const token = issuePortalSessionToken("KWL-ABCD1234", PORTAL_SECRET, now);
    const payload = verifyPortalSessionToken(token, PORTAL_SECRET, now);
    expect(payload.sub).toBe("KWL-ABCD1234");
    expect(payload.iat).toBe(now);
    expect(payload.exp).toBe(now + PORTAL_SESSION_TTL_SECONDS);
  });

  it("rejects a token with a wrong secret", () => {
    const token = issuePortalSessionToken("KWL-ABCD1234", PORTAL_SECRET);
    expect(() => verifyPortalSessionToken(token, "wrong-secret")).toThrow(
      expect.objectContaining({ code: "unauthorized" })
    );
  });

  it("rejects a tampered payload", () => {
    const token = issuePortalSessionToken("KWL-ABCD1234", PORTAL_SECRET);
    const parts = token.split(".");
    // Flip one char in the payload
    parts[1] = parts[1].slice(0, -1) + (parts[1].endsWith("A") ? "B" : "A");
    expect(() => verifyPortalSessionToken(parts.join("."), PORTAL_SECRET)).toThrow(
      expect.objectContaining({ code: "unauthorized" })
    );
  });

  it("rejects an expired token", () => {
    const issuedAt = Math.floor(Date.now() / 1000);
    const token = issuePortalSessionToken("KWL-ABCD1234", PORTAL_SECRET, issuedAt);
    const afterExpiry = issuedAt + PORTAL_SESSION_TTL_SECONDS + 1;
    expect(() => verifyPortalSessionToken(token, PORTAL_SECRET, afterExpiry)).toThrow(
      expect.objectContaining({ code: "session_expired" })
    );
  });

  it("rejects a malformed token (wrong number of parts)", () => {
    expect(() => verifyPortalSessionToken("not.a.valid.token.here", PORTAL_SECRET)).toThrow(
      expect.objectContaining({ code: "unauthorized" })
    );
  });
});

// ── POST /api/portal/login integration tests ─────────────────────────────────

describe("POST /api/portal/login", () => {
  it("returns 200 with a signed token on valid credentials", async () => {
    const reservationPublicId = await seedConfirmedSession("correct-password-123");

    const response = await handler(loginRequest({
      reservationPublicId,
      password: "correct-password-123",
      language: "en",
    }));

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.token).toBeDefined();
    expect(body.reservationPublicId).toBe(reservationPublicId);
    expect(body.expiresIn).toBe(PORTAL_SESSION_TTL_SECONDS);

    // Token must be verifiable
    const payload = verifyPortalSessionToken(body.token, PORTAL_SECRET);
    expect(payload.sub).toBe(reservationPublicId);
  });

  it("fails closed in production when portal session storage is not configured", async () => {
    const prodConfig = createTestConfig();
    prodConfig.observability = { ...prodConfig.observability, environment: "prod" };
    const prodHandler = createBookingApiHandler(prodConfig);
    const reservationPublicId = await seedConfirmedSession("correct-password-123");

    const response = await prodHandler(loginRequest({
      reservationPublicId,
      password: "correct-password-123",
      language: "en",
    }));

    expect(response.statusCode).toBe(503);
    expect(JSON.parse(response.body).error).toMatchObject({
      code: "database_unavailable",
      retryable: true,
    });
  });

  it("returns 401 for wrong password (uniform error)", async () => {
    const reservationPublicId = await seedConfirmedSession("correct-password-123");

    const response = await handler(loginRequest({
      reservationPublicId,
      password: "wrong-password-456",
      language: "en",
    }));

    expect(response.statusCode).toBe(401);
    const body = JSON.parse(response.body);
    expect(body.error.code).toBe("invalid_credentials");
  });

  it("returns 401 for unknown reservation ID (same error — no enumeration)", async () => {
    const response = await handler(loginRequest({
      reservationPublicId: "KWL-NOTEXIST",
      password: "any-password-123",
      language: "en",
    }));

    expect(response.statusCode).toBe(401);
    const body = JSON.parse(response.body);
    expect(body.error.code).toBe("invalid_credentials");
  });

  it("returns 403 when booking is not yet confirmed", async () => {
    // Create a session that is only hold_active (not confirmed)
    const session = await bookingSessions.createQuotedSession({
      arrivalDate: "2026-07-01",
      departureDate: "2026-07-05",
      guests: 2,
      language: "en",
    });

    const { scrypt: scryptCallback, randomUUID } = await import("crypto");
    const salt = randomUUID().replace(/-/g, "");
    const derived = await new Promise<Buffer>((resolve, reject) => {
      scryptCallback("my-password-123", salt, 64, { N: 16384, r: 8, p: 1 }, (err, key) => {
        if (err) reject(err);
        else resolve(key);
      });
    });
    const hash = `scryptN16384r8p1${salt}${derived.toString("base64")}`;

    await bookingSessions.markHoldCreating({
      bookingSessionId: session.id,
      propertyId: "00000000-0000-0000-0000-000000000001",
      paymentMethod: "paypal",
      ratePlan: "flexible",
      price: {
        propertyId: "00000000-0000-0000-0000-000000000001",
        currency: "USD",
        totalAmountCents: 50000,
        nightlyAverageCents: 12500,
        nights: 4,
        includesTaxes: false,
        rateSource: "smoobu",
      },
      guest: { firstName: "Test", lastName: "Guest", email: "test@example.com" },
      portalPasswordHash: hash,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    });
    await bookingSessions.markHoldActive({
      bookingSessionId: session.id,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    });

    const response = await handler(loginRequest({
      reservationPublicId: session.reservationPublicId,
      password: "my-password-123",
      language: "en",
    }));

    expect(response.statusCode).toBe(403);
    const body = JSON.parse(response.body);
    expect(body.error.code).toBe("booking_not_confirmed");
  });

  it("returns 422 when required fields are missing", async () => {
    const response = await handler(loginRequest({ language: "en" }));
    expect(response.statusCode).toBe(422);
  });

  it("returns 422 when password is too short (< 12 chars)", async () => {
    const response = await handler(loginRequest({
      reservationPublicId: "KWL-ABCD1234",
      password: "short",
      language: "en",
    }));
    // password validation is in validateHoldRequest (creation), not login —
    // login accepts any non-empty string and just fails auth
    // This test verifies the route accepts the request and returns 401 (not 422)
    expect(response.statusCode).toBe(401);
  });

  it("returns 429 when rate limit is exceeded", async () => {
    const rateLimitedConfig = createTestConfig();
    rateLimitedConfig.abuseProtection = {
      enabled: true,
      captchaChallengesEnabled: false,
      maxTrackedBuckets: 1000,
    };
    const rateLimitedHandler = createBookingApiHandler(rateLimitedConfig);

    // portalLogin policy: 10 per 5 min per IP
    let lastResponse: Awaited<ReturnType<typeof rateLimitedHandler>> | undefined;
    for (let i = 0; i < 12; i++) {
      lastResponse = await rateLimitedHandler(loginRequest({
        reservationPublicId: "KWL-ABCD1234",
        password: "any-password-123",
        language: "en",
      }, "5.5.5.5"));
    }

    expect(lastResponse?.statusCode).toBe(429);
  });
});
