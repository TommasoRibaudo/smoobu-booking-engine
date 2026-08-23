/**
 * Staff deposit review page — the "Confirm" button's form action must resolve,
 * from the browser's address bar, to the actual POST route.
 *
 * The GET page is served at /api/staff/deposit-review/{token} behind an API
 * Gateway stage (e.g. https://<id>.execute-api.<region>.amazonaws.com/prod/...).
 * Lambda only ever sees the path *after* the stage, so a bug in a root-relative
 * action (e.g. "/api/staff/deposit-review") that drops the stage prefix cannot
 * be seen by hitting the Lambda handler alone — it only shows up once a real
 * browser resolves the relative URL against the page it's actually looking at.
 * These tests reproduce that resolution with the Fetch API's URL, without a browser.
 */

import { createBookingApiHandler } from "./app";
import { InMemoryBookingSessionRepository } from "./bookingSessions";
import { InMemoryHoldRepository } from "./holds";
import { StaticSecretProvider } from "./secrets";
import { issueSignedToken } from "./signedTokens";
import { BookingApiConfig, LambdaHttpRequest } from "./types";

const PORTAL_SECRET = "portal-session-secret-for-deposit-confirm-tests";

let bookingSessions: InMemoryBookingSessionRepository;
let config: BookingApiConfig;
let handler: ReturnType<typeof createBookingApiHandler>;

function createTestConfig(): BookingApiConfig {
  bookingSessions = new InMemoryBookingSessionRepository();
  return {
    allowedOrigins: ["https://booking.test"],
    maxBodyBytes: 64 * 1024,
    secrets: new StaticSecretProvider({
      smoobuApiKey: "smoobu-secret-value",
      smoobuApiSecret: "smoobu-api-secret-value",
      smoobuWebhookSecret: "smoobu-webhook-secret-value",
      paypalClientId: "paypal-client-id-value",
      paypalClientSecret: "paypal-client-secret-value",
      paypalWebhookId: "paypal-webhook-id-value",
      bookingEncryptionKeyBase64: Buffer.alloc(32, 7).toString("base64"),
      portalSessionSecret: PORTAL_SECRET,
      rdsConnectionString: "postgres://booking_user:pw@db.example.com:5432/booking_engine",
    }),
    smoobu: {
      baseUrl: "https://login.smoobu.com",
      customerId: 9,
      timeoutMs: 8_000,
      maxRetries: 0,
      baseBackoffMs: 250,
      maxBackoffMs: 2_000,
      maxRateLimitDelayMs: 60_000,
      holdChannelId: 11,
    },
    paypal: { baseUrl: "https://api-m.sandbox.paypal.com", timeoutMs: 10_000, orderReturnUrl: "", orderCancelUrl: "" },
    bookingSessions,
    holds: new InMemoryHoldRepository(),
    hold: { defaultTtlMinutes: 60, idempotencyTtlMinutes: 1440, staleIdempotencyLockSeconds: 120 },
    deposit: { holdTtlHours: 48, confirmTokenTtlHours: 168, staffConfirmBaseUrl: "https://booking.test-api/prod" },
    abuseProtection: { enabled: false, captchaChallengesEnabled: false, maxTrackedBuckets: 100 },
    email: { fromAddress: "test@example.com", region: "us-east-1", disabled: true },
    observability: { serviceName: "booking-api", environment: "test", logLevel: "silent", metricsEnabled: false },
  };
}

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
});

function jsonResp(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    ...init,
    headers: { "content-type": "application/json", ...(init.headers as Record<string, string> | undefined) },
  });
}

function makeSearchEvent(): LambdaHttpRequest {
  return {
    version: "2.0",
    rawPath: "/api/search",
    headers: { "content-type": "application/json", origin: "https://booking.test" },
    body: JSON.stringify({ arrivalDate: "2099-06-10", departureDate: "2099-06-14", guests: 2, language: "en" }),
    requestContext: { http: { method: "POST", path: "/api/search", sourceIp: "203.0.113.40" } },
  };
}

function makeDepositHoldEvent(body: unknown): LambdaHttpRequest {
  return {
    version: "2.0",
    rawPath: "/api/deposit-holds",
    headers: {
      "content-type": "application/json",
      "idempotency-key": "idem-deposit-hold-promotion-001",
      origin: "https://booking.test",
    },
    body: JSON.stringify(body),
    requestContext: { http: { method: "POST", path: "/api/deposit-holds", sourceIp: "203.0.113.40" } },
  };
}

function postDepositReviewSubmit(token: string): LambdaHttpRequest {
  return {
    version: "2.0",
    rawPath: "/api/staff/deposit-review",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: `token=${encodeURIComponent(token)}`,
    requestContext: { http: { method: "POST", path: "/api/staff/deposit-review", sourceIp: "203.0.113.40" } },
  };
}

async function seedSession(): Promise<{ id: string; reservationPublicId: string }> {
  const session = await bookingSessions.createQuotedSession({
    arrivalDate: "2099-05-01",
    departureDate: "2099-05-05",
    guests: 2,
    language: "en",
  });
  return { id: session.id, reservationPublicId: session.reservationPublicId };
}

function confirmToken(bookingSessionId: string, reservationPublicId: string): string {
  return issueSignedToken(
    { bookingSessionId, reservationPublicId, purpose: "deposit_confirm", ttlSeconds: 3600 },
    PORTAL_SECRET
  );
}

