import { ApiError } from "./http/errors";
import { reportServerConversion } from "./serverConversions";
import { jsonResponse } from "./http/response";
import { BOOKING_PROPERTIES, BOOKING_PROPERTIES_BY_SMOOBU_ID, BookingProperty, listingUrlForLanguage } from "./propertyCatalog";
import { createSmoobuClient } from "./smoobuClient";
import { ApiResponse, BookingApiConfig, HeadersMap, RouteObservability } from "./types";
import { SearchRequest } from "./validation";
import { CacheAdapter } from "./memoryCache";
import { createCacheAdapter, getCacheBackend, TTL_SCOPES } from "./cacheFactory";

const QUOTE_TTL_MS = 10 * 60 * 1000;

/** Below this the "discount" is Smoobu rounding, not an offer worth showing. */
const MIN_DISPLAYABLE_DISCOUNT_PERCENTAGE = 1;

/**
 * Shortest stay that can carry a length-of-stay discount. Many Smoobu
 * accounts start discounting at five nights (and again at thirty), so a shorter
 * search cannot produce one and the rack-rate lookup would be a Smoobu call
 * spent to prove a negative. Raise or lower this to match the account's
 * shortest configured long-stay rule.
 */
const BASELINE_MIN_NIGHTS = 5;

// Rate tables move rarely and the calendar already reads them on this TTL.
const stayRatesCache: CacheAdapter = createCacheAdapter(getCacheBackend());
const STAY_RATES_CACHE_PREFIX = "stay-rates:";

/** Test seam: the cache outlives a single search, so suites must reset it. */
export async function clearStayRatesCache(): Promise<void> {
  await stayRatesCache.invalidateByPrefix(STAY_RATES_CACHE_PREFIX);
}

interface SmoobuAvailabilityResponse {
  availableApartments?: unknown;
  prices?: unknown;
  errorMessages?: unknown;
}

/**
 * What Smoobu knocked off the rack rate, reconstructed rather than reported.
 *
 * Neither `checkApartmentAvailability` nor `/api/rates` returns a breakdown —
 * the availability total simply arrives already discounted. So the baseline is
 * the sum of the nightly rates for the same nights, which knows nothing about
 * stay length and therefore still carries the undiscounted price.
 */
interface PriceDiscount {
  /**
   * Length-of-stay pricing unless the search carried a code, in which case the
   * gap includes whatever that code did and must not be labelled a long stay.
   */
  source: "long_stay" | "discount_code";
  baseTotalCents: number;
  baseNightlyAverageCents: number;
  amountCents: number;
  percentage: number;
}

interface PriceQuote {
  currency: string;
  totalAmountCents: number;
  nightlyAverageCents: number;
  nights: number;
  includesTaxes: false;
  rateSource: "smoobu";
  discount?: PriceDiscount;
}

interface AvailabilityWarning {
  code: string;
  messageKey: string;
  propertyId?: string;
}

