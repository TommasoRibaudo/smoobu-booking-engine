import { BookingSessionRecord } from "./bookingSessions";
import { InMemoryHoldRepository } from "./holds";
import { promoteSmoobuReservation } from "./smoobuPromotion";
import { StaticSecretProvider } from "./secrets";
import { BookingApiConfig, RouteObservability } from "./types";

const SUNSET_PROPERTY_ID = "11111111-0000-4000-8000-000000000001";
const SUNSET_APARTMENT_ID = 100001;
const PALM_PROPERTY_ID = "11111111-0000-4000-8000-000000000002";
const PALM_APARTMENT_ID = 100002;
const OCEAN_PROPERTY_ID = "11111111-0000-4000-8000-000000000003";
const OLD_RESERVATION_ID = 555001;
const REBLOCK_RESERVATION_ID = 555999;
const NEW_WEBSITE_RESERVATION_ID = 556100;

const originalFetch = global.fetch;

function createConfig(): BookingApiConfig {
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
    paypal: { baseUrl: "https://api-m.sandbox.paypal.com", timeoutMs: 10_000, orderReturnUrl: "", orderCancelUrl: "" },
    hold: { defaultTtlMinutes: 60, idempotencyTtlMinutes: 1440, staleIdempotencyLockSeconds: 120 },
    abuseProtection: { enabled: false, captchaChallengesEnabled: false, maxTrackedBuckets: 100 },
    email: { fromAddress: "test@example.com", region: "us-east-1", disabled: true },
    observability: { serviceName: "booking-api", environment: "test", logLevel: "silent", metricsEnabled: false },
  };
}

function createObservability(): RouteObservability {
  return {
    logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
    recordProviderCall: jest.fn(),
    recordStateTransition: jest.fn(),
    recordSecurityEvent: jest.fn(),
  };
}

function createSession(): BookingSessionRecord {
  return {
    id: "22222222-2222-4222-8222-222222222222",
    reservationPublicId: "KWL-ABCDEFGH",
    propertyId: SUNSET_PROPERTY_ID,
    arrivalDate: "2026-05-01",
    departureDate: "2026-05-05",
    guests: 2,
    language: "en",
    guest: { firstName: "Ana", lastName: "Mora", email: "ana@example.com" },
    totalAmountCents: 40000,
  } as unknown as BookingSessionRecord;
}

async function seedConvertedHold(holds: InMemoryHoldRepository): Promise<string> {
  const hold = await holds.createCreatingHold({
    bookingSessionId: "22222222-2222-4222-8222-222222222222",
    propertyId: SUNSET_PROPERTY_ID,
    arrivalDate: "2026-05-01",
    departureDate: "2026-05-05",
    expiresAt: "2026-06-01T00:00:00.000Z",
    smoobuChannelId: 11,
    smoobuCreatePayloadHash: "hash",
  });
  await holds.activateHold({ holdId: hold.id, smoobuReservationId: OLD_RESERVATION_ID });
  await holds.markHoldConfirmed(hold.id);
  return hold.id;
}

afterEach(() => {
  global.fetch = originalFetch;
  jest.restoreAllMocks();
});

// ─── Race-condition regression: promotion never leaves dates unblocked (R2) ───

