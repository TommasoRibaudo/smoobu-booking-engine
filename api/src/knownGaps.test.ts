/**
 * Known-gaps regression net.
 *
 * These tests encode behavior the booking flow SHOULD have but currently
 * doesn't. Each is written with `test.failing()`: Jest treats a failing
 * assertion here as expected (the suite stays green), but the moment the
 * underlying bug is fixed and the test starts passing, Jest reports it as a
 * failure — a nudge to remove `.failing` and confirm the fix landed.
 *
 * Do not add `.failing` tests here speculatively — only for gaps with a
 * fix contract that's unambiguous from the existing code (see each test's
 * comment for why the expected behavior isn't a guess).
 */

import { createBookingApiHandler } from "./app";
import { InMemoryBookingSessionRepository } from "./bookingSessions";
import { loadConfig } from "./config";
import { EmailClient } from "./email";
import { InMemoryHoldRepository } from "./holds";
import { InMemoryPaymentRepository } from "./payments";
import { InMemoryWebhookEventRepository } from "./paypalWebhooks";
import { InMemoryPortalSessionRepository } from "./portalSessions";
import { StaticSecretProvider } from "./secrets";
import { BookingApiConfig, LambdaHttpRequest } from "./types";

// ── shared happy-path harness (mirrors happyPath.test.ts) ─────────────────────

const PORTAL_SECRET = "portal-session-secret-known-gaps";

const SMOOBU_AVAILABILITY = {
  availableApartments: [100001],
  prices: { "100001": { price: 510, currency: "USD" } },
  errorMessages: {},
};
const SMOOBU_RESERVATION = { id: 9900002 };
const PAYPAL_TOKEN = { access_token: "pp-gaps-token", expires_in: 3600 };
const PAYPAL_ORDER = {
  id: "GAPS-ORDER-001",
  status: "CREATED",
  links: [
    { rel: "approve", href: "https://www.sandbox.paypal.com/checkoutnow?token=GAPS-ORDER-001", method: "GET" },
    { rel: "self", href: "https://api-m.sandbox.paypal.com/v2/checkout/orders/GAPS-ORDER-001", method: "GET" },
  ],
};
const PAYPAL_CAPTURE = {
  id: "GAPS-ORDER-001",
  status: "COMPLETED",
  purchase_units: [
    {
      payments: {
        captures: [
          { id: "GAPS-CAP-001", status: "COMPLETED", amount: { currency_code: "USD", value: "510.00" } },
        ],
      },
    },
  ],
};

let bookingSessions: InMemoryBookingSessionRepository;
let holds: InMemoryHoldRepository;
let payments: InMemoryPaymentRepository;
let webhookEvents: InMemoryWebhookEventRepository;
let portalSessions: InMemoryPortalSessionRepository;
let config: BookingApiConfig;

const originalFetch = global.fetch;

function createTestConfig(): BookingApiConfig {
  bookingSessions = new InMemoryBookingSessionRepository();
  holds = new InMemoryHoldRepository();
  payments = new InMemoryPaymentRepository();
  webhookEvents = new InMemoryWebhookEventRepository();
  portalSessions = new InMemoryPortalSessionRepository();
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
      rdsConnectionString: "postgres://booking_user:pw@db.test:5432/booking_engine",
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
    paypal: {
      baseUrl: "https://api-m.sandbox.paypal.com",
      timeoutMs: 10_000,
      orderReturnUrl: "https://booking.test/book/return",
      orderCancelUrl: "https://booking.test/book/cancel",
    },
    bookingSessions,
    holds,
    payments,
    webhookEvents,
    portalSessions,
    hold: {
      defaultTtlMinutes: 60,
      idempotencyTtlMinutes: 1440,
      staleIdempotencyLockSeconds: 120,
    },
    abuseProtection: { enabled: false, captchaChallengesEnabled: false, maxTrackedBuckets: 100 },
    email: { fromAddress: "test@example.com", region: "us-east-1", disabled: true },
    observability: { serviceName: "booking-api", environment: "test", logLevel: "silent", metricsEnabled: false },
  };
}

