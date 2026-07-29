import { createHash, randomUUID } from "crypto";
import { BookingSessionRepository } from "./bookingSessions";
import { createEmailClient } from "./email";
import { HoldRepository } from "./holds";
import { ApiError } from "./http/errors";
import { reportServerConversion } from "./serverConversions";
import { getHeader } from "./http/request";
import { jsonResponse } from "./http/response";
import { PaymentRepository } from "./payments";
import { BOOKING_PROPERTIES_BY_ID } from "./propertyCatalog";
import { createPayPalClient, PayPalVerifySignatureInput } from "./paypalClient";
import { promoteSmoobuReservation } from "./smoobuPromotion";
import { ApiResponse, BookingApiConfig, RouteRequest } from "./types";

// ─── Webhook event repository ─────────────────────────────────────────────────

export type WebhookEventStatus = "pending" | "processed" | "duplicate" | "ignored" | "failed";

export interface WebhookEventRecord {
  id: string;
  provider: "paypal" | "smoobu";
  externalEventId: string;
  eventType: string;
  receivedAt: string;
  processedAt?: string;
  status: WebhookEventStatus;
  payloadHash: string;
}

export interface WebhookEventRepository {
  /** Returns true if the event was newly inserted; false if it was a duplicate. */
  insertIfNew(input: {
    provider: "paypal" | "smoobu";
    externalEventId: string;
    eventType: string;
    payloadHash: string;
    payload?: unknown;
  }): Promise<{ inserted: boolean; record: WebhookEventRecord }>;

  markProcessed(provider: "paypal" | "smoobu", externalEventId: string, status: WebhookEventStatus): Promise<void>;
}

interface Queryable {
  query<Row extends object = Record<string, unknown>>(text: string, values?: unknown[]): Promise<{ rows: Row[] }>;
}

interface WebhookEventRow {
  id: string;
  provider: "paypal" | "smoobu";
  external_event_id: string | null;
  dedupe_key: string;
  event_type: string;
  received_at: string | Date;
  processed_at: string | Date | null;
  processing_status: string;
  payload_hash: string;
}

const WEBHOOK_EVENT_COLUMNS = `
  id,
  provider,
  external_event_id,
  dedupe_key,
  event_type,
  received_at,
  processed_at,
  processing_status,
  payload_hash
`;

export class RdsWebhookEventRepository implements WebhookEventRepository {
  constructor(private readonly pool: Queryable) {}

  async insertIfNew(input: {
    provider: "paypal" | "smoobu";
    externalEventId: string;
    eventType: string;
    payloadHash: string;
    payload?: unknown;
  }): Promise<{ inserted: boolean; record: WebhookEventRecord }> {
    const payload = input.payload === undefined ? {} : input.payload;
    const result = await this.pool.query<WebhookEventRow>(
      `
        insert into webhook_events (
          provider,
          external_event_id,
          dedupe_key,
          event_type,
          payload_hash,
          payload,
          processing_status,
          received_at,
          updated_at
        )
        values ($1, $2, $2, $3, $4, $5::jsonb, 'pending', now(), now())
        on conflict do nothing
        returning ${WEBHOOK_EVENT_COLUMNS}
      `,
      [
        input.provider,
        input.externalEventId,
        input.eventType,
        input.payloadHash,
        JSON.stringify(payload),
      ]
    );

    if (result.rows[0]) {
      return { inserted: true, record: mapWebhookEventRow(result.rows[0]) };
    }

    const existing = await this.pool.query<WebhookEventRow>(
      `
        select ${WEBHOOK_EVENT_COLUMNS}
        from webhook_events
        where provider = $1
          and (external_event_id = $2 or dedupe_key = $2)
        limit 1
      `,
      [input.provider, input.externalEventId]
    );

    if (!existing.rows[0]) {
      throw new Error(`Webhook event ${input.provider}:${input.externalEventId} conflicted but was not found.`);
    }

    return { inserted: false, record: mapWebhookEventRow(existing.rows[0]) };
  }

