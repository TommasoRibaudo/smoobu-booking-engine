/**
 * POST /api/portal/reservation/:reservationPublicId/cancel
 *
 * Guest self-service cancellation. The rules under test:
 *   - flexible + more than 24h before check-in  -> cancels for real
 *   - non-refundable                            -> refused outright
 *   - inside the 24h window                     -> refused, contact staff
 *   - a Smoobu failure                          -> 502 with no local mutation
 *   - a Smoobu 404 (already gone)               -> treated as success
 *   - repeat submits                            -> idempotent
 */

import { createBookingApiHandler } from "./app";
import { InMemoryBookingSessionRepository, type BookingRatePlan } from "./bookingSessions";
import { InMemoryHoldRepository } from "./holds";
import { InMemoryPaymentRepository } from "./payments";
import { StaticSecretProvider } from "./secrets";
import { issuePortalSessionToken } from "./portalSessions";
import { BookingApiConfig, LambdaHttpRequest } from "./types";

const PORTAL_SECRET = "portal-session-secret-for-cancel-tests";
const PROPERTY_ID = "11111111-0000-4000-8000-000000000001"; // Sunset Villa
const SMOOBU_RESERVATION_ID = 7_700_001;

// Check-in is 15:00 Costa Rica = 21:00 UTC, so the deadline for a 2026-07-01
// arrival is 2026-06-30T21:00Z. "Now" sits comfortably before it.
const ARRIVAL_DATE = "2026-07-01";
const DEPARTURE_DATE = "2026-07-05";
const WELL_BEFORE_DEADLINE = new Date("2026-06-20T12:00:00Z");
const INSIDE_24H_WINDOW = new Date("2026-06-30T22:00:00Z");

let bookingSessions: InMemoryBookingSessionRepository;
let holds: InMemoryHoldRepository;
let payments: InMemoryPaymentRepository;
let config: BookingApiConfig;
let handler: ReturnType<typeof createBookingApiHandler>;

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
    hold: { defaultTtlMinutes: 60, idempotencyTtlMinutes: 1440, staleIdempotencyLockSeconds: 120 },
    abuseProtection: { enabled: false, captchaChallengesEnabled: false, maxTrackedBuckets: 100 },
    email: { fromAddress: "test@example.com", region: "us-east-1", disabled: true, staffNotificationEmail: "staff@booking.test" },
    observability: { serviceName: "booking-api", environment: "test", logLevel: "silent", metricsEnabled: false },
  };
}

async function hashPassword(password: string): Promise<string> {
  const { scrypt: scryptCallback, randomUUID } = await import("crypto");
  const salt = randomUUID().replace(/-/g, "");
  const derived = await new Promise<Buffer>((resolve, reject) => {
    scryptCallback(password, salt, 64, { N: 16384, r: 8, p: 1 }, (err, key) => {
      if (err) reject(err);
      else resolve(key);
    });
  });
  return `scryptN16384r8p1${salt}${derived.toString("base64")}`;
}

/** Drives the real state machine to a confirmed, captured booking with a converted hold. */
async function seedConfirmedBooking(
  options: { ratePlan?: BookingRatePlan; captured?: boolean } = {}
): Promise<{ reservationPublicId: string; bookingSessionId: string }> {
  const ratePlan = options.ratePlan ?? "flexible";
  const captured = options.captured ?? true;
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();

  const session = await bookingSessions.createQuotedSession({
    arrivalDate: ARRIVAL_DATE,
    departureDate: DEPARTURE_DATE,
    guests: 2,
    language: "en",
  });

  await bookingSessions.markHoldCreating({
    bookingSessionId: session.id,
    propertyId: PROPERTY_ID,
    paymentMethod: "paypal",
    ratePlan,
    price: {
      propertyId: PROPERTY_ID,
      currency: "USD",
      totalAmountCents: 50000,
      nightlyAverageCents: 12500,
      nights: 4,
      includesTaxes: false,
      rateSource: "smoobu",
    },
    guest: { firstName: "Ana", lastName: "García", email: "ana@example.com" },
    portalPasswordHash: await hashPassword("test-password-123"),
    expiresAt,
  });
  await bookingSessions.markHoldActive({ bookingSessionId: session.id, expiresAt });
  await bookingSessions.markPaypalOrderCreated({ bookingSessionId: session.id, paypalOrderId: "PAYPAL-ORDER-TEST" });
  await bookingSessions.markBookingConfirmed({ bookingSessionId: session.id, confirmedAt: new Date().toISOString() });

  const hold = await holds.createCreatingHold({
    bookingSessionId: session.id,
    propertyId: PROPERTY_ID,
    arrivalDate: ARRIVAL_DATE,
    departureDate: DEPARTURE_DATE,
    expiresAt,
    smoobuChannelId: 11,
    smoobuCreatePayloadHash: "test-payload-hash",
  });
  await holds.activateHold({ holdId: hold.id, smoobuReservationId: SMOOBU_RESERVATION_ID });
  // Mirrors post-payment promotion: the live reservation is the channel-70 one.
  await holds.convertHold({
    holdId: hold.id,
    newSmoobuReservationId: SMOOBU_RESERVATION_ID + 1,
    newSmoobuChannelId: 70,
  });

  await payments.createOrderPayment({
    bookingSessionId: session.id,
    paypalOrderId: "PAYPAL-ORDER-TEST",
    paypalRequestIdOrder: "req-order-123",
    paypalRequestIdCapture: "req-capture-123",
    currency: "USD",
    totalAmountCents: 50000,
  });
  if (captured) {
    await payments.markCaptured({
      bookingSessionId: session.id,
      paypalCaptureId: "PAYPAL-CAPTURE-TEST",
      capturedAt: new Date().toISOString(),
    });
  }

  return { reservationPublicId: session.reservationPublicId, bookingSessionId: session.id };
}