function happyPathFetch(): jest.Mock {
  return jest.fn(async (url: string | URL) => {
    const { hostname, pathname } = new URL(url.toString());

    if (hostname === "login.smoobu.com") {
      if (pathname === "/booking/checkApartmentAvailability") return jsonResp(SMOOBU_AVAILABILITY);
      if (pathname === "/api/reservations") return jsonResp(SMOOBU_RESERVATION);
    }

    if (hostname === "api-m.sandbox.paypal.com") {
      if (pathname === "/v1/oauth2/token") return jsonResp(PAYPAL_TOKEN);
      if (pathname === "/v2/checkout/orders") return jsonResp(PAYPAL_ORDER);
      if (pathname.endsWith("/capture")) return jsonResp(PAYPAL_CAPTURE);
    }

    return jsonResp({ detail: "unexpected call to " + pathname }, { status: 500 });
  });
}

function jsonResp(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    ...init,
    headers: { "content-type": "application/json", ...(init.headers as Record<string, string> | undefined) },
  });
}

function searchEvent(): LambdaHttpRequest {
  return {
    version: "2.0",
    rawPath: "/api/search",
    headers: { "content-type": "application/json", origin: "https://booking.test", "x-booking-device-id": "gaps-device" },
    body: JSON.stringify({ arrivalDate: "2099-09-01", departureDate: "2099-09-05", guests: 2, language: "en", source: "booking_page" }),
    requestContext: { http: { method: "POST", path: "/api/search", sourceIp: "203.0.113.1" } },
  };
}

function holdEvent(body: unknown): LambdaHttpRequest {
  return {
    version: "2.0",
    rawPath: "/api/holds",
    headers: {
      "content-type": "application/json",
      "idempotency-key": "gaps-hold-idem-key-0001",
      origin: "https://booking.test",
      "x-booking-device-id": "gaps-device",
    },
    body: JSON.stringify(body),
    requestContext: { http: { method: "POST", path: "/api/holds", sourceIp: "203.0.113.1" } },
  };
}

function orderEvent(bookingSessionId: string): LambdaHttpRequest {
  return {
    version: "2.0",
    rawPath: `/api/bookings/${bookingSessionId}/paypal/create-order`,
    headers: { "idempotency-key": "gaps-order-idem-key-0001", origin: "https://booking.test", "x-booking-device-id": "gaps-device" },
    requestContext: { http: { method: "POST", path: `/api/bookings/${bookingSessionId}/paypal/create-order`, sourceIp: "203.0.113.1" } },
  };
}

function captureEvent(bookingSessionId: string): LambdaHttpRequest {
  return {
    version: "2.0",
    rawPath: `/api/bookings/${bookingSessionId}/paypal/capture`,
    headers: {
      "content-type": "application/json",
      "idempotency-key": "gaps-capture-idem-key-0001",
      origin: "https://booking.test",
      "x-booking-device-id": "gaps-device",
    },
    body: JSON.stringify({ paypalOrderId: "GAPS-ORDER-001" }),
    requestContext: { http: { method: "POST", path: `/api/bookings/${bookingSessionId}/paypal/capture`, sourceIp: "203.0.113.1" } },
  };
}

function loginEvent(reservationPublicId: string): LambdaHttpRequest {
  return {
    version: "2.0",
    rawPath: "/api/portal/login",
    headers: { "content-type": "application/json", origin: "https://booking.test" },
    body: JSON.stringify({ reservationPublicId, password: "hunter2-horse-battery", language: "en" }),
    requestContext: { http: { method: "POST", path: "/api/portal/login", sourceIp: "203.0.113.2" } },
  };
}

function helpRequestEvent(reservationPublicId: string, token: string, message: string): LambdaHttpRequest {
  return {
    version: "2.0",
    rawPath: `/api/portal/reservation/${reservationPublicId}/help-request`,
    headers: {
      "content-type": "application/json",
      "idempotency-key": "gaps-help-idem-key-0001",
      origin: "https://booking.test",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ type: "general", message }),
    requestContext: { http: { method: "POST", path: `/api/portal/reservation/${reservationPublicId}/help-request`, sourceIp: "203.0.113.2" } },
  };
}

