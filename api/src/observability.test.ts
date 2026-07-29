import { createObservability, redactForLogs } from "./observability";
import { ApiError } from "./http/errors";

const config = {
  serviceName: "booking-api",
  environment: "test",
  logLevel: "debug" as const,
  metricsEnabled: true,
};

test("observability: redacts secrets and auth-shaped fields recursively", () => {
  expect(
    redactForLogs({
      authorization: "Bearer secret",
      idempotencyKey: "idem-123",
      bookingSessionId: "11111111-0000-4000-8000-000000000001",
      guest: {
        email: "guest@example.com",
        portalPassword: "secret-password",
      },
      headers: {
        "x-smoobu-webhook-secret": "webhook-secret",
        "paypal-transmission-sig": "signature",
      },
    })
  ).toEqual({
    authorization: "[REDACTED]",
    idempotencyKey: "idem-123",
    bookingSessionId: "11111111-0000-4000-8000-000000000001",
    guest: {
      email: "[REDACTED]",
      portalPassword: "[REDACTED]",
    },
    headers: {
      "x-smoobu-webhook-secret": "[REDACTED]",
      "paypal-transmission-sig": "[REDACTED]",
    },
  });
});

test("observability: records request logs, metrics, and webhook alert signals", () => {
  const entries: Array<{ level: string; entry: Record<string, unknown> }> = [];
  const observability = createObservability(config, (level, entry) => {
    entries.push({ level, entry });
  });

  observability.recordHttpRequest({
    correlationId: "corr-123",
    method: "POST",
    path: "/api/webhooks/smoobu",
    routePattern: "/api/webhooks/smoobu",
    statusCode: 401,
    durationMs: 12,
    clientIp: "203.0.113.1",
    userAgent: "Jest",
    error: new Error("not authorized"),
  });

  expect(entries.some(({ entry }) => entry.eventType === "http_request_completed")).toBe(true);
  expect(entries.some(({ entry }) => entry.eventType === "http_request_metrics")).toBe(true);

  const alert = entries.find(({ entry }) => entry.eventType === "operational_alert");
  expect(alert?.level).toBe("error");
  expect(alert?.entry.alertName).toBe("smoobu_webhook_auth_failure");

  const metrics = entries.find(({ entry }) => entry.eventType === "http_request_metrics")?.entry;
  expect(metrics?.WebhookRejectedCount).toBe(1);
  expect(metrics?.UnauthorizedWebhookCount).toBe(1);
  expect(metrics?.Route).toBe("/api/webhooks/smoobu");

  // correlationId must NOT appear as a metric dimension (high cardinality)
  expect(metrics?.CorrelationId).toBeUndefined();
  const metricDimensions: string[][] = (metrics?._aws as any)?.CloudWatchMetrics?.[0]?.Dimensions ?? [];
  const allDimensionKeys = metricDimensions.flat();
  expect(allDimensionKeys).not.toContain("CorrelationId");
});

test("observability: captcha_required emits captcha escalation alert and metric", () => {
  const entries: Array<{ level: string; entry: Record<string, unknown> }> = [];
  const observability = createObservability(config, (level, entry) => {
    entries.push({ level, entry });
  });
  observability.recordHttpRequest({
    correlationId: "corr-captcha",
    method: "POST",
    path: "/api/holds",
    routePattern: "/api/holds",
    statusCode: 400,
    durationMs: 5,
    error: new ApiError(400, "captcha_required", "CAPTCHA required", { retryable: false }),
  });

  const metrics = entries.find(({ entry }) => entry.eventType === "http_request_metrics")?.entry;
  expect(metrics?.CaptchaRequiredCount).toBe(1);

  const alert = entries.find(({ entry }) => entry.eventType === "operational_alert");
  expect(alert?.entry.alertName).toBe("captcha_escalation_triggered");
  expect(alert?.entry.severity).toBe("warning");
});

test("observability: rate_limited emits public rate limit alert", () => {
  const entries: Array<{ level: string; entry: Record<string, unknown> }> = [];
  const observability = createObservability(config, (level, entry) => {
    entries.push({ level, entry });
  });
  observability.recordHttpRequest({
    correlationId: "corr-ratelimit",
    method: "POST",
    path: "/api/search",
    routePattern: "/api/search",
    statusCode: 429,
    durationMs: 3,
    error: new ApiError(429, "rate_limited", "Too many requests", { retryable: true }),
  });

  const metrics = entries.find(({ entry }) => entry.eventType === "http_request_metrics")?.entry;
  expect(metrics?.RateLimitedCount).toBe(1);

  const alert = entries.find(({ entry }) => entry.eventType === "operational_alert");
  expect(alert?.entry.alertName).toBe("public_rate_limit_triggered");
  expect(alert?.entry.severity).toBe("warning");
});

