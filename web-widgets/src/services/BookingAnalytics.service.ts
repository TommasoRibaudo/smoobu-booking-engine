/**
 * Booking Analytics Service
 *
 * Unified analytics schema for the custom booking engine.
 * Fires events to PostHog, GA4, and Meta Pixel with consent gating.
 *
 * Event map (from plan.md / tasks.md):
 *   booking_search            → GA4: search / Meta: Search
 *   availability_results      → GA4: custom
 *   property_viewed           → GA4: view_item / Meta: ViewContent
 *   booking_form_viewed       → PostHog only
 *   booking_form_started      → PostHog only
 *   checkout_started          → GA4: begin_checkout / Meta: InitiateCheckout
 *   payment_method_selected   → GA4: add_payment_info / Meta: AddPaymentInfo
 *   payment_started           → PostHog only
 *   paypal_approved           → GA4: custom
 *   payment_completed         → PostHog only
 *   booking_confirmed         → GA4: purchase / Meta: Purchase  (server-side preferred)
 *   manual_deposit_handoff_clicked → GA4: custom / Meta: Lead (optional)
 *   booking_cancelled         → GA4: custom
 *
 * FUNNEL — the six steps behind the PostHog "Booking funnel" insight are
 * $pageview → booking_search → availability_results → booking_form_viewed →
 * checkout_started → payment_completed. Note that checkout_started fires AFTER
 * the server confirms the hold, so it is the "dates are actually reserved"
 * step despite the name; it keeps that name because Meta dedupes
 * InitiateCheckout against the server on the quote ID and existing PostHog
 * history is keyed to it.
 *
 * The PostHog-only events above deliberately skip gtag() and fbq(): they exist
 * to close gaps between the GA4/Meta commerce steps, and sending them onward
 * would add unmapped custom events to two products that already have their own
 * funnel semantics.
 *
 * GA4 OWNERSHIP — read before adding a gtag() call here.
 *
 * search, begin_checkout, add_payment_info and purchase are reported to GA4 by
 * the API (booking-api/src/serverConversions.ts), NOT from this file. The
 * Measurement Protocol has no deduplication mechanism beyond transaction_id on
 * purchase, so firing them from both sides double-counts every one. The Meta
 * pixel still fires them here because Meta dedupes on eventID — which is why the
 * eventID values below must stay identical to the server's event_id.
 *
 * view_item is the exception: listing pages are static and open in a new tab, so
 * the server never observes them and the browser is the only possible source.
 */

import * as PostHog from './PostHog.service';
import { CookieConsentService } from './CookieConsent.service';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type BookingAnalyticsLanguage = 'en' | 'es';
export type PaymentType =
  | 'paypal'
  /** Deposit booking that creates a real hold and awaits staff confirmation. */
  | 'manual_deposit'
  /** Legacy contact-only handoff, kept for continuity of historical events. */
  | 'manual_deposit_handoff';

export interface BookingSearchProps {
  arrival_date: string;
  departure_date: string;
  guests: number;
  language: BookingAnalyticsLanguage;
  source?: string;
}

export interface AvailabilityResultsProps {
  available_count: number;
  /** Minimum total price in cents across available properties, or null if no prices returned */
  min_price_cents: number | null;
  currency: string | null;
  arrival_date: string;
  departure_date: string;
  guests: number;
  language: BookingAnalyticsLanguage;
}

export interface PropertyViewedProps {
  property_id: string;
  property_slug: string;
  property_name: string;
  /** Total price in cents, or null if unavailable */
  price_cents: number | null;
  currency: string | null;
  language: BookingAnalyticsLanguage;
}

export interface CheckoutStartedProps {
  quote_id: string;
  property_id: string;
  property_slug: string;
  property_name: string;
  /** Total price in cents */
  value_cents: number;
  currency: string;
  arrival_date: string;
  departure_date: string;
  guests: number;
  language: BookingAnalyticsLanguage;
}

export interface PaymentMethodSelectedProps {
  quote_id: string;
  property_id: string;
  payment_type: PaymentType;
  /** Total price in cents */
  value_cents: number;
  currency: string;
  language: BookingAnalyticsLanguage;
}

