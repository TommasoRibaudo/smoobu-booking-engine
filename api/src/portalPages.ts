/**
 * Portal page handlers — task 6.4
 *
 * Implements three authenticated portal endpoints:
 *
 *   GET  /api/portal/reservation/:reservationPublicId
 *     Returns reservation details + payment status for the authenticated guest.
 *
 *   POST /api/portal/reservation/:reservationPublicId/help-request
 *     Records a guest help/support request in the audit log and notifies staff.
 *
 *   POST /api/portal/reservation/:reservationPublicId/cancellation-request
 *     Records a guest cancellation request in the audit log and notifies staff.
 *
 * All three routes require a valid portal session token (Bearer) issued by
 * POST /api/portal/login (task 6.3). The token's `sub` claim must match the
 * :reservationPublicId path parameter — guests can only access their own booking.
 *
 * Security properties:
 * - Token verified via requirePortalSession() (HMAC-SHA256, expiry checked)
 * - sub claim matched against path param (prevents horizontal privilege escalation)
 * - No PII beyond what the guest already provided is returned
 * - Idempotency key required on write endpoints (enforced at route level)
 * - Security events recorded for auth failures and successful accesses
 */

import { getHeader } from "./http/request";
import { jsonResponse } from "./http/response";
import { ApiError } from "./http/errors";
import { extractPortalSessionToken, verifyPortalSessionToken } from "./portalSessions";
import { BOOKING_PROPERTIES_BY_ID, listingUrlForLanguage } from "./propertyCatalog";
import { createSmoobuClient } from "./smoobuClient";
import { ApiResponse, BookingApiConfig, RouteRequest } from "./types";
import { BookingSessionRecord, BookingSessionRepository } from "./bookingSessions";
import { PaymentRecord, PaymentRepository } from "./payments";
import { HoldRecord, HoldRepository } from "./holds";
import {
  availablePortalActions,
  evaluateCancellationEligibility,
  type CancellationBlockReason,
} from "./cancellationPolicy";
import { createEmailClient } from "./email";
import { SmoobuProviderError } from "./smoobuClient";

// ── GET /api/portal/reservation/:reservationPublicId ─────────────────────────

export async function handlePortalReservation(
  reservationPublicId: string,
  request: RouteRequest,
  config: BookingApiConfig
): Promise<ApiResponse> {
  const session = await requireAuthenticatedSession(reservationPublicId, request, config);

  const hold = await requireHoldRepository(config).getByBookingSessionId(session.id);
  const payment = await requirePaymentRepository(config).getByBookingSessionId(session.id);

  request.observability.recordSecurityEvent({
    name: "portal_reservation_viewed",
    severity: "info",
    route: "/api/portal/reservation/:reservationPublicId",
    bookingSessionId: session.id,
  });

  return jsonResponse(200, buildReservationResponse(session, hold, payment), request.responseHeaders);
}

// ── POST /api/portal/reservation/:reservationPublicId/help-request ────────────

export async function handlePortalHelpRequest(
  reservationPublicId: string,
  body: { type?: string; message: string },
  request: RouteRequest,
  config: BookingApiConfig
): Promise<ApiResponse> {
  const session = await requireAuthenticatedSession(reservationPublicId, request, config);

  request.observability.logger.info("portal_help_request_received", {
    bookingSessionId: session.id,
    reservationPublicId: session.reservationPublicId,
    type: body.type ?? "general",
    // message intentionally omitted from structured log to avoid PII in logs
  });

  request.observability.recordStateTransition({
    entityType: "booking_session",
    fromState: session.status,
    toState: session.status, // status unchanged; this is a support event
    action: "portal.help_request",
    success: true,
    bookingSessionId: session.id,
    reservationPublicId: session.reservationPublicId,
  });

  request.observability.recordSecurityEvent({
    name: "portal_help_request_submitted",
    severity: "info",
    route: "/api/portal/reservation/:reservationPublicId/help-request",
    bookingSessionId: session.id,
  });

  const strings = portalStrings[session.language];
  return jsonResponse(
    200,
    {
      status: "received",
      message: strings.helpRequestReceived,
    },
    request.responseHeaders
  );
}

