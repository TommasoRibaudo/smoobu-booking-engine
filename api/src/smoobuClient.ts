import { createHash, createHmac, randomUUID } from "node:crypto";
import { ApiError } from "./http/errors";
import { BookingApiConfig, HttpMethod, RouteObservability, SmoobuClientConfig } from "./types";

const DEFAULT_SMOOBU_CONFIG: SmoobuClientConfig = {
  baseUrl: "https://login.smoobu.com",
  timeoutMs: 8_000,
  maxRetries: 3,
  baseBackoffMs: 250,
  maxBackoffMs: 2_000,
  maxRateLimitDelayMs: 60_000,
  holdChannelId: 11,
};
// Keep local defaults so SmoobuClient remains usable in focused tests and
// worker code that constructs it outside loadConfig().

const RETRYABLE_STATUS_CODES = new Set([408, 429, 500, 502, 503, 504]);

type FetchFn = (input: string | URL, init?: RequestInit) => Promise<Response>;
type SleepFn = (ms: number) => Promise<void>;

type SmoobuQueryPrimitive = string | number | boolean;
export type SmoobuQueryValue = SmoobuQueryPrimitive | SmoobuQueryPrimitive[] | null | undefined;

export interface SmoobuRateLimit {
  limit?: number;
  remaining?: number;
  retryAfterSeconds?: number;
  retryAfterEpochSeconds?: number;
}

export interface SmoobuRequestOptions {
  method?: Exclude<HttpMethod, "OPTIONS">;
  path: string;
  operation: string;
  query?: Record<string, SmoobuQueryValue>;
  body?: unknown;
  idempotent?: boolean;
}

export interface SmoobuResponse<T> {
  data: T;
  statusCode: number;
  rateLimit: SmoobuRateLimit;
}

export interface SmoobuClientOptions {
  apiKey: string;
  apiSecret: string;
  config?: Partial<SmoobuClientConfig>;
  fetchFn?: FetchFn;
  sleep?: SleepFn;
  now?: () => number;
  /** Overridable for tests. Defaults to crypto.randomUUID(). Must never repeat — see HMAC spec below. */
  nonceFn?: () => string;
}

export class SmoobuProviderError extends ApiError {
  readonly providerStatusCode?: number;
  readonly rateLimit?: SmoobuRateLimit;

  constructor(
    statusCode: number,
    code: string,
    message: string,
    options: {
      retryable?: boolean;
      providerStatusCode?: number;
      rateLimit?: SmoobuRateLimit;
    } = {}
  ) {
    super(statusCode, code, message, { retryable: options.retryable });
    this.providerStatusCode = options.providerStatusCode;
    this.rateLimit = options.rateLimit;
  }
}

export class SmoobuClient {
  private readonly apiKey: string;
  private readonly apiSecret: string;
  private readonly config: SmoobuClientConfig;
  private readonly fetchFn: FetchFn;
  private readonly sleep: SleepFn;
  private readonly now: () => number;
  private readonly nonceFn: () => string;
  private rateLimitBlockedUntilMs = 0;

  constructor(options: SmoobuClientOptions) {
    const apiKey = options.apiKey.trim();
    if (!apiKey) {
      throw new SmoobuProviderError(503, "provider_auth_failed", "Smoobu API key is not configured.");
    }
    const apiSecret = options.apiSecret.trim();
    if (!apiSecret) {
      throw new SmoobuProviderError(503, "provider_auth_failed", "Smoobu API secret is not configured.");
    }

    this.apiKey = apiKey;
    this.apiSecret = apiSecret;
    this.config = {
      ...DEFAULT_SMOOBU_CONFIG,
      ...options.config,
      baseUrl: normalizeBaseUrl(options.config?.baseUrl ?? DEFAULT_SMOOBU_CONFIG.baseUrl),
    };
    this.fetchFn = options.fetchFn ?? fetch;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = options.now ?? Date.now;
    this.nonceFn = options.nonceFn ?? (() => randomUUID());
  }

