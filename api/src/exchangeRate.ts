/**
 * USD → CRC reference rate, used only to show Spanish-speaking guests roughly
 * what a stay costs in colones.
 *
 * Nothing here touches money that is actually moved: every quote, hold, PayPal
 * order and Smoobu reservation stays in USD. The rate exists so a guest reading
 * "$740" — and about to send colones over SINPE — has a number they can compare
 * against their bank balance. That is why a slightly stale rate is preferable to
 * no rate at all, and why the response says which timestamp it came from.
 *
 * Providers are plain public JSON endpoints with no key, tried in order. The
 * extraction is shape-agnostic (see `extractRate`) so the URL list can be
 * repointed via `EXCHANGE_RATE_PROVIDER_URLS` — at the BCCR web service, for
 * instance — without a code change.
 */

import { ApiError } from "./http/errors";
import { jsonResponse } from "./http/response";
import { ApiResponse, BookingApiConfig, ExchangeRateConfig, HeadersMap, RouteObservability } from "./types";

const BASE_CURRENCY = "USD";
const QUOTE_CURRENCY = "CRC";

/**
 * Colones per dollar has sat between roughly ₡450 and ₡700 for two decades. The
 * band is deliberately far wider than that: it is not trying to judge whether a
 * rate is *good*, only to reject a provider that answered with an inverted rate
 * (0.0019), a different currency, or a placeholder — any of which would quote
 * guests an amount off by orders of magnitude.
 */
const MIN_PLAUSIBLE_RATE = 300;
const MAX_PLAUSIBLE_RATE = 1500;

export const DEFAULT_EXCHANGE_RATE_PROVIDER_URLS = [
  "https://open.er-api.com/v6/latest/USD",
  "https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.json",
];

/** Both providers publish once a day, so refetching more often buys nothing. */
export const DEFAULT_EXCHANGE_RATE_TTL_SECONDS = 6 * 60 * 60;
export const DEFAULT_EXCHANGE_RATE_TIMEOUT_MS = 4_000;
/**
 * How long a cached rate may be served after every provider has started
 * failing. Beyond this the endpoint 503s and the UI drops the estimate rather
 * than showing a number that may have drifted meaningfully.
 */
export const DEFAULT_EXCHANGE_RATE_STALE_MAX_AGE_SECONDS = 48 * 60 * 60;
/** Browser/CDN caching. Shorter than the server TTL so a repointed provider propagates. */
const RESPONSE_MAX_AGE_SECONDS = 15 * 60;

interface ResolvedSettings {
  providerUrls: string[];
  ttlSeconds: number;
  timeoutMs: number;
  staleMaxAgeSeconds: number;
}

interface CachedRate {
  rate: number;
  source: string;
  fetchedAtMs: number;
}

/**
 * Module-level rather than the shared `CacheAdapter`: this is a single scalar,
 * it must survive the blanket `invalidateByPrefix("")` a Smoobu `updateRates`
 * webhook performs on the calendar cache, and warm-start persistence is
 * identical either way while the Redis adapter is still a memory-backed stub.
 */
let cachedRate: CachedRate | null = null;
let inFlightFetch: Promise<CachedRate | null> | null = null;

export interface ExchangeRatePayload {
  base: string;
  quote: string;
  /** Colones per one dollar. */
  rate: number;
  source: string;
  fetchedAt: string;
  /** True when every provider failed and this is the last known good rate. */
  stale: boolean;
  cache: {
    status: "hit" | "miss";
    ttlSeconds: number;
  };
}

export async function handleExchangeRateRequest(
  config: BookingApiConfig,
  responseHeaders: HeadersMap,
  observability: RouteObservability,
  now: () => number = Date.now
): Promise<ApiResponse> {
  const settings = resolveSettings(config.exchangeRate);
  const nowMs = now();

  if (cachedRate && nowMs - cachedRate.fetchedAtMs < settings.ttlSeconds * 1_000) {
    return respond(cachedRate, "hit", false, settings, nowMs, responseHeaders);
  }

  const fetched = await loadRate(settings, observability, nowMs);
  if (fetched) {
    return respond(fetched, "miss", false, settings, nowMs, responseHeaders);
  }

  if (cachedRate && nowMs - cachedRate.fetchedAtMs < settings.staleMaxAgeSeconds * 1_000) {
    return respond(cachedRate, "hit", true, settings, nowMs, responseHeaders);
  }

  throw new ApiError(503, "exchange_rate_unavailable", "Exchange rate is unavailable right now.", {
    retryable: true,
  });
}