  async markProcessed(provider: "paypal" | "smoobu", externalEventId: string, status: WebhookEventStatus): Promise<void> {
    await this.pool.query(
      `
        update webhook_events
        set
          processing_status = $3,
          processed_at = now(),
          updated_at = now()
        where provider = $1
          and (external_event_id = $2 or dedupe_key = $2)
      `,
      [provider, externalEventId, status]
    );
  }
}

export class InMemoryWebhookEventRepository implements WebhookEventRepository {
  private readonly records = new Map<string, WebhookEventRecord>();

  async insertIfNew(input: {
    provider: "paypal" | "smoobu";
    externalEventId: string;
    eventType: string;
    payloadHash: string;
    payload?: unknown;
  }): Promise<{ inserted: boolean; record: WebhookEventRecord }> {
    const dedupeKey = `${input.provider}:${input.externalEventId}`;
    const existing = this.records.get(dedupeKey);
    if (existing) {
      return { inserted: false, record: existing };
    }

    const record: WebhookEventRecord = {
      id: randomUUID(),
      provider: input.provider,
      externalEventId: input.externalEventId,
      eventType: input.eventType,
      receivedAt: new Date().toISOString(),
      status: "pending",
      payloadHash: input.payloadHash,
    };
    this.records.set(dedupeKey, record);
    return { inserted: true, record };
  }

  async markProcessed(provider: "paypal" | "smoobu", externalEventId: string, status: WebhookEventStatus): Promise<void> {
    const key = `${provider}:${externalEventId}`;
    const existing = this.records.get(key);
    if (existing) {
      this.records.set(key, {
        ...existing,
        status,
        processedAt: new Date().toISOString(),
      });
    }
  }
}

// ─── PayPal webhook event shapes ──────────────────────────────────────────────

interface PayPalWebhookEvent {
  id?: string;
  event_type?: string;
  resource?: {
    id?: string;
    status?: string;
    custom_id?: string;
    purchase_units?: Array<{
      reference_id?: string;
      custom_id?: string;
      payments?: {
        captures?: Array<{
          id?: string;
          status?: string;
          amount?: { currency_code?: string; value?: string };
        }>;
      };
    }>;
  };
}

// ─── Replay protection ────────────────────────────────────────────────────────

/**
 * Maximum age (in milliseconds) of a PayPal webhook transmission timestamp
 * used to detect clock-skew anomalies.
 *
 * PayPal retries failed webhook deliveries for up to 3 days, and each retry
 * carries the *original* transmission-time. A 4-day window therefore accepts
 * all legitimate retries while still flagging timestamps that are clearly
 * anomalous (e.g. replayed events from months ago).
 *
 * Note: primary replay protection is the deduplication store (insertIfNew).
 * This check is a secondary defence against grossly out-of-range timestamps.
 */
export const PAYPAL_WEBHOOK_MAX_AGE_MS = 4 * 24 * 60 * 60 * 1000; // 4 days

/**
 * Returns true if the paypal-transmission-time header is within the allowed
 * window relative to `nowMs`.
 */
export function isPayPalTransmissionTimeValid(
  transmissionTime: string | undefined,
  nowMs: number = Date.now()
): boolean {
  if (!transmissionTime) {
    return false;
  }

  const eventMs = new Date(transmissionTime).getTime();
  if (Number.isNaN(eventMs)) {
    return false;
  }

  return Math.abs(nowMs - eventMs) <= PAYPAL_WEBHOOK_MAX_AGE_MS;
}

// ─── Signature verification ───────────────────────────────────────────────────

/**
 * Verifies a PayPal webhook signature using the postback (online) method.
 * Calls PayPal's POST /v1/notifications/verify-webhook-signature endpoint.
 *
 * Returns:
 *  - "valid"     — signature verified successfully
 *  - "invalid"   — PayPal returned FAILURE (forged or tampered webhook)
 *  - "error"     — transient provider error (network, 5xx); caller should 503
 */