export async function handleAvailabilitySearch(
  request: SearchRequest,
  config: BookingApiConfig,
  responseHeaders: HeadersMap,
  observability: RouteObservability
): Promise<ApiResponse> {
  const customerId = config.smoobu.customerId;
  if (!customerId) {
    throw new ApiError(503, "provider_config_missing", "Smoobu customer ID is not configured.", {
      retryable: false,
      fieldErrors: {
        smoobuCustomerId: ["required"],
      },
    });
  }

  const smoobuClient = await createSmoobuClient(config);
  const apartmentIds = BOOKING_PROPERTIES.map((property) => property.smoobuApartmentId);
  const smoobuPayload = {
    arrivalDate: request.arrivalDate,
    departureDate: request.departureDate,
    apartments: apartmentIds,
    customerId,
    guests: request.guests,
    ...(request.discountCode ? { discountCode: request.discountCode } : {}),
  };

  // Run together: the rack-rate lookup is only used to annotate the prices the
  // availability call returns, so serialising them would add latency for
  // nothing. A rates failure resolves to "no baselines" rather than rejecting.
  const [availability, baselines] = await Promise.all([
    smoobuClient.checkApartmentAvailability<SmoobuAvailabilityResponse>(smoobuPayload, observability),
    fetchStayBaselines(smoobuClient, apartmentIds, request, observability),
  ]);
  const normalized = normalizeAvailability(availability.data, request, baselines);

  const bookingSessions = config.bookingSessions;
  if (!bookingSessions) {
    throw new ApiError(503, "database_unavailable", "Booking session storage is not configured.", {
      retryable: true,
    });
  }

  const bookingSessionInput = {
    arrivalDate: request.arrivalDate,
    departureDate: request.departureDate,
    guests: request.guests,
    language: request.language,
    source: request.source,
    quoteTtlMs: QUOTE_TTL_MS,
    // Captured at session creation so every later funnel event can be attributed
    // back to the campaign that produced the search.
    ...(request.tracking ? { tracking: request.tracking } : {}),
    marketingConsent: request.marketingConsent === true,
    quotedProperties: normalized.properties.map((property) => ({
      propertyId: property.propertyId,
      currency: property.price.currency,
      totalAmountCents: property.price.totalAmountCents,
      nightlyAverageCents: property.price.nightlyAverageCents,
      nights: property.price.nights,
      includesTaxes: property.price.includesTaxes,
      rateSource: property.price.rateSource,
    })),
  };
  const bookingSession =
    normalized.properties.length > 0
      ? await bookingSessions.createQuotedSession(bookingSessionInput)
      : await bookingSessions.createNoAvailabilitySession(bookingSessionInput);

  observability.recordStateTransition({
    entityType: "booking_session",
    toState: bookingSession.status,
    action: "availability_search",
    success: true,
    bookingSessionId: bookingSession.id,
    provider: "smoobu",
  });

  // GA4 receives funnel events only from here — the Measurement Protocol cannot
  // deduplicate, so the browser no longer reports them. Best-effort by design.
  await reportServerConversion("search", bookingSession, config.serverConversions, observability.logger);

  return jsonResponse(
    200,
    {
      bookingSessionId: bookingSession.id,
      quoteId: bookingSession.quoteId,
      quoteExpiresAt: bookingSession.quoteExpiresAt,
      arrivalDate: bookingSession.arrivalDate,
      departureDate: bookingSession.departureDate,
      guests: bookingSession.guests,
      language: bookingSession.language,
      resultsCount: normalized.properties.length,
      properties: normalized.properties,
      availabilityWarnings:
        normalized.properties.length === 0
          ? ensureNoAvailabilityWarning(normalized.availabilityWarnings)
          : normalized.availabilityWarnings,
    },
    responseHeaders
  );
}

function normalizeAvailability(
  data: SmoobuAvailabilityResponse,
  request: SearchRequest,
  baselines: Map<number, number> = new Map()
) {
  const unavailableIds = parseUnavailableApartmentIds(data.errorMessages);
  const availableIds = parseAvailableApartmentIds(data.availableApartments).filter((id) => !unavailableIds.has(id));
  const properties = availableIds
    .map((apartmentId) => {
      const property = BOOKING_PROPERTIES_BY_SMOOBU_ID.get(apartmentId);
      if (!property) {
        return undefined;
      }

      const price = parsePriceQuote(data.prices, apartmentId, request);
      if (!price) {
        return undefined;
      }

      return buildPublicProperty(property, withDiscount(price, baselines.get(apartmentId), request), request.language);
    })
    .filter((property): property is ReturnType<typeof buildPublicProperty> => property !== undefined);

  return {
    properties,
    availabilityWarnings: mapAvailabilityWarnings(data.errorMessages),
  };
}

/**
 * Annotates a quote with the gap between the rack rate and what Smoobu actually
 * charges for these dates — a long-stay discount, in practice.
 *
 * Only ever *subtracts*. A property that prices extra guests above the nightly
 * rate quotes more than the baseline, and that is a surcharge, not a negative
 * discount, so it is left unannotated rather than shown as a fake saving.
 */
