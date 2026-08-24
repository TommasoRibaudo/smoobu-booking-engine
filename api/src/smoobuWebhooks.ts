import { createHash, timingSafeEqual } from "crypto";
import { HoldRecord, HoldRepository } from "./holds";
import { ApiError } from "./http/errors";
import { getHeader } from "./http/request";
import { jsonResponse } from "./http/response";
import { invalidateCalendarRatesCacheFromWebhook } from "./calendar";
import { getWebhookEventRepository } from "./paypalWebhooks";
import { BOOKING_PROPERTIES_BY_SMOOBU_ID } from "./propertyCatalog";
import { ApiResponse, BookingApiConfig, JsonBody, RouteRequest } from "./types";

// ─── Smoobu webhook payload shapes ───────────────────────────────────────────

export type SmoobuWebhookAction =
  | "newReservation"
  | "cancelReservation"
  | "updateReservation"
  | "updateRates";

interface SmoobuWebhookPayload {
  action: SmoobuWebhookAction | string;
  data?: {
    id?: number;
    apartmentId?: number;
    reservationId?: number;
    arrival?: string;
    departure?: string;
    modifiedAt?: string;
    [key: string]: unknown;
  };
}

// ─── POST /api/webhooks/smoobu ────────────────────────────────────────────────

export async function handleSmoobuWebhook(
  request: RouteRequest,
  config: BookingApiConfig,
  body: JsonBody
): Promise<ApiResponse> {
  // Authenticate the webhook using a shared secret header.
  // Smoobu does not provide cryptographic signatures, so we rely on a
  // high-entropy shared secret passed in the X-Smoobu-Webhook-Secret header.
  await verifySmoobuWebhookSecret(request, config);

  const payload = parseSmoobuPayload(body);

  // 1. Cache invalidation for updateRates (handled inline for speed)
  if (payload.action === "updateRates") {
    return handleUpdateRates(request, body);
  }

  // 2. Dedupe — generate a stable dedupe key and insert
  const dedupeKey = buildDedupeKey(payload, request.rawBody);
  const webhookEvents = getWebhookEventRepository(config);
  const payloadHash = sha256(request.rawBody);

  const { inserted, record } = await webhookEvents.insertIfNew({
    provider: "smoobu",
    externalEventId: dedupeKey,
    eventType: payload.action,
    payloadHash,
    payload: body,
  });

  // Only short-circuit a redelivery once it has actually been processed; a row
  // left 'pending'/'failed' by a crashed prior delivery must be reprocessed
  // rather than swallowed (R8). Action handlers are idempotent / CAS-guarded.
  if (!inserted && record.status === "processed") {
    request.observability.recordStateTransition({
      entityType: "webhook_event",
      toState: "duplicate",
      action: `smoobu.webhook.${payload.action}`,
      success: true,
      provider: "smoobu",
      providerObjectId: payload.data?.reservationId != null ? String(payload.data.reservationId) : undefined,
    });
    return jsonResponse(200, { received: true, duplicate: true }, request.responseHeaders);
  }

  // 3. Route to action-specific handler
  try {
    await applySmoobuWebhookEvent(payload, config, request);
    await webhookEvents.markProcessed("smoobu", dedupeKey, "processed");
  } catch (error) {
    await webhookEvents.markProcessed("smoobu", dedupeKey, "failed");
    throw error;
  }

  return jsonResponse(200, { received: true }, request.responseHeaders);
}

// ─── Action routing ───────────────────────────────────────────────────────────

async function applySmoobuWebhookEvent(
  payload: SmoobuWebhookPayload,
  config: BookingApiConfig,
  request: RouteRequest
): Promise<void> {
  switch (payload.action) {
    case "cancelReservation":
      await handleCancelReservation(payload, config, request);
      break;

    case "newReservation":
      await handleNewReservation(payload, config, request);
      break;

    case "updateReservation":
      await handleUpdateReservation(payload, config, request);
      break;

    default:
      // Unknown action — acknowledge and ignore
      request.observability.recordStateTransition({
        entityType: "webhook_event",
        toState: "ignored",
        action: `smoobu.webhook.${payload.action}`,
        success: true,
        provider: "smoobu",
      });
      break;
  }
}

// ─── updateRates ──────────────────────────────────────────────────────────────

async function handleUpdateRates(request: RouteRequest, body: JsonBody): Promise<ApiResponse> {
  const cacheInvalidation = await invalidateCalendarRatesCacheFromWebhook(body, request.observability);
  return jsonResponse(
    200,
    {
      received: true,
      action: "updateRates",
      cache: { invalidatedEntries: cacheInvalidation.invalidatedEntries },
    },
    request.responseHeaders
  );
}

