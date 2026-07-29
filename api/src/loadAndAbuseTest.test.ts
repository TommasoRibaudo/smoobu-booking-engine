/**
 * Task 7.3 — Load + abuse testing
 *
 * Simulates bot traffic patterns against the search and hold endpoints and
 * validates that:
 *   - Rate limits engage at the correct thresholds for each policy
 *   - CAPTCHA challenges fire before hard 429s on sensitive endpoints
 *   - Distinct IPs / devices are tracked independently (no cross-contamination)
 *   - Rate-limit headers are present and accurate on every response
 *   - Smoobu API call volume is bounded (cost control): the AbuseGuard stops
 *     requests before they reach the Smoobu proxy layer
 *   - Disabled abuse protection lets all traffic through (feature-flag safety)
 *   - Window expiry resets counters so legitimate traffic recovers
 */

import { AbuseGuard } from "./abuseProtection";
import { createBookingApiHandler } from "./app";
import { InMemoryBookingSessionRepository } from "./bookingSessions";
import { InMemoryHoldRepository } from "./holds";
import { InMemoryPaymentRepository } from "./payments";
import { InMemoryWebhookEventRepository } from "./paypalWebhooks";
import { MissingSecretProvider } from "./secrets";
import {
  AbuseProtectionConfig,
  BookingApiConfig,
  LambdaHttpRequest,
  RouteObservability,
  RouteRequest,
} from "./types";

// ---------------------------------------------------------------------------
// Shared test helpers
// ---------------------------------------------------------------------------

const ABUSE_CONFIG: AbuseProtectionConfig = {
  enabled: true,
  captchaChallengesEnabled: true,
  maxTrackedBuckets: 1_000,
};

const NOOP_OBSERVABILITY: RouteObservability = {
  logger: {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  },
  recordProviderCall: () => undefined,
  recordStateTransition: () => undefined,
  recordSecurityEvent: () => undefined,
};

function makeRequest(overrides: Partial<RouteRequest> = {}): RouteRequest {
  return {
    method: "POST",
    path: "/api/search",
    headers: {
      "user-agent": "BotSimulator/1.0",
      "accept-language": "en-US",
      "x-booking-device-id": "bot-device-001",
      ...overrides.headers,
    },
    responseHeaders: {},
    query: {},
    pathParams: {},
    body: undefined,
    rawBody: "",
    correlationId: "load-test-correlation",
    clientIp: "198.51.100.1",
    userAgent: "BotSimulator/1.0",
    observability: NOOP_OBSERVABILITY,
    ...overrides,
  };
}