export async function verifyPayPalWebhookSignature(
  request: RouteRequest,
  config: BookingApiConfig,
  webhookId: string
): Promise<"valid" | "invalid" | "error"> {
  const authAlgo = getHeader(request.headers, "paypal-auth-algo");
  const certUrl = getHeader(request.headers, "paypal-cert-url");
  const transmissionId = getHeader(request.headers, "paypal-transmission-id");
  const transmissionSig = getHeader(request.headers, "paypal-transmission-sig");
  const transmissionTime = getHeader(request.headers, "paypal-transmission-time");

  if (!authAlgo || !certUrl || !transmissionId || !transmissionSig || !transmissionTime) {
    return "invalid";
  }

  let parsedEvent: unknown;
  try {
    parsedEvent = JSON.parse(request.rawBody);
  } catch {
    return "invalid";
  }

  const verifyPayload: PayPalVerifySignatureInput = {
    auth_algo: authAlgo,
    cert_url: certUrl,
    transmission_id: transmissionId,
    transmission_sig: transmissionSig,
    transmission_time: transmissionTime,
    webhook_id: webhookId,
    webhook_event: parsedEvent,
  };

  const paypalClient = await createPayPalClient(config);

  try {
    // PayPalClient.verifyWebhookSignature already records the provider call metric
    const result = await paypalClient.verifyWebhookSignature(verifyPayload, request.observability);
    return result.verification_status === "SUCCESS" ? "valid" : "invalid";
  } catch (error) {
    // Provider error (network timeout, 5xx) — distinguish from a forged webhook
    request.observability.recordSecurityEvent({
      name: "paypal_webhook_verify_provider_error",
      severity: "error",
      route: "/api/webhooks/paypal",
      provider: "paypal",
      errorCode: error instanceof ApiError ? error.code : "unknown_error",
    });
    return "error";
  }
}

// ─── POST /api/webhooks/paypal ────────────────────────────────────────────────

export async function handlePayPalWebhook(
  request: RouteRequest,
  config: BookingApiConfig
): Promise<ApiResponse> {
  const { paypalWebhookId } = await config.secrets.getSecrets();

  // 1. Verify signature
  //    - "valid"   → proceed
  //    - "invalid" → reject with 400 (security event)
  //    - "error"   → reject with 503 so PayPal retries (transient provider failure)
  const signatureResult = await verifyPayPalWebhookSignature(request, config, paypalWebhookId);

  if (signatureResult === "error") {
    // Transient failure talking to PayPal's verify API — return 503 so PayPal retries
    throw new ApiError(503, "webhook_verify_unavailable", "PayPal signature verification service is temporarily unavailable.", {
      retryable: true,
    });
  }

  if (signatureResult === "invalid") {
    request.observability.recordSecurityEvent({
      name: "paypal_webhook_invalid_signature",
      severity: "warn",
      route: "/api/webhooks/paypal",
      provider: "paypal",
    });
    throw new ApiError(400, "webhook_signature_invalid", "PayPal webhook signature verification failed.");
  }

  // 2. Replay protection — reject events with a transmission-time outside the
  //    allowed window. Legitimate PayPal retries carry the *original*
  //    transmission-time; a 4-day window covers all retry scenarios while
  //    flagging clearly anomalous timestamps (e.g. months-old replays).
  //    Primary replay protection is the deduplication store (step 4).
  //    Return 200 so PayPal does not keep retrying a stale-but-verified event.
  if (!isPayPalTransmissionTimeValid(getHeader(request.headers, "paypal-transmission-time"))) {
    request.observability.recordSecurityEvent({
      name: "paypal_webhook_replay_rejected",
      severity: "warn",
      route: "/api/webhooks/paypal",
      provider: "paypal",
    });
    return jsonResponse(200, { received: true, stale: true }, request.responseHeaders);
  }

  // 3. Parse event
  let event: PayPalWebhookEvent;
  try {
    event = JSON.parse(request.rawBody) as PayPalWebhookEvent;
  } catch {
    throw new ApiError(400, "invalid_json", "Webhook body is not valid JSON.");
  }

  const externalEventId = event.id;
  const eventType = event.event_type;

  if (!externalEventId || !eventType) {
    throw new ApiError(400, "invalid_webhook_payload", "Webhook event is missing id or event_type.");
  }

  // 4. Dedupe — idempotent insert
  const webhookEvents = getWebhookEventRepository(config);
  const payloadHash = sha256(request.rawBody);
  const { inserted } = await webhookEvents.insertIfNew({
    provider: "paypal",
    externalEventId,
    eventType,
    payloadHash,
    payload: event,
  });

  if (!inserted) {
    request.observability.recordStateTransition({
      entityType: "webhook_event",
      toState: "duplicate",
      action: `paypal.webhook.${eventType}`,
      success: true,
      provider: "paypal",
      providerObjectId: externalEventId,
    });
    return jsonResponse(200, { received: true, duplicate: true }, request.responseHeaders);
  }

  // 5. Apply state transitions
  try {
    await applyPayPalWebhookEvent(event, config, request);
    await webhookEvents.markProcessed("paypal", externalEventId, "processed");
  } catch (error) {
    await webhookEvents.markProcessed("paypal", externalEventId, "failed");
    throw error;
  }

  return jsonResponse(200, { received: true }, request.responseHeaders);
}