function cancelRequest(reservationPublicId: string, token?: string, idempotencyKey = "cancel-key-0000000001"): LambdaHttpRequest {
  return {
    version: "2.0",
    rawPath: `/api/portal/reservation/${reservationPublicId}/cancel`,
    headers: {
      "content-type": "application/json",
      origin: "https://booking.test",
      "idempotency-key": idempotencyKey,
      ...(token ? { authorization: token } : {}),
    },
    body: JSON.stringify({ reason: "change_of_plans", message: "Something came up" }),
    requestContext: {
      http: {
        method: "POST",
        path: `/api/portal/reservation/${reservationPublicId}/cancel`,
        sourceIp: "203.0.113.5",
      },
    },
  };
}

function bearerToken(reservationPublicId: string): string {
  return `Bearer ${issuePortalSessionToken(reservationPublicId, PORTAL_SECRET)}`;
}

/** Stubs Smoobu's DELETE /api/reservations/:id with the given status. */
function stubSmoobuCancel(status: number): jest.Mock {
  const fetchMock = jest.fn(async () =>
    new Response(status === 200 ? JSON.stringify({ id: SMOOBU_RESERVATION_ID + 1 }) : JSON.stringify({ title: "error" }), {
      status,
      headers: { "content-type": "application/json" },
    })
  );
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

const originalFetch = global.fetch;

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(WELL_BEFORE_DEADLINE);
  config = createTestConfig();
  handler = createBookingApiHandler(config);
});

afterEach(() => {
  jest.useRealTimers();
  global.fetch = originalFetch;
  jest.restoreAllMocks();
});

// ── happy path ───────────────────────────────────────────────────────────────

it("cancels a flexible booking, releases the dates and flags the payment for refund", async () => {
  const { reservationPublicId, bookingSessionId } = await seedConfirmedBooking();
  const fetchMock = stubSmoobuCancel(200);

  const response = await handler(cancelRequest(reservationPublicId, bearerToken(reservationPublicId)));

  expect(response.statusCode).toBe(200);
  const body = JSON.parse(response.body);
  expect(body.status).toBe("cancelled");
  expect(body.reservation.status).toBe("cancelled");
  expect(body.reservation.cancellationReason).toBe("change_of_plans");
  expect(body.hold.status).toBe("cancelled");
  expect(body.payment.status).toBe("refund_flagged");
  expect(body.refund).toEqual({ status: "manual_review", paypalCaptureId: "PAYPAL-CAPTURE-TEST" });

  // Cancellation must target the promoted channel-70 reservation, not the
  // original blocked-channel one that promotion already deleted.
  const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
  expect(url).toContain(`/api/reservations/${SMOOBU_RESERVATION_ID + 1}`);
  expect(init.method).toBe("DELETE");

  const stored = await bookingSessions.getById(bookingSessionId);
  expect(stored?.status).toBe("cancelled");
  expect(stored?.cancelledBy).toBe("guest");
  expect(stored?.cancelledAt).toBeDefined();
});

it("reports no refund when the payment was never captured", async () => {
  const { reservationPublicId } = await seedConfirmedBooking({ captured: false });
  stubSmoobuCancel(200);

  const response = await handler(cancelRequest(reservationPublicId, bearerToken(reservationPublicId)));

  expect(response.statusCode).toBe(200);
  const body = JSON.parse(response.body);
  expect(body.reservation.status).toBe("cancelled");
  expect(body.refund).toEqual({ status: "not_applicable" });
});

// ── policy refusals ──────────────────────────────────────────────────────────