// ── POST /api/portal/reservation/:reservationPublicId/cancellation-request ────

export async function handlePortalCancellationRequest(
  reservationPublicId: string,
  body: { reason: string; message?: string },
  request: RouteRequest,
  config: BookingApiConfig
): Promise<ApiResponse> {
  const session = await requireAuthenticatedSession(reservationPublicId, request, config);

  // Only confirmed bookings can request cancellation
  if (session.status !== "booking_confirmed") {
    throw new ApiError(
      409,
      "invalid_booking_state",
      "Cancellation requests can only be submitted for confirmed bookings."
    );
  }

  request.observability.logger.info("portal_cancellation_request_received", {
    bookingSessionId: session.id,
    reservationPublicId: session.reservationPublicId,
    reason: body.reason,
    // message intentionally omitted from structured log to avoid PII in logs
  });

  request.observability.recordStateTransition({
    entityType: "booking_session",
    fromState: session.status,
    toState: session.status, // status unchanged; staff handles actual cancellation
    action: "portal.cancellation_request",
    success: true,
    bookingSessionId: session.id,
    reservationPublicId: session.reservationPublicId,
  });

  request.observability.recordSecurityEvent({
    name: "portal_cancellation_request_submitted",
    severity: "info",
    route: "/api/portal/reservation/:reservationPublicId/cancellation-request",
    bookingSessionId: session.id,
  });

  const strings = portalStrings[session.language];
  return jsonResponse(
    200,
    {
      status: "received",
      message: strings.cancellationRequestReceived,
    },
    request.responseHeaders
  );
}

// ── POST /api/portal/reservation/:reservationPublicId/cancel ─────────────────

/**
 * Guest self-service cancellation.
 *
 * Cancels for real: the Smoobu reservation is deleted (releasing the dates), the
 * session moves to `cancelled`, and any captured payment is flagged for a manual
 * PayPal refund by staff. No money moves automatically.
 *
 * Ordering matters. Smoobu is called first: if it fails we return 502 having
 * changed nothing locally, so the guest can retry against a consistent state.
 * Once Smoobu succeeds the local writes go session-first, so the session reaches
 * its terminal state before the hold changes — the cancelReservation webhook
 * Smoobu reflects back at us keys off the hold, and this ordering makes that
 * echo a no-op instead of a race.
 */
