import { InMemoryBookingSessionRepository, BookingSessionRecord } from "./bookingSessions";
import { InMemoryHoldRepository, HoldRecord } from "./holds";
import { processExpiredHolds, HoldExpiryDependencies, HoldExpiryResult } from "./holdExpiry";
import { SmoobuClient, SmoobuProviderError } from "./smoobuClient";
import { ObservabilityLogger } from "./types";

function createSilentLogger(): ObservabilityLogger {
  return {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };
}

function createMockSmoobuClient(overrides: Partial<SmoobuClient> = {}): SmoobuClient {
  return {
    cancelReservation: jest.fn().mockResolvedValue({ data: { success: true }, statusCode: 200, rateLimit: {} }),
    ...overrides,
  } as unknown as SmoobuClient;
}

const NOW = "2026-04-15T12:00:00.000Z";
const PAST = "2026-04-15T11:00:00.000Z";
const FUTURE = "2026-04-15T13:00:00.000Z";

async function seedActiveHold(
  holds: InMemoryHoldRepository,
  sessions: InMemoryBookingSessionRepository,
  overrides: { expiresAt?: string; smoobuReservationId?: number; holdStatus?: "active" | "creating" } = {}
): Promise<{ hold: HoldRecord; session: BookingSessionRecord }> {
  const session = await sessions.createQuotedSession({
    arrivalDate: "2026-05-01",
    departureDate: "2026-05-05",
    guests: 2,
    language: "en",
    quotedProperties: [
      {
        propertyId: "palmcottage",
        currency: "USD",
        totalAmountCents: 40000,
        nightlyAverageCents: 10000,
        nights: 4,
        includesTaxes: false,
        rateSource: "smoobu",
      },
    ],
  });

  const expiresAt = overrides.expiresAt ?? PAST;

  const hold = await holds.createCreatingHold({
    bookingSessionId: session.id,
    propertyId: "palmcottage",
    arrivalDate: "2026-05-01",
    departureDate: "2026-05-05",
    expiresAt,
    smoobuChannelId: 11,
    smoobuCreatePayloadHash: "test-hash",
  });

  const smoobuReservationId = overrides.smoobuReservationId ?? 99001;
  const activated = await holds.activateHold({ holdId: hold.id, smoobuReservationId });
  await sessions.markHoldCreating({
    bookingSessionId: session.id,
    propertyId: "palmcottage",
    paymentMethod: "paypal",
    ratePlan: "flexible",
    price: session.quotedProperties[0],
    guest: { firstName: "Test", lastName: "Guest", email: "test@example.com" },
    portalPasswordHash: "hash",
    expiresAt,
  });
  const activeSession = await sessions.markHoldActive({ bookingSessionId: session.id, expiresAt });

  return { hold: activated, session: activeSession };
}

function createDeps(overrides: Partial<HoldExpiryDependencies> = {}): HoldExpiryDependencies {
  return {
    holds: new InMemoryHoldRepository(),
    bookingSessions: new InMemoryBookingSessionRepository(),
    smoobuClient: createMockSmoobuClient(),
    logger: createSilentLogger(),
    now: () => NOW,
    ...overrides,
  };
}

