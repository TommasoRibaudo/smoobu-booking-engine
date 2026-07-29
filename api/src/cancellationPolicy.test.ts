import {
  CANCELLATION_CUTOFF_HOURS,
  CHECK_IN_HOUR_COSTA_RICA,
  COSTA_RICA_UTC_OFFSET_HOURS,
  availablePortalActions,
  cancellationDeadlineIso,
  checkInInstantMs,
  evaluateCancellationEligibility,
} from "./cancellationPolicy";
import type { BookingSessionRecord } from "./bookingSessions";

function session(overrides: Partial<BookingSessionRecord> = {}): BookingSessionRecord {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    reservationPublicId: "KWL-ABCD1234",
    quoteId: "qt_TEST",
    status: "booking_confirmed",
    language: "en",
    arrivalDate: "2099-08-01",
    departureDate: "2099-08-05",
    guests: 2,
    quoteExpiresAt: "2099-07-01T00:00:00.000Z",
    quotedProperties: [],
    ratePlan: "flexible",
    createdAt: "2099-07-01T00:00:00.000Z",
    updatedAt: "2099-07-01T00:00:00.000Z",
    ...overrides,
  };
}

// ── the check-in convention ──────────────────────────────────────────────────

test("check-in is 15:00 Costa Rica, expressed as 21:00 UTC", () => {
  expect(checkInInstantMs("2099-08-01")).toBe(Date.parse("2099-08-01T21:00:00.000Z"));
  expect(CHECK_IN_HOUR_COSTA_RICA + COSTA_RICA_UTC_OFFSET_HOURS).toBe(21);
});

test("the hardcoded UTC-6 offset matches Intl across the year", () => {
  // Costa Rica has had no DST since 1992. If that ever changes, the fixed offset
  // silently shifts the cancellation deadline by an hour — catch it here.
  for (const date of ["2099-01-15", "2099-04-15", "2099-07-15", "2099-10-15"]) {
    const noonUtc = new Date(`${date}T12:00:00Z`);
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Costa_Rica",
      hour: "2-digit",
      hour12: false,
    }).formatToParts(noonUtc);
    const localHour = Number(parts.find((part) => part.type === "hour")?.value);
    expect(12 - localHour).toBe(COSTA_RICA_UTC_OFFSET_HOURS);
  }
});

test("the deadline is exactly 24 hours before check-in", () => {
  const deadline = cancellationDeadlineIso("2099-08-01");
  expect(deadline).toBe("2099-07-31T21:00:00.000Z");
  expect(Date.parse("2099-08-01T21:00:00.000Z") - Date.parse(deadline as string)).toBe(
    CANCELLATION_CUTOFF_HOURS * 60 * 60 * 1000
  );
});

// ── the window boundary ──────────────────────────────────────────────────────

test("cancellation is allowed one second before the deadline", () => {
  const result = evaluateCancellationEligibility({
    session: session(),
    nowMs: Date.parse("2099-07-31T20:59:59.000Z"),
  });
  expect(result.allowed).toBe(true);
});

test("cancellation is blocked exactly at the deadline", () => {
  const result = evaluateCancellationEligibility({
    session: session(),
    nowMs: Date.parse("2099-07-31T21:00:00.000Z"),
  });
  expect(result).toMatchObject({ allowed: false, reason: "cancellation_window_closed" });
});

test("cancellation is blocked after check-in has passed", () => {
  const result = evaluateCancellationEligibility({
    session: session(),
    nowMs: Date.parse("2099-08-02T10:00:00.000Z"),
  });
  expect(result).toMatchObject({ allowed: false, reason: "cancellation_window_closed" });
});

// ── rate plan gating ─────────────────────────────────────────────────────────

test("non-refundable bookings can never be self-cancelled, even months ahead", () => {
  const result = evaluateCancellationEligibility({
    session: session({ ratePlan: "non_refundable" }),
    nowMs: Date.parse("2099-01-01T00:00:00.000Z"),
  });
  expect(result).toMatchObject({ allowed: false, reason: "non_refundable_rate" });
});

test("a legacy booking with no rate plan fails closed", () => {
  // Rows predating migration 0013 carry no rate plan and cannot be classified
  // retroactively, so they must not be treated as flexible.
  const legacy = session();
  delete (legacy as { ratePlan?: string }).ratePlan;

  const result = evaluateCancellationEligibility({
    session: legacy,
    nowMs: Date.parse("2099-01-01T00:00:00.000Z"),
  });
  expect(result).toMatchObject({ allowed: false, reason: "rate_plan_unknown" });
});

// ── state gating and precedence ──────────────────────────────────────────────

test("an already-cancelled booking reports that rather than a window error", () => {
  const result = evaluateCancellationEligibility({
    session: session({ status: "cancelled" }),
    nowMs: Date.parse("2099-08-02T10:00:00.000Z"),
  });
  expect(result).toMatchObject({ allowed: false, reason: "already_cancelled" });
});

test("an unconfirmed booking reports invalid state, not a rate-plan problem", () => {
  const result = evaluateCancellationEligibility({
    session: session({ status: "hold_active", ratePlan: "non_refundable" }),
    nowMs: Date.parse("2099-01-01T00:00:00.000Z"),
  });
  expect(result).toMatchObject({ allowed: false, reason: "invalid_booking_state" });
});

// ── portal actions ───────────────────────────────────────────────────────────

test("portal actions include cancel_booking only while cancellation is allowed", () => {
  const early = availablePortalActions(session(), Date.parse("2099-01-01T00:00:00.000Z"));
  expect(early).toEqual(["request_help", "update_guests", "cancel_booking"]);

  const late = availablePortalActions(session(), Date.parse("2099-07-31T22:00:00.000Z"));
  expect(late).toEqual(["request_help", "update_guests"]);

  const nonRefundable = availablePortalActions(
    session({ ratePlan: "non_refundable" }),
    Date.parse("2099-01-01T00:00:00.000Z")
  );
  expect(nonRefundable).toEqual(["request_help", "update_guests"]);
});

test("a cancelled booking offers neither guest edits nor another cancellation", () => {
  const actions = availablePortalActions(
    session({ status: "cancelled" }),
    Date.parse("2099-01-01T00:00:00.000Z")
  );
  expect(actions).toEqual(["request_help"]);
});