export interface BookingFormViewedProps {
  quote_id: string;
  property_id: string;
  property_slug: string;
  property_name: string;
  payment_type: PaymentType;
  /** Total price in cents, or null when the quote carried no price */
  value_cents: number | null;
  currency: string | null;
  language: BookingAnalyticsLanguage;
}

export interface BookingFormStartedProps {
  quote_id: string;
  property_id: string;
  property_slug: string;
  payment_type: PaymentType;
  /** Which field the guest touched first — shows where the form invites entry. */
  first_field: string;
  language: BookingAnalyticsLanguage;
}

export interface PaypalApprovedProps {
  paypal_order_id: string;
  property_id: string;
  language: BookingAnalyticsLanguage;
}

export interface PaymentStartedProps {
  payment_type: PaymentType;
  reservation_id: string;
  booking_session_id: string;
  property_id: string;
  /** Total price in cents, or null when the quote carried no price */
  value_cents: number | null;
  currency: string | null;
  language: BookingAnalyticsLanguage;
}

export interface PaymentCompletedProps {
  payment_type: PaymentType;
  reservation_id: string;
  property_id: string;
  /** Total price in cents, or null when the quote carried no price */
  value_cents: number | null;
  currency: string | null;
  /**
   * 'confirmed' — money captured, booking is live (PayPal).
   * 'awaiting_verification' — guest uploaded a transfer receipt and staff have
   * yet to verify it (manual deposit). Both end the guest-facing funnel, but
   * only the first is revenue.
   */
  outcome: 'confirmed' | 'awaiting_verification';
  language: BookingAnalyticsLanguage;
}

export interface BookingConfirmedProps {
  reservation_id: string;
  property_id: string;
  property_slug: string;
  property_name: string;
  /** Total price in cents */
  value_cents: number;
  currency: string;
  arrival_date: string;
  departure_date: string;
  payment_method: PaymentType;
  language: BookingAnalyticsLanguage;
}

export interface ManualDepositHandoffClickedProps {
  contact_method: string;
  quote_id: string;
  property_id: string;
  property_slug: string;
  language: BookingAnalyticsLanguage;
  analytics_consent?: boolean;
}