export async function handlePortalCancelBooking(
  reservationPublicId: string,
  body: { reason: string; message?: string },
  request: RouteRequest,
  config: BookingApiConfig
): Promise<ApiResponse> {
  const session = await requireAuthenticatedSession(reservationPublicId, request, config);
  const holds = requireHoldRepository(config);
  const payments = requirePaymentRepository(config);
  const sessions = requireBookingSessionRepository(config);

  const hold = await holds.getByBookingSessionId(session.id);
  const payment = await payments.getByBookingSessionId(session.id);
  const strings = portalStrings[session.language];

  const eligibility = evaluateCancellationEligibility({ session });
  if (!eligibility.allowed) {
    // A repeat submit is success, not an error — return the terminal state.
    if (eligibility.reason === "already_cancelled") {
      return jsonResponse(
        200,
        {
          status: "cancelled",
          message: strings.bookingCancelled,
          ...buildReservationResponse(session, hold, payment),
          refund: buildRefundSummary(payment),
        },
        request.responseHeaders
      );
    }

    throw cancellationNotAllowedError(eligibility.reason, eligibility.deadline);
  }

  // 1. Smoobu first — a provider failure must leave local state untouched.
  if (hold?.smoobuReservationId) {
    try {
      const smoobuClient = await createSmoobuClient(config);
      await smoobuClient.cancelReservation(hold.smoobuReservationId, request.observability);
    } catch (error) {
      // A 404 means the reservation is already gone from Smoobu, which is the
      // outcome we wanted — treat it as success rather than stranding the guest.
      if (error instanceof SmoobuProviderError && error.providerStatusCode === 404) {
        request.observability.logger.warn("portal_cancel_smoobu_already_absent", {
          bookingSessionId: session.id,
          smoobuReservationId: hold.smoobuReservationId,
        });
      } else {
        request.observability.logger.warn("portal_cancel_smoobu_failed", {
          bookingSessionId: session.id,
          smoobuReservationId: hold.smoobuReservationId,
          error: error instanceof Error ? error.message : String(error),
        });
        throw new ApiError(
          502,
          "provider_error",
          "Could not cancel the reservation with our booking provider. Please try again."
        );
      }
    }
  }

  // 2. Local state, session first (see the ordering note above).
  const cancelledAt = new Date().toISOString();
  const cancelledSession = await sessions.markCancelled({
    bookingSessionId: session.id,
    reason: body.reason,
    cancelledBy: "guest",
    cancelledAt,
  });

  if (hold) {
    await holds.cancelHold(hold.id);
  }

  // A captured payment is handed to staff for a manual refund. Cancellations
  // inside the no-refund window still cancel the stay, but claim nothing back.
  const refundExpected = payment?.status === "captured" || payment?.status === "paid";
  const flaggedPayment = refundExpected
    ? await payments.markRefundFlagged({ bookingSessionId: session.id, flaggedAt: cancelledAt })
    : payment;

  request.observability.recordStateTransition({
    entityType: "booking_session",
    fromState: "booking_confirmed",
    toState: "cancelled",
    action: "portal.cancel",
    success: true,
    bookingSessionId: session.id,
    reservationPublicId: session.reservationPublicId,
  });

  if (hold) {
    request.observability.recordStateTransition({
      entityType: "hold",
      fromState: hold.status,
      toState: "cancelled",
      action: "portal.cancel",
      success: true,
      bookingSessionId: session.id,
      reservationPublicId: session.reservationPublicId,
      ...(hold.smoobuReservationId ? { providerObjectId: String(hold.smoobuReservationId) } : {}),
      provider: "smoobu",
    });
  }

  if (refundExpected) {
    request.observability.recordStateTransition({
      entityType: "payment",
      fromState: payment?.status,
      toState: "refund_flagged",
      action: "portal.cancel",
      success: true,
      bookingSessionId: session.id,
      reservationPublicId: session.reservationPublicId,
      provider: "paypal",
      ...(payment?.paypalCaptureId ? { providerObjectId: payment.paypalCaptureId } : {}),
    });
  }

  request.observability.recordSecurityEvent({
    name: "portal_booking_cancelled",
    severity: "info",
    route: "/api/portal/reservation/:reservationPublicId/cancel",
    bookingSessionId: session.id,
  });

  // 3. Notifications last, and non-fatal — the booking is already cancelled and
  // a mail failure must not report that back to the guest as an error.
  try {
    const property = BOOKING_PROPERTIES_BY_ID.get(session.propertyId ?? "");
    const propertyName = property?.name ?? session.propertyId ?? "";
    const emailClient = createEmailClient(config.email, request.observability.logger);
    const emailOptions = {
      ...(payment?.paypalCaptureId ? { paypalCaptureId: payment.paypalCaptureId } : {}),
      refundExpected,
    };

    await emailClient.sendGuestCancellation(cancelledSession, propertyName, emailOptions);
    await emailClient.sendStaffCancellationAlert(cancelledSession, propertyName, emailOptions);
  } catch (emailError) {
    request.observability.logger.error("portal_cancel_email_failed", {
      bookingSessionId: session.id,
      error: emailError instanceof Error ? emailError.message : String(emailError),
    });
  }

  const updatedHold = await holds.getByBookingSessionId(session.id);

  return jsonResponse(
    200,
    {
      status: "cancelled",
      message: strings.bookingCancelled,
      ...buildReservationResponse(cancelledSession, updatedHold, flaggedPayment),
      refund: buildRefundSummary(flaggedPayment),
    },
    request.responseHeaders
  );
}

