import { createHash } from "crypto";
import { BookingSessionRecord, BookingSessionRepository } from "./bookingSessions";
import { createEmailClient } from "./email";
import { HoldRepository } from "./holds";
import { ApiError } from "./http/errors";
import { reportServerConversion } from "./serverConversions";
import { getHeader } from "./http/request";
import { jsonResponse } from "./http/response";
import { PaymentRecord, PaymentRepository } from "./payments";
import { createPayPalClient, PayPalProviderError } from "./paypalClient";
import { BOOKING_PROPERTIES_BY_ID, listingUrlForLanguage } from "./propertyCatalog";
import { promoteSmoobuReservation } from "./smoobuPromotion";
import { ApiResponse, BookingApiConfig, RouteObservability, RouteRequest } from "./types";

/**
 * Stable PayPal-Request-Id for a given client Idempotency-Key + session + phase.
 * Same inputs → same id, so a retried createOrder is deduplicated by PayPal.
 */
export function derivePaypalRequestId(idempotencyKey: string, bookingSessionId: string, phase: "order" | "capture"): string {
  return createHash("sha256").update(`${idempotencyKey}:${bookingSessionId}:${phase}`).digest("hex");
}

function getHoldRepository(config: BookingApiConfig): HoldRepository {
  if (!config.holds) {
    throw new ApiError(503, "database_unavailable", "Hold storage is not configured.", { retryable: true });
  }
  return config.holds;
}

// ─── Repository accessor ─────────────────────────────────────────────────────

export function getPaymentRepository(config: BookingApiConfig): PaymentRepository {
  if (!config.payments) {
    throw new ApiError(503, "database_unavailable", "Payment storage is not configured.", { retryable: true });
  }
  return config.payments;
}

// ─── POST /api/paypal/order ───────────────────────────────────────────────────

