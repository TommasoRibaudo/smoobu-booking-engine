/**
 * cancellationPolicy.ts
 *
 * Single source of truth for whether a guest may cancel their own booking.
 * Imported by both the cancel handler and the portal reservation response, so
 * the button the guest sees and the rule the server enforces can never drift.
 *
 * The policy:
 *   - Non-refundable bookings cannot be self-cancelled at all.
 *   - Flexible bookings can be cancelled up to 24 hours before check-in.
 *   - Inside 24 hours the guest is routed to staff instead.
 */

import type { BookingSessionRecord } from "./bookingSessions";

/**
 * Check-in time, needed because arrival_date is a bare `date` with no time
 * component — without a convention the 24-hour boundary is ambiguous by up to a
 * full day. Costa Rica is UTC-6 year round (no DST since 1992), so 15:00 local
 * is 21:00 UTC with no seasonal adjustment.
 */
export const CHECK_IN_HOUR_COSTA_RICA = 15;
export const COSTA_RICA_UTC_OFFSET_HOURS = 6;
export const CANCELLATION_CUTOFF_HOURS = 24;

export type CancellationBlockReason =
  | "already_cancelled"
  | "invalid_booking_state"
  | "non_refundable_rate"
  | "rate_plan_unknown"
  | "cancellation_window_closed";

export type CancellationEligibility =
  | { allowed: true; deadline: string }
  | { allowed: false; reason: CancellationBlockReason; deadline: string | null };

/** UTC instant of check-in for a `YYYY-MM-DD` arrival date. */
export function checkInInstantMs(arrivalDate: string): number {
  const utcHour = CHECK_IN_HOUR_COSTA_RICA + COSTA_RICA_UTC_OFFSET_HOURS;
  return Date.parse(`${arrivalDate}T${String(utcHour).padStart(2, "0")}:00:00Z`);
}

/** Last instant at which self-service cancellation is still permitted. */
export function cancellationDeadlineIso(arrivalDate: string): string | null {
  const checkInMs = checkInInstantMs(arrivalDate);
  if (!Number.isFinite(checkInMs)) {
    return null;
  }
  return new Date(checkInMs - CANCELLATION_CUTOFF_HOURS * 60 * 60 * 1000).toISOString();
}

export function evaluateCancellationEligibility(input: {
  session: BookingSessionRecord;
  nowMs?: number;
}): CancellationEligibility {
  const { session } = input;
  const nowMs = input.nowMs ?? Date.now();
  const deadline = cancellationDeadlineIso(session.arrivalDate);

  // Ordered deliberately: a booking that is already cancelled reports that
  // rather than a window or rate-plan complaint, so a repeat submit reads as
  // "already done" instead of an error.
  if (session.status === "cancelled") {
    return { allowed: false, reason: "already_cancelled", deadline };
  }

  if (session.status !== "booking_confirmed") {
    return { allowed: false, reason: "invalid_booking_state", deadline };
  }

  if (session.ratePlan === "non_refundable") {
    return { allowed: false, reason: "non_refundable_rate", deadline };
  }

  // Rows created before migration 0013 have no rate plan, and there is no signal
  // to infer it from retroactively. Failing closed routes those guests to staff
  // rather than risking a refund on a non-refundable booking.
  if (session.ratePlan !== "flexible") {
    return { allowed: false, reason: "rate_plan_unknown", deadline };
  }

  if (deadline === null) {
    return { allowed: false, reason: "invalid_booking_state", deadline: null };
  }

  if (nowMs >= Date.parse(deadline)) {
    return { allowed: false, reason: "cancellation_window_closed", deadline };
  }

  return { allowed: true, deadline };
}

/**
 * Actions the portal should offer for a reservation. Returned to the frontend so
 * the UI never has to re-derive the policy.
 */
export function availablePortalActions(session: BookingSessionRecord, nowMs?: number): string[] {
  const actions: string[] = ["request_help"];

  if (session.status === "booking_confirmed") {
    actions.push("update_guests");
  }

  if (evaluateCancellationEligibility({ session, ...(nowMs !== undefined ? { nowMs } : {}) }).allowed) {
    actions.push("cancel_booking");
  }

  return actions;
}