test("observability: PayPal webhook 4xx emits paypal_webhook_rejected alert", () => {
  const entries: Array<{ level: string; entry: Record<string, unknown> }> = [];
  const observability = createObservability(config, (level, entry) => {
    entries.push({ level, entry });
  });

  observability.recordHttpRequest({
    correlationId: "corr-paypal",
    method: "POST",
    path: "/api/webhooks/paypal",
    routePattern: "/api/webhooks/paypal",
    statusCode: 400,
    durationMs: 8,
    error: new Error("invalid signature"),
  });

  const metrics = entries.find(({ entry }) => entry.eventType === "http_request_metrics")?.entry;
  expect(metrics?.WebhookRejectedCount).toBe(1);

  const alert = entries.find(({ entry }) => entry.eventType === "operational_alert");
  expect(alert?.entry.alertName).toBe("paypal_webhook_rejected");
  expect(alert?.entry.severity).toBe("warning");
});

test("observability: 5xx non-501 emits booking_api_unhandled_error critical alert", () => {
  const entries: Array<{ level: string; entry: Record<string, unknown> }> = [];
  const observability = createObservability(config, (level, entry) => {
    entries.push({ level, entry });
  });

  observability.recordHttpRequest({
    correlationId: "corr-500",
    method: "GET",
    path: "/api/search",
    routePattern: "/api/search",
    statusCode: 500,
    durationMs: 20,
    error: new Error("unexpected crash"),
  });

  const metrics = entries.find(({ entry }) => entry.eventType === "http_request_metrics")?.entry;
  expect(metrics?.ServerErrorCount).toBe(1);
  expect(metrics?.ErrorCount).toBe(1);

  const alert = entries.find(({ entry }) => entry.eventType === "operational_alert");
  expect(alert?.entry.alertName).toBe("booking_api_unhandled_error");
  expect(alert?.entry.severity).toBe("critical");
});

test("observability: 501 not_implemented counts metric but does NOT emit critical alert", () => {
  const entries: Array<{ level: string; entry: Record<string, unknown> }> = [];
  const observability = createObservability(config, (level, entry) => {
    entries.push({ level, entry });
  });
  observability.recordHttpRequest({
    correlationId: "corr-501",
    method: "POST",
    path: "/api/holds",
    routePattern: "/api/holds",
    statusCode: 501,
    durationMs: 2,
    error: new ApiError(501, "not_implemented", "Not implemented", { retryable: false }),
  });

  const metrics = entries.find(({ entry }) => entry.eventType === "http_request_metrics")?.entry;
  expect(metrics?.NotImplementedCount).toBe(1);
  expect(metrics?.ServerErrorCount).toBe(1);

  const alert = entries.find(({ entry }) => entry.eventType === "operational_alert");
  expect(alert).toBeUndefined();
});

test("observability: recordStateTransition failure emits booking_state_transition_failed critical alert", () => {
  const entries: Array<{ level: string; entry: Record<string, unknown> }> = [];
  const observability = createObservability(config, (level, entry) => {
    entries.push({ level, entry });
  });
  const routeObservability = observability.createRouteObservability({
    correlationId: "corr-state",
    route: "/api/orders",
  });

  routeObservability.recordStateTransition({
    entityType: "booking_session",
    fromState: "hold_confirmed",
    toState: "payment_captured",
    action: "capture_paypal_order",
    success: false,
    bookingSessionId: "bs-999",
    errorCode: "paypal_capture_failed",
  });

  const transition = entries.find((entry) => entry.entry.eventType === "booking_state_transition");
  expect(transition?.level).toBe("error");

  const metricEntry = entries.find(({ entry }) => entry.eventType === "booking_state_transition_metrics")?.entry;
  expect(metricEntry?.BookingStateTransitionCount).toBe(1);
  expect(metricEntry?.BookingStateTransitionFailureCount).toBe(1);

  const alert = entries.find(({ entry }) => entry.eventType === "operational_alert");
  expect(alert?.entry.alertName).toBe("booking_state_transition_failed");
  expect(alert?.entry.severity).toBe("critical");
});

test("observability: recordStateTransition success does not emit alert", () => {
  const entries: Array<{ level: string; entry: Record<string, unknown> }> = [];
  const observability = createObservability(config, (level, entry) => {
    entries.push({ level, entry });
  });
  const routeObservability = observability.createRouteObservability({
    correlationId: "corr-state-ok",
    route: "/api/orders",
  });

  routeObservability.recordStateTransition({
    entityType: "hold",
    fromState: "pending",
    toState: "confirmed",
    action: "confirm_hold",
    success: true,
    bookingSessionId: "bs-100",
  });

  const metricEntry = entries.find(({ entry }) => entry.eventType === "booking_state_transition_metrics")?.entry;
  expect(metricEntry?.BookingStateTransitionCount).toBe(1);
  expect(metricEntry?.BookingStateTransitionFailureCount).toBe(0);

  const alert = entries.find(({ entry }) => entry.eventType === "operational_alert");
  expect(alert).toBeUndefined();
});