// ─── State machine transitions ────────────────────────────────────────────────

async function applyPayPalWebhookEvent(
  event: PayPalWebhookEvent,
  config: BookingApiConfig,
  request: RouteRequest
): Promise<void> {
  const eventType = event.event_type ?? "";

  switch (eventType) {
    case "PAYMENT.CAPTURE.COMPLETED":
      await handleCaptureCompleted(event, config, request);
      break;

    case "PAYMENT.CAPTURE.DENIED":
    case "PAYMENT.CAPTURE.REVERSED":
      await handleCaptureFailed(event, config, request, eventType);
      break;

    case "CHECKOUT.ORDER.APPROVED":
      // Buyer approved the order — no state change needed; capture is triggered by the
      // frontend calling POST /api/paypal/capture. Log for observability only.
      request.observability.recordStateTransition({
        entityType: "webhook_event",
        toState: "ignored",
        action: `paypal.webhook.${eventType}`,
        success: true,
        provider: "paypal",
        providerObjectId: event.id,
      });
      break;

    default:
      // Unknown event type — acknowledge and ignore
      request.observability.recordStateTransition({
        entityType: "webhook_event",
        toState: "ignored",
        action: `paypal.webhook.${eventType}`,
        success: true,
        provider: "paypal",
        providerObjectId: event.id,
      });
      break;
  }
}

// PAYPAL webhook `resource` shapes differ by event type. ORDER-shaped
// resources (e.g. CHECKOUT.ORDER.APPROVED) carry purchase_units, where
// reference_id is the internal bookingSessionId and custom_id is nested one
// level down. CAPTURE-shaped resources (e.g. PAYMENT.CAPTURE.COMPLETED) have
// no purchase_units at all — custom_id sits directly on the resource, and it
// carries the reservationPublicId (KWL-XXXXXXXX), not the bookingSessionId.
// Real PayPal payloads confirmed this during the live-acceptance-test.md pass;
// the existing mocks only exercised the ORDER shape, so this was invisible to
// every unit test.
async function resolveSessionFromWebhookResource(
  event: PayPalWebhookEvent,
  sessions: BookingSessionRepository
): ReturnType<BookingSessionRepository["getById"]> {
  const bookingSessionId = event.resource?.purchase_units?.[0]?.reference_id;
  if (bookingSessionId) {
    const session = await sessions.getById(bookingSessionId);
    if (session) {
      return session;
    }
  }

  const reservationPublicId = event.resource?.purchase_units?.[0]?.custom_id ?? event.resource?.custom_id;
  if (reservationPublicId) {
    return sessions.getByReservationPublicId(reservationPublicId);
  }

  return undefined;
}

