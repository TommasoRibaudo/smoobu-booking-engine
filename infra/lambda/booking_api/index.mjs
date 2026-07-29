/**
 * booking_api — placeholder Lambda handler.
 *
 * Returns 501 Not Implemented for every route until the real booking engine
 * backend is deployed in task 3.x.  CI/CD replaces this file via
 * `aws lambda update-function-code` without modifying the Terraform.
 *
 * The real handler must:
 *   - Add CORS headers to every response (Origin matching against ALLOWED_ORIGINS)
 *   - Handle OPTIONS preflight requests (return 200 with CORS headers only)
 *   - Route on event.httpMethod + event.path
 */

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": process.env.ALLOWED_ORIGINS?.split(",")[0] || "https://example.com",
  "Access-Control-Allow-Headers": "Content-Type,Authorization,X-Amz-Date,X-Api-Key",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
};

export const handler = async (event) => {
  // Handle CORS preflight
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers: CORS_HEADERS, body: "" };
  }

  return {
    statusCode: 501,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    body: JSON.stringify({
      error: "not_implemented",
      message: "Booking API not yet implemented.",
      path: event.path,
      method: event.httpMethod,
    }),
  };
};
