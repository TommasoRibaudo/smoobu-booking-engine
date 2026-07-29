import { AbuseGuard, verifyCaptchaToken } from "./abuseProtection";
import { ApiError } from "./http/errors";
import { AbuseProtectionConfig, RouteObservability, RouteRequest } from "./types";

const config: AbuseProtectionConfig = {
  enabled: true,
  captchaChallengesEnabled: true,
  maxTrackedBuckets: 100,
};

const noopObservability: RouteObservability = {
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
    path: "/api/holds",
    headers: {
      "user-agent": "Jest Browser",
      "accept-language": "en-US",
      "x-booking-device-id": "device-abc-123",
      ...overrides.headers,
    },
    responseHeaders: {},
    query: {},
    pathParams: {},
    body: undefined,
    rawBody: "",
    correlationId: "test-correlation",
    clientIp: "203.0.113.10",
    userAgent: "Jest Browser",
    observability: noopObservability,
    ...overrides,
  };
}

function captureApiError(fn: () => void): ApiError {
  try {
    fn();
  } catch (error) {
    if (error instanceof ApiError) {
      return error;
    }
    throw error;
  }

  throw new Error("Expected ApiError to be thrown.");
}

async function captureApiErrorAsync(fn: () => Promise<void>): Promise<ApiError> {
  try {
    await fn();
  } catch (error) {
    if (error instanceof ApiError) {
      return error;
    }
    throw error;
  }

  throw new Error("Expected ApiError to be thrown.");
}

test("AbuseGuard: returns CAPTCHA challenge after repeated hold-create attempts", async () => {
  const guard = new AbuseGuard(config, () => 1_000);
  const request = makeRequest();

  await guard.assertAllowed(request, "holdCreate");
  await guard.assertAllowed(request, "holdCreate");

  const error = await captureApiErrorAsync(() => guard.assertAllowed(request, "holdCreate"));

  expect(error.statusCode).toBe(403);
  expect(error.code).toBe("captcha_required");
  expect(request.responseHeaders["X-Captcha-Required"]).toBe("true");
  expect(request.responseHeaders["X-Captcha-Policy"]).toBe("holdCreate");
});

test("AbuseGuard: enforces per-device limits across changing IP addresses", async () => {
  const guard = new AbuseGuard(config, () => 1_000);

  for (let index = 0; index < 5; index += 1) {
    await guard.assertAllowed(makeRequest({ clientIp: `203.0.113.${index + 1}` }), "portalLogin");
  }

  const error = await captureApiErrorAsync(() =>
    guard.assertAllowed(makeRequest({ clientIp: "203.0.113.99" }), "portalLogin")
  );

  expect(error.statusCode).toBe(429);
  expect(error.code).toBe("rate_limited");
});

test("AbuseGuard: resets buckets after the route window expires", async () => {
  let now = 1_000;
  const guard = new AbuseGuard(config, () => now);
  const request = makeRequest();

  await guard.assertAllowed(request, "holdCreate");
  await guard.assertAllowed(request, "holdCreate");
  expect((await captureApiErrorAsync(() => guard.assertAllowed(request, "holdCreate"))).code).toBe("captcha_required");

  now += 15 * 60 * 1000 + 1;

  await expect(guard.assertAllowed(request, "holdCreate")).resolves.toBeUndefined();
});

test("AbuseGuard: can be disabled by configuration", async () => {
  const disabledGuard = new AbuseGuard({ ...config, enabled: false }, () => 1_000);
  const request = makeRequest();

  for (let index = 0; index < 20; index += 1) {
    await disabledGuard.assertAllowed(request, "holdCreate");
  }

  expect(request.responseHeaders["X-RateLimit-Policy"]).toBeUndefined();
});

test("AbuseGuard: enforces IP-only policy (webhook) and sets Retry-After on 429", async () => {
  const guard = new AbuseGuard(config, () => 1_000);

  // webhook policy: ip limit=300/60s, no device rule — exhaust via distinct device IDs
  for (let index = 0; index < 300; index += 1) {
    await guard.assertAllowed(
      makeRequest({ headers: { "x-booking-device-id": `device-${index}` } }),
      "webhook"
    );
  }

  const request = makeRequest({ headers: { "x-booking-device-id": "device-overflow" } });
  const error = await captureApiErrorAsync(() => guard.assertAllowed(request, "webhook"));

  expect(error.statusCode).toBe(429);
  expect(error.code).toBe("rate_limited");
  expect(request.responseHeaders["Retry-After"]).toBeDefined();
  expect(Number(request.responseHeaders["Retry-After"])).toBeGreaterThan(0);
});

