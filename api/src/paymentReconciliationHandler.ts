import { loadConfig } from "./config";
import { RdsBookingSessionRepository } from "./bookingSessions";
import { getPool } from "./db";
import { createObservability } from "./observability";
import { RdsPaymentRepository } from "./payments";
import { createPayPalClient } from "./paypalClient";
import { reconcilePendingPayments, ReconciliationResult } from "./paymentReconciliation";
import { BookingApiConfig } from "./types";

/**
 * Lambda entry point for the scheduled payment reconciliation worker.
 * Triggered by EventBridge rule (e.g. rate(5 minutes)).
 *
 * Checks all "pending PayPal" sessions against the PayPal Orders API
 * and resolves missing webhooks or stale/abandoned payments.
 *
 * IMPORTANT — Repository wiring:
 * Default Lambda config gets RDS repositories from the Secrets Manager/RDS
 * pool path before reconciliation runs.
 *
 * The core logic in reconcilePendingPayments is fully tested with in-memory
 * repositories and is reused unchanged by the RDS-backed worker.
 */
export async function handler(): Promise<ReconciliationResult> {
  const config = loadConfig();

  const observability = createObservability(config.observability);
  const logger = observability.createLogger({ worker: "payment-reconciliation" });

  await ensureRepositories(config);

  if (!config.bookingSessions || !config.payments) {
    logger.warn("payment_reconciliation_no_repositories", {
      hasBookingSessions: !!config.bookingSessions,
      hasPayments: !!config.payments,
      note: "RDS-backed repositories could not be initialised. Worker is a no-op.",
    });
    return {
      processed: 0,
      confirmed: 0,
      markedFailed: 0,
      stillPending: 0,
      providerErrors: 0,
      errors: [],
    };
  }

  const paypalClient = await createPayPalClient(config);

  return reconcilePendingPayments({
    payments: config.payments,
    bookingSessions: config.bookingSessions,
    paypalClient,
    logger,
    ...(config.serverConversions ? { serverConversions: config.serverConversions } : {}),
  });
}

async function ensureRepositories(config: BookingApiConfig): Promise<void> {
  if (config.bookingSessions && config.payments) {
    return;
  }

  const pool = await getPool({ secretProvider: config.secrets });
  if (!config.bookingSessions) {
    config.bookingSessions = new RdsBookingSessionRepository(pool);
  }
  if (!config.payments) {
    config.payments = new RdsPaymentRepository(pool);
  }
}
