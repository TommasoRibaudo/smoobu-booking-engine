import { createHash, createHmac } from "node:crypto";
import { SmoobuClient, SmoobuProviderError, parseRateLimitHeaders } from "./smoobuClient";
import { RouteObservability } from "./types";

const baseConfig = {
  baseUrl: "https://login.smoobu.com",
  timeoutMs: 1_000,
  maxRetries: 2,
  baseBackoffMs: 25,
  maxBackoffMs: 100,
  maxRateLimitDelayMs: 60_000,
};

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init.headers as Record<string, string> | undefined),
    },
  });
}

function createObservabilitySink() {
  const providerCalls: Parameters<RouteObservability["recordProviderCall"]>[0][] = [];
  const observability: RouteObservability = {
    logger: {
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    },
    recordProviderCall: (observation) => providerCalls.push(observation),
    recordStateTransition: () => undefined,
    recordSecurityEvent: () => undefined,
  };

  return { observability, providerCalls };
}

test("SmoobuClient: sends API key server-side and parses rates with rate-limit headers", async () => {
  const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchFn = jest.fn(async (url: string | URL, init?: RequestInit) => {
    fetchCalls.push({ url: url.toString(), init });
    return jsonResponse(
      {
        data: {
          "297": {
            "2026-06-15": {
              price: 120,
              min_length_of_stay: 2,
              available: 1,
            },
          },
        },
      },
      {
        headers: {
          "x-ratelimit-limit": "1000",
          "x-ratelimit-remaining": "999",
          "x-ratelimit-retry-after": "1770998460",
        },
      }
    );
  });
  const now = () => 1_770_998_400_000;
  const client = new SmoobuClient({
    apiKey: "smoobu-secret",
    apiSecret: "smoobu-hmac-secret",
    config: baseConfig,
    fetchFn,
    now,
    nonceFn: () => "test-nonce-1",
  });

  const response = await client.getRates<{ data: Record<string, unknown> }>({
    apartmentIds: [297, 301],
    startDate: "2026-06-01",
    endDate: "2026-06-30",
  });

  expect(fetchCalls).toHaveLength(1);
  const url = new URL(fetchCalls[0].url);
  expect(url.pathname).toBe("/api/rates");
  expect(url.searchParams.getAll("apartments[]")).toEqual(["297", "301"]);
  expect(url.searchParams.get("start_date")).toBe("2026-06-01");
  expect(url.searchParams.get("end_date")).toBe("2026-06-30");

  const headers = fetchCalls[0].init?.headers as Record<string, string>;
  const expectedTimestamp = new Date(now()).toISOString().replace(/\.\d{3}Z$/, "Z");
  const expectedBodyHash = createHash("sha256").update("", "utf8").digest("hex");
  const expectedCanonical = [
    "GET",
    "/api/rates",
    "apartments%5B%5D=297&apartments%5B%5D=301&end_date=2026-06-30&start_date=2026-06-01",
    expectedTimestamp,
    "test-nonce-1",
    expectedBodyHash,
    "smoobu-secret",
  ].join("\n");
  const expectedSignature = createHmac("sha256", "smoobu-hmac-secret").update(expectedCanonical, "utf8").digest("base64");

  expect(headers["X-API-Key"]).toBe("smoobu-secret");
  expect(headers["X-Timestamp"]).toBe(expectedTimestamp);
  expect(headers["X-Nonce"]).toBe("test-nonce-1");
  expect(headers["X-Signature"]).toBe(expectedSignature);
  expect(response.data.data).toHaveProperty("297");
  expect(response.rateLimit).toEqual({
    limit: 1000,
    remaining: 999,
    retryAfterEpochSeconds: 1770998460,
    retryAfterSeconds: 60,
  });
});

test("SmoobuClient: retries idempotent Smoobu calls with exponential backoff", async () => {
  const sleepMs: number[] = [];
  const fetchFn = jest
    .fn()
    .mockResolvedValueOnce(jsonResponse({ detail: "temporary" }, { status: 503 }))
    .mockResolvedValueOnce(jsonResponse({ availableApartments: [297] }));
  const { observability, providerCalls } = createObservabilitySink();
  const client = new SmoobuClient({
    apiKey: "smoobu-secret",
    apiSecret: "smoobu-hmac-secret",
    config: baseConfig,
    fetchFn,
    sleep: async (ms) => {
      sleepMs.push(ms);
    },
    now: () => 1_770_998_400_000,
  });

  const response = await client.checkApartmentAvailability<{ availableApartments: number[] }>(
    {
      arrivalDate: "2026-06-01",
      departureDate: "2026-06-05",
      apartments: [297],
      customerId: 1,
    },
    observability
  );

  expect(fetchFn).toHaveBeenCalledTimes(2);
  expect(sleepMs).toEqual([25]);
  expect(response.data.availableApartments).toEqual([297]);
  expect(providerCalls).toHaveLength(1);
  expect(providerCalls[0]).toMatchObject({
    provider: "smoobu",
    operation: "checkApartmentAvailability",
    statusCode: 200,
  });
});

test("SmoobuClient: honors Smoobu rate-limit retry-after timestamp before retrying", async () => {
  const sleepMs: number[] = [];
  let nowMs = 1_770_998_400_000;
  const fetchFn = jest
    .fn()
    .mockResolvedValueOnce(
      jsonResponse(
        { detail: "rate limited" },
        {
          status: 429,
          headers: {
            "x-ratelimit-limit": "1000",
            "x-ratelimit-remaining": "0",
            "x-ratelimit-retry-after": "1770998402",
          },
        }
      )
    )
    .mockResolvedValueOnce(jsonResponse({ data: {} }));
  const client = new SmoobuClient({
    apiKey: "smoobu-secret",
    apiSecret: "smoobu-hmac-secret",
    config: baseConfig,
    fetchFn,
    sleep: async (ms) => {
      sleepMs.push(ms);
      nowMs += ms;
    },
    now: () => nowMs,
  });

  await client.getRates({
    apartmentIds: [297],
    startDate: "2026-06-01",
    endDate: "2026-06-30",
  });

  expect(fetchFn).toHaveBeenCalledTimes(2);
  expect(sleepMs).toEqual([2_000]);
});