function withDiscount(price: PriceQuote, baseTotalCents: number | undefined, request: SearchRequest): PriceQuote {
  if (baseTotalCents === undefined || baseTotalCents <= price.totalAmountCents) {
    return price;
  }

  const amountCents = baseTotalCents - price.totalAmountCents;
  const percentage = Math.round((amountCents / baseTotalCents) * 100);
  if (percentage < MIN_DISPLAYABLE_DISCOUNT_PERCENTAGE) {
    return price;
  }

  return {
    ...price,
    discount: {
      source: request.discountCode ? "discount_code" : "long_stay",
      baseTotalCents,
      baseNightlyAverageCents: Math.round(baseTotalCents / price.nights),
      amountCents,
      percentage,
    },
  };
}

/**
 * Sums each apartment's nightly rates across the stay, giving the price before
 * any length-of-stay discount.
 *
 * One call covers the whole portfolio, and the result is cached on the rate TTL
 * — searches for popular date ranges repeat constantly, and Smoobu's rate limit
 * is a shared budget with availability and the calendar.
 *
 * Never throws: a missing baseline costs a "was €X" line, not the search.
 */
async function fetchStayBaselines(
  smoobuClient: Awaited<ReturnType<typeof createSmoobuClient>>,
  apartmentIds: number[],
  request: SearchRequest,
  observability: RouteObservability
): Promise<Map<number, number>> {
  // Rates are per night, so the departure date itself is not slept in.
  const stayDates = enumerateStayNights(request.arrivalDate, request.departureDate);
  if (stayDates.length < BASELINE_MIN_NIGHTS) {
    return new Map();
  }

  const cacheKey = `${STAY_RATES_CACHE_PREFIX}${request.arrivalDate}:${request.departureDate}`;

  try {
    const cached = await stayRatesCache.get(cacheKey);
    if (cached !== null) {
      return parseBaselineCacheEntry(cached);
    }

    const rates = await smoobuClient.getRates<{ data?: unknown }>(
      {
        apartmentIds,
        startDate: stayDates[0],
        endDate: stayDates[stayDates.length - 1],
      },
      observability
    );

    const baselines = sumNightlyRates(rates.data, apartmentIds, stayDates);
    await stayRatesCache.set(
      cacheKey,
      JSON.stringify(Array.from(baselines.entries())),
      TTL_SCOPES["calendar-rates"]
    );
    return baselines;
  } catch (error) {
    observability.logger.warn("stay_baseline_lookup_failed", {
      arrivalDate: request.arrivalDate,
      departureDate: request.departureDate,
      error: error instanceof Error ? error.message : String(error),
    });
    return new Map();
  }
}

function parseBaselineCacheEntry(serialized: string): Map<number, number> {
  try {
    const parsed = JSON.parse(serialized) as [number, number][];
    return Array.isArray(parsed) ? new Map(parsed) : new Map();
  } catch {
    return new Map();
  }
}

/**
 * A baseline is only usable when every night of the stay has a rate. A partial
 * sum would understate the rack rate and turn a real discount into a smaller
 * one — or invent one where none exists.
 */
function sumNightlyRates(data: unknown, apartmentIds: number[], stayDates: string[]): Map<number, number> {
  const root = data && typeof data === "object" && "data" in data ? (data as { data: unknown }).data : data;
  const baselines = new Map<number, number>();

  if (!root || typeof root !== "object" || Array.isArray(root)) {
    return baselines;
  }

  for (const apartmentId of apartmentIds) {
    const apartmentRates = (root as Record<string, unknown>)[String(apartmentId)];
    if (!apartmentRates || typeof apartmentRates !== "object" || Array.isArray(apartmentRates)) {
      continue;
    }

    let totalCents = 0;
    let complete = true;
    for (const date of stayDates) {
      const night = (apartmentRates as Record<string, unknown>)[date];
      const price = night && typeof night === "object" ? (night as { price?: unknown }).price : undefined;
      if (typeof price !== "number" || !Number.isFinite(price) || price <= 0) {
        complete = false;
        break;
      }
      totalCents += Math.round(price * 100);
    }

    if (complete && totalCents > 0) {
      baselines.set(apartmentId, totalCents);
    }
  }

  return baselines;
}