function buildRefundSummary(payment: PaymentRecord | undefined) {
  if (!payment || payment.status !== "refund_flagged") {
    return { status: "not_applicable" as const };
  }

  return {
    status: "manual_review" as const,
    ...(payment.paypalCaptureId ? { paypalCaptureId: payment.paypalCaptureId } : {}),
  };
}

function cancellationNotAllowedError(
  reason: CancellationBlockReason,
  deadline: string | null
): ApiError {
  if (reason === "cancellation_window_closed") {
    return new ApiError(
      403,
      "cancellation_window_closed",
      "This booking can no longer be cancelled online. Please contact us directly.",
      { fieldErrors: { deadline: [deadline ?? "unknown"] } }
    );
  }

  if (reason === "non_refundable_rate" || reason === "rate_plan_unknown") {
    return new ApiError(
      403,
      "cancellation_not_allowed",
      "This booking cannot be cancelled online. Please contact us directly.",
      { fieldErrors: { ratePlan: [reason] } }
    );
  }

  return new ApiError(409, "invalid_booking_state", "Only confirmed bookings can be cancelled.");
}

// ── PUT /api/portal/reservation/:reservationPublicId/guests ───────────────────

export async function handlePortalGuestUpdate(
  reservationPublicId: string,
  body: { guests: number },
  request: RouteRequest,
  config: BookingApiConfig
): Promise<ApiResponse> {
  const session = await requireAuthenticatedSession(reservationPublicId, request, config);

  // Only confirmed bookings can update guest count
  if (session.status !== "booking_confirmed") {
    throw new ApiError(
      409,
      "invalid_booking_state",
      "Guest count can only be updated for confirmed bookings."
    );
  }

  const property = session.propertyId ? BOOKING_PROPERTIES_BY_ID.get(session.propertyId) : undefined;
  if (property && body.guests > property.guestCapacity) {
    throw new ApiError(400, "guest_count_exceeds_capacity", `This property allows a maximum of ${property.guestCapacity} guests.`, {
      fieldErrors: { guests: ["exceeds_capacity"] },
    });
  }

  if (body.guests < 1) {
    throw new ApiError(400, "validation_error", "Guest count must be at least 1.", {
      fieldErrors: { guests: ["min_1"] },
    });
  }

  // Update the Smoobu reservation if a hold with a smoobuReservationId exists
  const hold = await requireHoldRepository(config).getByBookingSessionId(session.id);
  if (hold?.smoobuReservationId) {
    try {
      const smoobuClient = await createSmoobuClient(config);
      await smoobuClient.updateReservation(
        hold.smoobuReservationId,
        { adults: body.guests },
        request.observability
      );
    } catch (err) {
      request.observability.logger.warn("portal_guest_update_smoobu_failed", {
        bookingSessionId: session.id,
        smoobuReservationId: hold.smoobuReservationId,
        error: err instanceof Error ? err.message : String(err),
      });
      throw new ApiError(502, "provider_error", "Could not update the reservation with our booking provider. Please try again.");
    }
  }

  // Update local DB
  const bookingSessions = requireBookingSessionRepository(config);
  const updatedSession = await bookingSessions.updateGuests({
    bookingSessionId: session.id,
    guests: body.guests,
  });

  request.observability.recordStateTransition({
    entityType: "booking_session",
    fromState: session.status,
    toState: updatedSession.status,
    action: "portal.guest_update",
    success: true,
    bookingSessionId: session.id,
    reservationPublicId: session.reservationPublicId,
  });

  request.observability.recordSecurityEvent({
    name: "portal_guest_count_updated",
    severity: "info",
    route: "/api/portal/reservation/:reservationPublicId/guests",
    bookingSessionId: session.id,
  });

  const updatedHold = await requireHoldRepository(config).getByBookingSessionId(session.id);
  const payment = await requirePaymentRepository(config).getByBookingSessionId(session.id);

  const strings = portalStrings[session.language];
  return jsonResponse(
    200,
    {
      status: "updated",
      message: strings.guestCountUpdated,
      ...buildReservationResponse(updatedSession, updatedHold, payment),
    },
    request.responseHeaders
  );
}