function cancellationRequestEvent(reservationPublicId: string, token: string, message: string): LambdaHttpRequest {
  return {
    version: "2.0",
    rawPath: `/api/portal/reservation/${reservationPublicId}/cancellation-request`,
    headers: {
      "content-type": "application/json",
      "idempotency-key": "gaps-cancel-idem-key-0001",
      origin: "https://booking.test",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ reason: "change_of_plans", message }),
    requestContext: {
      http: { method: "POST", path: `/api/portal/reservation/${reservationPublicId}/cancellation-request`, sourceIp: "203.0.113.2" },
    },
  };
}

/** Drives search → hold → paypal order → paypal capture, returns the confirmed reservation's public ID and booking session ID. */
async function driveToBookingConfirmed(handler: ReturnType<typeof createBookingApiHandler>): Promise<{
  bookingSessionId: string;
  reservationPublicId: string;
}> {
  const searchResp = await handler(searchEvent());
  const { bookingSessionId, quoteId, properties } = JSON.parse(searchResp.body);
  const propertyId = properties[0].propertyId;

  const holdResp = await handler(
    holdEvent({
      quoteId,
      bookingSessionId,
      propertyId,
      paymentMethod: "paypal",
      guest: { firstName: "Gap", lastName: "Test", email: "gap@booking.test", phone: "+50688000002", country: "CR" },
      portalPassword: "hunter2-horse-battery",
      termsAccepted: true,
    })
  );
  const { booking } = JSON.parse(holdResp.body);

  await handler(orderEvent(bookingSessionId));
  const captureResp = await handler(captureEvent(bookingSessionId));
  const captureBody = JSON.parse(captureResp.body);

  return { bookingSessionId, reservationPublicId: captureBody.booking.reservationPublicId ?? booking.reservationPublicId };
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date("2026-06-01T10:00:00Z"));
  config = createTestConfig();
});

afterEach(() => {
  jest.useRealTimers();
  global.fetch = originalFetch;
  jest.restoreAllMocks();
});

// ── Gap 1 — no confirmation email on the normal (browser-capture) path ────────
//
// paypalOrders.ts only ever calls createEmailClient() once, for
// sendPaymentPending() during order creation (line ~160). The capture handler
// never sends a booking-confirmed email — that only happens from the PayPal
// webhook (paypalWebhooks.ts:585), which early-returns before emailing
// whenever it finds the session already `booking_confirmed` (the normal case,
// since the browser's own capture call already made that transition).
// Net effect: guests who complete checkout never get a confirmation email.

test.failing("known gap: browser-driven capture sends a booking-confirmed email to the guest", async () => {
  global.fetch = happyPathFetch() as typeof fetch;
  const sendBookingConfirmedSpy = jest.spyOn(EmailClient.prototype, "sendBookingConfirmed");
  const handler = createBookingApiHandler(config);

  await driveToBookingConfirmed(handler);

  expect(sendBookingConfirmedSpy).toHaveBeenCalled();
});

// ── Gap 2 — portal help/cancellation requests discard the guest's message ─────
//
// handlePortalHelpRequest / handlePortalCancellationRequest (portalPages.ts)
// only call observability.logger.info / recordStateTransition /
// recordSecurityEvent — none of which persist the message body (it's
// explicitly excluded from the structured log to avoid PII). No email client
// is created and no repository write happens, so the text the guest typed
// reaches no human. EmailClient is the only outbound-communication channel
// this codebase has (see sendDepositHandoff's use of config.email.contactEmail
// for exactly this "notify a human" purpose), so the fix should route through
// it; assert the guest's message text is contained in an outbound email.