test("SmoobuClient: refuses to sleep past maxRateLimitDelayMs for known rate-limit windows", async () => {
  const sleepMs: number[] = [];
  let nowMs = 1_770_998_400_000;
  const fetchFn = jest.fn().mockResolvedValue(
    jsonResponse(
      { detail: "rate limited" },
      {
        status: 429,
        headers: {
          "x-ratelimit-remaining": "0",
          "x-ratelimit-retry-after": "1770998520",
        },
      }
    )
  );
  const client = new SmoobuClient({
    apiKey: "smoobu-secret",
    apiSecret: "smoobu-hmac-secret",
    config: {
      ...baseConfig,
      maxRateLimitDelayMs: 1_000,
    },
    fetchFn,
    sleep: async (ms) => {
      sleepMs.push(ms);
      nowMs += ms;
    },
    now: () => nowMs,
  });

  await expect(
    client.getRates({
      apartmentIds: [297],
      startDate: "2026-06-01",
      endDate: "2026-06-30",
    })
  ).rejects.toMatchObject({
    code: "provider_rate_limited",
    retryable: true,
    rateLimit: {
      retryAfterSeconds: 119,
    },
  });
  expect(fetchFn).toHaveBeenCalledTimes(1);
  expect(sleepMs).toEqual([1_000]);
});

test("SmoobuClient: does not retry non-idempotent reservation creation by default", async () => {
  const sleepMs: number[] = [];
  const fetchFn = jest.fn().mockResolvedValue(jsonResponse({ detail: "temporary" }, { status: 503 }));
  const client = new SmoobuClient({
    apiKey: "smoobu-secret",
    apiSecret: "smoobu-hmac-secret",
    config: baseConfig,
    fetchFn,
    sleep: async (ms) => {
      sleepMs.push(ms);
    },
  });

  await expect(
    client.createReservation({
      arrivalDate: "2026-06-01",
      departureDate: "2026-06-05",
      apartmentId: 297,
      channelId: 11,
    })
  ).rejects.toMatchObject({
    code: "provider_unavailable",
    providerStatusCode: 503,
    retryable: true,
  });
  expect(fetchFn).toHaveBeenCalledTimes(1);
  expect(sleepMs).toEqual([]);
});

test("SmoobuClient: maps fetch AbortError to provider_timeout", async () => {
  const abortError = new Error("The operation was aborted.");
  abortError.name = "AbortError";
  const fetchFn = jest.fn().mockRejectedValue(abortError);
  const client = new SmoobuClient({
    apiKey: "smoobu-secret",
    apiSecret: "smoobu-hmac-secret",
    config: {
      ...baseConfig,
      maxRetries: 0,
    },
    fetchFn,
  });

  await expect(client.listApartments()).rejects.toMatchObject({
    code: "provider_timeout",
    retryable: true,
  });
  expect(fetchFn).toHaveBeenCalledTimes(1);
});

test("SmoobuClient: maps Smoobu auth failures to provider_auth_failed", async () => {
  const fetchFn = jest.fn().mockResolvedValue(jsonResponse({ detail: "Unauthorized" }, { status: 401 }));
  const client = new SmoobuClient({
    apiKey: "smoobu-secret",
    apiSecret: "smoobu-hmac-secret",
    config: baseConfig,
    fetchFn,
  });

  await expect(client.listApartments()).rejects.toMatchObject({
    code: "provider_auth_failed",
    providerStatusCode: 401,
    retryable: false,
  });
  expect(fetchFn).toHaveBeenCalledTimes(1);
});

test("SmoobuClient: maps successful invalid JSON to a retryable provider error", async () => {
  const fetchFn = jest.fn().mockResolvedValue(
    new Response("not-json", {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  );
  const client = new SmoobuClient({
    apiKey: "smoobu-secret",
    apiSecret: "smoobu-hmac-secret",
    config: baseConfig,
    fetchFn,
  });

  await expect(client.listApartments()).rejects.toMatchObject({
    code: "provider_invalid_response",
    providerStatusCode: 200,
    retryable: true,
  });
});

test("parseRateLimitHeaders: ignores malformed Smoobu limit headers", () => {
  expect(
    parseRateLimitHeaders(
      new Headers({
        "x-ratelimit-limit": "not-a-number",
        "x-ratelimit-remaining": "-1",
        "x-ratelimit-retry-after": "0",
      })
    )
  ).toEqual({
    limit: undefined,
    remaining: undefined,
    retryAfterEpochSeconds: 0,
    retryAfterSeconds: undefined,
  });
});

test("SmoobuProviderError exposes safe provider metadata only", () => {
  const error = new SmoobuProviderError(503, "provider_rate_limited", "Smoobu rate limit was reached.", {
    retryable: true,
    providerStatusCode: 429,
    rateLimit: { remaining: 0, retryAfterSeconds: 10 },
  });

  expect(error).toMatchObject({
    statusCode: 503,
    code: "provider_rate_limited",
    retryable: true,
    providerStatusCode: 429,
    rateLimit: { remaining: 0, retryAfterSeconds: 10 },
  });
});
