import { ApiError } from "./http/errors";
import { jsonResponse } from "./http/response";
import { BOOKING_PROPERTIES, BookingProperty } from "./propertyCatalog";
import { createSmoobuClient } from "./smoobuClient";
import { ApiResponse, BookingApiConfig, HeadersMap, JsonBody, RouteObservability } from "./types";
import { CacheAdapter } from "./memoryCache";
import { createCacheAdapter, getCacheBackend, TTL_SCOPES } from "./cacheFactory";

const DEFAULT_CURRENCY = "USD";
const LOW_PRICE_THRESHOLD = 0.9;
const HIGH_PRICE_THRESHOLD = 1.1;

type PriceDot = "green" | "yellow" | "red" | "grey";
type CacheStatus = "hit" | "miss";

interface CalendarRequest {
  apartmentSlug: string;
  month: string;
  language: "en" | "es";
}

interface SmoobuRatesResponse {
  data?: unknown;
}

interface SmoobuRateDay {
  price?: unknown;
  min_length_of_stay?: unknown;
  available?: unknown;
}

/**
 * A night exactly as Smoobu reported it, before any "is this night still in the
 * future?" masking. This is what gets cached: the cache key is scoped to
 * apartment + month but *not* to the current date, so a entry written just
 * before midnight would otherwise keep advertising yesterday as bookable for
 * the rest of its TTL.
 */
interface RawCalendarDay {
  date: string;
  available: boolean;
  priceCents: number | null;
  minStay: number | null;
}

interface CalendarDay extends RawCalendarDay {
  dot: PriceDot;
  ariaLabelKey: string;
}

interface CalendarStats {
  availableNightCount: number;
  minPriceCents: number | null;
  maxPriceCents: number | null;
  averagePriceCents: number | null;
}

interface CalendarProperty {
  propertyId: string;
  slug: string;
  name: string;
}

interface RawCalendarPayload {
  property: CalendarProperty;
  month: string;
  currency: string;
  days: RawCalendarDay[];
}

interface CalendarPayload {
  property: CalendarProperty;
  month: string;
  currency: string;
  days: CalendarDay[];
  stats: CalendarStats;
}

interface CalendarCacheEntry {
  raw: RawCalendarPayload;
  generatedAt: string;
  expiresAtMs: number; // stored so cache-hit responses can report accurate remaining TTL
}

// Module-level CacheAdapter instance — survives Lambda warm starts
const adapter: CacheAdapter = createCacheAdapter(getCacheBackend());

export async function handleCalendarRequest(
  request: CalendarRequest,
  config: BookingApiConfig,
  responseHeaders: HeadersMap,
  observability: RouteObservability,
  now: () => number = Date.now
): Promise<ApiResponse> {
  const property = getPropertyBySlug(request.apartmentSlug);
  if (!property) {
    throw new ApiError(404, "property_not_found", "Property was not found.");
  }

  const cacheKey = calendarCacheKey(property.smoobuApartmentId, request.month);
  const ttlSeconds = TTL_SCOPES["calendar-rates"];
  const nowMs = now();
  const today = costaRicaToday(nowMs);

  const cachedRaw = await adapter.get(cacheKey);
  if (cachedRaw !== null) {
    const cached = parseCacheEntry(cachedRaw);
    // An entry written by a previous deploy has a different shape; treat it as a
    // miss rather than serving a payload we can no longer mask correctly.
    if (cached) {
      // Report the actual remaining TTL, not the full TTL, so callers know how
      // stale the entry is (mirrors the behaviour of the original Map-based cache).
      const remainingTtlSeconds = Math.max(0, Math.ceil((cached.expiresAtMs - nowMs) / 1_000));
      return jsonResponse(
        200,
        withCache(finalizeCalendarPayload(cached.raw, today), "hit", cached.generatedAt, remainingTtlSeconds),
        responseHeaders
      );
    }
  }

  const { startDate, endDate } = monthBounds(request.month);
  const smoobuClient = await createSmoobuClient(config);
  const rates = await smoobuClient.getRates<SmoobuRatesResponse>(
    {
      apartmentIds: [property.smoobuApartmentId],
      startDate,
      endDate,
    },
    observability
  );

  const raw = normalizeCalendarPayload(property, request.month, rates.data);
  const generatedAt = new Date(nowMs).toISOString();
  const expiresAtMs = nowMs + ttlSeconds * 1_000;
  const entry: CalendarCacheEntry = { raw, generatedAt, expiresAtMs };
  await adapter.set(cacheKey, JSON.stringify(entry), ttlSeconds);

  return jsonResponse(
    200,
    withCache(finalizeCalendarPayload(raw, today), "miss", generatedAt, ttlSeconds),
    responseHeaders
  );
}

function parseCacheEntry(serialized: string): CalendarCacheEntry | null {
  try {
    const parsed = JSON.parse(serialized) as Partial<CalendarCacheEntry>;
    if (!parsed?.raw || !Array.isArray(parsed.raw.days) || typeof parsed.generatedAt !== "string") {
      return null;
    }
    return parsed as CalendarCacheEntry;
  } catch {
    return null;
  }
}

