/**
 * webhooks — placeholder Lambda handler.
 *
 * Returns 200 for every incoming webhook event until the real ingestion
 * logic is deployed in task 3.x.  Returning 200 prevents Smoobu/PayPal
 * from retrying deliveries against a 501 during initial infrastructure
 * bring-up.
 *
 * The real handler must:
 *   - Verify the request signature before touching the payload
 *     (HMAC-SHA256 for Smoobu, PayPal signature verification endpoint)
 *   - Write the raw event to the webhook_events DB table (idempotent on event_id)
 *   - Return 200 immediately; process asynchronously
 */

export const handler = async (event) => {
  console.info("webhook received", {
    path: event.path,
    method: event.httpMethod,
    source: event.headers?.["user-agent"] ?? "unknown",
  });

  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ received: true }),
  };
};