export async function handleCreatePayPalOrder(
  body: { bookingSessionId: string },
  request: RouteRequest,
  config: BookingApiConfig
): Promise<ApiResponse> {
  const idempotencyKey = getHeader(request.headers, "idempotency-key");
  if (!idempotencyKey) {
    throw new ApiError(400, "missing_idempotency_key", "Idempotency-Key header is required.");
  }

  const sessions = getRequiredBookingSessionRepository(config);
  const payments = getPaymentRepository(config);

  const session = await sessions.getById(body.bookingSessionId);
  if (!session) {
    throw new ApiError(404, "not_found", "Booking session was not found.");
  }

  // Idempotency: if an order already exists for this session, return it
  const existingPayment = await payments.getByBookingSessionId(session.id);
  if (existingPayment) {
    return handleExistingPayment(existingPayment, session, request);
  }

  // Session must be hold_active and not expired
  assertSessionReadyForPayment(session);

  const property = BOOKING_PROPERTIES_BY_ID.get(session.propertyId ?? "");
  if (!property) {
    throw new ApiError(409, "invalid_booking_state", "The booking session has no property associated.");
  }

  // Verify the hold is still active (not expired by the worker between now and request)
  const holds = getHoldRepository(config);
  const hold = await holds.getByBookingSessionId(session.id);
  if (!hold || hold.status !== "active") {
    throw new ApiError(409, "hold_no_longer_active", "The hold is no longer active.");
  }

  // Derive the PayPal-Request-Id deterministically from the client's
  // Idempotency-Key and the session, rather than a fresh UUID per attempt. If a
  // retry reaches createOrder again (e.g. the previous attempt created the order
  // on PayPal but crashed before persisting the payment row), PayPal sees the
  // same request id and returns the *same* order instead of creating a duplicate
  // (R7). The capture id is likewise stable and persisted for the capture step.
  const paypalRequestIdOrder = derivePaypalRequestId(idempotencyKey, session.id, "order");
  const paypalRequestIdCapture = derivePaypalRequestId(idempotencyKey, session.id, "capture");

  const paypalClient = await createPayPalClient(config);

  // Derive return/cancel URLs from the request's Origin header so the same
  // Lambda serves both localhost and production without env var changes.
  //
  // The SPA only bare-roots the "home" route for English (see pathForKey()
  // in src/routes.config.ts) — every other route, "book" included, is
  // registered under its locale prefix ("/en/book", "/es/book"). There is no
  // legacy redirect covering "/book" the way there is for prerendered
  // listing pages, so a bare "/book" path 404s.
  const requestOrigin = getHeader(request.headers, "origin")?.trim();
  const bookPath = session.language === "es" ? "/es/book" : "/en/book";
  const returnUrl = requestOrigin
    ? `${requestOrigin}${bookPath}/return`
    : config.paypal.orderReturnUrl;
  const cancelUrl = requestOrigin
    ? `${requestOrigin}${bookPath}`
    : config.paypal.orderCancelUrl;

  let paypalOrderResult: { orderId: string; approvalUrl: string };
  try {
    paypalOrderResult = await paypalClient.createOrder(
      {
        bookingSessionId: session.id,
        reservationPublicId: session.reservationPublicId,
        arrivalDate: session.arrivalDate,
        departureDate: session.departureDate,
        currency: session.currency ?? "USD",
        totalAmountCents: session.totalAmountCents ?? 0,
        propertyName: property.name,
        language: session.language,
        returnUrl,
        cancelUrl,
      },
      paypalRequestIdOrder,
      request.observability
    );
  } catch (error) {
    request.observability.recordStateTransition({
      entityType: "payment",
      toState: "failed",
      action: "paypal.order.create",
      success: false,
      bookingSessionId: session.id,
      reservationPublicId: session.reservationPublicId,
      provider: "paypal",
      errorCode: safeErrorCode(error),
      errorDetail: safeErrorDetail(error),
    });
    throw error;
  }

  // Persist payment record and advance session state atomically (best-effort in-memory;
  // in production these would be a single DB transaction)
  await payments.createOrderPayment({
    bookingSessionId: session.id,
    paypalOrderId: paypalOrderResult.orderId,
    paypalRequestIdOrder,
    paypalRequestIdCapture,
    currency: session.currency ?? "USD",
    totalAmountCents: session.totalAmountCents ?? 0,
  });

  const orderCreatedSession = await sessions.markPaypalOrderCreated({
    bookingSessionId: session.id,
    paypalOrderId: paypalOrderResult.orderId,
  });

  await reportServerConversion(
    "add_payment_info",
    orderCreatedSession,
    config.serverConversions,
    request.observability.logger
  );

  request.observability.recordStateTransition({
    entityType: "payment",
    toState: "order_created",
    action: "paypal.order.create",
    success: true,
    bookingSessionId: session.id,
    reservationPublicId: session.reservationPublicId,
    provider: "paypal",
    providerObjectId: paypalOrderResult.orderId,
  });

  request.observability.recordStateTransition({
    entityType: "booking_session",
    fromState: "hold_active",
    toState: "paypal_order_created",
    action: "paypal.order.create",
    success: true,
    bookingSessionId: session.id,
    reservationPublicId: session.reservationPublicId,
    provider: "paypal",
    providerObjectId: paypalOrderResult.orderId,
  });

  // Send payment_pending email — non-fatal
  const emailClient = createEmailClient(config.email, request.observability.logger);
  await emailClient.sendPaymentPending(session, property.name, paypalOrderResult.orderId);

  const responseBody = buildCreateOrderResponse(session, paypalOrderResult, property);
  return jsonResponse(200, responseBody, request.responseHeaders);
}

// ─── POST /api/paypal/capture ─────────────────────────────────────────────────