async function handleCaptureCompleted(
  event: PayPalWebhookEvent,
  config: BookingApiConfig,
  request: RouteRequest
): Promise<void> {
  const capture = event.resource?.purchase_units?.[0]?.payments?.captures?.[0];
  const captureId = capture?.id ?? event.resource?.id;

  if (!captureId) {
    request.observability.recordStateTransition({
      entityType: "webhook_event",
      toState: "ignored",
      action: "paypal.webhook.PAYMENT.CAPTURE.COMPLETED",
      success: false,
      provider: "paypal",
      errorCode: "missing_capture_id_or_session_id",
    });
    return;
  }

  const sessions = config.bookingSessions;
  if (!sessions) {
    throw new ApiError(503, "database_unavailable", "Booking storage is not configured.", { retryable: true });
  }
  const payments = getPaymentRepository(config);

  const session = await resolveSessionFromWebhookResource(event, sessions);
  if (!session) {
    request.observability.recordStateTransition({
      entityType: "webhook_event",
      toState: "ignored",
      action: "paypal.webhook.PAYMENT.CAPTURE.COMPLETED",
      success: false,
      provider: "paypal",
      errorCode: "session_not_found",
    });
    return;
  }

  // Already confirmed — idempotent
  if (session.status === "booking_confirmed") {
    request.observability.recordStateTransition({
      entityType: "booking_session",
      fromState: "booking_confirmed",
      toState: "booking_confirmed",
      action: "paypal.webhook.PAYMENT.CAPTURE.COMPLETED",
      success: true,
      bookingSessionId: session.id,
      reservationPublicId: session.reservationPublicId,
      provider: "paypal",
      providerObjectId: captureId,
    });
    return;
  }

  // Only transition from paypal_order_created
  if (session.status !== "paypal_order_created") {
    request.observability.recordStateTransition({
      entityType: "webhook_event",
      toState: "ignored",
      action: "paypal.webhook.PAYMENT.CAPTURE.COMPLETED",
      success: false,
      bookingSessionId: session.id,
      provider: "paypal",
      errorCode: `unexpected_session_status_${session.status}`,
    });
    return;
  }

  const confirmedAt = new Date().toISOString();

  await payments.markCaptured({
    bookingSessionId: session.id,
    paypalCaptureId: captureId,
    capturedAt: confirmedAt,
  });

  const confirmedSession = await sessions.markBookingConfirmed({
    bookingSessionId: session.id,
    confirmedAt,
  });

  await reportServerConversion(
    "purchase",
    confirmedSession,
    config.serverConversions,
    request.observability.logger
  );

  request.observability.recordStateTransition({
    entityType: "booking_session",
    fromState: "paypal_order_created",
    toState: "booking_confirmed",
    action: "paypal.webhook.PAYMENT.CAPTURE.COMPLETED",
    success: true,
    bookingSessionId: session.id,
    reservationPublicId: session.reservationPublicId,
    provider: "paypal",
    providerObjectId: captureId,
  });

  // Promote the Smoobu reservation from Blocked channel to Direct booking.
  // Non-fatal: must not affect webhook 2xx response.
  try {
    const holds = getHoldRepository(config);
    if (holds) {
      const hold = await holds.getByBookingSessionId(session.id).catch(() => undefined);
      if (hold) {
        // Extract amount from webhook event; fall back to session totalAmountCents
        const captureAmount = capture?.amount?.value
          ? Math.round(parseFloat(capture.amount.value) * 100)
          : session.totalAmountCents ?? 0;

        await promoteSmoobuReservation(
          {
            session,
            hold,
            captureId,
            amountCents: captureAmount,
            confirmedAt,
          },
          holds,
          config,
          request.observability
        );
      }
    }
  } catch (promoError) {
    request.observability.logger.warn("smoobu_promotion_webhook_error", {
      bookingSessionId: session.id,
      error: promoError instanceof Error ? promoError.message : String(promoError),
    });
  }

  // Send booking_confirmed email — non-fatal; must not affect webhook 2xx response
  try {
    const property = BOOKING_PROPERTIES_BY_ID.get(session.propertyId ?? "");
    const emailClient = createEmailClient(config.email, request.observability.logger);
    await emailClient.sendBookingConfirmed(
      { ...session, confirmedAt, status: "booking_confirmed" },
      property?.name ?? session.propertyId ?? "",
      captureId
    );
  } catch (emailError) {
    request.observability.logger.error("booking_confirmed_email_failed", {
      bookingSessionId: session.id,
      error: emailError instanceof Error ? emailError.message : String(emailError),
    });
  }
}