describe("processExpiredHolds", () => {
  it("returns empty result when no holds are expired", async () => {
    const deps = createDeps();
    const result = await processExpiredHolds(deps);

    expect(result.processed).toBe(0);
    expect(result.expired).toBe(0);
    expect(result.errors).toHaveLength(0);
  });

  it("expires an active hold past its expiresAt and cancels Smoobu reservation", async () => {
    const holds = new InMemoryHoldRepository();
    const sessions = new InMemoryBookingSessionRepository();
    const smoobuClient = createMockSmoobuClient();

    const { hold, session } = await seedActiveHold(holds, sessions, { expiresAt: PAST });

    const deps = createDeps({ holds, bookingSessions: sessions, smoobuClient });
    const result = await processExpiredHolds(deps);

    expect(result.processed).toBe(1);
    expect(result.expired).toBe(1);
    expect(result.smoobuCancelled).toBe(1);
    expect(result.smoobuCancelFailed).toBe(0);
    expect(result.sessionUpdateFailed).toBe(0);
    expect(result.errors).toHaveLength(0);

    // Verify hold status
    const updatedHold = await holds.getByBookingSessionId(session.id);
    expect(updatedHold?.status).toBe("expired");

    // Verify Smoobu cancel was called
    expect(smoobuClient.cancelReservation).toHaveBeenCalledWith(hold.smoobuReservationId);

    // Verify session status
    const updatedSession = await sessions.getById(session.id);
    expect(updatedSession?.status).toBe("hold_expired");
  });

  it("does not expire holds that have not yet reached expiresAt", async () => {
    const holds = new InMemoryHoldRepository();
    const sessions = new InMemoryBookingSessionRepository();

    await seedActiveHold(holds, sessions, { expiresAt: FUTURE });

    const deps = createDeps({ holds, bookingSessions: sessions });
    const result = await processExpiredHolds(deps);

    expect(result.processed).toBe(0);
    expect(result.expired).toBe(0);
  });

  it("continues processing other holds when Smoobu cancel fails for one", async () => {
    const holds = new InMemoryHoldRepository();
    const sessions = new InMemoryBookingSessionRepository();

    const { hold: hold1 } = await seedActiveHold(holds, sessions, {
      expiresAt: PAST,
      smoobuReservationId: 99001,
    });

    // Seed a second hold — need a different property to avoid conflict
    const session2 = await sessions.createQuotedSession({
      arrivalDate: "2026-06-01",
      departureDate: "2026-06-05",
      guests: 2,
      language: "es",
      quotedProperties: [
        {
          propertyId: "sunsetvilla",
          currency: "USD",
          totalAmountCents: 50000,
          nightlyAverageCents: 12500,
          nights: 4,
          includesTaxes: false,
          rateSource: "smoobu",
        },
      ],
    });
    const hold2raw = await holds.createCreatingHold({
      bookingSessionId: session2.id,
      propertyId: "sunsetvilla",
      arrivalDate: "2026-06-01",
      departureDate: "2026-06-05",
      expiresAt: PAST,
      smoobuChannelId: 11,
      smoobuCreatePayloadHash: "test-hash-2",
    });
    await holds.activateHold({ holdId: hold2raw.id, smoobuReservationId: 99002 });
    await sessions.markHoldCreating({
      bookingSessionId: session2.id,
      propertyId: "sunsetvilla",
      paymentMethod: "paypal",
      ratePlan: "flexible",
      price: session2.quotedProperties[0],
      guest: { firstName: "Test", lastName: "Two", email: "test2@example.com" },
      portalPasswordHash: "hash2",
      expiresAt: PAST,
    });
    await sessions.markHoldActive({ bookingSessionId: session2.id, expiresAt: PAST });

    // Make Smoobu cancel fail for the first reservation but succeed for the second
    const smoobuClient = createMockSmoobuClient({
      cancelReservation: jest.fn().mockImplementation((reservationId: number) => {
        if (reservationId === 99001) {
          throw new SmoobuProviderError(503, "provider_unavailable", "Smoobu is down.");
        }
        return Promise.resolve({ data: { success: true }, statusCode: 200, rateLimit: {} });
      }),
    });

    const deps = createDeps({ holds, bookingSessions: sessions, smoobuClient });
    const result = await processExpiredHolds(deps);

    expect(result.processed).toBe(2);
    expect(result.expired).toBe(2);
    expect(result.smoobuCancelled).toBe(1);
    expect(result.smoobuCancelFailed).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].phase).toBe("cancel_smoobu");

    // Both sessions should still be marked expired even though one Smoobu cancel failed
    const s1 = await sessions.getById(hold1.bookingSessionId);
    const s2 = await sessions.getById(session2.id);
    expect(s1?.status).toBe("hold_expired");
    expect(s2?.status).toBe("hold_expired");
  });

  it("handles hold without smoobuReservationId (creating status that expired)", async () => {
    const holds = new InMemoryHoldRepository();
    const sessions = new InMemoryBookingSessionRepository();

    const session = await sessions.createQuotedSession({
      arrivalDate: "2026-05-01",
      departureDate: "2026-05-05",
      guests: 2,
      language: "en",
      quotedProperties: [
        {
          propertyId: "oceanbreeze",
          currency: "USD",
          totalAmountCents: 30000,
          nightlyAverageCents: 7500,
          nights: 4,
          includesTaxes: false,
          rateSource: "smoobu",
        },
      ],
    });

    // Create a hold in "creating" status (no smoobuReservationId yet)
    await holds.createCreatingHold({
      bookingSessionId: session.id,
      propertyId: "oceanbreeze",
      arrivalDate: "2026-05-01",
      departureDate: "2026-05-05",
      expiresAt: PAST,
      smoobuChannelId: 11,
      smoobuCreatePayloadHash: "test-hash-3",
    });
    await sessions.markHoldCreating({
      bookingSessionId: session.id,
      propertyId: "oceanbreeze",
      paymentMethod: "paypal",
      ratePlan: "flexible",
      price: session.quotedProperties[0],
      guest: { firstName: "Test", lastName: "Three", email: "test3@example.com" },
      portalPasswordHash: "hash3",
      expiresAt: PAST,
    });

    const smoobuClient = createMockSmoobuClient();
    const deps = createDeps({ holds, bookingSessions: sessions, smoobuClient });
    const result = await processExpiredHolds(deps);

    expect(result.processed).toBe(1);
    expect(result.expired).toBe(1);
    expect(result.smoobuCancelled).toBe(0);
    expect(result.smoobuCancelFailed).toBe(0);
    // cancelReservation should NOT have been called since there's no smoobuReservationId
    expect(smoobuClient.cancelReservation).not.toHaveBeenCalled();
  });

  it("logs appropriately when sweep finds no expired holds", async () => {
    const logger = createSilentLogger();
    const deps = createDeps({ logger });
    await processExpiredHolds(deps);

    expect(logger.debug).toHaveBeenCalledWith("hold_expiry_sweep_empty", expect.any(Object));
  });

  it("sends cancellation email when emailConfig is provided and session has guest email", async () => {
    const holds = new InMemoryHoldRepository();
    const sessions = new InMemoryBookingSessionRepository();
    const smoobuClient = createMockSmoobuClient();
    const logger = createSilentLogger();

    await seedActiveHold(holds, sessions, { expiresAt: PAST });

    const emailConfig = {
      fromAddress: "test@example.com",
      region: "us-east-1",
      disabled: true, // disabled so no real SES call; we verify the log
    };

    const deps = createDeps({ holds, bookingSessions: sessions, smoobuClient, logger, emailConfig });
    await processExpiredHolds(deps);

    // With disabled=true the EmailClient logs email_send_skipped_disabled
    expect(logger.info).toHaveBeenCalledWith(
      "email_send_skipped_disabled",
      expect.objectContaining({ template: "cancelled" })
    );
  });

  it("does not attempt email when emailConfig is not provided", async () => {
    const holds = new InMemoryHoldRepository();
    const sessions = new InMemoryBookingSessionRepository();
    const logger = createSilentLogger();

    await seedActiveHold(holds, sessions, { expiresAt: PAST });

    // No emailConfig — should complete without any email log
    const deps = createDeps({ holds, bookingSessions: sessions, logger });
    await processExpiredHolds(deps);

    expect(logger.info).not.toHaveBeenCalledWith(
      "email_send_skipped_disabled",
      expect.anything()
    );
  });

  it("short-circuits a hold when expireHold DB update fails, skipping Smoobu cancel and session update", async () => {
    const holds = new InMemoryHoldRepository();
    const sessions = new InMemoryBookingSessionRepository();
    const smoobuClient = createMockSmoobuClient();
    const logger = createSilentLogger();

    const { hold, session } = await seedActiveHold(holds, sessions, { expiresAt: PAST });

    // Sabotage expireHold to simulate a DB failure
    const originalExpireHold = holds.expireHold.bind(holds);
    holds.expireHold = jest.fn().mockRejectedValue(new Error("connection reset"));

    const deps = createDeps({ holds, bookingSessions: sessions, smoobuClient, logger });
    const result = await processExpiredHolds(deps);

    expect(result.processed).toBe(1);
    expect(result.expired).toBe(0);
    expect(result.smoobuCancelled).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({
      holdId: hold.id,
      phase: "expire_hold",
      errorCode: "db_update_failed",
    });

    // Smoobu cancel should NOT have been called — we short-circuited
    expect(smoobuClient.cancelReservation).not.toHaveBeenCalled();

    // Session should still be hold_active (not expired)
    const updatedSession = await sessions.getById(session.id);
    expect(updatedSession?.status).toBe("hold_active");

    // Error was logged
    expect(logger.error).toHaveBeenCalledWith(
      "hold_expiry_db_failed",
      expect.objectContaining({ holdId: hold.id, error: "connection reset" })
    );
  });
});

describe("processExpiredHolds — race-condition regression (R1)", () => {
  it("does not expire or cancel a hold whose session is already booking_confirmed", async () => {
    const holds = new InMemoryHoldRepository();
    const sessions = new InMemoryBookingSessionRepository();
    const smoobuClient = createMockSmoobuClient();

    const { session } = await seedActiveHold(holds, sessions, { expiresAt: PAST });

    // Payment landed and the session is confirmed, but the hold was left `active`
    // (e.g. the Smoobu promotion failed after capture). The expiry sweep must not
    // cancel this now-paid booking's reservation.
    await sessions.markPaypalOrderCreated({ bookingSessionId: session.id, paypalOrderId: "PP-R1" });
    await sessions.markBookingConfirmed({ bookingSessionId: session.id, confirmedAt: NOW });

    const deps = createDeps({ holds, bookingSessions: sessions, smoobuClient });
    const result = await processExpiredHolds(deps);

    expect(smoobuClient.cancelReservation).not.toHaveBeenCalled();
    expect(result.expired).toBe(0);
    expect(result.smoobuCancelled).toBe(0);
    const after = await holds.getByBookingSessionId(session.id);
    expect(after?.status).toBe("active");
  });
});