export async function handleCapturePayPalOrder(
  body: { bookingSessionId: string; paypalOrderId: string },
  request: RouteRequest,
  config: BookingApiConfig
): Promise<ApiResponse> {
  const idempotencyKey = getHeader(request.headers, "idempotency-key");
  if (!idempotencyKey) {
    throw new ApiError(400, "missing_idempotency_key", "Idempotency-Key header is required.");
  }

  const sessions = getRequiredBookingSessionRepository(config);
  const payments = getPaymentRepository(config);

  const session = await sessions.getById(body.bookingSessionId);
  if (!session) {
    throw new ApiError(404, "not_found", "Booking session was not found.");
  }

  const payment = await payments.getByBookingSessionId(session.id);
  if (!payment) {
    throw new ApiError(409, "invalid_booking_state", "No payment record found for this booking session.");
  }

  // Verify the caller-supplied orderId matches what we stored
  if (payment.paypalOrderId !== body.paypalOrderId) {
    throw new ApiError(409, "paypal_order_id_mismatch", "The provided PayPal order ID does not match the booking session.");
  }

  // Idempotency: already captured
  if (payment.status === "captured" && session.status === "booking_confirmed") {
    const property = BOOKING_PROPERTIES_BY_ID.get(session.propertyId ?? "");
    return jsonResponse(200, buildConfirmedResponse(session, payment, property), request.responseHeaders);
  }

  if (payment.status === "failed") {
    throw new ApiError(409, "payment_already_failed", "This payment has already failed. Please start a new booking.");
  }

  // Session must be paypal_order_created and not expired
  assertSessionReadyForCapture(session);

  const property = BOOKING_PROPERTIES_BY_ID.get(session.propertyId ?? "");
  if (!property) {
    throw new ApiError(409, "invalid_booking_state", "The booking session has no property associated.");
  }

  const paypalClient = await createPayPalClient(config);

  let captureResult: { captureId: string; status: string; currency: string; amountCents: number };
  try {
    captureResult = await paypalClient.captureOrder(
      payment.paypalOrderId,
      payment.paypalRequestIdCapture,
      request.observability
    );
  } catch (error) {
    // Mark payment as failed for non-retryable payment declines
    if (isPaymentDeclined(error)) {
      await payments.markFailed(session.id);
      await sessions.markFailed({ bookingSessionId: session.id, reason: safeErrorCode(error) });

      request.observability.recordStateTransition({
        entityType: "payment",
        fromState: "order_created",
        toState: "failed",
        action: "paypal.order.capture",
        success: false,
        bookingSessionId: session.id,
        reservationPublicId: session.reservationPublicId,
        provider: "paypal",
        errorCode: safeErrorCode(error),
        errorDetail: safeErrorDetail(error),
      });
    }
    throw error;
  }

  const capturedAt = new Date().toISOString();

  await payments.markCaptured({
    bookingSessionId: session.id,
    paypalCaptureId: captureResult.captureId,
    capturedAt,
  });

  let confirmedSession: BookingSessionRecord;
  // Tracks whether *this* request is the one that made the transition, as
  // opposed to discovering it already happened (see the catch branch below).
  // Only the transitioning request should send the confirmation email — the
  // webhook path may equally have won that race, and it already sends its own.
  let justConfirmed = false;
  try {
    confirmedSession = await sessions.markBookingConfirmed({
      bookingSessionId: session.id,
      confirmedAt: capturedAt,
    });
    justConfirmed = true;
  } catch (error) {
    // A concurrent webhook or the reconciliation sweep may have confirmed this
    // session first; markBookingConfirmed's CAS then matches 0 rows and throws.
    // The payment did succeed, so treat an already-confirmed session as success
    // instead of surfacing a 500 to the guest (R3).
    const latest = await sessions.getById(session.id);
    if (latest?.status === "booking_confirmed") {
      confirmedSession = latest;
    } else {
      throw error;
    }
  }

  // Also reported from the webhook and the reconciliation sweep. Meta dedupes on
  // event_id and GA4 on transaction_id, so the booking still counts exactly once.
  await reportServerConversion(
    "purchase",
    confirmedSession,
    config.serverConversions,
    request.observability.logger
  );

  request.observability.recordStateTransition({
    entityType: "payment",
    fromState: "order_created",
    toState: "captured",
    action: "paypal.order.capture",
    success: true,
    bookingSessionId: session.id,
    reservationPublicId: session.reservationPublicId,
    provider: "paypal",
    providerObjectId: captureResult.captureId,
  });

  request.observability.recordStateTransition({
    entityType: "booking_session",
    fromState: "paypal_order_created",
    toState: "booking_confirmed",
    action: "paypal.order.capture",
    success: true,
    bookingSessionId: session.id,
    reservationPublicId: session.reservationPublicId,
    provider: "paypal",
    providerObjectId: captureResult.captureId,
  });

  // Promote the Smoobu reservation from Blocked channel to Direct booking.
  // Non-fatal: if this fails the booking is already captured in our DB.
  const holds = getHoldRepository(config);
  const hold = await holds.getByBookingSessionId(session.id).catch(() => undefined);
  if (hold) {
    // Move the hold to `converted` before the best-effort promotion runs, so the
    // expiry sweep can never cancel this now-paid booking's Smoobu reservation
    // even if promotion fails (R1). Fatal-safe: on any error we still attempt
    // promotion with the hold we have.
    const confirmedHold = await holds.markHoldConfirmed(hold.id).catch(() => hold);
    if (confirmedHold.status !== "converted") {
      request.observability.logger.error("booking_confirmed_hold_already_expired", {
        bookingSessionId: session.id,
        holdId: hold.id,
        holdStatus: confirmedHold.status,
      });
    }
    await promoteSmoobuReservation(
      {
        session,
        hold: confirmedHold,
        notice: buildPaypalConfirmedNotice(session, captureResult.captureId, capturedAt),
        amountCents: captureResult.amountCents,
      },
      holds,
      config,
      request.observability
    ).catch((err) => {
      request.observability.logger.warn("smoobu_promotion_unexpected_error", {
        bookingSessionId: session.id,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }

  // Send booking_confirmed email — non-fatal; must not affect the guest's
  // response. Only fires for the request that actually made the transition
  // (see `justConfirmed` above); the webhook path sends its own on the rare
  // race where it wins instead (paypalWebhooks.ts's early-return on an
  // already-`booking_confirmed` session prevents a double-send there too).
  if (justConfirmed) {
    try {
      const emailClient = createEmailClient(config.email, request.observability.logger);
      await emailClient.sendBookingConfirmed(confirmedSession, property.name, captureResult.captureId);
    } catch (emailError) {
      request.observability.logger.error("booking_confirmed_email_failed", {
        bookingSessionId: session.id,
        error: emailError instanceof Error ? emailError.message : String(emailError),
      });
    }
  }

  const updatedPayment = await payments.getByBookingSessionId(session.id);
  return jsonResponse(
    200,
    buildConfirmedResponse(confirmedSession, updatedPayment ?? payment, property),
    request.responseHeaders
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

export function buildPaypalConfirmedNotice(session: BookingSessionRecord, captureId: string, confirmedAt: string): string {
  return [
    `Confirmed — PayPal payment received.`,
    `Reservation ID: ${session.reservationPublicId}`,
    `PayPal capture: ${captureId}`,
    `Confirmed at: ${confirmedAt}`,
  ].join("\n");
}

function getRequiredBookingSessionRepository(config: BookingApiConfig): BookingSessionRepository {
  if (!config.bookingSessions) {
    throw new ApiError(503, "database_unavailable", "Booking session storage is not configured.", {
      retryable: true,
    });
  }
  return config.bookingSessions;
}

function assertSessionReadyForPayment(session: BookingSessionRecord): void {
  if (session.status !== "hold_active") {
    throw new ApiError(409, "invalid_booking_state", "This booking session is not in the hold_active state.");
  }

  if (session.expiresAt && Date.parse(session.expiresAt) <= Date.now()) {
    throw new ApiError(409, "hold_expired", "The hold has expired.");
  }
}

function assertSessionReadyForCapture(session: BookingSessionRecord): void {
  if (session.status !== "paypal_order_created") {
    throw new ApiError(409, "invalid_booking_state", "This booking session is not in the paypal_order_created state.");
  }

  if (session.expiresAt && Date.parse(session.expiresAt) <= Date.now()) {
    throw new ApiError(409, "hold_expired", "The hold has expired.");
  }
}

function handleExistingPayment(
  payment: PaymentRecord,
  session: BookingSessionRecord,
  request: RouteRequest
): ApiResponse {
  if (payment.status === "failed") {
    throw new ApiError(409, "payment_already_failed", "A previous payment attempt failed. Please start a new booking.");
  }

  if (payment.status === "captured") {
    const property = BOOKING_PROPERTIES_BY_ID.get(session.propertyId ?? "");
    return jsonResponse(200, buildConfirmedResponse(session, payment, property), request.responseHeaders);
  }

  // order_created — return the existing order for idempotent retry
  const property = BOOKING_PROPERTIES_BY_ID.get(session.propertyId ?? "");
  return jsonResponse(
    200,
    buildCreateOrderResponse(session, { orderId: payment.paypalOrderId, approvalUrl: "" }, property),
    request.responseHeaders
  );
}

function buildCreateOrderResponse(
  session: BookingSessionRecord,
  order: { orderId: string; approvalUrl: string },
  property: ReturnType<typeof BOOKING_PROPERTIES_BY_ID.get>
) {
  return {
    booking: {
      bookingSessionId: session.id,
      reservationPublicId: session.reservationPublicId,
      status: "paypal_order_created",
      language: session.language,
      arrivalDate: session.arrivalDate,
      departureDate: session.departureDate,
      guests: session.guests,
      ...(property
        ? {
            property: {
              propertyId: property.propertyId,
              slug: property.slug,
              listingUrl: listingUrlForLanguage(property.slug, session.language),
              name: property.name,
            },
          }
        : {}),
      price: {
        currency: session.currency,
        totalAmountCents: session.totalAmountCents,
      },
      hold: {
        expiresAt: session.expiresAt,
      },
    },
    paypal: {
      orderId: order.orderId,
      approvalUrl: order.approvalUrl,
    },
    nextAction: "approve_paypal_order",
  };
}

function buildConfirmedResponse(
  session: BookingSessionRecord,
  payment: PaymentRecord,
  property: ReturnType<typeof BOOKING_PROPERTIES_BY_ID.get>
) {
  return {
    booking: {
      bookingSessionId: session.id,
      reservationPublicId: session.reservationPublicId,
      status: "booking_confirmed",
      language: session.language,
      arrivalDate: session.arrivalDate,
      departureDate: session.departureDate,
      guests: session.guests,
      confirmedAt: session.confirmedAt,
      ...(property
        ? {
            property: {
              propertyId: property.propertyId,
              slug: property.slug,
              listingUrl: listingUrlForLanguage(property.slug, session.language),
              name: property.name,
            },
          }
        : {}),
      price: {
        currency: session.currency,
        totalAmountCents: session.totalAmountCents,
      },
    },
    payment: {
      method: "paypal",
      status: "captured",
      paypalOrderId: payment.paypalOrderId,
      paypalCaptureId: payment.paypalCaptureId,
      capturedAt: payment.capturedAt,
    },
  };
}

/** 402 = payment declined — mark the payment as permanently failed */
function isPaymentDeclined(error: unknown): boolean {
  if (error instanceof ApiError) {
    return error.statusCode === 402;
  }
  return false;
}

function safeErrorCode(error: unknown): string {
  if (error instanceof PayPalProviderError) return error.code;
  if (error instanceof ApiError) return error.code;
  if (error instanceof Error) return error.name;
  return "unknown_error";
}

function safeErrorDetail(error: unknown): string | undefined {
  if (error instanceof PayPalProviderError) return error.providerDetail;
  return undefined;
}