function enumerateStayNights(arrivalDate: string, departureDate: string): string[] {
  const dates: string[] = [];
  let currentMs = Date.parse(`${arrivalDate}T00:00:00Z`);
  const lastNightMs = Date.parse(`${departureDate}T00:00:00Z`) - 86_400_000;

  if (!Number.isFinite(currentMs) || !Number.isFinite(lastNightMs)) {
    return dates;
  }

  while (currentMs <= lastNightMs) {
    dates.push(new Date(currentMs).toISOString().slice(0, 10));
    currentMs += 86_400_000;
  }

  return dates;
}

function buildPublicProperty(property: BookingProperty, price: PriceQuote, language: "en" | "es") {
  const listingUrl = listingUrlForLanguage(property.slug, language);

  return {
    propertyId: property.propertyId,
    slug: property.slug,
    listingUrl,
    name: property.name,
    guestCapacity: property.guestCapacity,
    thumbnailUrl: property.thumbnailUrl,
    amenities: property.amenities.map((amenity) => ({
      code: amenity.code,
      label: localizeAmenityLabel(amenity, language),
    })),
    price,
    actions: {
      viewListingUrl: listingUrl,
      // Hard-coded true now that the hold route is implemented (task 4.1).
      // TODO: derive dynamically once per-property or per-environment feature flags exist.
      canCreatePayPalHold: true,
      canUseManualDepositHandoff: true,
    },
  };
}

function localizeAmenityLabel(amenity: BookingProperty["amenities"][number], language: "en" | "es"): string {
  if (language === "en") {
    return amenity.label;
  }

  if (amenity.code === "bath" && amenity.label.startsWith("2 ")) {
    return "2 ba\u00f1os";
  }

  if (amenity.code === "parking") {
    if (amenity.label.toLowerCase().includes("unfenced")) {
      return "Parqueo sin cerca";
    }
    if (amenity.label.toLowerCase().includes("fenced")) {
      return "Parqueo privado cercado";
    }
    if (amenity.label.toLowerCase().includes("outside")) {
      return "Parqueo exterior";
    }
    return "Parqueo privado";
  }

  const labels: Record<string, string> = {
    ac: "A/C",
    bath: "Ba\u00f1o privado equipado",
    kitchen: "Cocina privada equipada",
    pet: "Acepta mascotas",
    pool: "Piscina privada",
    wifi: amenity.label === "WiFi" ? "WiFi" : "WiFi 100Mbps",
  };

  return labels[amenity.code] ?? amenity.label;
}

function parseAvailableApartmentIds(value: unknown): number[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const ids = value
    .map((item) => {
      if (typeof item === "number" && Number.isInteger(item)) {
        return item;
      }
      if (typeof item === "string" && /^\d+$/.test(item)) {
        return Number(item);
      }
      if (item && typeof item === "object" && "id" in item) {
        const id = (item as { id?: unknown }).id;
        return typeof id === "number" && Number.isInteger(id) ? id : undefined;
      }
      return undefined;
    })
    .filter((id): id is number => typeof id === "number");

  return Array.from(new Set(ids));
}