test("AbuseGuard: sets Retry-After header when IP limit is exceeded", async () => {
  // Disable CAPTCHA so requests escalate straight to 429 when the IP cap is hit.
  const guard = new AbuseGuard({ ...config, captchaChallengesEnabled: false }, () => 1_000);

  // holdCreate ip limit=8/900s — use distinct device IDs so each device bucket stays at 1.
  for (let index = 0; index < 8; index += 1) {
    await guard.assertAllowed(
      makeRequest({ headers: { "x-booking-device-id": `unique-device-${index}` } }),
      "holdCreate"
    );
  }

  const request = makeRequest({ headers: { "x-booking-device-id": "unique-device-overflow" } });
  const error = await captureApiErrorAsync(() => guard.assertAllowed(request, "holdCreate"));

  expect(error.statusCode).toBe(429);
  expect(request.responseHeaders["Retry-After"]).toBeDefined();
  expect(Number(request.responseHeaders["Retry-After"])).toBeGreaterThan(0);
});

// ---------------------------------------------------------------------------
// CAPTCHA bypass path (task 7.3a)
// ---------------------------------------------------------------------------

test("AbuseGuard: valid CAPTCHA token bypasses the 403 challenge", async () => {
  // Spin up a minimal HTTP server that mimics the hCaptcha verify endpoint.
  const http = await import("http");
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ success: true }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };

  const guardWithVerifier = new AbuseGuard(
    {
      ...config,
      captchaVerifier: {
        provider: "hcaptcha",
        secretKey: "test-secret",
        verifyUrl: `http://127.0.0.1:${port}/siteverify`,
      },
    },
    () => 1_000
  );

  const request = makeRequest();

  // Exhaust the captchaAfter threshold (holdCreate device captchaAfter=2).
  await guardWithVerifier.assertAllowed(request, "holdCreate");
  await guardWithVerifier.assertAllowed(request, "holdCreate");

  // Third request would normally 403 — but we supply a valid token.
  const requestWithToken = makeRequest({
    headers: { ...request.headers, "x-captcha-token": "valid-token-from-client" },
  });

  await expect(guardWithVerifier.assertAllowed(requestWithToken, "holdCreate")).resolves.toBeUndefined();
  expect(requestWithToken.responseHeaders["X-Captcha-Required"]).toBeUndefined();

  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test("AbuseGuard: invalid CAPTCHA token still returns 403", async () => {
  const http = await import("http");
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ success: false, "error-codes": ["invalid-input-response"] }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };

  const guardWithVerifier = new AbuseGuard(
    {
      ...config,
      captchaVerifier: {
        provider: "hcaptcha",
        secretKey: "test-secret",
        verifyUrl: `http://127.0.0.1:${port}/siteverify`,
      },
    },
    () => 1_000
  );

  const request = makeRequest();
  await guardWithVerifier.assertAllowed(request, "holdCreate");
  await guardWithVerifier.assertAllowed(request, "holdCreate");

  const requestWithBadToken = makeRequest({
    headers: { ...request.headers, "x-captcha-token": "bad-token" },
  });

  const error = await captureApiErrorAsync(() =>
    guardWithVerifier.assertAllowed(requestWithBadToken, "holdCreate")
  );

  expect(error.statusCode).toBe(403);
  expect(error.code).toBe("captcha_required");
  expect(requestWithBadToken.responseHeaders["X-Captcha-Required"]).toBe("true");

  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test("AbuseGuard: resolves the CAPTCHA secret from Secrets Manager when the env var is unset", async () => {
  const http = await import("http");
  const seenSecrets: string[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      seenSecrets.push(new URLSearchParams(body).get("secret") ?? "");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };

  const getSecrets = jest.fn(async () => ({ captchaSecretKey: "secret-from-secrets-manager" }));

  const guardWithVerifier = new AbuseGuard(
    {
      ...config,
      // No secretKey — it must come from the secret provider.
      captchaVerifier: { provider: "recaptcha", verifyUrl: `http://127.0.0.1:${port}/siteverify` },
    },
    () => 1_000,
    { source: "static", getSecrets } as unknown as ConstructorParameters<typeof AbuseGuard>[2]
  );

  const request = makeRequest();
  await guardWithVerifier.assertAllowed(request, "holdCreate");
  await guardWithVerifier.assertAllowed(request, "holdCreate");

  const requestWithToken = makeRequest({
    headers: { ...request.headers, "x-captcha-token": "valid-token-from-client" },
  });
  await expect(guardWithVerifier.assertAllowed(requestWithToken, "holdCreate")).resolves.toBeUndefined();

  const secondToken = makeRequest({
    headers: { ...request.headers, "x-captcha-token": "another-valid-token" },
  });
  await expect(guardWithVerifier.assertAllowed(secondToken, "holdCreate")).resolves.toBeUndefined();

  expect(seenSecrets).toEqual(["secret-from-secrets-manager", "secret-from-secrets-manager"]);
  // The resolved secret is memoised rather than re-fetched on every challenge.
  expect(getSecrets).toHaveBeenCalledTimes(1);

  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test("AbuseGuard: a secrets outage fails the CAPTCHA check closed instead of throwing", async () => {
  const guardWithVerifier = new AbuseGuard(
    { ...config, captchaVerifier: { provider: "recaptcha" } },
    () => 1_000,
    {
      source: "static",
      getSecrets: async () => {
        throw new Error("secrets manager unavailable");
      },
    } as unknown as ConstructorParameters<typeof AbuseGuard>[2]
  );

  const request = makeRequest();
  await guardWithVerifier.assertAllowed(request, "holdCreate");
  await guardWithVerifier.assertAllowed(request, "holdCreate");

  const requestWithToken = makeRequest({
    headers: { ...request.headers, "x-captcha-token": "valid-token-from-client" },
  });

  const error = await captureApiErrorAsync(() =>
    guardWithVerifier.assertAllowed(requestWithToken, "holdCreate")
  );

  expect(error.statusCode).toBe(403);
  expect(error.code).toBe("captcha_required");
});

test("AbuseGuard: no verifier configured — token header is ignored and 403 is still returned", async () => {
  // captchaVerifier is undefined (no CAPTCHA_SECRET_KEY set in env).
  const guardNoVerifier = new AbuseGuard(config, () => 1_000);

  const request = makeRequest();
  await guardNoVerifier.assertAllowed(request, "holdCreate");
  await guardNoVerifier.assertAllowed(request, "holdCreate");

  const requestWithToken = makeRequest({
    headers: { ...request.headers, "x-captcha-token": "some-token" },
  });

  const error = await captureApiErrorAsync(() =>
    guardNoVerifier.assertAllowed(requestWithToken, "holdCreate")
  );

  expect(error.statusCode).toBe(403);
  expect(error.code).toBe("captcha_required");
});

test("verifyCaptchaToken: returns false when provider returns non-200", async () => {
  const http = await import("http");
  const server = http.createServer((_req, res) => {
    res.writeHead(500);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };

  const result = await verifyCaptchaToken("any-token", {
    provider: "hcaptcha",
    secretKey: "test-secret",
    verifyUrl: `http://127.0.0.1:${port}/siteverify`,
  });

  expect(result).toBe(false);
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test("verifyCaptchaToken: returns false on network error (connection refused)", async () => {
  // Port 1 is reserved and will always refuse connections.
  const result = await verifyCaptchaToken("any-token", {
    provider: "hcaptcha",
    secretKey: "test-secret",
    verifyUrl: "http://127.0.0.1:1/siteverify",
  });

  expect(result).toBe(false);
});

test("verifyCaptchaToken: returns false when provider returns malformed JSON", async () => {
  const http = await import("http");
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end("not-json{{{{");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };

  const result = await verifyCaptchaToken("any-token", {
    provider: "hcaptcha",
    secretKey: "test-secret",
    verifyUrl: `http://127.0.0.1:${port}/siteverify`,
  });

  expect(result).toBe(false);
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test("AbuseGuard: verification error is swallowed and returns 403 (does not throw 500)", async () => {
  // Simulate a verifier that throws unexpectedly by pointing at a port that refuses.
  const guardWithBrokenVerifier = new AbuseGuard(
    {
      ...config,
      captchaVerifier: {
        provider: "hcaptcha",
        secretKey: "test-secret",
        verifyUrl: "http://127.0.0.1:1/siteverify",
      },
    },
    () => 1_000
  );

  const request = makeRequest();
  await guardWithBrokenVerifier.assertAllowed(request, "holdCreate");
  await guardWithBrokenVerifier.assertAllowed(request, "holdCreate");

  const requestWithToken = makeRequest({
    headers: { ...request.headers, "x-captcha-token": "some-token" },
  });

  // Should return 403, not propagate a network error as 500.
  const error = await captureApiErrorAsync(() =>
    guardWithBrokenVerifier.assertAllowed(requestWithToken, "holdCreate")
  );

  expect(error.statusCode).toBe(403);
  expect(error.code).toBe("captcha_required");
});
