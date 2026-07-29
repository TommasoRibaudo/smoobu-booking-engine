/**
 * C23 — Concurrency test: simultaneous hold creation for the same property
 *
 * Fires two POST /api/holds requests for the same property and dates using
 * Promise.all to verify that only one succeeds and the other receives 409
 * property_no_longer_available.
 *
 * The in-memory repository enforces this via an overlap scan on insertion,
 * mirroring the behaviour of the RDS exclusion constraint
 * (holds_no_overlapping_active_inventory). The RDS constraint path is
 * exercised separately in holds.test.ts via the mapHoldInsertError tests.
 */

import { createBookingApiHandler } from "./app";
import { InMemoryBookingSessionRepository } from "./bookingSessions";
import { InMemoryHoldRepository } from "./holds";
import { InMemoryPaymentRepository } from "./payments";
import { StaticSecretProvider } from "./secrets";
import { BookingApiConfig, LambdaHttpRequest } from "./types";

// ── test config ───────────────────────────────────────────────────────────────

let bookingSessions: InMemoryBookingSessionRepository;
let holds: InMemoryHoldRepository;

const originalFetch = global.fetch;

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
      portalSessionSecret: "portal-session-secret-value",
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
      orderReturnUrl: "",
      orderCancelUrl: "",
    },
    bookingSessions,
    holds,
    payments: new InMemoryPaymentRepository(),
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

function happySmoobuFetch(): jest.Mock {
  return jest.fn(async (url: string | URL) => {
    const { pathname } = new URL(url.toString());
    const body =
      pathname === "/booking/checkApartmentAvailability"
        ? { availableApartments: [100001], prices: { "100001": { price: 510, currency: "USD" } }, errorMessages: {} }
        : { id: 9900099 };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
}

function searchEvent(deviceId: string): LambdaHttpRequest {
  return {
    version: "2.0",
    rawPath: "/api/search",
    headers: {
      "content-type": "application/json",
      origin: "https://booking.test",
      "x-booking-device-id": deviceId,
    },
    body: JSON.stringify({ arrivalDate: "2099-09-01", departureDate: "2099-09-05", guests: 2, language: "en", source: "booking_page" }),
    requestContext: { http: { method: "POST", path: "/api/search", sourceIp: "203.0.113.10" } },
  };
}

function holdEvent(body: unknown, idempotencyKey: string, ip: string): LambdaHttpRequest {
  return {
    version: "2.0",
    rawPath: "/api/holds",
    headers: {
      "content-type": "application/json",
      "idempotency-key": idempotencyKey,
      origin: "https://booking.test",
      "x-booking-device-id": idempotencyKey,
    },
    body: JSON.stringify(body),
    requestContext: { http: { method: "POST", path: "/api/holds", sourceIp: ip } },
  };
}

// ── setup / teardown ──────────────────────────────────────────────────────────

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date("2026-06-01T10:00:00Z"));
});

afterEach(() => {
  jest.useRealTimers();
  global.fetch = originalFetch;
  jest.restoreAllMocks();
});

// ── concurrency tests ─────────────────────────────────────────────────────────

test("simultaneous holds for the same property and dates: exactly one succeeds and one gets 409", async () => {
  global.fetch = happySmoobuFetch() as typeof fetch;
  const config = createTestConfig();
  const handler = createBookingApiHandler(config);

  // User A and User B search independently and both see the property as available
  const [searchA, searchB] = await Promise.all([
    handler(searchEvent("device-concurrent-A")),
    handler(searchEvent("device-concurrent-B")),
  ]);
  expect(searchA.statusCode).toBe(200);
  expect(searchB.statusCode).toBe(200);

  const bodyA = JSON.parse(searchA.body);
  const bodyB = JSON.parse(searchB.body);
  const propertyId = bodyA.properties[0].propertyId;
  // Both quotes target the same property
  expect(bodyB.properties[0].propertyId).toBe(propertyId);

  const holdRequestA = {
    quoteId: bodyA.quoteId,
    bookingSessionId: bodyA.bookingSessionId,
    propertyId,
    paymentMethod: "paypal",
    guest: { firstName: "Alice", lastName: "A", email: "alice@example.com" },
    portalPassword: "alice-secure-password",
    termsAccepted: true,
  };
  const holdRequestB = {
    quoteId: bodyB.quoteId,
    bookingSessionId: bodyB.bookingSessionId,
    propertyId,
    paymentMethod: "paypal",
    guest: { firstName: "Bob", lastName: "B", email: "bob@example.com" },
    portalPassword: "bob-secure-password",
    termsAccepted: true,
  };

  // Fire both hold requests simultaneously
  const [respA, respB] = await Promise.all([
    handler(holdEvent(holdRequestA, "concurrent-idem-A-0001", "203.0.113.11")),
    handler(holdEvent(holdRequestB, "concurrent-idem-B-0001", "203.0.113.12")),
  ]);

  const statuses = [respA.statusCode, respB.statusCode].sort((a, b) => a - b);

  // Exactly one must succeed and exactly one must be rejected
  expect(statuses).toEqual([200, 409]);

  // The 409 response must carry the property_no_longer_available code
  const failed = respA.statusCode === 409 ? respA : respB;
  expect(JSON.parse(failed.body).error.code).toBe("property_no_longer_available");

  // Only one Smoobu reservation should have been created
  const smoobuReservationCalls = (global.fetch as jest.Mock).mock.calls.filter(
    ([url]) => new URL(url.toString()).pathname === "/api/reservations"
  );
  expect(smoobuReservationCalls).toHaveLength(1);

  // The hold store should contain exactly one active hold for the property
  const successResp = respA.statusCode === 200 ? respA : respB;
  const { booking } = JSON.parse(successResp.body);
  const storedHold = await holds.getByBookingSessionId(booking.bookingSessionId);
  expect(storedHold?.status).toBe("active");
  expect(storedHold?.propertyId).toBe(propertyId);
});