async function handleCaptureFailed(
  event: PayPalWebhookEvent,
  config: BookingApiConfig,
  request: RouteRequest,
  eventType: string
): Promise<void> {
  const sessions = config.bookingSessions;
  if (!sessions) {
    throw new ApiError(503, "database_unavailable", "Booking storage is not configured.", { retryable: true });
  }
  const payments = getPaymentRepository(config);

  const session = await resolveSessionFromWebhookResource(event, sessions);
  if (!session) {
    request.observability.recordStateTransition({
      entityType: "webhook_event",
      toState: "ignored",
      action: `paypal.webhook.${eventType}`,
      success: false,
      provider: "paypal",
      errorCode: "missing_session_id",
    });
    return;
  }

  // Already in a terminal state — skip
  if (session.status === "booking_confirmed" || session.status === "failed") {
    return;
  }

  await payments.markFailed(session.id);
  await sessions.markFailed({ bookingSessionId: session.id, reason: eventType.toLowerCase() });

  request.observability.recordStateTransition({
    entityType: "booking_session",
    fromState: session.status,
    toState: "failed",
    action: `paypal.webhook.${eventType}`,
    success: true,
    bookingSessionId: session.id,
    reservationPublicId: session.reservationPublicId,
    provider: "paypal",
    providerObjectId: event.resource?.id,
  });
}

// ─── Repository accessors ─────────────────────────────────────────────────────

export function getWebhookEventRepository(config: BookingApiConfig): WebhookEventRepository {
  if (!config.webhookEvents) {
    throw new ApiError(503, "database_unavailable", "Webhook event storage is not configured.", {
      retryable: true,
    });
  }
  return config.webhookEvents;
}

function getBookingSessionRepository(config: BookingApiConfig): BookingSessionRepository {
  if (!config.bookingSessions) {
    throw new ApiError(503, "database_unavailable", "Booking session storage is not configured.", {
      retryable: true,
    });
  }
  return config.bookingSessions;
}

function getPaymentRepository(config: BookingApiConfig): PaymentRepository {
  if (!config.payments) {
    throw new ApiError(503, "database_unavailable", "Payment storage is not configured.", {
      retryable: true,
    });
  }
  return config.payments;
}

function getHoldRepository(config: BookingApiConfig): HoldRepository | undefined {
  return config.holds ?? undefined;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function mapWebhookEventRow(row: WebhookEventRow): WebhookEventRecord {
  return {
    id: row.id,
    provider: row.provider,
    externalEventId: row.external_event_id ?? row.dedupe_key,
    eventType: row.event_type,
    receivedAt: toIsoString(row.received_at),
    ...(row.processed_at ? { processedAt: toIsoString(row.processed_at) } : {}),
    status: parseWebhookEventStatus(row.processing_status),
    payloadHash: row.payload_hash,
  };
}

function parseWebhookEventStatus(status: string): WebhookEventStatus {
  if (
    status === "pending" ||
    status === "processed" ||
    status === "duplicate" ||
    status === "ignored" ||
    status === "failed"
  ) {
    return status;
  }

  if (status === "received" || status === "verified" || status === "processing") {
    return "pending";
  }

  if (status === "rejected_signature") {
    return "failed";
  }

  throw new Error(`Unsupported webhook processing status from database: ${status}`);
}

function toIsoString(value: string | Date): string {
  if (value instanceof Date) {
    return value.toISOString();
  }

  const timestampMs = Date.parse(value);
  return Number.isNaN(timestampMs) ? value : new Date(timestampMs).toISOString();
}