  async request<T = unknown>(
    options: SmoobuRequestOptions,
    observability?: RouteObservability
  ): Promise<SmoobuResponse<T>> {
    const method = options.method ?? "GET";
    const idempotent = options.idempotent ?? method === "GET";
    const maxAttempts = idempotent ? this.config.maxRetries + 1 : 1;
    const url = this.buildUrl(options.path, options.query);
    const startedAtMs = this.now();
    let finalStatusCode: number | undefined;
    let finalRateLimit: SmoobuRateLimit = {};
    let finalRetryable = false;
    let finalErrorCode: string | undefined;

    try {
      for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        try {
          await this.waitForKnownRateLimitWindow();
          const response = await this.fetchWithTimeout(url, method, options.body);
          finalStatusCode = response.status;
          finalRateLimit = parseRateLimitHeaders(response.headers, this.now);
          this.updateRateLimitWindow(finalRateLimit);

          if (response.ok) {
            const data = await parseJsonResponse<T>(response, this.now);
            finalRetryable = false;
            return {
              data,
              statusCode: response.status,
              rateLimit: finalRateLimit,
            };
          }

          finalRetryable = RETRYABLE_STATUS_CODES.has(response.status);
          finalErrorCode = mapProviderErrorCode(response.status);

          if (attempt < maxAttempts - 1 && finalRetryable) {
            await this.sleep(this.retryDelayMs(response, finalRateLimit, attempt));
            continue;
          }

          throw providerHttpError(response.status, finalRateLimit, finalRetryable);
        } catch (error) {
          if (error instanceof SmoobuProviderError) {
            finalErrorCode = error.code;
            finalRetryable = error.retryable;
            finalStatusCode = error.providerStatusCode;
            finalRateLimit = error.rateLimit ?? finalRateLimit;
            throw error;
          }

          finalRetryable = true;
          finalErrorCode = isAbortError(error) ? "provider_timeout" : "provider_unavailable";
          if (attempt < maxAttempts - 1) {
            await this.sleep(this.backoffDelayMs(attempt));
            continue;
          }

          throw new SmoobuProviderError(503, finalErrorCode, "Smoobu is temporarily unavailable.", {
            retryable: true,
          });
        }
      }

      throw new SmoobuProviderError(503, "provider_unavailable", "Smoobu is temporarily unavailable.", {
        retryable: true,
      });
    } finally {
      observability?.recordProviderCall({
        provider: "smoobu",
        operation: options.operation,
        durationMs: this.now() - startedAtMs,
        statusCode: finalStatusCode,
        retryable: finalRetryable,
        rateLimitRemaining: finalRateLimit.remaining,
        rateLimitResetSeconds: finalRateLimit.retryAfterSeconds,
        errorCode: finalErrorCode,
      });
    }
  }

  async checkApartmentAvailability<T = unknown>(
    body: unknown,
    observability?: RouteObservability
  ): Promise<SmoobuResponse<T>> {
    return this.request<T>(
      {
        method: "POST",
        path: "/booking/checkApartmentAvailability",
        operation: "checkApartmentAvailability",
        body,
        idempotent: true,
      },
      observability
    );
  }

  async getRates<T = unknown>(
    params: { apartmentIds: number[]; startDate: string; endDate: string },
    observability?: RouteObservability
  ): Promise<SmoobuResponse<T>> {
    return this.request<T>(
      {
        method: "GET",
        path: "/api/rates",
        operation: "getRates",
        query: {
          "apartments[]": params.apartmentIds,
          start_date: params.startDate,
          end_date: params.endDate,
        },
      },
      observability
    );
  }

  async createReservation<T = unknown>(body: unknown, observability?: RouteObservability): Promise<SmoobuResponse<T>> {
    return this.request<T>(
      {
        method: "POST",
        path: "/api/reservations",
        operation: "createReservation",
        body,
        idempotent: false,
      },
      observability
    );
  }

  async updateReservation<T = unknown>(
    reservationId: number | string,
    body: unknown,
    observability?: RouteObservability
  ): Promise<SmoobuResponse<T>> {
    return this.request<T>(
      {
        method: "PUT",
        path: `/api/reservations/${encodeURIComponent(String(reservationId))}`,
        operation: "updateReservation",
        body,
        idempotent: true,
      },
      observability
    );
  }

  async cancelReservation<T = unknown>(
    reservationId: number | string,
    observability?: RouteObservability
  ): Promise<SmoobuResponse<T>> {
    return this.request<T>(
      {
        method: "DELETE",
        path: `/api/reservations/${encodeURIComponent(String(reservationId))}`,
        operation: "cancelReservation",
        idempotent: true,
      },
      observability
    );
  }

  async listApartments<T = unknown>(observability?: RouteObservability): Promise<SmoobuResponse<T>> {
    return this.request<T>(
      {
        method: "GET",
        path: "/api/apartments",
        operation: "listApartments",
      },
      observability
    );
  }

  async getApartment<T = unknown>(
    apartmentId: number | string,
    observability?: RouteObservability
  ): Promise<SmoobuResponse<T>> {
    return this.request<T>(
      {
        method: "GET",
        path: `/api/apartments/${encodeURIComponent(String(apartmentId))}`,
        operation: "getApartment",
      },
      observability
    );
  }

  private buildUrl(path: string, query: Record<string, SmoobuQueryValue> = {}): URL {
    if (!path.startsWith("/") || path.startsWith("//")) {
      throw new SmoobuProviderError(500, "provider_request_invalid", "Smoobu request path is invalid.");
    }

    const url = new URL(path, `${this.config.baseUrl}/`);
    for (const [key, value] of Object.entries(query)) {
      appendQueryParam(url, key, value);
    }
    return url;
  }

  private async fetchWithTimeout(url: URL, method: Exclude<HttpMethod, "OPTIONS">, body: unknown): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);
    const rawBody = body === undefined ? "" : JSON.stringify(body);

    try {
      return await this.fetchFn(url.toString(), {
        method,
        headers: this.buildHeaders(method, url, rawBody),
        body: body === undefined ? undefined : rawBody,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  // HMAC request signing — see docs.smoobu.com/#hmac-authentication. Legacy API
  // Key auth sunsets 2026-09-25; signing every request (not just for new keys)
  // keeps this working on both sides of that date.
  private buildHeaders(method: string, url: URL, rawBody: string): Record<string, string> {
    const timestamp = new Date(this.now()).toISOString().replace(/\.\d{3}Z$/, "Z");
    const nonce = this.nonceFn();
    const bodyHash = createHash("sha256").update(rawBody, "utf8").digest("hex");
    const canonical = [
      method,
      url.pathname,
      canonicalQueryString(url),
      timestamp,
      nonce,
      bodyHash,
      this.apiKey,
    ].join("\n");
    const signature = createHmac("sha256", this.apiSecret).update(canonical, "utf8").digest("base64");

    return {
      Accept: "application/json",
      "X-API-Key": this.apiKey,
      "X-Timestamp": timestamp,
      "X-Nonce": nonce,
      "X-Signature": signature,
      "Cache-Control": "no-cache",
      ...(rawBody ? { "Content-Type": "application/json" } : {}),
    };
  }

  private updateRateLimitWindow(rateLimit: SmoobuRateLimit): void {
    if (rateLimit.remaining !== 0 || !rateLimit.retryAfterSeconds) {
      return;
    }

    this.rateLimitBlockedUntilMs = Math.max(
      this.rateLimitBlockedUntilMs,
      this.now() + rateLimit.retryAfterSeconds * 1_000
    );
  }

  private async waitForKnownRateLimitWindow(): Promise<void> {
    const delayMs = this.rateLimitBlockedUntilMs - this.now();
    if (delayMs <= 0) {
      return;
    }

    if (delayMs > this.config.maxRateLimitDelayMs) {
      throw new SmoobuProviderError(503, "provider_rate_limited", "Smoobu rate limit window is still active.", {
        retryable: true,
        rateLimit: {
          retryAfterSeconds: Math.ceil(delayMs / 1_000),
        },
      });
    }

    await this.sleep(delayMs);
  }

  private retryDelayMs(response: Response, rateLimit: SmoobuRateLimit, attempt: number): number {
    const retryAfterMs = parseRetryAfterHeader(response.headers, this.now) ?? secondsToMs(rateLimit.retryAfterSeconds);
    if (retryAfterMs !== undefined) {
      return Math.min(retryAfterMs, this.config.maxRateLimitDelayMs);
    }

    return this.backoffDelayMs(attempt);
  }

  private backoffDelayMs(attempt: number): number {
    return Math.min(this.config.baseBackoffMs * 2 ** attempt, this.config.maxBackoffMs);
  }
}

export async function createSmoobuClient(config: BookingApiConfig): Promise<SmoobuClient> {
  const { smoobuApiKey, smoobuApiSecret } = await config.secrets.getSecrets();
  return new SmoobuClient({
    apiKey: smoobuApiKey,
    apiSecret: smoobuApiSecret,
    config: config.smoobu,
  });
}

// Query params sorted alphabetically by key per the HMAC canonical-string spec.
function canonicalQueryString(url: URL): string {
  const params = Array.from(url.searchParams.entries());
  params.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return params.map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join("&");
}

export function parseRateLimitHeaders(headers: Headers, now: () => number = Date.now): SmoobuRateLimit {
  const retryAfterEpochSeconds = parseIntegerHeader(headers.get("x-ratelimit-retry-after"));
  const retryAfterSeconds = retryAfterEpochSeconds
    ? Math.max(0, retryAfterEpochSeconds - Math.floor(now() / 1_000))
    : undefined;

  return {
    limit: parseIntegerHeader(headers.get("x-ratelimit-limit")),
    remaining: parseIntegerHeader(headers.get("x-ratelimit-remaining")),
    retryAfterEpochSeconds,
    retryAfterSeconds,
  };
}

function normalizeBaseUrl(value: string): string {
  const parsed = new URL(value);
  // This is a hard validation layer for direct SmoobuClient construction.
  if (parsed.protocol !== "https:" && parsed.hostname !== "localhost") {
    throw new SmoobuProviderError(500, "provider_request_invalid", "Smoobu base URL must use HTTPS.");
  }
  return parsed.toString().replace(/\/+$/, "");
}

function appendQueryParam(url: URL, key: string, value: SmoobuQueryValue): void {
  if (value === null || value === undefined) {
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      url.searchParams.append(key, String(item));
    }
    return;
  }

  url.searchParams.append(key, String(value));
}

async function parseJsonResponse<T>(response: Response, now: () => number): Promise<T> {
  const text = await response.text();
  if (!text.trim()) {
    return undefined as T;
  }

  try {
    return JSON.parse(text) as T;
  } catch {
    throw new SmoobuProviderError(
      503,
      "provider_invalid_response",
      "Smoobu returned an invalid JSON response.",
      {
        retryable: true,
        providerStatusCode: response.status,
        rateLimit: parseRateLimitHeaders(response.headers, now),
      }
    );
  }
}

function providerHttpError(statusCode: number, rateLimit: SmoobuRateLimit, retryable: boolean): SmoobuProviderError {
  if (statusCode === 429) {
    return new SmoobuProviderError(503, "provider_rate_limited", "Smoobu rate limit was reached.", {
      retryable: true,
      providerStatusCode: statusCode,
      rateLimit,
    });
  }

  if (statusCode === 401 || statusCode === 403) {
    return new SmoobuProviderError(503, "provider_auth_failed", "Smoobu authentication failed.", {
      retryable: false,
      providerStatusCode: statusCode,
      rateLimit,
    });
  }

  if (statusCode >= 500 || statusCode === 408) {
    return new SmoobuProviderError(503, "provider_unavailable", "Smoobu is temporarily unavailable.", {
      retryable,
      providerStatusCode: statusCode,
      rateLimit,
    });
  }

  return new SmoobuProviderError(502, "provider_rejected", "Smoobu rejected the request.", {
    retryable: false,
    providerStatusCode: statusCode,
    rateLimit,
  });
}

function mapProviderErrorCode(statusCode: number): string {
  if (statusCode === 429) {
    return "provider_rate_limited";
  }
  if (statusCode === 401 || statusCode === 403) {
    return "provider_auth_failed";
  }
  if (statusCode >= 500 || statusCode === 408) {
    return "provider_unavailable";
  }
  return "provider_rejected";
}

function parseRetryAfterHeader(headers: Headers, now: () => number): number | undefined {
  const raw = headers.get("retry-after");
  if (!raw) {
    return undefined;
  }

  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1_000;
  }

  const parsedDate = Date.parse(raw);
  if (Number.isNaN(parsedDate)) {
    return undefined;
  }

  return Math.max(0, parsedDate - now());
}

function parseIntegerHeader(value: string | null): number | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function secondsToMs(seconds: number | undefined): number | undefined {
  return seconds === undefined ? undefined : seconds * 1_000;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
