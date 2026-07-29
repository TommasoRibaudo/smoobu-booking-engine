/**
 * Deposit receipt upload endpoints.
 *
 * The two behaviours most worth pinning down:
 *   - the presigned PUT must NOT carry ContentLength. SigV4 signs whatever
 *     headers are present, so pinning the length would force the browser to
 *     upload exactly that many bytes or receive a 403 from S3.
 *   - both endpoints require a deposit_access token. Without one the only gate
 *     is a bookingSessionId in the body.
 */

const putObjectInput: Record<string, unknown>[] = [];
const headObjectResponses: Array<{ ContentLength?: number } | Error> = [];

jest.mock("@aws-sdk/client-s3", () => ({
  S3Client: class {
    async send(command: { __type: string }) {
      if (command.__type === "HeadObject") {
        const next = headObjectResponses.shift() ?? { ContentLength: 1024 };
        if (next instanceof Error) {
          throw next;
        }
        return next;
      }
      return {};
    }
  },
  PutObjectCommand: class {
    __type = "PutObject";
    constructor(public input: Record<string, unknown>) {
      putObjectInput.push(input);
    }
  },
  GetObjectCommand: class {
    __type = "GetObject";
    constructor(public input: Record<string, unknown>) {}
  },
  HeadObjectCommand: class {
    __type = "HeadObject";
    constructor(public input: Record<string, unknown>) {}
  },
}));

jest.mock("@aws-sdk/s3-request-presigner", () => ({
  getSignedUrl: jest.fn(async () => "https://s3.example.test/presigned"),
}));

import { createBookingApiHandler } from "./app";
import { InMemoryBookingSessionRepository } from "./bookingSessions";
import { InMemoryHoldRepository } from "./holds";
import { InMemoryPaymentRepository } from "./payments";
import { StaticSecretProvider } from "./secrets";
import { issueSignedToken } from "./signedTokens";
import { BookingApiConfig, LambdaHttpRequest } from "./types";

const PORTAL_SECRET = "portal-session-secret-for-deposit-receipt-tests";
const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024;

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
    payments: new InMemoryPaymentRepository(),
    s3Upload: {
      bucketName: "booking-test-receipts",
      region: "us-east-1",
      presignedPutExpirySeconds: 300,
      presignedGetExpirySeconds: 604_800,
      maxFileSizeBytes: MAX_FILE_SIZE_BYTES,
      allowedMimeTypes: ["image/jpeg", "image/png", "application/pdf"],
    },
    hold: { defaultTtlMinutes: 60, idempotencyTtlMinutes: 1440, staleIdempotencyLockSeconds: 120 },
    abuseProtection: { enabled: false, captchaChallengesEnabled: false, maxTrackedBuckets: 100 },
    email: { fromAddress: "test@example.com", region: "us-east-1", disabled: true },
    observability: { serviceName: "booking-api", environment: "test", logLevel: "silent", metricsEnabled: false },
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

function accessToken(bookingSessionId: string, reservationPublicId: string): string {
  return `Bearer ${issueSignedToken(
    { bookingSessionId, reservationPublicId, purpose: "deposit_access", ttlSeconds: 3600 },
    PORTAL_SECRET
  )}`;
}

function post(path: string, body: unknown, authorization?: string, idempotencyKey?: string): LambdaHttpRequest {
  return {
    version: "2.0",
    rawPath: path,
    headers: {
      "content-type": "application/json",
      origin: "https://booking.test",
      ...(authorization ? { authorization } : {}),
      ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
    },
    body: JSON.stringify(body),
    requestContext: { http: { method: "POST", path, sourceIp: "203.0.113.9" } },
  };
}

beforeEach(() => {
  putObjectInput.length = 0;
  headObjectResponses.length = 0;
  config = createTestConfig();
  handler = createBookingApiHandler(config);
});

// ── presigned upload ─────────────────────────────────────────────────────────

it("presigns a PUT without ContentLength so the browser can send any size up to the cap", async () => {
  const session = await seedSession();

  const response = await handler(
    post(
      "/api/deposit-receipt/upload-url",
      { bookingSessionId: session.id, fileName: "receipt.jpg", contentType: "image/jpeg" },
      accessToken(session.id, session.reservationPublicId)
    )
  );

  expect(response.statusCode).toBe(200);
  const body = JSON.parse(response.body);
  expect(body.uploadUrl).toBe("https://s3.example.test/presigned");
  expect(body.s3Key).toContain(`deposit-receipts/${session.id}/`);

  expect(putObjectInput).toHaveLength(1);
  expect(putObjectInput[0]).not.toHaveProperty("ContentLength");
  expect(putObjectInput[0].ContentType).toBe("image/jpeg");
});