test.failing("known gap: portal help request forwards the guest's message to a human via email", async () => {
  global.fetch = happyPathFetch() as typeof fetch;
  const handler = createBookingApiHandler(config);
  const { reservationPublicId } = await driveToBookingConfirmed(handler);

  const loginResp = await handler(loginEvent(reservationPublicId));
  const { token } = JSON.parse(loginResp.body);

  const sendSpy = jest.spyOn(EmailClient.prototype as unknown as { send: (...args: unknown[]) => Promise<void> }, "send");

  const message = "The air conditioning unit in the bedroom is leaking water onto the floor.";
  const helpResp = await handler(helpRequestEvent(reservationPublicId, token, message));
  expect(helpResp.statusCode).toBe(200);

  const forwarded = sendSpy.mock.calls.some((call) => call.some((arg) => typeof arg === "string" && arg.includes(message)));
  expect(forwarded).toBe(true);
});

test.failing("known gap: portal cancellation request forwards the guest's message to a human via email", async () => {
  global.fetch = happyPathFetch() as typeof fetch;
  const handler = createBookingApiHandler(config);
  const { reservationPublicId } = await driveToBookingConfirmed(handler);

  const loginResp = await handler(loginEvent(reservationPublicId));
  const { token } = JSON.parse(loginResp.body);

  const sendSpy = jest.spyOn(EmailClient.prototype as unknown as { send: (...args: unknown[]) => Promise<void> }, "send");

  const message = "Our flights got cancelled, we need to cancel this reservation.";
  const cancelResp = await handler(cancellationRequestEvent(reservationPublicId, token, message));
  expect(cancelResp.statusCode).toBe(200);

  const forwarded = sendSpy.mock.calls.some((call) => call.some((arg) => typeof arg === "string" && arg.includes(message)));
  expect(forwarded).toBe(true);
});

// ── Gap 5 — CAPTCHA provider mismatch between frontend and backend default ────
//
// FIXED. The frontend (Booking.page.tsx) exclusively mints Google reCAPTCHA v3
// tokens via react-google-recaptcha-v3's GoogleReCaptchaProvider, but the
// backend used to default CAPTCHA_PROVIDER to "hcaptcha" whenever the env var
// was unset or unrecognized. A Google token verified against hCaptcha's
// siteverify endpoint never validates, so once abuse thresholds triggered a
// challenge, legitimate guests got permanently stuck. The default now tracks
// the client. Kept as a live regression test — if the frontend widget is ever
// swapped, this must be updated in the same change.

test("default CAPTCHA_PROVIDER matches the frontend's Google reCAPTCHA v3 widget", () => {
  const resolvedConfig = loadConfig({ CAPTCHA_SECRET_KEY: "test-secret-key" } as NodeJS.ProcessEnv);
  expect(resolvedConfig.abuseProtection.captchaVerifier?.provider).toBe("recaptcha");
});

test("an unrecognized CAPTCHA_PROVIDER falls back to the frontend's provider rather than the other vendor", () => {
  const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
  const resolvedConfig = loadConfig({
    CAPTCHA_SECRET_KEY: "test-secret-key",
    CAPTCHA_PROVIDER: "turnstile",
  } as NodeJS.ProcessEnv);

  expect(resolvedConfig.abuseProtection.captchaVerifier?.provider).toBe("recaptcha");
  expect(warn).toHaveBeenCalledWith(expect.stringContaining("Unrecognized CAPTCHA_PROVIDER"));
  warn.mockRestore();
});

test("the CAPTCHA verifier is configured even when the secret only arrives via Secrets Manager", () => {
  const resolvedConfig = loadConfig({ CAPTCHA_PROVIDER: "recaptcha" } as NodeJS.ProcessEnv);

  // No CAPTCHA_SECRET_KEY in the environment: the verifier must still exist so
  // AbuseGuard can resolve the secret from the combined Secrets Manager entry.
  expect(resolvedConfig.abuseProtection.captchaVerifier).toEqual({ provider: "recaptcha" });
});

test("hcaptcha remains selectable for deployments that switch providers", () => {
  const resolvedConfig = loadConfig({
    CAPTCHA_SECRET_KEY: "test-secret-key",
    CAPTCHA_PROVIDER: "hcaptcha",
  } as NodeJS.ProcessEnv);

  expect(resolvedConfig.abuseProtection.captchaVerifier).toMatchObject({
    provider: "hcaptcha",
    secretKey: "test-secret-key",
  });
});