export async function invalidateCalendarRatesCache(filters: { apartmentId?: number; month?: string } = {}): Promise<number> {
  if (filters.apartmentId !== undefined && filters.month !== undefined) {
    // Exact key match
    const key = calendarCacheKey(filters.apartmentId, filters.month);
    const count = await adapter.invalidateByPrefix(key);
    return count;
  }

  if (filters.apartmentId !== undefined) {
    // All months for a specific apartment
    const prefix = `${filters.apartmentId}:`;
    return adapter.invalidateByPrefix(prefix);
  }

  // No filters — clear everything
  return adapter.invalidateByPrefix("");
}

export async function clearCalendarRatesCache(): Promise<void> {
  await adapter.invalidateByPrefix("");
}

export async function invalidateCalendarRatesCacheFromWebhook(
  body: JsonBody,
  observability: RouteObservability
): Promise<{ action?: string; invalidatedEntries: number }> {
  const action = typeof body.action === "string" ? body.action : undefined;
  if (action !== "updateRates") {
    return { action, invalidatedEntries: 0 };
  }

  const apartmentId = extractWebhookApartmentId(body);
  const months = extractWebhookMonths(body);
  let invalidatedEntries = 0;

  if (!apartmentId) {
    invalidatedEntries = await invalidateCalendarRatesCache();
  } else if (months.length === 0) {
    invalidatedEntries = await invalidateCalendarRatesCache({ apartmentId });
  } else {
    for (const month of months) {
      invalidatedEntries += await invalidateCalendarRatesCache({ apartmentId, month });
    }
  }

  observability.recordStateTransition({
    entityType: "webhook_event",
    toState: "processed",
    action: "smoobu_updateRates_cache_invalidation",
    success: true,
    provider: "smoobu",
    providerObjectId: apartmentId ? String(apartmentId) : undefined,
  });

  return { action, invalidatedEntries };
}

function normalizeCalendarPayload(
  property: BookingProperty,
  month: string,
  response: SmoobuRatesResponse
): RawCalendarPayload {
  const rateDays = getApartmentRates(response, property.smoobuApartmentId);
  const days = enumerateMonthDates(month).map((date) => normalizeCalendarDay(date, rateDays[date]));

  return {
    property: {
      propertyId: property.propertyId,
      slug: property.slug,
      name: property.name,
    },
    month,
    currency: DEFAULT_CURRENCY,
    days,
  };
}

/**
 * Turns raw Smoobu nights into the public payload.
 *
 * Smoobu keeps reporting `available: 1` for nights that have already passed —
 * it has no notion of "now". Serving those through would advertise a night the
 * guest physically cannot book (the search widget floors check-in at today), so
 * anything before `today` in Costa Rica is forced unavailable *before* stats are
 * computed. Otherwise dead nights would also drag the month average — and with
 * it every dot colour — off the real bookable range.
 */
function finalizeCalendarPayload(raw: RawCalendarPayload, today: string): CalendarPayload {
  const days: RawCalendarDay[] = raw.days.map((day) => ({
    ...day,
    available: day.available && day.date >= today,
  }));
  const stats = computeStats(days);
  const classifiedDays = days.map((day) => {
    const dot = classifyDot(day, stats.averagePriceCents);
    return {
      ...day,
      dot,
      ariaLabelKey: ariaLabelKey(dot),
    };
  });

  return {
    property: raw.property,
    month: raw.month,
    currency: raw.currency,
    days: classifiedDays,
    stats,
  };
}

/**
 * Costa Rica sits at UTC-6 year-round (no DST), so a fixed offset is exact.
 */
function costaRicaToday(nowMs: number): string {
  return new Date(nowMs - 6 * 60 * 60 * 1_000).toISOString().slice(0, 10);
}

function getApartmentRates(response: SmoobuRatesResponse, apartmentId: number): Record<string, SmoobuRateDay> {
  const root = response && typeof response === "object" && "data" in response ? response.data : response;
  if (!root || typeof root !== "object" || Array.isArray(root)) {
    return {};
  }

  const apartmentRates = (root as Record<string, unknown>)[String(apartmentId)];
  if (!apartmentRates || typeof apartmentRates !== "object" || Array.isArray(apartmentRates)) {
    return {};
  }

  return apartmentRates as Record<string, SmoobuRateDay>;
}

function normalizeCalendarDay(date: string, rateDay: SmoobuRateDay | undefined): RawCalendarDay {
  return {
    date,
    available: normalizeAvailable(rateDay?.available),
    priceCents: normalizePriceCents(rateDay?.price),
    minStay: normalizeMinStay(rateDay?.min_length_of_stay),
  };
}