it("refuses to cancel a non-refundable booking and leaves it untouched", async () => {
  const { reservationPublicId, bookingSessionId } = await seedConfirmedBooking({ ratePlan: "non_refundable" });
  const fetchMock = stubSmoobuCancel(200);

  const response = await handler(cancelRequest(reservationPublicId, bearerToken(reservationPublicId)));

  expect(response.statusCode).toBe(403);
  expect(JSON.parse(response.body).error.code).toBe("cancellation_not_allowed");
  expect(fetchMock).not.toHaveBeenCalled();

  const stored = await bookingSessions.getById(bookingSessionId);
  expect(stored?.status).toBe("booking_confirmed");
});

it("refuses inside the 24-hour window and points the guest at staff", async () => {
  const { reservationPublicId, bookingSessionId } = await seedConfirmedBooking();
  const fetchMock = stubSmoobuCancel(200);
  jest.setSystemTime(INSIDE_24H_WINDOW);

  const response = await handler(cancelRequest(reservationPublicId, bearerToken(reservationPublicId)));

  expect(response.statusCode).toBe(403);
  expect(JSON.parse(response.body).error.code).toBe("cancellation_window_closed");
  expect(fetchMock).not.toHaveBeenCalled();

  const stored = await bookingSessions.getById(bookingSessionId);
  expect(stored?.status).toBe("booking_confirmed");
});

// ── provider failure handling ────────────────────────────────────────────────

it("returns 502 and changes nothing locally when Smoobu fails", async () => {
  const { reservationPublicId, bookingSessionId } = await seedConfirmedBooking();
  stubSmoobuCancel(500);

  const response = await handler(cancelRequest(reservationPublicId, bearerToken(reservationPublicId)));

  expect(response.statusCode).toBe(502);
  expect(JSON.parse(response.body).error.code).toBe("provider_error");

  // The guest can safely retry: nothing was half-applied.
  const stored = await bookingSessions.getById(bookingSessionId);
  expect(stored?.status).toBe("booking_confirmed");
  const hold = await holds.getByBookingSessionId(bookingSessionId);
  expect(hold?.status).toBe("converted");
  const payment = await payments.getByBookingSessionId(bookingSessionId);
  expect(payment?.status).toBe("captured");
});

it("treats a Smoobu 404 as success — the reservation is already gone", async () => {
  const { reservationPublicId, bookingSessionId } = await seedConfirmedBooking();
  stubSmoobuCancel(404);

  const response = await handler(cancelRequest(reservationPublicId, bearerToken(reservationPublicId)));

  expect(response.statusCode).toBe(200);
  const stored = await bookingSessions.getById(bookingSessionId);
  expect(stored?.status).toBe("cancelled");
});

// ── idempotency ──────────────────────────────────────────────────────────────

it("is idempotent across repeat submits with a different idempotency key", async () => {
  const { reservationPublicId } = await seedConfirmedBooking();
  const fetchMock = stubSmoobuCancel(200);
  const token = bearerToken(reservationPublicId);

  const first = await handler(cancelRequest(reservationPublicId, token, "cancel-key-0000000001"));
  const second = await handler(cancelRequest(reservationPublicId, token, "cancel-key-0000000002"));

  expect(first.statusCode).toBe(200);
  expect(second.statusCode).toBe(200);

  const secondBody = JSON.parse(second.body);
  expect(secondBody.reservation.status).toBe("cancelled");
  expect(secondBody.reservation.cancellationReason).toBe("change_of_plans");

  // Smoobu is only told once — the second pass short-circuits on already_cancelled.
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

// ── auth ─────────────────────────────────────────────────────────────────────

it("rejects an unauthenticated cancel", async () => {
  const { reservationPublicId } = await seedConfirmedBooking();
  const response = await handler(cancelRequest(reservationPublicId));
  expect(response.statusCode).toBe(401);
});

it("rejects a token issued for a different reservation", async () => {
  const { reservationPublicId } = await seedConfirmedBooking();
  const response = await handler(cancelRequest(reservationPublicId, bearerToken("KWL-OTHER123")));
  expect(response.statusCode).toBe(403);
});

// ── the portal view drives the button ────────────────────────────────────────

it("exposes matching cancellation policy on the reservation view", async () => {
  const { reservationPublicId } = await seedConfirmedBooking();
  const token = bearerToken(reservationPublicId);

  const view = await handler({
    version: "2.0",
    rawPath: `/api/portal/reservation/${reservationPublicId}`,
    headers: { origin: "https://booking.test", authorization: token },
    requestContext: {
      http: { method: "GET", path: `/api/portal/reservation/${reservationPublicId}`, sourceIp: "203.0.113.5" },
    },
  });

  const body = JSON.parse(view.body);
  expect(body.reservation.ratePlan).toBe("flexible");
  expect(body.reservation.cancellation).toEqual({
    cancellable: true,
    deadline: "2026-06-30T21:00:00.000Z",
  });
  expect(body.reservation.availableActions).toContain("cancel_booking");
});