// ─── cancelReservation ────────────────────────────────────────────────────────

async function handleCancelReservation(
  payload: SmoobuWebhookPayload,
  config: BookingApiConfig,
  request: RouteRequest
): Promise<void> {
  const reservationId = payload.data?.reservationId ?? payload.data?.id;
  if (reservationId == null) {
    request.observability.recordStateTransition({
      entityType: "webhook_event",
      toState: "ignored",
      action: "smoobu.webhook.cancelReservation",
      success: false,
      provider: "smoobu",
      errorCode: "missing_reservation_id",
    });
    return;
  }

  const hold = await findHoldBySmoobuReservationId(config, reservationId);
  if (!hold) {
    // External reservation not managed by us — log for audit
    request.observability.recordStateTransition({
      entityType: "webhook_event",
      toState: "ignored",
      action: "smoobu.webhook.cancelReservation",
      success: true,
      provider: "smoobu",
      providerObjectId: String(reservationId),
      errorCode: "hold_not_found",
    });
    return;
  }

  // Already in a terminal state — idempotent
  if (hold.status === "cancelled" || hold.status === "expired" || hold.status === "converted") {
    request.observability.recordStateTransition({
      entityType: "hold",
      fromState: hold.status,
      toState: hold.status,
      action: "smoobu.webhook.cancelReservation",
      success: true,
      bookingSessionId: hold.bookingSessionId,
      provider: "smoobu",
      providerObjectId: String(reservationId),
    });
    return;
  }

  // Cancel the hold
  const holds = getHoldRepository(config);
  await holds.cancelHold(hold.id);

  // Fail the associated booking session
  const sessions = config.bookingSessions;
  if (!sessions) {
    throw new ApiError(503, "database_unavailable", "Booking storage is not configured.", { retryable: true });
  }
  const session = await sessions.getById(hold.bookingSessionId);
  if (session && session.status !== "booking_confirmed" && session.status !== "failed") {
    await sessions.markFailed({
      bookingSessionId: hold.bookingSessionId,
      reason: "smoobu_cancellation",
    });
  }

  request.observability.recordStateTransition({
    entityType: "hold",
    fromState: hold.status,
    toState: "cancelled",
    action: "smoobu.webhook.cancelReservation",
    success: true,
    bookingSessionId: hold.bookingSessionId,
    provider: "smoobu",
    providerObjectId: String(reservationId),
  });
}

// ─── newReservation ───────────────────────────────────────────────────────────

async function handleNewReservation(
  payload: SmoobuWebhookPayload,
  config: BookingApiConfig,
  request: RouteRequest
): Promise<void> {
  const reservationId = payload.data?.reservationId ?? payload.data?.id;
  const apartmentId = payload.data?.apartmentId;

  // Log for audit — external reservations created outside our engine
  // affect availability for our holds. Invalidate cache for the property.
  if (apartmentId != null) {
    const property = BOOKING_PROPERTIES_BY_SMOOBU_ID.get(apartmentId);
    if (property) {
      // Invalidate all cached months for this apartment so the next availability
      // check reflects the new external booking immediately.
      await invalidateCalendarRatesCacheFromWebhook(
        { action: "updateRates", data: { apartmentId } },
        request.observability
      );
      request.observability.recordStateTransition({
        entityType: "webhook_event",
        toState: "processed",
        action: "smoobu.webhook.newReservation",
        success: true,
        provider: "smoobu",
        providerObjectId: reservationId != null ? String(reservationId) : undefined,
      });
    } else {
      request.observability.recordStateTransition({
        entityType: "webhook_event",
        toState: "ignored",
        action: "smoobu.webhook.newReservation",
        success: true,
        provider: "smoobu",
        providerObjectId: reservationId != null ? String(reservationId) : undefined,
        errorCode: "unknown_apartment",
      });
    }
  } else {
    request.observability.recordStateTransition({
      entityType: "webhook_event",
      toState: "ignored",
      action: "smoobu.webhook.newReservation",
      success: true,
      provider: "smoobu",
      errorCode: "missing_apartment_id",
    });
  }
}

// ─── updateReservation ────────────────────────────────────────────────────────