/** Test seam — the module cache would otherwise leak between test cases. */
export function resetExchangeRateCache(): void {
  cachedRate = null;
  inFlightFetch = null;
}

function respond(
  entry: CachedRate,
  status: "hit" | "miss",
  stale: boolean,
  settings: ResolvedSettings,
  nowMs: number,
  responseHeaders: HeadersMap
): ApiResponse {
  const payload: ExchangeRatePayload = {
    base: BASE_CURRENCY,
    quote: QUOTE_CURRENCY,
    rate: entry.rate,
    source: entry.source,
    fetchedAt: new Date(entry.fetchedAtMs).toISOString(),
    stale,
    cache: {
      status,
      ttlSeconds: Math.max(0, Math.ceil((entry.fetchedAtMs + settings.ttlSeconds * 1_000 - nowMs) / 1_000)),
    },
  };

  return jsonResponse(200, payload, {
    ...responseHeaders,
    // A public daily rate carries no guest data, so unlike every other route it
    // is worth caching in the browser and at the edge.
    "Cache-Control": `public, max-age=${RESPONSE_MAX_AGE_SECONDS}`,
  });
}

/**
 * Fetches from the first provider that answers with a plausible rate.
 *
 * Concurrent misses share one attempt: without this, a burst of Spanish page
 * loads on a cold Lambda would each open their own outbound request.
 */
async function loadRate(
  settings: ResolvedSettings,
  observability: RouteObservability,
  nowMs: number
): Promise<CachedRate | null> {
  if (inFlightFetch) {
    return inFlightFetch;
  }

  inFlightFetch = (async () => {
    for (const url of settings.providerUrls) {
      const startedAt = Date.now();
      try {
        const rate = await fetchRate(url, settings.timeoutMs);
        observability.recordProviderCall({
          provider: "internal",
          operation: "exchange_rate_fetch",
          durationMs: Date.now() - startedAt,
          statusCode: 200,
        });
        const entry: CachedRate = { rate, source: providerName(url), fetchedAtMs: nowMs };
        cachedRate = entry;
        return entry;
      } catch (error) {
        observability.recordProviderCall({
          provider: "internal",
          operation: "exchange_rate_fetch",
          durationMs: Date.now() - startedAt,
          retryable: true,
          errorCode: error instanceof Error ? error.message : "exchange_rate_provider_failed",
        });
      }
    }

    return null;
  })().finally(() => {
    inFlightFetch = null;
  });

  return inFlightFetch;
}

async function fetchRate(url: string, timeoutMs: number): Promise<number> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`exchange_rate_http_${response.status}`);
    }

    const rate = extractRate(await response.json());
    if (rate === null) {
      throw new Error("exchange_rate_not_in_payload");
    }

    return rate;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Pulls colones-per-dollar out of whichever shape the provider uses.
 *
 * Free rate APIs agree on the numbers and disagree on the envelope —
 * `rates.CRC`, `conversion_rates.CRC`, `usd.crc`, `data.CRC` are all in the
 * wild. Probing the known shapes is what keeps the provider list configurable.
 */
export function extractRate(body: unknown): number | null {
  if (!body || typeof body !== "object") {
    return null;
  }

  const root = body as Record<string, unknown>;
  const containers = [root.rates, root.conversion_rates, root.data, root.usd, root.USD, root];

  for (const container of containers) {
    if (!container || typeof container !== "object") {
      continue;
    }

    const record = container as Record<string, unknown>;
    for (const key of [QUOTE_CURRENCY, QUOTE_CURRENCY.toLowerCase()]) {
      const value = record[key];
      const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
      if (Number.isFinite(parsed) && parsed >= MIN_PLAUSIBLE_RATE && parsed <= MAX_PLAUSIBLE_RATE) {
        // Two decimals is all any provider publishes and all the UI shows.
        return Math.round(parsed * 100) / 100;
      }
    }
  }

  return null;
}

function providerName(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "unknown";
  }
}

function resolveSettings(config: ExchangeRateConfig | undefined): ResolvedSettings {
  const providerUrls = config?.providerUrls?.length ? config.providerUrls : DEFAULT_EXCHANGE_RATE_PROVIDER_URLS;

  return {
    providerUrls,
    ttlSeconds: config?.ttlSeconds ?? DEFAULT_EXCHANGE_RATE_TTL_SECONDS,
    timeoutMs: config?.timeoutMs ?? DEFAULT_EXCHANGE_RATE_TIMEOUT_MS,
    staleMaxAgeSeconds: config?.staleMaxAgeSeconds ?? DEFAULT_EXCHANGE_RATE_STALE_MAX_AGE_SECONDS,
  };
}