export interface BookingCancelledProps {
  reason: 'hold_expired' | 'user_cancelled' | 'payment_failed' | 'system';
  property_id?: string;
  language: BookingAnalyticsLanguage;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Returns true when the user has consented to analytics tracking. */
function canTrack(): boolean {
  try {
    return CookieConsentService.hasConsent('analytics');
  } catch {
    return false;
  }
}

/**
 * Returns true when the user has consented to marketing tracking.
 *
 * The Meta Pixel is only loaded when BOTH analytics and marketing are granted
 * (see App.tsx), so gating fbq on 'analytics' alone produced calls that silently
 * no-opped for anyone who accepted analytics only.
 */
function canTrackMarketing(): boolean {
  try {
    return CookieConsentService.hasConsent('marketing');
  } catch {
    return false;
  }
}

/** Safe gtag call — no-ops if gtag is unavailable. */
function gtag(event: string, params: Record<string, unknown>): void {
  if (typeof window !== 'undefined' && typeof window.gtag === 'function') {
    window.gtag('event', event, params);
  }
}

/**
 * Generates a Meta event ID for browser/server deduplication.
 *
 * When the same conversion is later sent via the Conversions API with the same
 * eventID, Meta collapses the pair instead of counting it twice. Pass a stable
 * key (e.g. the reservation ID) wherever one exists so the server can reproduce it.
 */
function metaEventId(stableKey?: string): string {
  if (stableKey) return stableKey;
  try {
    return crypto.randomUUID();
  } catch {
    return `evt-${Math.random().toString(36).slice(2)}-${performance.now().toFixed(0)}`;
  }
}

/** Safe fbq call — no-ops if fbq is unavailable or marketing consent is absent. */
function fbq(event: string, params?: Record<string, unknown>, eventId?: string): void {
  if (!canTrackMarketing()) return;
  if (typeof window === 'undefined' || typeof (window as any).fbq !== 'function') return;

  const options = eventId ? { eventID: eventId } : undefined;

  if (params) {
    (window as any).fbq('track', event, params, options);
  } else {
    (window as any).fbq('track', event, {}, options);
  }
}

/** Convert cents to a decimal amount for GA4 / Meta (they expect e.g. 52000 → 520.00). */
function centsToDecimal(cents: number): number {
  return cents / 100;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Guest submits the availability search form.
 * PostHog: booking_search | GA4: search | Meta: Search
 */
export function trackBookingSearch(props: BookingSearchProps): void {
  if (!canTrack()) return;

  PostHog.capture('booking_search', props);

  fbq('Search', {
    content_category: 'booking',
    content_type: 'property',
    search_string: `${props.arrival_date} → ${props.departure_date} · ${props.guests}`,
    checkin_date: props.arrival_date,
    checkout_date: props.departure_date,
    num_adults: props.guests,
  });
}

/**
 * Availability results are rendered (including empty results).
 * PostHog: availability_results | GA4: custom
 */
export function trackAvailabilityResults(props: AvailabilityResultsProps): void {
  if (!canTrack()) return;

  PostHog.capture('availability_results', props);

  gtag('availability_results', {
    event_category: 'booking',
    available_count: props.available_count,
    min_price: props.min_price_cents != null ? centsToDecimal(props.min_price_cents) : null,
    currency: props.currency,
    arrival_date: props.arrival_date,
    departure_date: props.departure_date,
    guests: props.guests,
    language: props.language,
  });
}

/**
 * Guest opens a property listing page from the results.
 * PostHog: property_viewed | GA4: view_item | Meta: ViewContent
 */
export function trackPropertyViewed(props: PropertyViewedProps): void {
  if (!canTrack()) return;

  PostHog.capture('property_viewed', props);

  gtag('view_item', {
    event_category: 'booking',
    items: [
      {
        item_id: props.property_id,
        item_name: props.property_name,
        price: props.price_cents != null ? centsToDecimal(props.price_cents) : undefined,
        currency: props.currency ?? undefined,
      },
    ],
    language: props.language,
  });

  fbq('ViewContent', {
    content_ids: [props.property_id],
    content_name: props.property_name,
    content_type: 'property',
    ...(props.price_cents != null && props.currency
      ? { value: centsToDecimal(props.price_cents), currency: props.currency }
      : {}),
  });
}

/**
 * Guest opens the guest-details form for a property (either payment path).
 * Funnel step 4 — the gap between "saw results" and "reserved dates".
 * PostHog only.
 */
export function trackBookingFormViewed(props: BookingFormViewedProps): void {
  if (!canTrack()) return;

  PostHog.capture('booking_form_viewed', props);
}

/**
 * Guest edits the first field of the guest-details form.
 * Separates "opened the form and left" from "started typing and gave up",
 * which are very different problems.
 * PostHog only.
 */
export function trackBookingFormStarted(props: BookingFormStartedProps): void {
  if (!canTrack()) return;

  PostHog.capture('booking_form_started', props);
}

/**
 * Guest clicks "Book now" / a hold is successfully created.
 * PostHog: checkout_started | GA4: begin_checkout | Meta: InitiateCheckout
 */
export function trackCheckoutStarted(props: CheckoutStartedProps): void {
  if (!canTrack()) return;

  PostHog.capture('checkout_started', props);

  fbq('InitiateCheckout', {
    value: centsToDecimal(props.value_cents),
    currency: props.currency,
    content_ids: [props.property_id],
    content_name: props.property_name,
    content_type: 'property',
    num_items: 1,
    checkin_date: props.arrival_date,
    checkout_date: props.departure_date,
    num_adults: props.guests,
  }, metaEventId(props.quote_id));
}

/**
 * Guest selects a payment method (PayPal or manual deposit handoff).
 * PostHog: payment_method_selected | GA4: add_payment_info | Meta: AddPaymentInfo
 */
export function trackPaymentMethodSelected(props: PaymentMethodSelectedProps): void {
  if (!canTrack()) return;

  PostHog.capture('payment_method_selected', props);

  fbq('AddPaymentInfo', {
    value: centsToDecimal(props.value_cents),
    currency: props.currency,
    content_ids: [props.property_id],
    content_type: 'property',
  }, metaEventId(`${props.quote_id}-${props.payment_type}`));
}

/**
 * Guest is handed off to actually pay: redirected to PayPal approval, or shown
 * the bank-transfer instructions for a manual deposit.
 *
 * This is the last thing the site controls before the guest leaves for a bank
 * or for PayPal, so a drop between here and payment_completed is an off-site
 * abandonment rather than a UX problem on our pages.
 * PostHog only.
 */
export function trackPaymentStarted(props: PaymentStartedProps): void {
  if (!canTrack()) return;

  PostHog.capture('payment_started', props);
}

/**
 * Guest returns from PayPal approval.
 * PostHog: paypal_approved | GA4: custom
 */
export function trackPaypalApproved(props: PaypalApprovedProps): void {
  if (!canTrack()) return;

  PostHog.capture('paypal_approved', props);

  gtag('paypal_approved', {
    event_category: 'booking',
    paypal_order_id: props.paypal_order_id,
    property_id: props.property_id,
    language: props.language,
  });
}

/**
 * Terminal funnel step for BOTH payment paths.
 *
 * booking_confirmed only ever fires for PayPal, because a manual deposit is not
 * confirmed until staff verify the transfer days later — off-session, so the
 * browser never sees it. Without this event the deposit path simply vanishes
 * from the funnel and PayPal looks like the only way anyone books.
 * PostHog only.
 */
export function trackPaymentCompleted(props: PaymentCompletedProps): void {
  if (!canTrack()) return;

  PostHog.capture('payment_completed', props);
}

/**
 * Booking is confirmed (PayPal capture completed).
 * Prefer firing this server-side via GA4 Measurement Protocol + PostHog server SDK.
 * This client-side version is a fallback for cases where the confirmation page is reached.
 *
 * PostHog: booking_confirmed | GA4: purchase | Meta: Purchase
 */
export function trackBookingConfirmed(props: BookingConfirmedProps): void {
  if (!canTrack()) return;

  PostHog.capture('booking_confirmed', {
    reservation_id: props.reservation_id,
    property_id: props.property_id,
    property_slug: props.property_slug,
    arrival_date: props.arrival_date,
    departure_date: props.departure_date,
    value: centsToDecimal(props.value_cents),
    currency: props.currency,
    payment_method: props.payment_method,
    language: props.language,
  });

  // eventID is the reservation ID so a server-side Conversions API Purchase for
  // the same booking deduplicates instead of double-counting revenue.
  fbq('Purchase', {
    value: centsToDecimal(props.value_cents),
    currency: props.currency,
    content_ids: [props.property_id],
    content_name: props.property_name,
    content_type: 'property',
    num_items: 1,
    checkin_date: props.arrival_date,
    checkout_date: props.departure_date,
    order_id: props.reservation_id,
  }, metaEventId(props.reservation_id));
}

/**
 * Guest clicks a contact/deposit handoff link.
 * PostHog: manual_deposit_handoff_clicked | GA4: custom | Meta: Lead (optional)
 *
 * NOTE: This replaces the inline captureManualDepositHandoffClick in Booking.page.tsx.
 */
export function trackManualDepositHandoffClicked(props: ManualDepositHandoffClickedProps): void {
  if (!canTrack()) return;

  const eventProps =
    typeof props.analytics_consent === 'boolean'
      ? {
          ...props,
          analytics_consent: props.analytics_consent,
        }
      : props;

  PostHog.capture('manual_deposit_handoff_clicked', eventProps);

  const gtagProps: Record<string, unknown> = {
    event_category: 'booking',
    contact_method: props.contact_method,
    property_id: props.property_id,
    property_slug: props.property_slug,
    language: props.language,
  };

  if (typeof props.analytics_consent === 'boolean') {
    gtagProps.analytics_consent = props.analytics_consent;
  }

  gtag('manual_deposit_handoff_clicked', gtagProps);

  // Meta: Lead is optional per the event map; fire it to capture funnel intent
  fbq('Lead', {
    content_category: 'manual_deposit',
    content_ids: [props.property_id],
  });
}

/**
 * A booking hold is cancelled or expired.
 * PostHog: booking_cancelled | GA4: custom
 */
export function trackBookingCancelled(props: BookingCancelledProps): void {
  if (!canTrack()) return;

  PostHog.capture('booking_cancelled', props);

  gtag('booking_cancelled', {
    event_category: 'booking',
    reason: props.reason,
    property_id: props.property_id ?? null,
    language: props.language,
  });
}
