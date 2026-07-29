/**
 * Placeholder handler for the schema migration runner.
 *
 * This stub is deployed by Terraform on initial `terraform apply`.
 * CI/CD replaces it with the real compiled handler from
 * booking-api/src/migrationHandler.ts via `aws lambda update-function-code`.
 *
 * It deliberately reports failure: invoking the placeholder must never look
 * like a successful migration run, or a deploy could proceed on the assumption
 * that pending migrations had been applied when nothing ran.
 */
export async function handler(event) {
  console.log(JSON.stringify({
    level: "error",
    message: "migration_placeholder_invoked",
    event,
    note: "Replace this placeholder with the real migration runner via CI/CD.",
  }));

  return {
    ok: false,
    applied: [],
    pending: [],
    alreadyApplied: 0,
    dryRun: false,
    error: "Migration placeholder invoked — real handler has not been deployed.",
  };
}