test("R2: re-blocks the dates when the website reservation fails after the old block was deleted", async () => {
  // DELETE old block → ok. POST channel 70 (website) → fail. POST channel 11 (re-block) → ok.
  global.fetch = jest.fn(async (url: string | URL, init?: RequestInit) => {
    const { pathname } = new URL(url.toString());
    const method = (init?.method ?? "GET").toUpperCase();

    if (method === "DELETE" && pathname.startsWith("/api/reservations/")) {
      return new Response(JSON.stringify({ success: true }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (method === "POST" && pathname === "/api/reservations") {
      const body = JSON.parse(String(init?.body ?? "{}"));
      if (body.channelId === 70) {
        return new Response(JSON.stringify({ detail: "unavailable" }), { status: 500, headers: { "content-type": "application/json" } });
      }
      // Re-block on the Blocked channel (11) succeeds.
      return new Response(JSON.stringify({ id: REBLOCK_RESERVATION_ID }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({ detail: "unexpected" }), { status: 500, headers: { "content-type": "application/json" } });
  }) as typeof fetch;

  const holds = new InMemoryHoldRepository();
  const holdId = await seedConvertedHold(holds);
  const hold = (await holds.getByBookingSessionId("22222222-2222-4222-8222-222222222222"))!;

  const result = await promoteSmoobuReservation(
    { session: createSession(), hold, notice: "confirmed", amountCents: 40000 },
    holds,
    createConfig(),
    createObservability()
  );

  expect(result.promoted).toBe(false);
  expect(result.error).toBe("create_after_delete_failed_reblocked");
  expect(result.newSmoobuReservationId).toBe(REBLOCK_RESERVATION_ID);

  // The hold now points at the restored (blocked) reservation, not the deleted one.
  const after = await holds.getByBookingSessionId("22222222-2222-4222-8222-222222222222");
  expect(after?.smoobuReservationId).toBe(REBLOCK_RESERVATION_ID);
  expect(after?.smoobuChannelId).toBe(11);
  expect(holdId).toBe(after?.id);
});

// ─── Regression: promote onto the HOLD's property, never a drifted session ────
// Reproduces a property-drift incident: a Palm Cottage deposit hold whose
// booking session had a drifted propertyId (Ocean Breeze) was confirmed/sold onto
// Ocean Breeze's apartment. Promotion must key the apartment off the hold, not the session.

test("promotes onto the hold's apartment even when session.propertyId has drifted", async () => {
  const createPayloads: Array<Record<string, unknown>> = [];
  global.fetch = jest.fn(async (url: string | URL, init?: RequestInit) => {
    const { pathname } = new URL(url.toString());
    const method = (init?.method ?? "GET").toUpperCase();

    if (method === "DELETE" && pathname.startsWith("/api/reservations/")) {
      return new Response(JSON.stringify({ success: true }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (method === "POST" && pathname === "/api/reservations") {
      createPayloads.push(JSON.parse(String(init?.body ?? "{}")));
      return new Response(JSON.stringify({ id: NEW_WEBSITE_RESERVATION_ID }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({ detail: "unexpected" }), { status: 500, headers: { "content-type": "application/json" } });
  }) as typeof fetch;

  const holds = new InMemoryHoldRepository();
  // The blocked hold the guest actually created: Palm Cottage.
  const hold = await holds.createCreatingHold({
    bookingSessionId: "22222222-2222-4222-8222-222222222222",
    propertyId: PALM_PROPERTY_ID,
    arrivalDate: "2026-09-12",
    departureDate: "2026-09-13",
    expiresAt: "2026-08-05T00:00:00.000Z",
    smoobuChannelId: 11,
    smoobuCreatePayloadHash: "hash",
  });
  await holds.activateHold({ holdId: hold.id, smoobuReservationId: OLD_RESERVATION_ID });
  await holds.markHoldConfirmed(hold.id);
  const confirmedHold = (await holds.getByBookingSessionId("22222222-2222-4222-8222-222222222222"))!;

  // Session whose propertyId has drifted to Ocean Breeze (the bug's precondition).
  const session = {
    id: "22222222-2222-4222-8222-222222222222",
    reservationPublicId: "KWL-DEMO7X9Z",
    propertyId: OCEAN_PROPERTY_ID,
    arrivalDate: "2026-09-12",
    departureDate: "2026-09-13",
    guests: 3,
    language: "es",
    guest: { firstName: "Ana", lastName: "Mora", email: "ana@example.com" },
    totalAmountCents: 19400,
  } as unknown as BookingSessionRecord;

  const observability = createObservability();
  const result = await promoteSmoobuReservation(
    { session, hold: confirmedHold, notice: "confirmed", amountCents: 19400 },
    holds,
    createConfig(),
    observability
  );

  expect(result.promoted).toBe(true);
  // The website reservation must be created on Palm Cottage (the hold), NOT Ocean Breeze.
  expect(createPayloads).toHaveLength(1);
  expect(createPayloads[0].apartmentId).toBe(PALM_APARTMENT_ID);
  expect(createPayloads[0].apartmentId).not.toBe(SUNSET_APARTMENT_ID);

  // And the drift is surfaced for investigation.
  expect(observability.logger.error).toHaveBeenCalledWith(
    "smoobu_promotion_property_mismatch",
    expect.objectContaining({ holdPropertyId: PALM_PROPERTY_ID, sessionPropertyId: OCEAN_PROPERTY_ID })
  );
});