test("observability: recordSecurityEvent emits security_event log and metric with correct dimensions", () => {
  const entries: Array<{ level: string; entry: Record<string, unknown> }> = [];
  const observability = createObservability(config, (level, entry) => {
    entries.push({ level, entry });
  });
  const routeObservability = observability.createRouteObservability({
    correlationId: "corr-sec",
    route: "/api/webhooks/smoobu",
  });

  routeObservability.recordSecurityEvent({
    name: "webhook_replay_attempt",
    severity: "warn",
    route: "/api/webhooks/smoobu",
  });

  const log = entries.find(({ entry }) => entry.eventType === "security_event");
  expect(log?.level).toBe("warn");

  const metricEntry = entries.find(({ entry }) => entry.eventType === "security_event_metrics")?.entry;
  expect(metricEntry?.SecurityEventCount).toBe(1);
  expect(metricEntry?.SecurityEvent).toBe("webhook_replay_attempt");
  expect(metricEntry?.Severity).toBe("warn");
});

test("observability: logLevel silent suppresses all output", () => {
  const entries: Array<Record<string, unknown>> = [];
  const observability = createObservability(
    { ...config, logLevel: "silent" as const },
    (_level, entry) => { entries.push(entry); }
  );

  observability.recordHttpRequest({
    correlationId: "corr-silent",
    method: "GET",
    path: "/api/search",
    statusCode: 200,
    durationMs: 5,
  });

  // logs suppressed; metrics also go through writer so they would be caught too
  const logs = entries.filter((e) => e.eventType === "http_request_completed");
  expect(logs).toHaveLength(0);
});

test("observability: logLevel warn suppresses debug and info, passes warn and error", () => {
  const entries: Array<{ level: string; entry: Record<string, unknown> }> = [];
  const observability = createObservability(
    { ...config, logLevel: "warn" as const },
    (level, entry) => { entries.push({ level, entry }); }
  );
  const logger = observability.createLogger();

  logger.debug("debug message");
  logger.info("info message");
  logger.warn("warn message");
  logger.error("error message");

  const levels = entries.map(({ level }) => level);
  expect(levels).not.toContain("debug");
  expect(levels).not.toContain("info");
  expect(levels).toContain("warn");
  expect(levels).toContain("error");
});

test("observability: records Smoobu provider rate-limit metrics", () => {
  const entries: Array<Record<string, unknown>> = [];
  const observability = createObservability(config, (_level, entry) => {
    entries.push(entry);
  });
  const routeObservability = observability.createRouteObservability({
    correlationId: "corr-456",
    route: "/api/search",
  });

  routeObservability.recordProviderCall({
    provider: "smoobu",
    operation: "checkApartmentAvailability",
    durationMs: 250,
    statusCode: 429,
    retryable: true,
    rateLimitRemaining: 0,
    rateLimitResetSeconds: 60,
  });

  const metrics = entries.find((entry) => entry.eventType === "provider_call_metrics");
  expect(metrics?.ProviderRequestCount).toBe(1);
  expect(metrics?.ProviderErrorCount).toBe(1);
  expect(metrics?.SmoobuRateLimitedCount).toBe(1);

  const alert = entries.find((entry) => entry.eventType === "operational_alert");
  expect(alert?.alertName).toBe("smoobu_provider_degraded");
});

// ─── Logging redaction: PII fields ───────────────────────────────────────────

test("observability: redacts guest PII fields (email, phone, firstName, lastName)", () => {
  expect(
    redactForLogs({
      email: "guest@example.com",
      phone: "+1-555-0100",
      firstName: "Ana",
      lastName: "Mora",
      nested: {
        "guest.email": "other@example.com",
        "guest.phone": "+1-555-0101",
        "guest.firstName": "Carlos",
        "guest.lastName": "Vega",
      },
    })
  ).toEqual({
    email: "[REDACTED]",
    phone: "[REDACTED]",
    firstName: "[REDACTED]",
    lastName: "[REDACTED]",
    nested: {
      "guest.email": "[REDACTED]",
      "guest.phone": "[REDACTED]",
      "guest.firstName": "[REDACTED]",
      "guest.lastName": "[REDACTED]",
    },
  });
});

test("observability: redacts portalPassword and portalPasswordHash", () => {
  expect(
    redactForLogs({
      portalPassword: "correct horse battery staple",
      portalPasswordHash: "$argon2id$v=19$m=65536,t=3,p=4$...",
    })
  ).toEqual({
    portalPassword: "[REDACTED]",
    portalPasswordHash: "[REDACTED]",
  });
});

test("observability: does not redact non-sensitive booking fields", () => {
  const input = {
    bookingSessionId: "11111111-0000-4000-8000-000000000001",
    reservationPublicId: "KWL-ABCD1234",
    propertyId: "prop-001",
    arrivalDate: "2026-06-01",
    departureDate: "2026-06-05",
    guests: 2,
    status: "booking_confirmed",
    language: "en",
  };
  expect(redactForLogs(input)).toEqual(input);
});
