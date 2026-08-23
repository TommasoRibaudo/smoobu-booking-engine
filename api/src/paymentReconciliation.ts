import { BookingSessionRepository } from "./bookingSessions";
import { reportServerConversion, ServerConversionConfig } from "./serverConversions";
import { PaymentRecord, PaymentRepository } from "./payments";
import { PayPalClient, PayPalProviderError } from "./paypalClient";
import { ObservabilityLogger } from "./types";

// ─── Result types ─────────────────────────────────────────────────────────────

export interface ReconciliationResult {
  processed: number;
  confirmed: number;
  markedFailed: number;
  stillPending: number;
  providerErrors: number;
  errors: ReconciliationError[];
}

export interface ReconciliationError {
  bookingSessionId: string;
  paypalOrderId: string;
  phase: "fetch_order" | "confirm_session" | "fail_session";
  errorCode: string;
  message: string;
}

// ─── Dependencies ─────────────────────────────────────────────────────────────

export interface ReconciliationDependencies {
  payments: PaymentRepository;
  bookingSessions: BookingSessionRepository;
  paypalClient: PayPalClient;
  logger: ObservabilityLogger;
  now?: () => string;
  /** Max age in ms for a pending payment before it's considered stale. Default: 2h */
  staleThresholdMs?: number;
  /**
   * Optional — reports the recovered sale. This path only fires when a webhook
   * was missed, so without it those bookings would never reach Google or Meta.
   */
  serverConversions?: ServerConversionConfig;
}

const DEFAULT_STALE_THRESHOLD_MS = 2 * 60 * 60 * 1000; // 2 hours

/**
 * Periodic reconciliation job for "pending PayPal" sessions.
 *
 * Finds all payments in `order_created` status, queries PayPal for the
 * actual order state, and resolves discrepancies:
 *
 * - If PayPal says COMPLETED → confirm the booking (webhook was missed).
 * - If PayPal says VOIDED/expired/declined → mark as failed.
 * - If still APPROVED/CREATED and not stale → leave alone (still in progress).
 * - If still APPROVED/CREATED but stale (>2h) → mark as failed (abandoned).
 * - If PayPal API is unreachable → log and skip (retry next run).
 *
 * Designed to run on a schedule (e.g. every 5 minutes via EventBridge).
 * Each payment is processed independently so a single failure does not block others.
 */
export async function reconcilePendingPayments(
  deps: ReconciliationDependencies
): Promise<ReconciliationResult> {
  const { payments, bookingSessions, paypalClient, logger } = deps;
  const now = deps.now?.() ?? new Date().toISOString();
  const staleThresholdMs = deps.staleThresholdMs ?? DEFAULT_STALE_THRESHOLD_MS;

  const result: ReconciliationResult = {
    processed: 0,
    confirmed: 0,
    markedFailed: 0,
    stillPending: 0,
    providerErrors: 0,
    errors: [],
  };

  const pendingPayments = await payments.listByStatus("order_created");
  result.processed = pendingPayments.length;

  if (pendingPayments.length > 0) {
    logger.info("payment_reconciliation_started", { count: pendingPayments.length, now });
    for (const payment of pendingPayments) {
      await reconcileOnePayment(payment, deps, result, now, staleThresholdMs);
    }
  } else {
    logger.debug("payment_reconciliation_empty", { now });
  }

  // Recover sessions stranded mid-confirm (R9): the payment was captured but the
  // session never advanced to booking_confirmed — a crash between markCaptured and
  // markBookingConfirmed in the capture endpoint or webhook. The main scan above
  // filters on *payment* status ('order_created') and can never re-pick these,
  // since their payment already reads 'captured'.
  await recoverStrandedConfirmations(deps, result, now);

  logger.info("payment_reconciliation_completed", {
    processed: result.processed,
    confirmed: result.confirmed,
    markedFailed: result.markedFailed,
    stillPending: result.stillPending,
    providerErrors: result.providerErrors,
    errorCount: result.errors.length,
  });

  // Alert if any sessions were confirmed by reconciliation (missed webhooks)
  if (result.confirmed > 0) {
    logger.warn("payment_reconciliation_missed_webhooks", {
      confirmedCount: result.confirmed,
      note: "These bookings were confirmed by reconciliation because PayPal webhooks were missed.",
    });
  }

  return result;
}