/** Fire `count` requests through the guard and return all thrown errors. */
async function fireRequests(
  guard: AbuseGuard,
  request: RouteRequest,
  policy: Parameters<AbuseGuard["assertAllowed"]>[1],
  count: number
): Promise<Array<{ index: number; error: unknown }>> {
  const errors: Array<{ index: number; error: unknown }> = [];
  for (let i = 0; i < count; i++) {
    try {
      await guard.assertAllowed(request, policy);
    } catch (error) {
      errors.push({ index: i, error });
    }
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Integration-level handler helpers (end-to-end through createBookingApiHandler)
// ---------------------------------------------------------------------------

function makeHandlerConfig(): BookingApiConfig {
  return {
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
    abuseProtection: ABUSE_CONFIG,
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
}

function makeSearchEvent(overrides: {
  ip?: string;
  deviceId?: string;
  idempotencyKey?: string;
} = {}): LambdaHttpRequest {
  return {
    version: "2.0",
    rawPath: "/api/search",
    headers: {
      "content-type": "application/json",
      "user-agent": "BotSimulator/1.0",
      "x-booking-device-id": overrides.deviceId ?? "bot-device-001",
    },
    body: JSON.stringify({
      arrivalDate: "2027-06-01",
      departureDate: "2027-06-05",
      guests: 2,
      language: "en",
    }),
    requestContext: {
      http: {
        method: "POST",
        path: "/api/search",
        sourceIp: overrides.ip ?? "198.51.100.1",
        userAgent: "BotSimulator/1.0",
      },
    },
  };
}

function makeHoldEvent(overrides: {
  ip?: string;
  deviceId?: string;
  idempotencyKey?: string;
} = {}): LambdaHttpRequest {
  // Idempotency-Key must be 16–128 chars per assertRouteHardening
  const defaultKey = `idem-hold-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return {
    version: "2.0",
    rawPath: "/api/holds",
    headers: {
      "content-type": "application/json",
      "idempotency-key": overrides.idempotencyKey ?? defaultKey,
      "user-agent": "BotSimulator/1.0",
      "x-booking-device-id": overrides.deviceId ?? "bot-device-001",
    },
    body: JSON.stringify({
      quoteId: "qt_bot_test",
      bookingSessionId: "11111111-0000-4000-8000-000000000001",
      propertyId: "a1b2c3d4-1234-4abc-89ab-000000000001",
      paymentMethod: "paypal",
      guest: {
        firstName: "Bot",
        lastName: "Tester",
        email: "bot@example.com",
      },
      portalPassword: "correct-horse-battery",
      termsAccepted: true,
    }),
    requestContext: {
      http: {
        method: "POST",
        path: "/api/holds",
        sourceIp: overrides.ip ?? "198.51.100.1",
        userAgent: "BotSimulator/1.0",
      },
    },
  };
}

// ---------------------------------------------------------------------------
// 1. Search endpoint — availabilitySearch policy (30 req/min per IP, 20 per device)
// ---------------------------------------------------------------------------

describe("search endpoint — availabilitySearch rate limiting", () => {
  test("bot exhausts per-IP search limit and receives 429", async () => {
    const handler = createBookingApiHandler(makeHandlerConfig());
    const statuses: number[] = [];

    // IP limit is 30/min. Fire 35 requests from the same IP.
    for (let i = 0; i < 35; i++) {
      const res = await handler(makeSearchEvent({ ip: "198.51.100.10", deviceId: `device-${i}` }));
      statuses.push(res.statusCode);
    }

    const blocked = statuses.filter((s) => s === 429);
    expect(blocked.length).toBeGreaterThanOrEqual(5);
    // First 30 must not be rate-limited
    expect(statuses.slice(0, 30).every((s) => s !== 429)).toBe(true);
  });

  test("bot exhausts per-device search limit and receives 429", async () => {
    const handler = createBookingApiHandler(makeHandlerConfig());
    const statuses: number[] = [];

    // Device limit is 20/min. Rotate IPs but keep same device ID.
    for (let i = 0; i < 25; i++) {
      const res = await handler(makeSearchEvent({ ip: `198.51.100.${i + 1}`, deviceId: "sticky-bot-device" }));
      statuses.push(res.statusCode);
    }

    const blocked = statuses.filter((s) => s === 429);
    expect(blocked.length).toBeGreaterThanOrEqual(5);
    expect(statuses.slice(0, 20).every((s) => s !== 429)).toBe(true);
  });

  test("rate-limit headers are present on allowed search response", async () => {
    const handler = createBookingApiHandler(makeHandlerConfig());

    const res = await handler(makeSearchEvent({ ip: "198.51.100.20", deviceId: "header-check-device" }));

    expect(res.headers["X-RateLimit-Policy"]).toBe("availabilitySearch");
    expect(res.headers["X-RateLimit-Limit"]).toBeDefined();
    expect(res.headers["X-RateLimit-Remaining"]).toBeDefined();
    expect(res.headers["X-RateLimit-Reset"]).toBeDefined();
  });

  test("rate-limit headers are present on 429 blocked search response", async () => {
    const handler = createBookingApiHandler(makeHandlerConfig());

    // Exhaust the IP limit (30/min) using distinct device IDs
    for (let i = 0; i < 30; i++) {
      await handler(makeSearchEvent({ ip: "198.51.100.21", deviceId: `hdr-429-dev-${i}` }));
    }

    // 31st request should be 429
    const blocked = await handler(makeSearchEvent({ ip: "198.51.100.21", deviceId: "hdr-429-dev-overflow" }));

    expect(blocked.statusCode).toBe(429);
    expect(blocked.headers["X-RateLimit-Policy"]).toBe("availabilitySearch");
    expect(blocked.headers["X-RateLimit-Limit"]).toBeDefined();
    expect(blocked.headers["X-RateLimit-Remaining"]).toBe("0");
    expect(blocked.headers["Retry-After"]).toBeDefined();
    expect(Number(blocked.headers["Retry-After"])).toBeGreaterThan(0);
  });

  test("Retry-After header is set when search IP limit is exceeded", async () => {
    const guard = new AbuseGuard({ ...ABUSE_CONFIG, captchaChallengesEnabled: false }, () => 1_000);
    const request = makeRequest({ path: "/api/search" });

    // Exhaust IP limit (30/60s) using distinct device IDs
    for (let i = 0; i < 30; i++) {
      await guard.assertAllowed(
        makeRequest({ headers: { "x-booking-device-id": `unique-${i}` } }),
        "availabilitySearch"
      );
    }

    try {
      await guard.assertAllowed(request, "availabilitySearch");
      throw new Error("Expected rate limit error");
    } catch (error: unknown) {
      expect((error as { statusCode?: number }).statusCode).toBe(429);
      expect(request.responseHeaders["Retry-After"]).toBeDefined();
      expect(Number(request.responseHeaders["Retry-After"])).toBeGreaterThan(0);
    }
  });

  test("two different IPs are tracked independently — one blocked does not affect the other", async () => {
    const guard = new AbuseGuard({ ...ABUSE_CONFIG, captchaChallengesEnabled: false }, () => 1_000);

    // Exhaust IP A (30 requests)
    for (let i = 0; i < 30; i++) {
      await guard.assertAllowed(
        makeRequest({ clientIp: "10.0.0.1", headers: { "x-booking-device-id": `dev-a-${i}` } }),
        "availabilitySearch"
      );
    }

    // IP A is now blocked
    await expect(
      guard.assertAllowed(
        makeRequest({ clientIp: "10.0.0.1", headers: { "x-booking-device-id": "dev-a-overflow" } }),
        "availabilitySearch"
      )
    ).rejects.toBeDefined();

    // IP B should still be allowed
    await expect(
      guard.assertAllowed(
        makeRequest({ clientIp: "10.0.0.2", headers: { "x-booking-device-id": "dev-b-1" } }),
        "availabilitySearch"
      )
    ).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 2. Hold endpoint — holdCreate policy (8 req/15min per IP, captchaAfter=3)
// ---------------------------------------------------------------------------

describe("hold endpoint — holdCreate rate limiting and CAPTCHA", () => {
  test("CAPTCHA challenge fires after 3 hold attempts from same device", async () => {
    const guard = new AbuseGuard(ABUSE_CONFIG, () => 1_000);
    const request = makeRequest({ path: "/api/holds" });

    await guard.assertAllowed(request, "holdCreate"); // 1
    await guard.assertAllowed(request, "holdCreate"); // 2

    // 3rd attempt triggers CAPTCHA (captchaAfter=2 for device scope)
    try {
      await guard.assertAllowed(request, "holdCreate");
      throw new Error("Expected captcha_required");
    } catch (error: unknown) {
      expect((error as { statusCode?: number }).statusCode).toBe(403);
      expect((error as { code?: string }).code).toBe("captcha_required");
      expect(request.responseHeaders["X-Captcha-Required"]).toBe("true");
      expect(request.responseHeaders["X-Captcha-Policy"]).toBe("holdCreate");
    }
  });

  /**
   * When no captchaVerifier is configured (CAPTCHA_SECRET_KEY not set),
   * a token in the request header is ignored and the 403 is still returned.
   * This is the safe default: the bypass only works when a verifier is wired up.
   */
  test("no verifier configured — token in request header does not unblock", async () => {
    // ABUSE_CONFIG has no captchaVerifier, matching the default when CAPTCHA_SECRET_KEY is unset.
    const guard = new AbuseGuard(ABUSE_CONFIG, () => 1_000);

    const baseRequest = makeRequest({ path: "/api/holds" });
    await guard.assertAllowed(baseRequest, "holdCreate");
    await guard.assertAllowed(baseRequest, "holdCreate");

    const requestWithToken = makeRequest({
      path: "/api/holds",
      headers: {
        "user-agent": "BotSimulator/1.0",
        "accept-language": "en-US",
        "x-booking-device-id": "bot-device-001",
        "x-captcha-token": "simulated-valid-token",
      },
    });

    try {
      await guard.assertAllowed(requestWithToken, "holdCreate");
      throw new Error("Expected captcha_required");
    } catch (error: unknown) {
      expect((error as { statusCode?: number }).statusCode).toBe(403);
      expect((error as { code?: string }).code).toBe("captcha_required");
    }
  });

  test("hold endpoint returns 403 captcha_required via full handler after 3 attempts", async () => {
    const handler = createBookingApiHandler(makeHandlerConfig());
    const statuses: number[] = [];
    const codes: string[] = [];

    // Keys must be 16–128 chars (assertRouteHardening requirement)
    const keys = [
      "idem-hold-key-001",
      "idem-hold-key-002",
      "idem-hold-key-003",
      "idem-hold-key-004",
      "idem-hold-key-005",
    ];

    for (let i = 0; i < 5; i++) {
      const res = await handler(makeHoldEvent({ ip: "198.51.100.30", idempotencyKey: keys[i] }));
      statuses.push(res.statusCode);
      try {
        codes.push(JSON.parse(res.body).error?.code ?? "");
      } catch {
        codes.push("");
      }
    }

    // First two pass abuse guard (fail at business logic — 404 quote not found)
    expect(statuses[0]).toBe(404);
    expect(statuses[1]).toBe(404);
    // Third triggers CAPTCHA (device captchaAfter=2)
    expect(statuses[2]).toBe(403);
    expect(codes[2]).toBe("captcha_required");
  });

  test("hold IP hard limit (8/15min) blocks after CAPTCHA window is exhausted", async () => {
    // Disable CAPTCHA to test the hard IP cap directly
    const guard = new AbuseGuard({ ...ABUSE_CONFIG, captchaChallengesEnabled: false }, () => 1_000);

    // Exhaust IP limit (8/900s) using distinct device IDs so device bucket stays low
    for (let i = 0; i < 8; i++) {
      await guard.assertAllowed(
        makeRequest({ path: "/api/holds", headers: { "x-booking-device-id": `hold-dev-${i}` } }),
        "holdCreate"
      );
    }

    const request = makeRequest({
      path: "/api/holds",
      headers: { "x-booking-device-id": "hold-dev-overflow" },
    });

    try {
      await guard.assertAllowed(request, "holdCreate");
      throw new Error("Expected rate limit");
    } catch (error: unknown) {
      expect((error as { statusCode?: number }).statusCode).toBe(429);
      expect(request.responseHeaders["Retry-After"]).toBeDefined();
      expect(Number(request.responseHeaders["Retry-After"])).toBeGreaterThan(0);
    }
  });

  test("bot rotating IPs still hits per-device hold limit", async () => {
    const guard = new AbuseGuard(ABUSE_CONFIG, () => 1_000);

    // Device limit is 5/900s with captchaAfter=2
    // Use a single sticky device ID but rotate IPs
    const stickyDevice = "sticky-hold-bot";

    await guard.assertAllowed(
      makeRequest({ clientIp: "10.1.0.1", headers: { "x-booking-device-id": stickyDevice } }),
      "holdCreate"
    );
    await guard.assertAllowed(
      makeRequest({ clientIp: "10.1.0.2", headers: { "x-booking-device-id": stickyDevice } }),
      "holdCreate"
    );

    // 3rd attempt from a new IP but same device → CAPTCHA
    try {
      await guard.assertAllowed(
        makeRequest({ clientIp: "10.1.0.3", headers: { "x-booking-device-id": stickyDevice } }),
        "holdCreate"
      );
      throw new Error("Expected captcha_required");
    } catch (error: unknown) {
      expect((error as { code?: string }).code).toBe("captcha_required");
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Cost control: Smoobu API call volume is bounded by rate limiting
// ---------------------------------------------------------------------------

describe("cost control — Smoobu API calls bounded by rate limits", () => {
  test("search rate limit prevents more than 30 Smoobu calls per minute from one IP", async () => {
    const guard = new AbuseGuard({ ...ABUSE_CONFIG, captchaChallengesEnabled: false }, () => 1_000);
    let allowedCount = 0;

    for (let i = 0; i < 50; i++) {
      try {
        await guard.assertAllowed(
          makeRequest({ clientIp: "203.0.113.50", headers: { "x-booking-device-id": `cost-dev-${i}` } }),
          "availabilitySearch"
        );
        allowedCount++;
      } catch {
        // blocked
      }
    }

    // At most 30 requests should reach the Smoobu proxy layer from this IP
    expect(allowedCount).toBeLessThanOrEqual(30);
  });

  test("hold rate limit prevents more than 8 Smoobu hold-create calls per 15min from one IP", async () => {
    const guard = new AbuseGuard({ ...ABUSE_CONFIG, captchaChallengesEnabled: false }, () => 1_000);
    let allowedCount = 0;

    for (let i = 0; i < 20; i++) {
      try {
        await guard.assertAllowed(
          makeRequest({ clientIp: "203.0.113.60", headers: { "x-booking-device-id": `hold-cost-dev-${i}` } }),
          "holdCreate"
        );
        allowedCount++;
      } catch {
        // blocked
      }
    }

    expect(allowedCount).toBeLessThanOrEqual(8);
  });

  test("concurrent bots from different IPs are each individually capped", async () => {
    const guard = new AbuseGuard({ ...ABUSE_CONFIG, captchaChallengesEnabled: false }, () => 1_000);
    const botIps = ["203.0.113.71", "203.0.113.72", "203.0.113.73"];
    const allowedPerBot: Record<string, number> = {};

    for (const ip of botIps) {
      allowedPerBot[ip] = 0;
      for (let i = 0; i < 50; i++) {
        try {
          await guard.assertAllowed(
            makeRequest({ clientIp: ip, headers: { "x-booking-device-id": `${ip}-dev-${i}` } }),
            "availabilitySearch"
          );
          allowedPerBot[ip]++;
        } catch {
          // blocked
        }
      }
    }

    for (const ip of botIps) {
      expect(allowedPerBot[ip]).toBeLessThanOrEqual(30);
    }
  });
});

// ---------------------------------------------------------------------------
// 4. Window expiry — legitimate traffic recovers after the rate-limit window
// ---------------------------------------------------------------------------

describe("window expiry — traffic recovers after window resets", () => {
  test("search window resets after 60 seconds and allows new requests", async () => {
    let now = 1_000;
    const guard = new AbuseGuard({ ...ABUSE_CONFIG, captchaChallengesEnabled: false }, () => now);
    const request = makeRequest({ path: "/api/search" });

    // Exhaust IP limit
    const errors = await fireRequests(guard, request, "availabilitySearch", 31);
    expect(errors.length).toBeGreaterThanOrEqual(1);

    // Advance clock past the 60-second window
    now += 60 * 1_000 + 1;

    // Should be allowed again
    await expect(guard.assertAllowed(request, "availabilitySearch")).resolves.toBeUndefined();
  });

  test("hold window resets after 15 minutes and allows new requests", async () => {
    let now = 1_000;
    const guard = new AbuseGuard(ABUSE_CONFIG, () => now);
    const request = makeRequest({ path: "/api/holds" });

    // Trigger CAPTCHA
    await guard.assertAllowed(request, "holdCreate");
    await guard.assertAllowed(request, "holdCreate");
    await expect(guard.assertAllowed(request, "holdCreate")).rejects.toBeDefined();

    // Advance clock past the 15-minute window
    now += 15 * 60 * 1_000 + 1;

    // Should be allowed again
    await expect(guard.assertAllowed(request, "holdCreate")).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 5. Disabled abuse protection — feature-flag safety
// ---------------------------------------------------------------------------

describe("disabled abuse protection — feature-flag safety", () => {
  test("all search requests pass through when abuse protection is disabled", async () => {
    const config = makeHandlerConfig();
    config.abuseProtection = { ...ABUSE_CONFIG, enabled: false };
    const handler = createBookingApiHandler(config);

    const statuses: number[] = [];
    for (let i = 0; i < 50; i++) {
      const res = await handler(makeSearchEvent({ ip: "198.51.100.99", deviceId: "disabled-test-device" }));
      statuses.push(res.statusCode);
    }

    // None should be 429 (rate limited) — business logic errors (503/404) are fine
    expect(statuses.every((s) => s !== 429)).toBe(true);
  });

  test("no rate-limit headers are set when abuse protection is disabled", async () => {
    const guard = new AbuseGuard({ ...ABUSE_CONFIG, enabled: false }, () => 1_000);
    const request = makeRequest();

    for (let i = 0; i < 50; i++) {
      await guard.assertAllowed(request, "availabilitySearch");
    }

    expect(request.responseHeaders["X-RateLimit-Policy"]).toBeUndefined();
    expect(request.responseHeaders["X-RateLimit-Limit"]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 6. Sustained bot burst — mixed search + hold traffic
// ---------------------------------------------------------------------------

describe("sustained bot burst — mixed search and hold traffic", () => {
  test("bot sending alternating search and hold requests is blocked on both endpoints", async () => {
    const handler = createBookingApiHandler(makeHandlerConfig());
    const searchStatuses: number[] = [];
    const holdStatuses: number[] = [];

    // Simulate a bot alternating between search and hold from the same IP + same device
    // (sticky device ID so the device bucket accumulates and triggers CAPTCHA at attempt 3)
    for (let i = 0; i < 40; i++) {
      if (i % 2 === 0) {
        const res = await handler(makeSearchEvent({ ip: "198.51.100.50", deviceId: "burst-bot-device" }));
        searchStatuses.push(res.statusCode);
      } else {
        const res = await handler(
          makeHoldEvent({
            ip: "198.51.100.50",
            deviceId: "burst-bot-device",
            idempotencyKey: `idem-burst-hold-key-${i.toString().padStart(4, "0")}`,
          })
        );
        holdStatuses.push(res.statusCode);
      }
    }

    // Search: 20 requests, limit is 30 — none should be rate-limited
    expect(searchStatuses.every((s) => s !== 429)).toBe(true);

    // Hold: 20 requests, device captchaAfter=2 — should see 403 (captcha_required)
    const holdBlocked = holdStatuses.filter((s) => s === 403 || s === 429);
    expect(holdBlocked.length).toBeGreaterThan(0);
  });

  test("high-volume bot from single IP is blocked within the first window", async () => {
    const guard = new AbuseGuard({ ...ABUSE_CONFIG, captchaChallengesEnabled: false }, () => 1_000);
    let blockedAt: number | undefined;

    for (let i = 0; i < 100; i++) {
      try {
        await guard.assertAllowed(
          makeRequest({ clientIp: "203.0.113.100", headers: { "x-booking-device-id": `hv-dev-${i}` } }),
          "availabilitySearch"
        );
      } catch {
        if (blockedAt === undefined) {
          blockedAt = i;
        }
      }
    }

    // Must be blocked within the first 31 requests (limit is 30)
    expect(blockedAt).toBeDefined();
    expect(blockedAt!).toBeLessThanOrEqual(30);
  });
});

// ---------------------------------------------------------------------------
// 7. Portal login — brute-force protection
// ---------------------------------------------------------------------------

describe("portal login — brute-force protection", () => {
  test("portal login is blocked after 5 attempts from same device", async () => {
    const guard = new AbuseGuard(ABUSE_CONFIG, () => 1_000);
    const request = makeRequest({ path: "/api/portal/login" });

    for (let i = 0; i < 5; i++) {
      await guard.assertAllowed(request, "portalLogin");
    }

    try {
      await guard.assertAllowed(request, "portalLogin");
      throw new Error("Expected rate limit");
    } catch (error: unknown) {
      expect((error as { statusCode?: number }).statusCode).toBe(429);
    }
  });

  test("portal login IP limit (10/5min) blocks credential-stuffing bots", async () => {
    const guard = new AbuseGuard({ ...ABUSE_CONFIG, captchaChallengesEnabled: false }, () => 1_000);

    // Rotate device IDs to bypass device limit, keep same IP
    for (let i = 0; i < 10; i++) {
      await guard.assertAllowed(
        makeRequest({ clientIp: "10.2.0.1", headers: { "x-booking-device-id": `stuffing-dev-${i}` } }),
        "portalLogin"
      );
    }

    try {
      await guard.assertAllowed(
        makeRequest({ clientIp: "10.2.0.1", headers: { "x-booking-device-id": "stuffing-dev-overflow" } }),
        "portalLogin"
      );
      throw new Error("Expected rate limit");
    } catch (error: unknown) {
      expect((error as { statusCode?: number }).statusCode).toBe(429);
    }
  });
});
