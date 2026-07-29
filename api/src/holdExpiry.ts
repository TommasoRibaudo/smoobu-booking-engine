import { BookingSessionRepository } from "./bookingSessions";
import { HoldRecord, HoldRepository } from "./holds";
import { createEmailClient } from "./email";
import { BOOKING_PROPERTIES_BY_ID } from "./propertyCatalog";
import { SmoobuProviderError } from "./smoobuClient";
import { ObservabilityLogger, BookingApiConfig } from "./types";

import type { SmoobuClient } from "./smoobuClient";

export interface HoldExpiryResult {
  processed: number;
  expired: number;
  smoobuCancelled: number;
  smoobuCancelFailed: number;
  sessionUpdateFailed: number;
  errors: HoldExpiryError[];
}

export interface HoldExpiryError {
  holdId: string;
  bookingSessionId: string;
  phase: "expire_hold" | "cancel_smoobu" | "expire_session";
  errorCode: string;
  message: string;
}

export interface HoldExpiryDependencies {
  holds: HoldRepository;
  bookingSessions: BookingSessionRepository;
  smoobuClient: SmoobuClient;
  logger: ObservabilityLogger;
  emailConfig?: BookingApiConfig["email"];
  now?: () => string;
}

/**
 * Finds all holds past their `expiresAt` and transitions them to `expired`,
 * cancels the corresponding Smoobu reservation (if one exists), and marks
 * the booking session as `hold_expired`.
 *
 * Designed to run on a schedule (e.g. every 1 minute via EventBridge).
 * Each hold is processed independently so a single failure does not block others.
 */
export async function processExpiredHolds(deps: HoldExpiryDependencies): Promise<HoldExpiryResult> {
  const { holds, bookingSessions, smoobuClient, logger } = deps;
  const now = deps.now?.() ?? new Date().toISOString();

  const result: HoldExpiryResult = {
    processed: 0,
    expired: 0,
    smoobuCancelled: 0,
    smoobuCancelFailed: 0,
    sessionUpdateFailed: 0,
    errors: [],
  };

  const expiredHolds = await holds.listExpiredHolds(now);
  result.processed = expiredHolds.length;

  if (expiredHolds.length === 0) {
    logger.debug("hold_expiry_sweep_empty", { now });
    return result;
  }

  logger.info("hold_expiry_sweep_started", { count: expiredHolds.length, now });

  for (const hold of expiredHolds) {
    await processOneHold(hold, deps, result);
  }

  logger.info("hold_expiry_sweep_completed", {
    processed: result.processed,
    expired: result.expired,
    smoobuCancelled: result.smoobuCancelled,
    smoobuCancelFailed: result.smoobuCancelFailed,
    sessionUpdateFailed: result.sessionUpdateFailed,
    errorCount: result.errors.length,
  });

  return result;
}

async function processOneHold(
  hold: HoldRecord,
  deps: HoldExpiryDependencies,
  result: HoldExpiryResult
): Promise<void> {
  const { holds, bookingSessions, smoobuClient, logger } = deps;

  // 1. Mark hold as expired in DB
  try {
    await holds.expireHold(hold.id);
    result.expired += 1;
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : "unknown";
    logger.error("hold_expiry_db_failed", {
      holdId: hold.id,
      bookingSessionId: hold.bookingSessionId,
      error: errMsg,
    });
    result.errors.push({
      holdId: hold.id,
      bookingSessionId: hold.bookingSessionId,
      phase: "expire_hold",
      errorCode: "db_update_failed",
      message: errMsg,
    });
    // Don't proceed if we can't even mark the hold expired
    return;
  }

  // 2. Cancel Smoobu reservation if one was created
  if (hold.smoobuReservationId) {
    try {
      await smoobuClient.cancelReservation(hold.smoobuReservationId);
      result.smoobuCancelled += 1;
      logger.info("hold_expiry_smoobu_cancelled", {
        holdId: hold.id,
        smoobuReservationId: hold.smoobuReservationId,
      });
    } catch (error) {
      result.smoobuCancelFailed += 1;
      const errCode = error instanceof SmoobuProviderError ? error.code : "unknown";
      const errMsg = error instanceof Error ? error.message : "unknown";
      logger.error("hold_expiry_smoobu_cancel_failed", {
        holdId: hold.id,
        smoobuReservationId: hold.smoobuReservationId,
        errorCode: errCode,
        error: errMsg,
      });
      result.errors.push({
        holdId: hold.id,
        bookingSessionId: hold.bookingSessionId,
        phase: "cancel_smoobu",
        errorCode: errCode,
        message: errMsg,
      });
      // Continue to expire the session even if Smoobu cancel fails —
      // a reconciliation job (task 5.3) will catch orphaned reservations.
    }
  }

  // 3. Mark booking session as hold_expired
  try {
    await bookingSessions.markHoldExpired({ bookingSessionId: hold.bookingSessionId });
    logger.info("hold_expiry_session_expired", {
      holdId: hold.id,
      bookingSessionId: hold.bookingSessionId,
    });

    // Send cancellation email — non-fatal
    if (deps.emailConfig) {
      try {
        const session = await bookingSessions.getById(hold.bookingSessionId);
        if (session?.guest?.email) {
          const property = BOOKING_PROPERTIES_BY_ID.get(session.propertyId ?? "");
          const emailClient = createEmailClient(deps.emailConfig, logger);
          await emailClient.sendCancelled(session, property?.name ?? session.propertyId ?? "");
        }
      } catch (emailError) {
        logger.error("hold_expiry_email_failed", {
          holdId: hold.id,
          bookingSessionId: hold.bookingSessionId,
          error: emailError instanceof Error ? emailError.message : String(emailError),
        });
      }
    }
  } catch (error) {
    result.sessionUpdateFailed += 1;
    const errMsg = error instanceof Error ? error.message : "unknown";
    logger.error("hold_expiry_session_update_failed", {
      holdId: hold.id,
      bookingSessionId: hold.bookingSessionId,
      error: errMsg,
    });
    result.errors.push({
      holdId: hold.id,
      bookingSessionId: hold.bookingSessionId,
      phase: "expire_session",
      errorCode: "session_update_failed",
      message: errMsg,
    });
  }
}