// ── helpers ───────────────────────────────────────────────────────────────────

/**
 * Verify the Bearer token, check the sub claim matches the path param,
 * and load the booking session. Throws 401/403/404 on any failure.
 */
async function requireAuthenticatedSession(
  reservationPublicId: string,
  request: RouteRequest,
  config: BookingApiConfig
): Promise<BookingSessionRecord> {
  const { portalSessionSecret } = await config.secrets.getSecrets();
  const authHeader = getHeader(request.headers, "authorization");

  let token: string;
  let tokenPayload: { sub: string };
  try {
    token = extractPortalSessionToken(authHeader);
    tokenPayload = verifyPortalSessionToken(token, portalSessionSecret);
  } catch (err) {
    request.observability.recordSecurityEvent({
      name: "portal_auth_failed",
      severity: "warn",
      route: request.path,
      errorCode: err instanceof ApiError ? err.code : "token_invalid",
    });
    throw err;
  }

  // Prevent horizontal privilege escalation: token sub must match path param
  if (tokenPayload.sub !== reservationPublicId) {
    request.observability.recordSecurityEvent({
      name: "portal_auth_mismatch",
      severity: "warn",
      route: request.path,
      errorCode: "reservation_id_mismatch",
    });
    throw new ApiError(403, "forbidden", "You are not authorized to access this reservation.");
  }

  if (config.portalSessions) {
    const storedSession = await config.portalSessions.touchActiveSession({
      token,
      reservationPublicId,
      seenAt: new Date().toISOString(),
    });
    if (!storedSession) {
      request.observability.recordSecurityEvent({
        name: "portal_auth_session_not_active",
        severity: "warn",
        route: request.path,
        errorCode: "portal_session_not_active",
      });
      throw new ApiError(401, "unauthorized", "Invalid or expired session token.");
    }
  } else if (portalSessionPersistenceRequired(config)) {
    throw new ApiError(503, "database_unavailable", "Portal session storage is not configured.", {
      retryable: true,
    });
  }

  const session = await requireBookingSessionRepository(config).getByReservationPublicId(reservationPublicId);
  if (!session) {
    throw new ApiError(404, "not_found", "Reservation not found.");
  }

  return session;
}

function buildReservationResponse(
  session: BookingSessionRecord,
  hold: HoldRecord | undefined,
  payment: PaymentRecord | undefined
) {
  const property = session.propertyId ? BOOKING_PROPERTIES_BY_ID.get(session.propertyId) : undefined;
  const eligibility = evaluateCancellationEligibility({ session });

  return {
    reservation: {
      reservationPublicId: session.reservationPublicId,
      status: session.status,
      language: session.language,
      arrivalDate: session.arrivalDate,
      departureDate: session.departureDate,
      guests: session.guests,
      confirmedAt: session.confirmedAt,
      ratePlan: session.ratePlan ?? null,
      hasPet: session.hasPet === true,
      // The frontend renders from these rather than re-deriving the policy, so
      // the button a guest sees always matches what the server will allow.
      cancellation: {
        cancellable: eligibility.allowed,
        deadline: eligibility.deadline,
        ...(eligibility.allowed ? {} : { reasonCode: eligibility.reason }),
      },
      availableActions: availablePortalActions(session),
      ...(session.cancelledAt ? { cancelledAt: session.cancelledAt } : {}),
      ...(session.cancellationReason ? { cancellationReason: session.cancellationReason } : {}),
      ...(property
        ? {
            property: {
              propertyId: property.propertyId,
              slug: property.slug,
              name: property.name,
              listingUrl: listingUrlForLanguage(property.slug, session.language),
              guestCapacity: property.guestCapacity,
              thumbnailUrl: property.thumbnailUrl,
              amenities: property.amenities,
            },
          }
        : {}),
      ...(session.currency && session.totalAmountCents !== undefined
        ? {
            price: {
              currency: session.currency,
              totalAmountCents: session.totalAmountCents,
            },
          }
        : {}),
      ...(session.guest
        ? {
            guest: {
              firstName: session.guest.firstName,
              lastName: session.guest.lastName,
              email: session.guest.email,
            },
          }
        : {}),
    },
    hold: hold
      ? {
          status: hold.status,
          expiresAt: hold.expiresAt,
          smoobuReservationId: hold.smoobuReservationId,
        }
      : null,
    payment: buildPaymentSummary(session, payment),
  };
}