async function reconcileOnePayment(
  payment: PaymentRecord,
  deps: ReconciliationDependencies,
  result: ReconciliationResult,
  now: string,
  staleThresholdMs: number
): Promise<void> {
  const { paypalClient, logger } = deps;
  const dummyObservability = createReconciliationObservability(logger);

  // 1. Query PayPal for the order's current status
  let orderStatus: string;
  let captureId: string | undefined;
  let captureStatus: string | undefined;

  try {
    const details = await paypalClient.getOrderDetails(payment.paypalOrderId, dummyObservability);
    orderStatus = details.status;
    captureId = details.captureId;
    captureStatus = details.captureStatus;
  } catch (error) {
    result.providerErrors += 1;
    const errCode = error instanceof PayPalProviderError ? error.code : "unknown";
    const errMsg = error instanceof Error ? error.message : "unknown";
    logger.warn("payment_reconciliation_fetch_failed", {
      bookingSessionId: payment.bookingSessionId,
      paypalOrderId: payment.paypalOrderId,
      errorCode: errCode,
      error: errMsg,
    });
    result.errors.push({
      bookingSessionId: payment.bookingSessionId,
      paypalOrderId: payment.paypalOrderId,
      phase: "fetch_order",
      errorCode: errCode,
      message: errMsg,
    });
    return;
  }

  // 2. Decide action based on PayPal order status
  if (orderStatus === "COMPLETED" && captureStatus === "COMPLETED" && captureId) {
    await confirmFromReconciliation(payment, captureId, now, deps, result);
    return;
  }

  if (TERMINAL_FAILURE_STATUSES.has(orderStatus) || TERMINAL_CAPTURE_STATUSES.has(captureStatus ?? "")) {
    await failFromReconciliation(payment, `paypal_status_${orderStatus.toLowerCase()}`, deps, result);
    return;
  }

  // 3. Check staleness — if the payment has been pending too long, mark as failed
  const paymentAgeMs = Date.parse(now) - Date.parse(payment.createdAt);
  if (paymentAgeMs > staleThresholdMs) {
    logger.warn("payment_reconciliation_stale", {
      bookingSessionId: payment.bookingSessionId,
      paypalOrderId: payment.paypalOrderId,
      paypalStatus: orderStatus,
      ageMs: paymentAgeMs,
    });
    await failFromReconciliation(payment, "stale_pending_payment", deps, result);
    return;
  }

  // 4. Still in progress — leave alone.
  // Note: PAYER_ACTION_REQUIRED (e.g. 3DS challenge) and APPROVED (buyer approved
  // but capture not yet attempted) are not failures. They fall through to the
  // staleness check above, and if still within the threshold, are left for the
  // next reconciliation run.
  result.stillPending += 1;
  logger.debug("payment_reconciliation_still_pending", {
    bookingSessionId: payment.bookingSessionId,
    paypalOrderId: payment.paypalOrderId,
    paypalStatus: orderStatus,
    ageMs: paymentAgeMs,
  });
}

// PayPal order-level terminal failures. EXPIRED means the order was never
// captured within PayPal's ~3-hour window and cannot be recovered.
const TERMINAL_FAILURE_STATUSES = new Set(["VOIDED", "EXPIRED"]);
const TERMINAL_CAPTURE_STATUSES = new Set(["DECLINED", "REFUNDED", "REVERSED"]);