function computeStats(days: RawCalendarDay[]): CalendarStats {
  const availablePrices = days
    .filter((day) => day.available && day.priceCents !== null)
    .map((day) => day.priceCents as number);

  if (availablePrices.length === 0) {
    return {
      availableNightCount: 0,
      minPriceCents: null,
      maxPriceCents: null,
      averagePriceCents: null,
    };
  }

  const total = availablePrices.reduce((sum, price) => sum + price, 0);

  return {
    availableNightCount: availablePrices.length,
    minPriceCents: Math.min(...availablePrices),
    maxPriceCents: Math.max(...availablePrices),
    averagePriceCents: Math.round(total / availablePrices.length),
  };
}

function classifyDot(day: RawCalendarDay, averagePriceCents: number | null): PriceDot {
  if (!day.available || day.priceCents === null || averagePriceCents === null) {
    return "grey";
  }

  if (day.priceCents < averagePriceCents * LOW_PRICE_THRESHOLD) {
    return "green";
  }

  if (day.priceCents > averagePriceCents * HIGH_PRICE_THRESHOLD) {
    return "red";
  }

  return "yellow";
}

function ariaLabelKey(dot: PriceDot): string {
  if (dot === "grey") {
    return "calendar.unavailable";
  }
  if (dot === "green") {
    return "calendar.priceLow";
  }
  if (dot === "red") {
    return "calendar.priceHigh";
  }
  return "calendar.priceAverage";
}

function normalizeAvailable(value: unknown): boolean {
  if (typeof value === "number") {
    return value > 0;
  }
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    return value === "1" || value.toLowerCase() === "true";
  }
  return false;
}

function normalizePriceCents(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return null;
  }

  return Math.round(value * 100);
}

function normalizeMinStay(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return value;
  }
  return null;
}

function getPropertyBySlug(slug: string): BookingProperty | undefined {
  const normalized = slug.toLowerCase();
  return BOOKING_PROPERTIES.find((property) => property.slug.toLowerCase() === normalized);
}

function withCache(payload: CalendarPayload, status: CacheStatus, generatedAt: string, ttlSeconds: number) {
  return {
    ...payload,
    cache: {
      status,
      ttlSeconds,
      generatedAt,
    },
  };
}

function calendarCacheKey(apartmentId: number, month: string): string {
  return `${apartmentId}:${month}`;
}

function monthBounds(month: string): { startDate: string; endDate: string } {
  const startDate = `${month}-01`;
  const [year, monthNumber] = month.split("-").map(Number);
  const lastDay = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  return {
    startDate,
    endDate: `${month}-${String(lastDay).padStart(2, "0")}`,
  };
}

function enumerateMonthDates(month: string): string[] {
  const { startDate, endDate } = monthBounds(month);
  const dates: string[] = [];
  let currentMs = Date.parse(`${startDate}T00:00:00Z`);
  const endMs = Date.parse(`${endDate}T00:00:00Z`);

  while (currentMs <= endMs) {
    dates.push(new Date(currentMs).toISOString().slice(0, 10));
    currentMs += 86_400_000;
  }

  return dates;
}

function extractWebhookApartmentId(body: JsonBody): number | undefined {
  const data = getObject(body.data);
  const candidates = [
    data?.apartmentId,
    data?.apartmentID,
    data?.apartment_id,
    data?.apartment,
    body.apartmentId,
    body.apartmentID,
    body.apartment_id,
  ];

  for (const candidate of candidates) {
    const parsed = parsePositiveInteger(candidate);
    if (parsed !== undefined) {
      return parsed;
    }
  }

  return undefined;
}

function extractWebhookMonths(body: JsonBody): string[] {
  const data = getObject(body.data);
  const months = new Set<string>();
  const candidates = [
    data?.month,
    data?.date,
    data?.startDate,
    data?.endDate,
    data?.start_date,
    data?.end_date,
    data?.dates,
    body.month,
    body.date,
    body.startDate,
    body.endDate,
    body.start_date,
    body.end_date,
    body.dates,
  ];

  for (const candidate of candidates) {
    collectMonths(candidate, months);
  }

  return Array.from(months);
}

function collectMonths(value: unknown, months: Set<string>): void {
  if (Array.isArray(value)) {
    value.forEach((item) => collectMonths(item, months));
    return;
  }

  if (typeof value !== "string") {
    return;
  }

  // Smoobu rate-update operations can represent date ranges as
  // "YYYY-MM-DD:YYYY-MM-DD"; single webhook dates fall through unchanged.
  for (const dateLike of value.split(":")) {
    if (/^\d{4}-\d{2}$/.test(dateLike)) {
      months.add(dateLike);
      continue;
    }

    const match = /^(\d{4}-\d{2})-\d{2}$/.exec(dateLike);
    if (match) {
      months.add(match[1]);
    }
  }
}

function parsePositiveInteger(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return value;
  }
  if (typeof value === "string" && /^\d+$/.test(value)) {
    return Number(value);
  }
  return undefined;
}

function getObject(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  return value as Record<string, unknown>;
}
