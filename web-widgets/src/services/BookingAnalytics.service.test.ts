/**
 * BookingAnalytics.service tests
 *
 * Covers task 7.1 acceptance criteria:
 *   - All funnel events fire to PostHog, GA4, and Meta Pixel with correct properties
 *   - Consent gate: no events fire when analytics consent is absent
 *   - Consent gate: events fire when analytics consent is present
 *   - centsToDecimal conversion is applied correctly for GA4/Meta
 *   - manual_deposit_handoff_clicked does NOT fire a purchase/booking_confirmed event
 */

import * as PostHog from './PostHog.service';
import { CookieConsentService } from './CookieConsent.service';
import {
  trackBookingSearch,
  trackAvailabilityResults,
  trackPropertyViewed,
  trackBookingFormViewed,
  trackBookingFormStarted,
  trackCheckoutStarted,
  trackPaymentMethodSelected,
  trackPaymentStarted,
  trackPaypalApproved,
  trackPaymentCompleted,
  trackBookingConfirmed,
  trackManualDepositHandoffClicked,
  trackBookingCancelled,
} from './BookingAnalytics.service';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

/**
 * Mock the PostHog wrapper, not posthog-js. The library is loaded lazily behind
 * PostHog.service now, so a posthog-js mock sees nothing: this file asserted
 * against a module BookingAnalytics no longer imports.
 */
jest.mock('./PostHog.service', () => ({
  capture: jest.fn(),
}));

jest.mock('./CookieConsent.service', () => ({
  CookieConsentService: {
    hasConsent: jest.fn(),
  },
}));

const mockPosthog = { capture: PostHog.capture as jest.Mock };
const mockHasConsent = CookieConsentService.hasConsent as jest.Mock;

let mockGtag: jest.Mock;
let mockFbq: jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();

  mockGtag = jest.fn();
  mockFbq = jest.fn();
  (window as any).gtag = mockGtag;
  (window as any).fbq = mockFbq;
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function grantConsent() {
  mockHasConsent.mockReturnValue(true);
}

function denyConsent() {
  mockHasConsent.mockReturnValue(false);
}

// ---------------------------------------------------------------------------
// Consent gating
// ---------------------------------------------------------------------------

