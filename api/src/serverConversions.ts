/**
 * Server-side conversion reporting to GA4 and Meta.
 *
 * The browser is not a reliable place to report a sale:
 *
 *   * A manual-deposit booking is confirmed by staff hours later via the signed
 *     link in depositConfirm.ts. The guest's browser is long gone, so no
 *     client-side event can ever fire for that entire revenue channel.
 *   * Ad blockers and ITP drop a large share of browser Purchase beacons.
 *
 * So the API is the authoritative source for funnel events. GA4 receives them
 * *only* from here — the Measurement Protocol has no deduplication mechanism
 * beyond `transaction_id` on purchase, so mirroring browser events would double
 * count every one. Meta does dedupe on `event_id`, so the pixel keeps firing and
 * the two collapse; this module must therefore reproduce the browser's event IDs
 * exactly (see BookingAnalytics.service.ts on the frontend).
 *
 * Everything here is best-effort. A reporting failure must never break a booking,
 * so every entry point swallows its errors and logs instead.
 */

import { createHash } from "crypto";
import { BookingSessionRecord, BookingTrackingIdentifiers } from "./bookingSessions";
import { ObservabilityLogger } from "./types";

const GA4_ENDPOINT = "https://www.google-analytics.com/mp/collect";
const GA4_DEBUG_ENDPOINT = "https://www.google-analytics.com/debug/mp/collect";
const META_API_VERSION = "v21.0";
const DEFAULT_TIMEOUT_MS = 3_000;

export interface ServerConversionConfig {
  /** GA4 measurement ID, e.g. G-XXXXXXXXXX. Absent disables GA4 reporting. */
  ga4MeasurementId?: string;
  /** Created under the GA4 data stream. Absent disables GA4 reporting. */
  ga4ApiSecret?: string;
  /** Meta dataset / pixel ID. Absent disables Meta reporting. */
  metaPixelId?: string;
  /** Meta Conversions API access token. Absent disables Meta reporting. */
  metaCapiAccessToken?: string;
  /** Routes GA4 to the validation endpoint, which returns explicit errors. */
  debug?: boolean;
  /** Echoed to Meta so events land in the Test Events tab instead of live data. */
  metaTestEventCode?: string;
  timeoutMs?: number;
}

/** Request-scoped signals Meta uses for attribution and match quality. */
export interface ConversionRequestContext {
  clientIpAddress?: string;
  userAgent?: string;
  /** Absolute URL of the page that triggered the action, if known. */
  eventSourceUrl?: string;
}

export interface ServerConversionReporter {
  reportSearch(session: BookingSessionRecord, context?: ConversionRequestContext): Promise<void>;
  reportBeginCheckout(session: BookingSessionRecord, context?: ConversionRequestContext): Promise<void>;
  reportAddPaymentInfo(session: BookingSessionRecord, context?: ConversionRequestContext): Promise<void>;
  reportPurchase(session: BookingSessionRecord, context?: ConversionRequestContext): Promise<void>;
}

type FetchFn = (input: string, init: RequestInit) => Promise<Response>;

interface EventSpec {
  ga4Name: string;
  metaName: string;
  /** Must match the eventID the browser sends, or Meta counts the event twice. */
  eventId: (session: BookingSessionRecord) => string;
  /** Purchase carries revenue; upper-funnel events do not always. */
  includeValue: boolean;
}

const SEARCH: EventSpec = {
  ga4Name: "search",
  metaName: "Search",
  eventId: (session) => session.id,
  includeValue: false,
};

const BEGIN_CHECKOUT: EventSpec = {
  ga4Name: "begin_checkout",
  metaName: "InitiateCheckout",
  eventId: (session) => session.quoteId,
  includeValue: true,
};

const ADD_PAYMENT_INFO: EventSpec = {
  ga4Name: "add_payment_info",
  metaName: "AddPaymentInfo",
  // Mirrors `${quote_id}-${payment_type}` from BookingAnalytics.service.ts.
  eventId: (session) => `${session.quoteId}-${session.paymentMethod ?? "unknown"}`,
  includeValue: true,
};