async function confirmFromReconciliation(
  payment: PaymentRecord,
  captureId: string,
  now: string,
  deps: ReconciliationDependencies,
  result: ReconciliationResult
): Promise<void> {
  const { payments, bookingSessions, logger } = deps;
  const confirmedAt = now;

  try {
    await payments.markCaptured({
      bookingSessionId: payment.bookingSessionId,
      paypalCaptureId: captureId,
      capturedAt: confirmedAt,
    });

    const session = await bookingSessions.getById(payment.bookingSessionId);
    if (session && session.status === "paypal_order_created") {
      const confirmedSession = await bookingSessions.markBookingConfirmed({
        bookingSessionId: payment.bookingSessionId,
        confirmedAt,
      });

      await reportServerConversion("purchase", confirmedSession, deps.serverConversions, logger);
    }

    result.confirmed += 1;
    logger.info("payment_reconciliation_confirmed", {
      bookingSessionId: payment.bookingSessionId,
      paypalOrderId: payment.paypalOrderId,
      paypalCaptureId: captureId,
    });
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : "unknown";
    logger.error("payment_reconciliation_confirm_failed", {
      bookingSessionId: payment.bookingSessionId,
      paypalOrderId: payment.paypalOrderId,
      error: errMsg,
    });
    result.errors.push({
      bookingSessionId: payment.bookingSessionId,
      paypalOrderId: payment.paypalOrderId,
      phase: "confirm_session",
      errorCode: "db_update_failed",
      message: errMsg,
    });
  }
}

/**
 * Confirms sessions that were left in `paypal_order_created` even though their
 * payment already reached `captured` — a crash between markCaptured and
 * markBookingConfirmed. Enumerating by *session* status keeps the candidate set
 * small and current (only genuinely pending sessions), and confirmFromReconciliation
 * re-uses the idempotent markCaptured + CAS markBookingConfirmed path.
 */
async function recoverStrandedConfirmations(
  deps: ReconciliationDependencies,
  result: ReconciliationResult,
  now: string
): Promise<void> {
  const { payments, bookingSessions, logger } = deps;
  if (!bookingSessions.listByStatus) {
    return;
  }

  const strandedSessions = await bookingSessions.listByStatus("paypal_order_created");
  for (const session of strandedSessions) {
    const payment = await payments.getByBookingSessionId(session.id);
    if (payment?.status === "captured" && payment.paypalCaptureId) {
      logger.warn("payment_reconciliation_recovering_stranded_confirm", {
        bookingSessionId: session.id,
        paypalCaptureId: payment.paypalCaptureId,
      });
      await confirmFromReconciliation(payment, payment.paypalCaptureId, now, deps, result);
    }
  }
}

async function failFromReconciliation(
  payment: PaymentRecord,
  reason: string,
  deps: ReconciliationDependencies,
  result: ReconciliationResult
): Promise<void> {
  const { payments, bookingSessions, logger } = deps;

  try {
    await payments.markFailed(payment.bookingSessionId);
    await bookingSessions.markFailed({
      bookingSessionId: payment.bookingSessionId,
      reason,
    });

    result.markedFailed += 1;
    logger.info("payment_reconciliation_failed_session", {
      bookingSessionId: payment.bookingSessionId,
      paypalOrderId: payment.paypalOrderId,
      reason,
    });
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : "unknown";
    logger.error("payment_reconciliation_fail_update_failed", {
      bookingSessionId: payment.bookingSessionId,
      paypalOrderId: payment.paypalOrderId,
      error: errMsg,
    });
    result.errors.push({
      bookingSessionId: payment.bookingSessionId,
      paypalOrderId: payment.paypalOrderId,
      phase: "fail_session",
      errorCode: "db_update_failed",
      message: errMsg,
    });
  }
}

// Minimal observability adapter for the reconciliation worker context
// (no HTTP request context, so we use the logger directly).
function createReconciliationObservability(logger: ObservabilityLogger) {
  return {
    logger,
    recordProviderCall: (obs: { provider: string; operation: string; durationMs: number; statusCode?: number; errorCode?: string }) => {
      logger.debug("reconciliation_provider_call", obs);
    },
    recordStateTransition: (obs: { entityType: string; toState: string; action: string; success: boolean }) => {
      logger.debug("reconciliation_state_transition", obs);
    },
    recordSecurityEvent: (obs: { name: string; severity: string }) => {
      logger.warn("reconciliation_security_event", obs);
    },
  } as import("./types").RouteObservability;
}