async function handleUpdateReservation(
  payload: SmoobuWebhookPayload,
  config: BookingApiConfig,
  request: RouteRequest
): Promise<void> {
  const reservationId = payload.data?.reservationId ?? payload.data?.id;
  if (reservationId == null) {
    request.observability.recordStateTransition({
      entityType: "webhook_event",
      toState: "ignored",
      action: "smoobu.webhook.updateReservation",
      success: false,
      provider: "smoobu",
      errorCode: "missing_reservation_id",
    });
    return;
  }

  const hold = await findHoldBySmoobuReservationId(config, reservationId);
  if (!hold) {
    // External reservation — log for audit only
    request.observability.recordStateTransition({
      entityType: "webhook_event",
      toState: "ignored",
      action: "smoobu.webhook.updateReservation",
      success: true,
      provider: "smoobu",
      providerObjectId: String(reservationId),
      errorCode: "hold_not_found",
    });
    return;
  }

  // For managed reservations, log the update for reconciliation.
  // Risky state transitions should re-fetch Smoobu state rather than
  // trusting the webhook payload alone (per API contract).
  request.observability.recordStateTransition({
    entityType: "webhook_event",
    toState: "processed",
    action: "smoobu.webhook.updateReservation",
    success: true,
    bookingSessionId: hold.bookingSessionId,
    provider: "smoobu",
    providerObjectId: String(reservationId),
  });
}

// ─── Smoobu webhook authentication ────────────────────────────────────────────

/**
 * Verifies the Smoobu webhook shared secret.
 *
 * The secret is passed in the `X-Smoobu-Webhook-Secret` header and compared
 * against the value stored in Secrets Manager using a timing-safe comparison
 * to prevent timing-based secret extraction.
 */
async function verifySmoobuWebhookSecret(
  request: RouteRequest,
  config: BookingApiConfig
): Promise<void> {
  const { smoobuWebhookSecret } = await config.secrets.getSecrets();

  const providedSecret = getHeader(request.headers, "x-smoobu-webhook-secret");

  if (!providedSecret) {
    request.observability.recordSecurityEvent({
      name: "smoobu_webhook_missing_secret",
      severity: "warn",
      route: "/api/webhooks/smoobu",
      provider: "smoobu",
    });
    throw new ApiError(401, "webhook_unauthorized", "Smoobu webhook secret is missing.");
  }

  const expected = Buffer.from(smoobuWebhookSecret, "utf8");
  const provided = Buffer.from(providedSecret, "utf8");

  // Timing-safe comparison: pad to equal length to prevent length-based leaks
  const maxLen = Math.max(expected.length, provided.length);
  const paddedExpected = Buffer.alloc(maxLen);
  const paddedProvided = Buffer.alloc(maxLen);
  expected.copy(paddedExpected);
  provided.copy(paddedProvided);

  if (expected.length !== provided.length || !timingSafeEqual(paddedExpected, paddedProvided)) {
    request.observability.recordSecurityEvent({
      name: "smoobu_webhook_invalid_secret",
      severity: "warn",
      route: "/api/webhooks/smoobu",
      provider: "smoobu",
    });
    throw new ApiError(401, "webhook_unauthorized", "Smoobu webhook secret is invalid.");
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function parseSmoobuPayload(body: JsonBody): SmoobuWebhookPayload {
  const action = typeof body.action === "string" ? body.action : undefined;
  if (!action) {
    throw new ApiError(400, "invalid_webhook_payload", "Smoobu webhook is missing action field.");
  }

  const data = typeof body.data === "object" && body.data !== null && !Array.isArray(body.data)
    ? (body.data as SmoobuWebhookPayload["data"])
    : undefined;

  return { action, data };
}

/**
 * Build a stable dedupe key for Smoobu webhooks.
 * Smoobu does not provide a guaranteed unique event ID, so we compose one from:
 *   action : reservationId|apartmentId : payloadHash
 */
function buildDedupeKey(payload: SmoobuWebhookPayload, rawBody: string): string {
  const action = payload.action;
  const objectId = payload.data?.reservationId ?? payload.data?.id ?? payload.data?.apartmentId ?? "unknown";
  const hash = sha256(rawBody).slice(0, 16);
  return `${action}:${objectId}:${hash}`;
}

async function findHoldBySmoobuReservationId(
  config: BookingApiConfig,
  smoobuReservationId: number
): Promise<HoldRecord | undefined> {
  const holds = getHoldRepository(config);
  return holds.getBySmoobuReservationId(smoobuReservationId);
}

function getHoldRepository(config: BookingApiConfig): HoldRepository {
  if (!config.holds) {
    throw new ApiError(503, "database_unavailable", "Hold storage is not configured.", {
      retryable: true,
    });
  }
  return config.holds;
}

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}