/**
 * Manual-deposit bookings never create a `payments` row — the money arrives by
 * bank transfer and is verified by a human, so there is no provider record to
 * store. Returning null made the portal render "Not available" next to a booking
 * the guest has actually paid for, so the state is synthesized from the session.
 */
function buildPaymentSummary(session: BookingSessionRecord, payment: PaymentRecord | undefined) {
  if (payment) {
    return {
      method: "paypal",
      status: payment.status,
      paypalOrderId: payment.paypalOrderId,
      currency: payment.currency,
      totalAmountCents: payment.totalAmountCents,
      capturedAt: payment.capturedAt,
    };
  }

  if (session.paymentMethod !== "manual_deposit") {
    return null;
  }

  return {
    method: "manual_deposit",
    status: session.status === "booking_confirmed" ? "paid" : "pending",
    ...(session.currency ? { currency: session.currency } : {}),
    ...(session.totalAmountCents !== undefined ? { totalAmountCents: session.totalAmountCents } : {}),
    ...(session.confirmedAt ? { capturedAt: session.confirmedAt } : {}),
  };
}

// ── repository helpers ────────────────────────────────────────────────────────

function requireBookingSessionRepository(config: BookingApiConfig): BookingSessionRepository {
  if (!config.bookingSessions) {
    throw new ApiError(503, "database_unavailable", "Booking session storage is not configured.", {
      retryable: true,
    });
  }
  return config.bookingSessions;
}

function requireHoldRepository(config: BookingApiConfig): HoldRepository {
  if (!config.holds) {
    throw new ApiError(503, "database_unavailable", "Hold storage is not configured.", {
      retryable: true,
    });
  }
  return config.holds;
}

function requirePaymentRepository(config: BookingApiConfig): PaymentRepository {
  if (!config.payments) {
    throw new ApiError(503, "database_unavailable", "Payment storage is not configured.", {
      retryable: true,
    });
  }
  return config.payments;
}

function portalSessionPersistenceRequired(config: BookingApiConfig): boolean {
  const environment = config.observability.environment.trim().toLowerCase();
  return environment === "prod" || environment === "production";
}

// ── i18n strings ──────────────────────────────────────────────────────────────

const portalStrings = {
  en: {
    helpRequestReceived:
      "We have your message. Our team will get back to you as soon as possible.",
    cancellationRequestReceived:
      "We have your cancellation request. Our team will review it and contact you shortly.",
    bookingCancelled:
      "We cancelled your booking and released the dates. Our team issues any refund due by hand.",
    guestCountUpdated:
      "Guest count updated.",
  },
  es: {
    helpRequestReceived:
      "Recibimos tu mensaje. Nuestro equipo se pondrá en contacto contigo lo antes posible.",
    cancellationRequestReceived:
      "Recibimos tu solicitud de cancelación. Nuestro equipo la revisará y se pondrá en contacto contigo en breve.",
    bookingCancelled:
      "Cancelamos tu reserva y liberamos las fechas. Nuestro equipo procesa a mano cualquier reembolso que corresponda.",
    guestCountUpdated:
      "Número de huéspedes actualizado.",
  },
} as const;
