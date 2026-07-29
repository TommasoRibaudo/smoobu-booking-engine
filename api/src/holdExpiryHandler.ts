import { loadConfig } from "./config";
import { RdsBookingSessionRepository } from "./bookingSessions";
import { getPool } from "./db";
import { RdsHoldRepository } from "./holds";
import { createObservability } from "./observability";
import { createSmoobuClient } from "./smoobuClient";
import { processExpiredHolds, HoldExpiryResult } from "./holdExpiry";
import { BookingApiConfig } from "./types";

/**
 * Lambda entry point for the scheduled hold expiry worker.
 * Triggered by EventBridge rule (e.g. rate(1 minute)).
 *
 * IMPORTANT — Repository wiring:
 * Default Lambda config gets RDS repositories from the Secrets Manager/RDS
 * pool path before the sweep runs.
 *
 * The core logic in processExpiredHolds is fully tested with in-memory
 * repositories and is reused unchanged by the RDS-backed worker.
 */
export async function handler(): Promise<HoldExpiryResult> {
  const config = loadConfig();

  const observability = createObservability(config.observability);
  const logger = observability.createLogger({ worker: "hold-expiry" });

  await ensureRepositories(config);

  if (!config.bookingSessions || !config.holds) {
    logger.warn("hold_expiry_no_repositories", {
      hasBookingSessions: !!config.bookingSessions,
      hasHolds: !!config.holds,
      note: "RDS-backed repositories could not be initialised. Worker is a no-op.",
    });
    return {
      processed: 0,
      expired: 0,
      smoobuCancelled: 0,
      smoobuCancelFailed: 0,
      sessionUpdateFailed: 0,
      errors: [],
    };
  }

  const smoobuClient = await createSmoobuClient(config);

  return processExpiredHolds({
    holds: config.holds,
    bookingSessions: config.bookingSessions,
    smoobuClient,
    logger,
    emailConfig: config.email,
  });
}

async function ensureRepositories(config: BookingApiConfig): Promise<void> {
  if (config.bookingSessions && config.holds) {
    return;
  }

  const pool = await getPool({ secretProvider: config.secrets });
  if (!config.bookingSessions) {
    config.bookingSessions = new RdsBookingSessionRepository(pool);
  }
  if (!config.holds) {
    config.holds = new RdsHoldRepository(pool);
  }
}
