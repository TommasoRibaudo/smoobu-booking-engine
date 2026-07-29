/**
 * Placeholder handler for the payment reconciliation scheduled worker.
 *
 * This stub is deployed by Terraform on initial `terraform apply`.
 * CI/CD replaces it with the real compiled handler from
 * booking-api/src/paymentReconciliationHandler.ts via `aws lambda update-function-code`.
 */
export async function handler(event) {
  console.log(JSON.stringify({
    level: "info",
    message: "payment_reconciliation_placeholder_invoked",
    event,
    note: "Replace this placeholder with the real payment reconciliation worker via CI/CD.",
  }));

  return {
    processed: 0,
    confirmed: 0,
    markedFailed: 0,
    stillPending: 0,
    providerErrors: 0,
    errors: [],
  };
}