it("rejects a content type outside the allowlist", async () => {
  const session = await seedSession();

  const response = await handler(
    post(
      "/api/deposit-receipt/upload-url",
      { bookingSessionId: session.id, fileName: "receipt.exe", contentType: "application/x-msdownload" },
      accessToken(session.id, session.reservationPublicId)
    )
  );

  expect(response.statusCode).toBe(400);
  expect(JSON.parse(response.body).error.code).toBe("invalid_content_type");
});

// ── authorization ────────────────────────────────────────────────────────────

it("refuses an upload URL without a deposit access token", async () => {
  const session = await seedSession();

  const response = await handler(
    post("/api/deposit-receipt/upload-url", {
      bookingSessionId: session.id,
      fileName: "receipt.jpg",
      contentType: "image/jpeg",
    })
  );

  expect(response.statusCode).toBe(401);
  expect(putObjectInput).toHaveLength(0);
});

it("refuses a token issued for a different booking session", async () => {
  const session = await seedSession();
  const other = await seedSession();

  const response = await handler(
    post(
      "/api/deposit-receipt/upload-url",
      { bookingSessionId: session.id, fileName: "receipt.jpg", contentType: "image/jpeg" },
      accessToken(other.id, other.reservationPublicId)
    )
  );

  expect(response.statusCode).toBe(403);
});

// ── confirm ──────────────────────────────────────────────────────────────────

it("stores the receipt key and returns a presigned download link", async () => {
  const session = await seedSession();
  const s3Key = `deposit-receipts/${session.id}/1700000000-receipt.jpg`;
  headObjectResponses.push({ ContentLength: 2048 });

  const response = await handler(
    post(
      "/api/deposit-receipt/confirm",
      { bookingSessionId: session.id, s3Key },
      accessToken(session.id, session.reservationPublicId),
      "deposit-receipt-confirm-001"
    )
  );

  expect(response.statusCode).toBe(200);
  const stored = await bookingSessions.getById(session.id);
  expect(stored?.depositReceiptS3Key).toBe(s3Key);
  // A plain object URL would 403 against a private bucket.
  expect(JSON.stringify(JSON.parse(response.body))).toContain("https://s3.example.test/presigned");
});

it("rejects an s3 key belonging to another booking session", async () => {
  const session = await seedSession();
  const other = await seedSession();

  const response = await handler(
    post(
      "/api/deposit-receipt/confirm",
      { bookingSessionId: session.id, s3Key: `deposit-receipts/${other.id}/1700000000-receipt.jpg` },
      accessToken(session.id, session.reservationPublicId),
      "deposit-receipt-confirm-002"
    )
  );

  expect(response.statusCode).toBe(400);
  expect(JSON.parse(response.body).error.code).toBe("invalid_s3_key");
});

it("rejects an object larger than the configured cap", async () => {
  const session = await seedSession();
  headObjectResponses.push({ ContentLength: MAX_FILE_SIZE_BYTES + 1 });

  const response = await handler(
    post(
      "/api/deposit-receipt/confirm",
      { bookingSessionId: session.id, s3Key: `deposit-receipts/${session.id}/1700000000-receipt.jpg` },
      accessToken(session.id, session.reservationPublicId),
      "deposit-receipt-confirm-003"
    )
  );

  expect(response.statusCode).toBe(400);
  expect(JSON.parse(response.body).error.code).toBe("upload_too_large");

  // Nothing is recorded against the booking for an oversize upload.
  const stored = await bookingSessions.getById(session.id);
  expect(stored?.depositReceiptS3Key).toBeUndefined();
});

it("reports a missing object as an upload that has not happened yet", async () => {
  const session = await seedSession();
  const notFound = new Error("not found");
  notFound.name = "NotFound";
  headObjectResponses.push(notFound);

  const response = await handler(
    post(
      "/api/deposit-receipt/confirm",
      { bookingSessionId: session.id, s3Key: `deposit-receipts/${session.id}/1700000000-receipt.jpg` },
      accessToken(session.id, session.reservationPublicId),
      "deposit-receipt-confirm-004"
    )
  );

  expect(response.statusCode).toBe(400);
  expect(JSON.parse(response.body).error.code).toBe("upload_not_found");
});