function parsePriceQuote(prices: unknown, apartmentId: number, request: SearchRequest): PriceQuote | undefined {
  if (!prices || typeof prices !== "object" || Array.isArray(prices)) {
    return undefined;
  }

  const priceInfo = (prices as Record<string, unknown>)[String(apartmentId)];
  if (!priceInfo || typeof priceInfo !== "object" || Array.isArray(priceInfo)) {
    return undefined;
  }

  const rawPrice = (priceInfo as Record<string, unknown>).price;
  const currency = (priceInfo as Record<string, unknown>).currency;
  if (typeof rawPrice !== "number" || !Number.isFinite(rawPrice) || rawPrice < 0 || typeof currency !== "string") {
    return undefined;
  }

  const nights = nightsBetween(request.arrivalDate, request.departureDate);
  const totalAmountCents = Math.round(rawPrice * 100);

  const normalizedCurrency = normalizeCurrencyCode(currency);

  return {
    currency: normalizedCurrency,
    totalAmountCents,
    nightlyAverageCents: Math.round(totalAmountCents / nights),
    nights,
    includesTaxes: false,
    rateSource: "smoobu",
  };
}

const CURRENCY_SYMBOL_MAP: Record<string, string> = {
  "$": "USD", "€": "EUR", "£": "GBP", "¥": "JPY", "₡": "CRC",
};

function normalizeCurrencyCode(raw: string): string {
  const upper = raw.trim().toUpperCase();
  if (/^[A-Z]{3}$/.test(upper)) {
    return upper;
  }
  return CURRENCY_SYMBOL_MAP[raw.trim()] ?? "USD";
}

function mapAvailabilityWarnings(errorMessages: unknown): AvailabilityWarning[] {
  if (!errorMessages || typeof errorMessages !== "object" || Array.isArray(errorMessages)) {
    return [];
  }

  return Object.entries(errorMessages as Record<string, unknown>)
    .map(([apartmentId, value]) => {
      const property = BOOKING_PROPERTIES_BY_SMOOBU_ID.get(Number(apartmentId));
      const code = mapSmoobuErrorToSafeCode(value);
      return {
        code,
        messageKey: `booking.availability.${code}`,
        ...(property ? { propertyId: property.propertyId } : {}),
      };
    })
    .filter((warning, index, warnings) => {
      const key = `${warning.propertyId ?? "global"}:${warning.code}`;
      return warnings.findIndex((candidate) => `${candidate.propertyId ?? "global"}:${candidate.code}` === key) === index;
    });
}

function parseUnavailableApartmentIds(errorMessages: unknown): Set<number> {
  if (!errorMessages || typeof errorMessages !== "object" || Array.isArray(errorMessages)) {
    return new Set();
  }

  return new Set(
    Object.keys(errorMessages)
      .map((key) => Number(key))
      .filter((id) => Number.isInteger(id))
  );
}

function mapSmoobuErrorToSafeCode(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return "no_properties_available";
  }

  const error = value as Record<string, unknown>;
  const errorCode = typeof error.errorCode === "number" ? error.errorCode : undefined;

  if (typeof error.minimumLengthOfStay === "number" || errorCode === 401) {
    return "minimum_stay_not_met";
  }
  if (typeof error.numberOfGuest === "number" || errorCode === 400) {
    return "guest_capacity_exceeded";
  }
  if (Array.isArray(error.arrivalDays) || errorCode === 402) {
    return "arrival_day_restricted";
  }
  if (typeof error.leadTime === "number" || errorCode === 403) {
    return "lead_time_restricted";
  }
  if (typeof error.minimumLengthBetweenBookings === "number" || errorCode === 404) {
    return "gap_rule_restricted";
  }

  return "no_properties_available";
}

function ensureNoAvailabilityWarning(warnings: AvailabilityWarning[]): AvailabilityWarning[] {
  if (warnings.length > 0) {
    return warnings;
  }

  return [
    {
      code: "no_properties_available",
      messageKey: "booking.noAvailability",
    },
  ];
}

function nightsBetween(arrivalDate: string, departureDate: string): number {
  const arrivalMs = Date.parse(`${arrivalDate}T00:00:00Z`);
  const departureMs = Date.parse(`${departureDate}T00:00:00Z`);
  return Math.max(1, Math.round((departureMs - arrivalMs) / 86_400_000));
}