const PURCHASE: EventSpec = {
  ga4Name: "purchase",
  metaName: "Purchase",
  eventId: (session) => session.reservationPublicId,
  includeValue: true,
};

/** SHA-256 hex of a normalised value, as Meta requires for user identifiers. */
function hashUserData(value: string): string {
  return createHash("sha256").update(value.trim().toLowerCase(), "utf8").digest("hex");
}

/**
 * Phone numbers must be hashed in E.164-ish form: digits only, no punctuation,
 * or the hash will not match Meta's index and the signal is wasted.
 */
function hashPhone(value: string): string {
  const digits = value.replace(/[^\d]/g, "");
  return digits ? createHash("sha256").update(digits, "utf8").digest("hex") : "";
}

function centsToDecimal(cents: number): number {
  return cents / 100;
}

function hasAnyIdentifier(tracking: BookingTrackingIdentifiers | undefined): boolean {
  if (!tracking) {
    return false;
  }
  return Boolean(tracking.gaClientId || tracking.fbp || tracking.fbc || tracking.gclid);
}

export function createServerConversionReporter(
  config: ServerConversionConfig,
  logger: ObservabilityLogger,
  fetchFn: FetchFn = (input, init) => fetch(input, init)
): ServerConversionReporter {
  const ga4Enabled = Boolean(config.ga4MeasurementId && config.ga4ApiSecret);
  const metaEnabled = Boolean(config.metaPixelId && config.metaCapiAccessToken);
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  async function post(url: string, body: unknown, target: "ga4" | "meta"): Promise<void> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetchFn(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        logger.warn("server_conversion_rejected", {
          target,
          statusCode: response.status,
        });
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  function buildGa4Payload(spec: EventSpec, session: BookingSessionRecord): unknown {
    const params: Record<string, unknown> = {
      // Without a session_id GA4 opens a new session for the event and the
      // conversion is attributed to Direct/None instead of the original campaign.
      ...(session.tracking?.gaSessionId ? { session_id: session.tracking.gaSessionId } : {}),
      engagement_time_msec: 1,
      language: session.language,
      arrival_date: session.arrivalDate,
      departure_date: session.departureDate,
      guests: session.guests,
      ...(config.debug ? { debug_mode: true } : {}),
    };

    if (spec.includeValue && session.totalAmountCents != null && session.currency) {
      params.value = centsToDecimal(session.totalAmountCents);
      params.currency = session.currency;
      params.items = [
        {
          item_id: session.propertyId,
          quantity: 1,
          price: centsToDecimal(session.totalAmountCents),
        },
      ];
    }

    if (spec.ga4Name === "purchase") {
      // GA4 dedupes purchase on transaction_id, which is what makes it safe to
      // report from the capture path, the webhook and the reconciliation sweep.
      params.transaction_id = session.reservationPublicId;
    }

    return {
      client_id: session.tracking?.gaClientId,
      events: [{ name: spec.ga4Name, params }],
    };
  }

  function buildMetaPayload(
    spec: EventSpec,
    session: BookingSessionRecord,
    context: ConversionRequestContext
  ): unknown {
    const userData: Record<string, unknown> = {
      ...(session.guest?.email ? { em: [hashUserData(session.guest.email)] } : {}),
      ...(session.guest?.phone && hashPhone(session.guest.phone)
        ? { ph: [hashPhone(session.guest.phone)] }
        : {}),
      ...(session.guest?.firstName ? { fn: [hashUserData(session.guest.firstName)] } : {}),
      ...(session.guest?.lastName ? { ln: [hashUserData(session.guest.lastName)] } : {}),
      ...(session.guest?.country ? { country: [hashUserData(session.guest.country)] } : {}),
      ...(session.tracking?.fbp ? { fbp: session.tracking.fbp } : {}),
      ...(session.tracking?.fbc ? { fbc: session.tracking.fbc } : {}),
      ...(context.clientIpAddress ? { client_ip_address: context.clientIpAddress } : {}),
      ...(context.userAgent ? { client_user_agent: context.userAgent } : {}),
    };

    const customData: Record<string, unknown> = {
      content_type: "property",
      ...(session.propertyId ? { content_ids: [session.propertyId] } : {}),
      checkin_date: session.arrivalDate,
      checkout_date: session.departureDate,
      num_adults: session.guests,
    };

    if (spec.includeValue && session.totalAmountCents != null && session.currency) {
      customData.value = centsToDecimal(session.totalAmountCents);
      customData.currency = session.currency;
    }

    if (spec.metaName === "Purchase") {
      customData.order_id = session.reservationPublicId;
    }

    return {
      data: [
        {
          event_name: spec.metaName,
          event_time: Math.floor(Date.now() / 1000),
          // Collapses this with the pixel's event for the same action.
          event_id: spec.eventId(session),
          action_source: "website",
          ...(context.eventSourceUrl ? { event_source_url: context.eventSourceUrl } : {}),
          user_data: userData,
          custom_data: customData,
        },
      ],
      ...(config.metaTestEventCode ? { test_event_code: config.metaTestEventCode } : {}),
    };
  }

  async function report(
    spec: EventSpec,
    session: BookingSessionRecord,
    context: ConversionRequestContext
  ): Promise<void> {
    try {
      // Fails closed: anything other than an explicit true means the guest did
      // not accept marketing cookies, and nothing leaves the building.
      if (session.marketingConsent !== true) {
        return;
      }

      if (!hasAnyIdentifier(session.tracking)) {
        return;
      }

      const tasks: Promise<void>[] = [];

      if (ga4Enabled && session.tracking?.gaClientId) {
        const endpoint = config.debug ? GA4_DEBUG_ENDPOINT : GA4_ENDPOINT;
        const url = `${endpoint}?measurement_id=${encodeURIComponent(
          config.ga4MeasurementId as string
        )}&api_secret=${encodeURIComponent(config.ga4ApiSecret as string)}`;
        tasks.push(post(url, buildGa4Payload(spec, session), "ga4"));
      }

      if (metaEnabled) {
        const url = `https://graph.facebook.com/${META_API_VERSION}/${encodeURIComponent(
          config.metaPixelId as string
        )}/events?access_token=${encodeURIComponent(config.metaCapiAccessToken as string)}`;
        tasks.push(post(url, buildMetaPayload(spec, session, context), "meta"));
      }

      if (tasks.length === 0) {
        return;
      }

      const results = await Promise.allSettled(tasks);
      for (const result of results) {
        if (result.status === "rejected") {
          logger.warn("server_conversion_failed", {
            event: spec.ga4Name,
            bookingSessionId: session.id,
            error: result.reason instanceof Error ? result.reason.message : String(result.reason),
          });
        }
      }
    } catch (error) {
      // Reporting is never worth failing a booking over.
      logger.error("server_conversion_error", {
        event: spec.ga4Name,
        bookingSessionId: session.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    reportSearch: (session, context = {}) => report(SEARCH, session, context),
    reportBeginCheckout: (session, context = {}) => report(BEGIN_CHECKOUT, session, context),
    reportAddPaymentInfo: (session, context = {}) => report(ADD_PAYMENT_INFO, session, context),
    reportPurchase: (session, context = {}) => report(PURCHASE, session, context),
  };
}

export type ServerConversionEvent = "search" | "begin_checkout" | "add_payment_info" | "purchase";

/**
 * Call-site convenience wrapper. Booking routes should not have to know whether
 * conversion reporting is configured, so an absent config is simply a no-op and
 * nothing here ever rejects.
 */
export async function reportServerConversion(
  event: ServerConversionEvent,
  session: BookingSessionRecord,
  config: ServerConversionConfig | undefined,
  logger: ObservabilityLogger,
  context: ConversionRequestContext = {}
): Promise<void> {
  if (!config) {
    return;
  }

  const reporter = createServerConversionReporter(config, logger);

  switch (event) {
    case "search":
      return reporter.reportSearch(session, context);
    case "begin_checkout":
      return reporter.reportBeginCheckout(session, context);
    case "add_payment_info":
      return reporter.reportAddPaymentInfo(session, context);
    case "purchase":
      return reporter.reportPurchase(session, context);
  }
}