function getReviewPage(token: string): LambdaHttpRequest {
  const path = `/api/staff/deposit-review/${token}`;
  return {
    version: "2.0",
    rawPath: path,
    headers: {},
    requestContext: { http: { method: "GET", path, sourceIp: "203.0.113.9" } },
  };
}

function extractFormAction(html: string): string {
  const match = /<form\s+method="POST"\s+action="([^"]*)"/.exec(html);
  if (!match) {
    throw new Error("review page did not render the expected <form> element");
  }
  return match[1];
}

beforeEach(() => {
  config = createTestConfig();
  handler = createBookingApiHandler(config);
});

it("submits to the real POST route once resolved against the review page's own (stage-prefixed) URL", async () => {
  const session = await seedSession();
  const token = confirmToken(session.id, session.reservationPublicId);

  const response = await handler(getReviewPage(token));
  expect(response.statusCode).toBe(200);

  const action = extractFormAction(response.body);
  // Mirrors DEPOSIT_STAFF_CONFIRM_BASE_URL as Terraform builds it in lambda.tf:
  // https://<rest-api-id>.execute-api.<region>.amazonaws.com/<stage>
  const addressBarUrl = `https://abc123.execute-api.us-east-2.amazonaws.com/prod/api/staff/deposit-review/${token}`;

  const resolved = new URL(action, addressBarUrl);
  expect(resolved.pathname).toBe("/prod/api/staff/deposit-review");
});

it("also resolves correctly with no stage/base-path prefix (e.g. a future custom domain)", async () => {
  const session = await seedSession();
  const token = confirmToken(session.id, session.reservationPublicId);

  const response = await handler(getReviewPage(token));
  const action = extractFormAction(response.body);

  const addressBarUrl = `https://api.booking.test/api/staff/deposit-review/${token}`;
  const resolved = new URL(action, addressBarUrl);
  expect(resolved.pathname).toBe("/api/staff/deposit-review");
});

// ─── Smoobu promotion on confirm ────────────────────────────────────────────
//
// A manual-deposit hold is created on Smoobu's "Blocked channel" (channelId 11)
// so the dates come off sale on every OTA while the bank transfer clears. Once
// staff confirm, it must be promoted to the "Homepage" channel (70) — the same
// mechanism PayPal captures already use (smoobuPromotion.ts) — or the guest's
// real reservation sits in Smoobu forever labeled as an anonymous block.

it("promotes the Smoobu reservation to the Homepage channel on confirm, instead of leaving it Blocked", async () => {
  let reservationCreateCount = 0;
  const fetchFn = jest.fn(async (url: string | URL, init?: RequestInit) => {
    const { hostname, pathname } = new URL(url.toString());
    const method = init?.method ?? "GET";

    if (hostname === "login.smoobu.com") {
      if (pathname === "/booking/checkApartmentAvailability") {
        return jsonResp({
          availableApartments: [100001],
          prices: { "100001": { price: 510, currency: "USD" } },
          errorMessages: {},
        });
      }
      if (pathname === "/api/reservations" && method === "POST") {
        reservationCreateCount += 1;
        // First call is the initial Blocked-channel hold; second is the promotion.
        return jsonResp({ id: reservationCreateCount === 1 ? 555111 : 777222 });
      }
      if (pathname === "/api/reservations/555111" && method === "DELETE") {
        return jsonResp({ success: true });
      }
    }

    return jsonResp({ detail: "unexpected" }, { status: 500 });
  });
  global.fetch = fetchFn as typeof fetch;

  const searchResp = await handler(makeSearchEvent());
  expect(searchResp.statusCode).toBe(200);
  const searchBody = JSON.parse(searchResp.body);

  const holdResp = await handler(
    makeDepositHoldEvent({
      quoteId: searchBody.quoteId,
      bookingSessionId: searchBody.bookingSessionId,
      propertyId: searchBody.properties[0].propertyId,
      guest: { firstName: "Ana", lastName: "Mora", email: "ana@example.com" },
      portalPassword: "correct horse battery staple",
      termsAccepted: true,
    })
  );
  expect(holdResp.statusCode).toBe(200);
  const { bookingSessionId, reservationPublicId } = JSON.parse(holdResp.body).booking;

  const token = confirmToken(bookingSessionId, reservationPublicId);
  const confirmResp = await handler(postDepositReviewSubmit(token));
  expect(confirmResp.statusCode).toBe(200);
  expect(confirmResp.body).toContain("is confirmed");

  const deletedOldBlock = fetchFn.mock.calls.some(
    ([u, i]) => new URL(u.toString()).pathname === "/api/reservations/555111" && (i as RequestInit | undefined)?.method === "DELETE"
  );
  expect(deletedOldBlock).toBe(true);

  const promotedToHomepage = fetchFn.mock.calls.some(([u, i]) => {
    if (new URL(u.toString()).pathname !== "/api/reservations" || (i as RequestInit | undefined)?.method !== "POST") {
      return false;
    }
    const body = JSON.parse((i as RequestInit).body as string);
    return body.channelId === 70;
  });
  expect(promotedToHomepage).toBe(true);

  const hold = await bookingSessions.getById(bookingSessionId);
  expect(hold?.status).toBe("booking_confirmed");
});
