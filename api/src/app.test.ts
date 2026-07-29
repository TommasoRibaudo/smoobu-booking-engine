import { createBookingApiHandler } from "./app";
import { InMemoryBookingSessionRepository } from "./bookingSessions";
import { InMemoryHoldRepository } from "./holds";
import { InMemoryPaymentRepository } from "./payments";
import { InMemoryWebhookEventRepository } from "./paypalWebhooks";
import { MissingSecretProvider } from "./secrets";
import { BookingApiConfig, LambdaHttpRequest } from "./types";

const config: BookingApiConfig = {
  allowedOrigins: ["https://booking.test"],
  maxBodyBytes: 64 * 1024,
  secrets: new MissingSecretProvider(),
  smoobu: {
    baseUrl: "https://login.smoobu.com",
    timeoutMs: 8_000,
    maxRetries: 3,
    baseBackoffMs: 250,
    maxBackoffMs: 2_000,
    maxRateLimitDelayMs: 60_000,
    holdChannelId: 11,
  },
  paypal: {
    baseUrl: "https://api-m.sandbox.paypal.com",
    timeoutMs: 10_000,
    orderReturnUrl: "",
    orderCancelUrl: "",
  },
  bookingSessions: new InMemoryBookingSessionRepository(),
  holds: new InMemoryHoldRepository(),
  payments: new InMemoryPaymentRepository(),
  webhookEvents: new InMemoryWebhookEventRepository(),
  hold: {
    defaultTtlMinutes: 60,
    idempotencyTtlMinutes: 1440,
    staleIdempotencyLockSeconds: 120,
  },
  abuseProtection: {
    enabled: true,
    captchaChallengesEnabled: true,
    maxTrackedBuckets: 100,
  },
  email: {
    fromAddress: "test@example.com",
    region: "us-east-1",
    disabled: true,
  },
  observability: {
    serviceName: "booking-api",
    environment: "test",
    logLevel: "silent",
    metricsEnabled: false,
  },
};

const validHoldBody = {
  quoteId: "qt_valid",
  bookingSessionId: "11111111-0000-4000-8000-000000000001",
  propertyId: "a1b2c3d4-1234-4abc-89ab-000000000001",
  paymentMethod: "paypal",
  guest: {
    firstName: "Jane",
    lastName: "Doe",
    email: "jane@example.com",
  },
  portalPassword: "correct-horse-battery",
  termsAccepted: true,
};

function makePostEvent(body: unknown, idempotencyKey: string): LambdaHttpRequest {
  return {
    version: "2.0",
    rawPath: "/api/holds",
    headers: {
      "content-type": "application/json",
      "idempotency-key": idempotencyKey,
      "user-agent": "Jest Browser",
      "x-booking-device-id": "device-abc-123",
    },
    body: JSON.stringify(body),
    requestContext: {
      http: {
        method: "POST",
        path: "/api/holds",
        sourceIp: "203.0.113.10",
        userAgent: "Jest Browser",
      },
    },
  };
}

test("booking handler: hold route triggers CAPTCHA before repeated create attempts reach handler", async () => {
  const handler = createBookingApiHandler(config);

  const first = await handler(makePostEvent(validHoldBody, "idem-key-00000001"));
  const second = await handler(makePostEvent(validHoldBody, "idem-key-00000002"));
  const third = await handler(makePostEvent(validHoldBody, "idem-key-00000003"));

  expect(first.statusCode).toBe(404);
  expect(second.statusCode).toBe(404);
  expect(third.statusCode).toBe(403);
  expect(third.headers["X-Captcha-Required"]).toBe("true");
  expect(JSON.parse(third.body).error.code).toBe("captcha_required");
});
