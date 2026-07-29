/**
 * Placeholder handler for the hold expiry scheduled worker.
 *
 * This stub is deployed by Terraform on initial `terraform apply`.
 * CI/CD replaces it with the real compiled handler from
 * booking-api/src/holdExpiryHandler.ts via `aws lambda update-function-code`.
 */
export async function handler(event) {
  console.log(JSON.stringify({
    level: "info",
    message: "hold_expiry_placeholder_invoked",
    event,
    note: "Replace this placeholder with the real hold expiry worker via CI/CD.",
  }));

  return {
    processed: 0,
    expired: 0,
    smoobuCancelled: 0,
    smoobuCancelFailed: 0,
    sessionUpdateFailed: 0,
    errors: [],
  };
}
