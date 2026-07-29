/**
 * Smoobu reservation promotion — converts a "Blocked channel" (channelId 11)
 * hold into a "Homepage" / website reservation (channelId 70) after PayPal
 * payment is captured.
 *
 * The Smoobu PUT /api/reservations endpoint does NOT support changing channelId,
 * so promotion requires deleting the old blocked reservation and creating a new
 * one on the Homepage channel with payment fields marked as complete.
 */

import { BookingSessionRecord, BookingSessionQuotedProperty } from "./bookingSessions";
import { HoldRecord, HoldRepository, SmoobuChannelId } from "./holds";
import { BookingProperty, BOOKING_PROPERTIES_BY_ID } from "./propertyCatalog";
import { createSmoobuClient, SmoobuClient } from "./smoobuClient";
import { BookingApiConfig, ObservabilityLogger, RouteObservability } from "./types";

/**
 * Smoobu channel ID 70 = "Homepage" — the website booking channel.
 * Confirmed reservations are promoted to this channel so they appear as
 * website reservations in the Smoobu dashboard, not blocked periods.
 */
const WEBSITE_CHANNEL_ID: SmoobuChannelId = 70;

interface SmoobuCreateReservationResponse {
  id?: unknown;
}

export interface PromoteSmoobuReservationInput {
  session: BookingSessionRecord;
  hold: HoldRecord;
  captureId: string;
  amountCents: number;
  confirmedAt: string;
}

export interface PromoteSmoobuReservationResult {
  promoted: boolean;
  newSmoobuReservationId?: number;
  error?: string;
}

/**
 * Promotes a Smoobu blocked-channel hold to a Homepage (website) reservation.
 *
 * Steps:
 * 1. Delete the old blocked reservation on Smoobu.
 * 2. Create a new reservation with channelId 70 (Homepage) and payment
 *    fields set to paid.
 * 3. Update the local hold record to "converted" with the new reservation ID.
 *
 * This is non-fatal: if any step fails, the booking is still confirmed in our
 * DB and the error is logged. The reconciliation worker can retry later.
 */