describe('consent gating', () => {
  it('suppresses all events when analytics consent is denied', () => {
    denyConsent();

    trackBookingSearch({ arrival_date: '2026-06-01', departure_date: '2026-06-05', guests: 2, language: 'en' });
    trackAvailabilityResults({ available_count: 3, min_price_cents: 50000, currency: 'USD', arrival_date: '2026-06-01', departure_date: '2026-06-05', guests: 2, language: 'en' });
    trackManualDepositHandoffClicked({ contact_method: 'whatsapp', quote_id: 'q1', property_id: 'p1', property_slug: 'SunsetVilla', language: 'en' });

    expect(mockPosthog.capture).not.toHaveBeenCalled();
    expect(mockGtag).not.toHaveBeenCalled();
    expect(mockFbq).not.toHaveBeenCalled();
  });

  it('fires events when analytics consent is granted', () => {
    grantConsent();

    trackBookingSearch({ arrival_date: '2026-06-01', departure_date: '2026-06-05', guests: 2, language: 'en' });

    expect(mockPosthog.capture).toHaveBeenCalledTimes(1);
    expect(mockFbq).toHaveBeenCalledTimes(1);
    // search is reported to GA4 by the API, not the browser — see the GA4
    // OWNERSHIP note in BookingAnalytics.service.ts.
    expect(mockGtag).not.toHaveBeenCalled();
  });

  it('checks analytics consent for GA4/PostHog and marketing consent for Meta', () => {
    grantConsent();
    trackBookingSearch({ arrival_date: '2026-06-01', departure_date: '2026-06-05', guests: 2, language: 'en' });

    expect(mockHasConsent).toHaveBeenCalledWith('analytics');
    expect(mockHasConsent).toHaveBeenCalledWith('marketing');
  });

  it('suppresses Meta Pixel events when marketing consent is absent', () => {
    mockHasConsent.mockImplementation((category: string) => category === 'analytics');
    trackBookingSearch({ arrival_date: '2026-06-01', departure_date: '2026-06-05', guests: 2, language: 'en' });

    expect(mockPosthog.capture).toHaveBeenCalledTimes(1);
    expect(mockFbq).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// trackBookingSearch
// ---------------------------------------------------------------------------

describe('trackBookingSearch', () => {
  it('fires booking_search to PostHog with all props', () => {
    grantConsent();
    const props = { arrival_date: '2026-06-01', departure_date: '2026-06-05', guests: 2, language: 'en' as const, source: 'booking_page' };

    trackBookingSearch(props);

    expect(mockPosthog.capture).toHaveBeenCalledWith('booking_search', props);
  });

  it('does NOT fire search to GA4 — the API owns that event', () => {
    grantConsent();
    trackBookingSearch({ arrival_date: '2026-06-01', departure_date: '2026-06-05', guests: 2, language: 'en' });

    // The Measurement Protocol cannot deduplicate, so a browser-side search
    // alongside the server's would double-count every one.
    expect(mockGtag).not.toHaveBeenCalledWith('event', 'search', expect.anything());
  });

  it('fires Search to Meta Pixel', () => {
    grantConsent();
    trackBookingSearch({ arrival_date: '2026-06-01', departure_date: '2026-06-05', guests: 2, language: 'en' });

    expect(mockFbq).toHaveBeenCalledWith(
      'track',
      'Search',
      expect.objectContaining({ checkin_date: '2026-06-01', checkout_date: '2026-06-05', num_adults: 2 }),
      undefined,
    );
  });
});

// ---------------------------------------------------------------------------
// trackAvailabilityResults
// ---------------------------------------------------------------------------

describe('trackAvailabilityResults', () => {
  it('fires availability_results to PostHog', () => {
    grantConsent();
    trackAvailabilityResults({ available_count: 0, min_price_cents: null, currency: null, arrival_date: '2026-06-01', departure_date: '2026-06-05', guests: 2, language: 'es' });

    expect(mockPosthog.capture).toHaveBeenCalledWith('availability_results', expect.objectContaining({ available_count: 0 }));
  });

  it('converts cents to decimal for GA4 min_price', () => {
    grantConsent();
    trackAvailabilityResults({ available_count: 1, min_price_cents: 52000, currency: 'USD', arrival_date: '2026-06-01', departure_date: '2026-06-05', guests: 2, language: 'en' });

    expect(mockGtag).toHaveBeenCalledWith('event', 'availability_results', expect.objectContaining({ min_price: 520 }));
  });

  it('passes null min_price to GA4 when no prices available', () => {
    grantConsent();
    trackAvailabilityResults({ available_count: 0, min_price_cents: null, currency: null, arrival_date: '2026-06-01', departure_date: '2026-06-05', guests: 2, language: 'en' });

    expect(mockGtag).toHaveBeenCalledWith('event', 'availability_results', expect.objectContaining({ min_price: null }));
  });

  it('does not fire Meta Pixel event', () => {
    grantConsent();
    trackAvailabilityResults({ available_count: 2, min_price_cents: 10000, currency: 'USD', arrival_date: '2026-06-01', departure_date: '2026-06-05', guests: 2, language: 'en' });

    expect(mockFbq).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// trackCheckoutStarted
// ---------------------------------------------------------------------------

describe('trackCheckoutStarted', () => {
  const props = {
    quote_id: 'q1',
    property_id: 'p1',
    property_slug: 'SunsetVilla',
    property_name: 'Sunset Villa',
    value_cents: 55000,
    currency: 'USD',
    arrival_date: '2026-06-01',
    departure_date: '2026-06-05',
    guests: 2,
    language: 'en' as const,
  };

  it('does NOT fire begin_checkout to GA4 — the API owns that event', () => {
    grantConsent();
    trackCheckoutStarted(props);

    expect(mockGtag).not.toHaveBeenCalledWith('event', 'begin_checkout', expect.anything());
  });

  it('fires InitiateCheckout to Meta Pixel with decimal value', () => {
    grantConsent();
    trackCheckoutStarted(props);

    expect(mockFbq).toHaveBeenCalledWith(
      'track',
      'InitiateCheckout',
      expect.objectContaining({ value: 550, currency: 'USD' }),
      { eventID: props.quote_id },
    );
  });
});

// ---------------------------------------------------------------------------
// trackBookingConfirmed
// ---------------------------------------------------------------------------

describe('trackBookingConfirmed', () => {
  const props = {
    reservation_id: 'R123',
    property_id: 'p1',
    property_slug: 'SunsetVilla',
    property_name: 'Sunset Villa',
    value_cents: 55000,
    currency: 'USD',
    arrival_date: '2026-06-01',
    departure_date: '2026-06-05',
    payment_method: 'paypal' as const,
    language: 'en' as const,
  };

  it('does NOT fire purchase to GA4 — the API owns the sale', () => {
    grantConsent();
    trackBookingConfirmed(props);

    // Reporting the sale server-side is the only way a manual-deposit booking
    // (confirmed by staff, guest long gone) is ever counted.
    expect(mockGtag).not.toHaveBeenCalledWith('event', 'purchase', expect.anything());
  });

  it('fires Purchase to Meta Pixel', () => {
    grantConsent();
    trackBookingConfirmed(props);

    // eventID must equal the reservation ID so a server-side CAPI Purchase dedupes.
    expect(mockFbq).toHaveBeenCalledWith(
      'track',
      'Purchase',
      expect.objectContaining({ value: 550, currency: 'USD', order_id: props.reservation_id }),
      { eventID: props.reservation_id },
    );
  });
});

// ---------------------------------------------------------------------------
// trackManualDepositHandoffClicked — must NOT fire purchase/booking_confirmed
// ---------------------------------------------------------------------------

describe('trackManualDepositHandoffClicked', () => {
  const props = {
    contact_method: 'whatsapp',
    quote_id: 'q1',
    property_id: 'p1',
    property_slug: 'SunsetVilla',
    language: 'es' as const,
  };

  it('fires manual_deposit_handoff_clicked to PostHog', () => {
    grantConsent();
    trackManualDepositHandoffClicked(props);

    expect(mockPosthog.capture).toHaveBeenCalledWith('manual_deposit_handoff_clicked', props);
  });

  it('does NOT fire purchase or booking_confirmed', () => {
    grantConsent();
    trackManualDepositHandoffClicked(props);

    const gtagCalls = mockGtag.mock.calls.map(([, event]) => event);
    expect(gtagCalls).not.toContain('purchase');

    const posthogCalls = (mockPosthog.capture as jest.Mock).mock.calls.map(([event]) => event);
    expect(posthogCalls).not.toContain('booking_confirmed');
  });

  it('fires Lead to Meta Pixel', () => {
    grantConsent();
    trackManualDepositHandoffClicked(props);

    expect(mockFbq).toHaveBeenCalledWith('track', 'Lead', expect.any(Object), undefined);
  });
});

// ---------------------------------------------------------------------------
// trackBookingCancelled
// ---------------------------------------------------------------------------

describe('trackBookingCancelled', () => {
  it('fires booking_cancelled to PostHog with reason', () => {
    grantConsent();
    trackBookingCancelled({ reason: 'hold_expired', language: 'en' });

    expect(mockPosthog.capture).toHaveBeenCalledWith('booking_cancelled', expect.objectContaining({ reason: 'hold_expired' }));
  });

  it('does not fire Meta Pixel event', () => {
    grantConsent();
    trackBookingCancelled({ reason: 'user_cancelled', language: 'en' });

    expect(mockFbq).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// trackPaypalApproved
// ---------------------------------------------------------------------------

describe('trackPaypalApproved', () => {
  it('fires paypal_approved to PostHog and GA4 only', () => {
    grantConsent();
    trackPaypalApproved({ paypal_order_id: 'PP-123', property_id: 'p1', language: 'en' });

    expect(mockPosthog.capture).toHaveBeenCalledWith('paypal_approved', expect.objectContaining({ paypal_order_id: 'PP-123' }));
    expect(mockGtag).toHaveBeenCalledWith('event', 'paypal_approved', expect.any(Object));
    expect(mockFbq).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Funnel-only events
//
// These exist to close the gaps between the GA4/Meta commerce steps, so the
// defining assertion for each is that it reaches PostHog and stops there —
// forwarding them would add unmapped custom events to two products that
// already have their own funnel semantics.
// ---------------------------------------------------------------------------

describe('funnel-only events', () => {
  const formProps = {
    quote_id: 'q1',
    property_id: 'p1',
    property_slug: 'SunsetVilla',
    property_name: 'Sunset Villa',
    payment_type: 'paypal' as const,
    value_cents: 52000,
    currency: 'USD',
    language: 'en' as const,
  };

  it('fires booking_form_viewed to PostHog only', () => {
    grantConsent();
    trackBookingFormViewed(formProps);

    expect(mockPosthog.capture).toHaveBeenCalledWith('booking_form_viewed', formProps);
    expect(mockGtag).not.toHaveBeenCalled();
    expect(mockFbq).not.toHaveBeenCalled();
  });

  it('fires booking_form_started to PostHog only, recording the first field touched', () => {
    grantConsent();
    trackBookingFormStarted({ quote_id: 'q1', property_id: 'p1', property_slug: 'SunsetVilla', payment_type: 'manual_deposit', first_field: 'email', language: 'es' });

    expect(mockPosthog.capture).toHaveBeenCalledWith('booking_form_started', expect.objectContaining({ first_field: 'email' }));
    expect(mockGtag).not.toHaveBeenCalled();
    expect(mockFbq).not.toHaveBeenCalled();
  });

  it('fires payment_started to PostHog only', () => {
    grantConsent();
    trackPaymentStarted({ payment_type: 'paypal', reservation_id: 'res_1', booking_session_id: 'bs_1', property_id: 'p1', value_cents: 52000, currency: 'USD', language: 'en' });

    expect(mockPosthog.capture).toHaveBeenCalledWith('payment_started', expect.objectContaining({ reservation_id: 'res_1', payment_type: 'paypal' }));
    expect(mockGtag).not.toHaveBeenCalled();
    expect(mockFbq).not.toHaveBeenCalled();
  });

  it('distinguishes a captured PayPal payment from an unverified deposit receipt', () => {
    grantConsent();
    trackPaymentCompleted({ payment_type: 'paypal', reservation_id: 'res_1', property_id: 'p1', value_cents: 52000, currency: 'USD', outcome: 'confirmed', language: 'en' });
    trackPaymentCompleted({ payment_type: 'manual_deposit', reservation_id: 'res_2', property_id: 'p2', value_cents: 40000, currency: 'USD', outcome: 'awaiting_verification', language: 'es' });

    expect(mockPosthog.capture).toHaveBeenNthCalledWith(1, 'payment_completed', expect.objectContaining({ outcome: 'confirmed' }));
    expect(mockPosthog.capture).toHaveBeenNthCalledWith(2, 'payment_completed', expect.objectContaining({ outcome: 'awaiting_verification' }));
  });

  it('never reports a deposit receipt upload as revenue', () => {
    grantConsent();
    trackPaymentCompleted({ payment_type: 'manual_deposit', reservation_id: 'res_2', property_id: 'p2', value_cents: 40000, currency: 'USD', outcome: 'awaiting_verification', language: 'en' });

    const gtagEvents = mockGtag.mock.calls.map(([, event]) => event);
    expect(gtagEvents).not.toContain('purchase');
    expect(mockFbq).not.toHaveBeenCalled();
  });

  it('suppresses every funnel-only event without analytics consent', () => {
    denyConsent();
    trackBookingFormViewed(formProps);
    trackBookingFormStarted({ quote_id: 'q1', property_id: 'p1', property_slug: 'SunsetVilla', payment_type: 'paypal', first_field: 'firstName', language: 'en' });
    trackPaymentStarted({ payment_type: 'paypal', reservation_id: 'res_1', booking_session_id: 'bs_1', property_id: 'p1', value_cents: 52000, currency: 'USD', language: 'en' });
    trackPaymentCompleted({ payment_type: 'paypal', reservation_id: 'res_1', property_id: 'p1', value_cents: 52000, currency: 'USD', outcome: 'confirmed', language: 'en' });

    expect(mockPosthog.capture).not.toHaveBeenCalled();
  });
});