test("simultaneous holds for non-overlapping dates both succeed", async () => {
  global.fetch = jest.fn(async (url: string | URL) => {
    const { pathname } = new URL(url.toString());
    const id = pathname === "/api/reservations" ? (pathname.includes("A") ? 9900101 : 9900102) : undefined;
    const body =
      pathname === "/booking/checkApartmentAvailability"
        ? { availableApartments: [100001], prices: { "100001": { price: 510, currency: "USD" } }, errorMessages: {} }
        : { id: id ?? 9900103 };
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;

  const config = createTestConfig();
  const handler = createBookingApiHandler(config);

  // User A searches for Aug 1–5, User B for Aug 10–14 (no overlap)
  const searchAResp = await handler({
    version: "2.0",
    rawPath: "/api/search",
    headers: { "content-type": "application/json", origin: "https://booking.test", "x-booking-device-id": "dev-nonoverlap-A" },
    body: JSON.stringify({ arrivalDate: "2099-08-01", departureDate: "2099-08-05", guests: 2, language: "en", source: "booking_page" }),
    requestContext: { http: { method: "POST", path: "/api/search", sourceIp: "203.0.113.20" } },
  });
  const searchBResp = await handler({
    version: "2.0",
    rawPath: "/api/search",
    headers: { "content-type": "application/json", origin: "https://booking.test", "x-booking-device-id": "dev-nonoverlap-B" },
    body: JSON.stringify({ arrivalDate: "2099-08-10", departureDate: "2099-08-14", guests: 2, language: "en", source: "booking_page" }),
    requestContext: { http: { method: "POST", path: "/api/search", sourceIp: "203.0.113.21" } },
  });

  const bA = JSON.parse(searchAResp.body);
  const bB = JSON.parse(searchBResp.body);

  const [holdA, holdB] = await Promise.all([
    handler(holdEvent(
      { quoteId: bA.quoteId, bookingSessionId: bA.bookingSessionId, propertyId: bA.properties[0].propertyId,
        paymentMethod: "paypal", guest: { firstName: "Alice", lastName: "A", email: "alice@example.com" },
        portalPassword: "alice-secure-passphrase", termsAccepted: true },
      "nonoverlap-idem-A-0001",
      "203.0.113.20"
    )),
    handler(holdEvent(
      { quoteId: bB.quoteId, bookingSessionId: bB.bookingSessionId, propertyId: bB.properties[0].propertyId,
        paymentMethod: "paypal", guest: { firstName: "Bob", lastName: "B", email: "bob@example.com" },
        portalPassword: "bob-secure-passphrase", termsAccepted: true },
      "nonoverlap-idem-B-0001",
      "203.0.113.21"
    )),
  ]);

  expect(holdA.statusCode).toBe(200);
  expect(holdB.statusCode).toBe(200);
});

test("RDS overlap constraint error (23P01) is mapped to 409 property_no_longer_available", async () => {
  const { RdsHoldRepository } = await import("./holds");

  const query = jest.fn(async () => {
    throw { code: "23P01", constraint: "holds_no_overlapping_active_inventory" };
  });
  const repo = new RdsHoldRepository({ query } as unknown as ConstructorParameters<typeof RdsHoldRepository>[0]);

  await expect(
    repo.createCreatingHold({
      bookingSessionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      propertyId: "11111111-0000-4000-8000-000000000001",
      arrivalDate: "2099-09-01",
      departureDate: "2099-09-05",
      expiresAt: "2026-06-01T11:00:00.000Z",
      smoobuChannelId: 11,
      smoobuCreatePayloadHash: "hash-concurrent",
    })
  ).rejects.toMatchObject({
    statusCode: 409,
    code: "property_no_longer_available",
    retryable: false,
  });
});