export async function promoteSmoobuReservation(
  input: PromoteSmoobuReservationInput,
  holds: HoldRepository,
  config: BookingApiConfig,
  observability: RouteObservability
): Promise<PromoteSmoobuReservationResult> {
  const { session, hold, captureId, amountCents, confirmedAt } = input;
  const logger = observability.logger;

  if (!hold.smoobuReservationId) {
    logger.warn("smoobu_promotion_skipped_no_reservation_id", {
      bookingSessionId: session.id,
      holdId: hold.id,
    });
    return { promoted: false, error: "no_smoobu_reservation_id" };
  }

  const property = BOOKING_PROPERTIES_BY_ID.get(session.propertyId ?? "");
  if (!property) {
    logger.warn("smoobu_promotion_skipped_no_property", {
      bookingSessionId: session.id,
      propertyId: session.propertyId,
    });
    return { promoted: false, error: "property_not_found" };
  }

  let smoobuClient: SmoobuClient;
  try {
    smoobuClient = await createSmoobuClient(config);
  } catch (err) {
    logger.warn("smoobu_promotion_client_init_failed", {
      bookingSessionId: session.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return { promoted: false, error: "smoobu_client_init_failed" };
  }

  // If the hold is already on the website channel, just update payment fields.
  if (hold.smoobuChannelId === WEBSITE_CHANNEL_ID) {
    return updateExistingWebsiteBooking(
      smoobuClient, hold, session, captureId, amountCents, confirmedAt, observability, logger
    );
  }

  // Step 1: Delete the old blocked reservation
  try {
    await smoobuClient.cancelReservation(hold.smoobuReservationId, observability);
    logger.info("smoobu_promotion_old_reservation_deleted", {
      bookingSessionId: session.id,
      smoobuReservationId: hold.smoobuReservationId,
    });
  } catch (err) {
    logger.error("smoobu_promotion_delete_failed", {
      bookingSessionId: session.id,
      smoobuReservationId: hold.smoobuReservationId,
      error: err instanceof Error ? err.message : String(err),
    });
    // Fall back to just updating the existing reservation's payment fields
    return fallbackUpdateReservation(
      smoobuClient, hold, session, captureId, amountCents, confirmedAt, observability, logger
    );
  }

  // Step 2: Create a new reservation on the Homepage (website) channel
  let newReservationId: number;
  try {
    const payload = buildConfirmedReservationPayload(session, property, captureId, amountCents, confirmedAt);
    const response = await smoobuClient.createReservation<SmoobuCreateReservationResponse>(payload, observability);
    newReservationId = parseSmoobuReservationId(response.data);

    logger.info("smoobu_promotion_new_reservation_created", {
      bookingSessionId: session.id,
      oldSmoobuReservationId: hold.smoobuReservationId,
      newSmoobuReservationId: newReservationId,
      channelId: WEBSITE_CHANNEL_ID,
    });
  } catch (err) {
    logger.error("smoobu_promotion_create_failed", {
      bookingSessionId: session.id,
      oldSmoobuReservationId: hold.smoobuReservationId,
      error: err instanceof Error ? err.message : String(err),
    });
    // The old reservation was deleted but the new one failed. This is a
    // problem — the dates are now unblocked on Smoobu. Log as critical.
    logger.error("smoobu_promotion_dates_unblocked", {
      bookingSessionId: session.id,
      arrivalDate: session.arrivalDate,
      departureDate: session.departureDate,
      propertyId: session.propertyId,
      action: "manual_intervention_required",
    });
    return { promoted: false, error: "create_after_delete_failed" };
  }

  // Step 3: Update local hold to converted with new reservation ID
  try {
    await holds.convertHold({
      holdId: hold.id,
      newSmoobuReservationId: newReservationId,
      newSmoobuChannelId: WEBSITE_CHANNEL_ID,
    });
  } catch (err) {
    // Non-fatal: the Smoobu reservation is correct, local state is stale
    logger.warn("smoobu_promotion_hold_convert_failed", {
      bookingSessionId: session.id,
      holdId: hold.id,
      newSmoobuReservationId: newReservationId,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  observability.recordStateTransition({
    entityType: "hold",
    fromState: "active",
    toState: "converted",
    action: "smoobu.reservation.promote",
    success: true,
    bookingSessionId: session.id,
    reservationPublicId: session.reservationPublicId,
    provider: "smoobu",
    providerObjectId: String(newReservationId),
  });

  return { promoted: true, newSmoobuReservationId: newReservationId };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * When the hold is already on the website channel, just update payment fields.
 */
async function updateExistingWebsiteBooking(
  smoobuClient: SmoobuClient,
  hold: HoldRecord,
  session: BookingSessionRecord,
  captureId: string,
  amountCents: number,
  confirmedAt: string,
  observability: RouteObservability,
  logger: ObservabilityLogger
): Promise<PromoteSmoobuReservationResult> {
  try {
    await smoobuClient.updateReservation(
      hold.smoobuReservationId!,
      {
        notice: buildConfirmedNotice(session, captureId, confirmedAt),
        prepayment: amountCents / 100,
        prepaymentStatus: 1,
        priceStatus: 1,
      },
      observability
    );
    logger.info("smoobu_promotion_website_booking_updated", {
      bookingSessionId: session.id,
      smoobuReservationId: hold.smoobuReservationId,
    });
    return { promoted: true, newSmoobuReservationId: hold.smoobuReservationId };
  } catch (err) {
    logger.warn("smoobu_promotion_website_booking_update_failed", {
      bookingSessionId: session.id,
      smoobuReservationId: hold.smoobuReservationId,
      error: err instanceof Error ? err.message : String(err),
    });
    return { promoted: false, error: "website_booking_update_failed" };
  }
}

/**
 * Fallback: if deleting the old blocked reservation fails, try to at least
 * update its payment fields so it shows as paid in Smoobu.
 */
async function fallbackUpdateReservation(
  smoobuClient: SmoobuClient,
  hold: HoldRecord,
  session: BookingSessionRecord,
  captureId: string,
  amountCents: number,
  confirmedAt: string,
  observability: RouteObservability,
  logger: ObservabilityLogger
): Promise<PromoteSmoobuReservationResult> {
  try {
    await smoobuClient.updateReservation(
      hold.smoobuReservationId!,
      {
        notice: buildConfirmedNotice(session, captureId, confirmedAt),
        prepayment: amountCents / 100,
        prepaymentStatus: 1,
        priceStatus: 1,
      },
      observability
    );
    logger.warn("smoobu_promotion_fallback_update_applied", {
      bookingSessionId: session.id,
      smoobuReservationId: hold.smoobuReservationId,
      note: "Reservation remains on Blocked channel but payment fields updated",
    });
    return { promoted: false, error: "delete_failed_fallback_update_applied" };
  } catch (updateErr) {
    logger.error("smoobu_promotion_fallback_update_also_failed", {
      bookingSessionId: session.id,
      smoobuReservationId: hold.smoobuReservationId,
      error: updateErr instanceof Error ? updateErr.message : String(updateErr),
    });
    return { promoted: false, error: "delete_and_update_both_failed" };
  }
}

function buildConfirmedReservationPayload(
  session: BookingSessionRecord,
  property: BookingProperty,
  captureId: string,
  amountCents: number,
  confirmedAt: string
) {
  const guest = session.guest;
  return {
    arrivalDate: session.arrivalDate,
    departureDate: session.departureDate,
    channelId: WEBSITE_CHANNEL_ID,
    apartmentId: property.smoobuApartmentId,
    firstName: guest?.firstName ?? "",
    lastName: guest?.lastName ?? "",
    email: guest?.email ?? "",
    ...(guest?.phone ? { phone: guest.phone } : {}),
    ...(guest?.country ? { country: guest.country } : {}),
    notice: buildConfirmedNotice(session, captureId, confirmedAt),
    adults: session.guests,
    children: 0,
    price: amountCents / 100,
    priceStatus: 1,
    prepayment: amountCents / 100,
    prepaymentStatus: 1,
    deposit: 0,
    depositStatus: 0,
    language: session.language,
  };
}

function buildConfirmedNotice(
  session: BookingSessionRecord,
  captureId: string,
  confirmedAt: string
): string {
  return [
    `Confirmed — PayPal payment received.`,
    `Reservation ID: ${session.reservationPublicId}`,
    `PayPal capture: ${captureId}`,
    `Confirmed at: ${confirmedAt}`,
  ].join("\n");
}

function parseSmoobuReservationId(data: SmoobuCreateReservationResponse): number {
  if (typeof data.id === "number" && Number.isInteger(data.id) && data.id > 0) {
    return data.id;
  }

  if (typeof data.id === "string" && /^\d+$/.test(data.id)) {
    return Number(data.id);
  }

  throw new Error("Smoobu returned an invalid reservation ID during promotion.");
}
