import React from 'react';
import { Alert, Button, Col, Container, Form, Row, Spinner } from 'react-bootstrap';
import { Helmet } from 'react-helmet';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faCalendarDays, faUser, faWifi, faSnowflake, faCar, faKitchenSet, faArrowLeft, faCheck, faPlus, faLocationDot, faBath, faPaw, faSwimmingPool } from '@fortawesome/free-solid-svg-icons';
import { GoogleReCaptchaProvider, useGoogleReCaptcha } from 'react-google-recaptcha-v3';
import { useLanguageDetection } from '../src/hooks/useLanguageDetection';
import { persistPortalSession, savePortalCredentials, readPortalCredentials, removePortalCredentials } from '../src/services/PortalSession.service';
import {
  BookingApiError,
  BookingAvailableProperty,
  BookingPrice,
  DepositHandoffResponse,
  BookingLanguage,
  BookingSearchResponse,
  PayPalCaptureResponse,
  DepositHoldResponse,
  PayPalHoldResponse,
  capturePayPalOrder,
  createDepositHold,
  createPayPalHold,
  createPayPalOrder,
  getDepositHandoff,
  portalLogin,
  recordDepositHandoffEvent,
  searchAvailability,
  uploadDepositReceipt,
} from '../src/services/BookingApi.service';
import {
  trackBookingSearch,
  trackAvailabilityResults,
  trackCheckoutStarted,
  trackBookingConfirmed,
  trackManualDepositHandoffClicked,
  trackPaymentMethodSelected,
  trackPropertyViewed,
  trackBookingFormViewed,
  trackBookingFormStarted,
  trackPaymentStarted,
  trackPaymentCompleted,
  trackPaypalApproved,
} from '../src/services/BookingAnalytics.service';
import { CookieConsentService } from '../src/services/CookieConsent.service';
import { useExchangeRate } from '../src/hooks/useExchangeRate';
import { formatColones, formatExchangeRate } from '../src/utils/money';
import { addDays, getCostaRicaToday } from '../src/utils/dates';
import { PROPERTY_DISPLAY_NAMES, PROPERTY_LOCATIONS } from '../src/utils/constants';
import { bookingStrings, BookingStrings } from './Booking.i18n';
import './Booking.style.scss';

/** Replace with your own site's navigation/header component. */
function SiteHeader(): JSX.Element {
  return (
    <header className="booking-page-header">
      <div className="booking-page-header__inner">Your Site Navigation</div>
    </header>
  );
}

type WizardStep = 'search' | 'results' | 'checkout' | 'deposit' | 'confirmation';

type WarningStringKey =
  | 'warningMinimumStay'
  | 'warningGuestCapacity'
  | 'warningArrivalDay'
  | 'warningLeadTime'
  | 'warningGapRule';

const amenityIcons: Record<string, typeof faWifi> = { ac: faSnowflake, kitchen: faKitchenSet, parking: faCar, wifi: faWifi, bath: faBath, pet: faPaw, pool: faSwimmingPool };

/**
 * Mirrors `isPetFriendly` in the backend catalog: the `pet` amenity is what
 * makes a home pet friendly, so the badge on the card and the pet filter can
 * never disagree.
 */
function isPetFriendly(property: BookingAvailableProperty): boolean {
  return property.amenities.some((amenity) => amenity.code === 'pet');
}

function getPropertyLocation(slug: string, strings: BookingStrings): string {
  return PROPERTY_LOCATIONS[slug] === 'countryside'
    ? strings.locationCountryside
    : strings.locationTownCenter;
}

const warningMessages: Record<string, WarningStringKey> = {
  minimum_stay_not_met: 'warningMinimumStay',
  guest_capacity_exceeded: 'warningGuestCapacity',
  arrival_day_restricted: 'warningArrivalDay',
  lead_time_restricted: 'warningLeadTime',
  gap_rule_restricted: 'warningGapRule',
};

interface PayPalHoldFormState {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  country: string;
  message: string;
  portalPassword: string;
  termsAccepted: boolean;
}

const initialPayPalHoldForm: PayPalHoldFormState = {
  firstName: '', lastName: '', email: '', phone: '', country: '', message: '', portalPassword: '', termsAccepted: false,
};

type DepositReceiptState =
  | { status: 'idle' }
  | { status: 'uploading' }
  | { status: 'uploaded' }
  | { status: 'error'; message: string };

interface StoredPayPalCheckout {
  bookingSessionId: string;
  paypalOrderId: string;
  reservationPublicId?: string;
  /**
   * Carried across the PayPal round trip purely so the paypal_approved event
   * on return can be broken down by home — the return URL has no property in it.
   */
  propertyId?: string;
  language: BookingLanguage;
}

const paypalCheckoutStorageKey = 'booking_paypal_checkout';
const bookingConfirmationStorageKey = 'booking_confirmation';
const bookingConfirmationTrackedPrefix = 'booking_confirmation_tracked_';
const portalAutoLoginKey = 'booking_portal_autologin';

// Step indicator
const WIZARD_STEPS: { key: WizardStep; labelKey: 'stepSearch' | 'stepResults' | 'stepCheckout' | 'stepConfirmation' }[] = [
  { key: 'search', labelKey: 'stepSearch' },
  { key: 'results', labelKey: 'stepResults' },
  { key: 'checkout', labelKey: 'stepCheckout' },
  { key: 'confirmation', labelKey: 'stepConfirmation' },
];

function stepIndex(step: WizardStep): number {
  if (step === 'deposit') return 2;
  return WIZARD_STEPS.findIndex((s) => s.key === step);
}

const StepIndicator = ({ currentStep, strings }: { currentStep: WizardStep; strings: BookingStrings }) => {
  const current = stepIndex(currentStep);
  return (
    <nav className="booking-wizard-steps" aria-label="Booking progress">
      <ol>
        {WIZARD_STEPS.map((s, i) => {
          const isDone = i < current;
          const isActive = i === current;
          return (
            <li key={s.key} className={`booking-wizard-step${isActive ? ' booking-wizard-step--active' : ''}${isDone ? ' booking-wizard-step--done' : ''}`} aria-current={isActive ? 'step' : undefined}>
              <span className="booking-wizard-step__dot">{isDone ? <FontAwesomeIcon icon={faCheck} /> : i + 1}</span>
              <span className="booking-wizard-step__label">{strings[s.labelKey]}</span>
            </li>
          );
        })}
      </ol>
    </nav>
  );
};

const BookingPage = () => {
  const location = useLocation();
  const navigate = useNavigate();
  const detectedSpanishPage = useLanguageDetection();
  const isSpanishPage = detectedSpanishPage || location.pathname.toLowerCase().startsWith('/bookes');
  const language: BookingLanguage = isSpanishPage ? 'es' : 'en';
  const strings = bookingStrings[language];
  const [searchParams, setSearchParams] = useSearchParams();
  const isPayPalReturnRoute = isBookingReturnPath(location.pathname);
  const isConfirmationRoute = isBookingConfirmedPath(location.pathname);
  const paypalReturnAttemptedRef = React.useRef(false);
  const confirmationTrackedRef = React.useRef<string | null>(null);
  // booking_form_started is a once-per-form-opening event; reset whenever a
  // checkout form opens so a guest who backs out and picks another home counts
  // as starting that second form too.
  const formStartTrackedRef = React.useRef(false);
  const paymentStartTrackedRef = React.useRef<string | null>(null);
  const today = React.useMemo(() => getCostaRicaToday(), []);
  const [arrivalDate, setArrivalDate] = React.useState(() => getInitialArrivalDate(searchParams.get('arrivalDate'), today));
  const [departureDate, setDepartureDate] = React.useState(() => getInitialDepartureDate(searchParams.get('departureDate'), searchParams.get('arrivalDate'), today));
  const [guests, setGuests] = React.useState(() => getInitialGuestCount(searchParams.get('guests')));
  // Set when the guest arrived from a listing page. It only promotes that home
  // to the top of the results — the search itself stays portfolio-wide.
  const [featuredSlug] = React.useState(() => sanitiseSlug(searchParams.get('property')));
  const [result, setResult] = React.useState<BookingSearchResponse | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [depositHandoff, setDepositHandoff] = React.useState<DepositHandoffResponse | null>(null);
  const [depositError, setDepositError] = React.useState<string | null>(null);
  const [depositLoadingPropertyId, setDepositLoadingPropertyId] = React.useState<string | null>(null);
  const [depositProperty, setDepositProperty] = React.useState<BookingAvailableProperty | null>(null);
  const [depositHoldResponse, setDepositHoldResponse] = React.useState<DepositHoldResponse | null>(null);
  const [isCreatingDepositHold, setIsCreatingDepositHold] = React.useState(false);
  const [receiptState, setReceiptState] = React.useState<DepositReceiptState>({ status: 'idle' });
  const [checkoutProperty, setCheckoutProperty] = React.useState<BookingAvailableProperty | null>(null);
  const [holdForm, setHoldForm] = React.useState<PayPalHoldFormState>(initialPayPalHoldForm);
  const [holdFieldErrors, setHoldFieldErrors] = React.useState<Record<string, string>>({});
  const [holdError, setHoldError] = React.useState<string | null>(null);
  const [holdResponse, setHoldResponse] = React.useState<PayPalHoldResponse | null>(null);
  const [isCreatingHold, setIsCreatingHold] = React.useState(false);
  const [paypalOrderError, setPayPalOrderError] = React.useState<string | null>(null);
  const [isCreatingPayPalOrder, setIsCreatingPayPalOrder] = React.useState(false);
  const [paypalCaptureResult, setPayPalCaptureResult] = React.useState<PayPalCaptureResponse | null>(null);
  const [paypalCaptureError, setPayPalCaptureError] = React.useState<string | null>(null);
  const [isCapturingPayPal, setIsCapturingPayPal] = React.useState(isPayPalReturnRoute);
  const [bookingConfirmation, setBookingConfirmation] = React.useState<PayPalCaptureResponse | null>(() => isConfirmationRoute ? readBookingConfirmationState() : null);
  const [fieldErrors, setFieldErrors] = React.useState<Record<string, string>>({});
  const [isSubmitting, setIsSubmitting] = React.useState(false);
  const [searchCaptchaRequired, setSearchCaptchaRequired] = React.useState(false);
  const [holdCaptchaRequired, setHoldCaptchaRequired] = React.useState(false);
  const { executeRecaptcha } = useGoogleReCaptcha();
  const [nonRefundable, setNonRefundable] = React.useState(false);
  // Filters the results down to the pet-friendly homes and rides along to the
  // hold so the booking itself records the pet.
  const [withPet, setWithPet] = React.useState(false);
  const minDepartureDate = addDays(arrivalDate || today, 1);

  // Derive wizard step
  const wizardStep: WizardStep = React.useMemo(() => {
    if (isConfirmationRoute || bookingConfirmation) return 'confirmation';
    if (isPayPalReturnRoute) return 'confirmation';
    if (depositProperty) return 'deposit';
    if (checkoutProperty) return 'checkout';
    if (result) return 'results';
    return 'search';
  }, [isConfirmationRoute, bookingConfirmation, isPayPalReturnRoute, depositProperty, checkoutProperty, result]);

  React.useEffect(() => { window.scrollTo({ top: 0, behavior: 'smooth' }); }, [wizardStep]);

  const updateBookingQuery = React.useCallback((updates: Record<string, string | number>) => {
    const nextParams = new URLSearchParams(searchParams.toString());
    Object.entries(updates).forEach(([key, value]) => { nextParams.set(key, String(value)); });
    setSearchParams(nextParams, { replace: true });
  }, [searchParams, setSearchParams]);

  // PayPal return capture
  React.useEffect(() => {
    if (!isPayPalReturnRoute || paypalReturnAttemptedRef.current) return;
    paypalReturnAttemptedRef.current = true;
    const paypalOrderId = searchParams.get('token')?.trim() ?? '';
    const payerId = searchParams.get('PayerID')?.trim() ?? searchParams.get('payerId')?.trim() ?? '';
    const storedCheckout = readPayPalCheckoutState();
    const bookingSessionId = searchParams.get('bookingSessionId')?.trim() || storedCheckout?.bookingSessionId || '';
    const captureLanguage = storedCheckout?.language ?? language;
    if (!paypalOrderId || !payerId || !bookingSessionId) { setIsCapturingPayPal(false); setPayPalCaptureError(strings.paypalReturnMissing); return; }
    // The guest approved at PayPal and came back. Capture can still fail after
    // this, so it is a distinct step from payment_completed — the gap between
    // the two is exactly the set of bookings lost to capture errors.
    trackPaypalApproved({ paypal_order_id: paypalOrderId, property_id: storedCheckout?.propertyId ?? '', language: captureLanguage });
    setIsCapturingPayPal(true); setPayPalCaptureError(null);
    capturePayPalOrder({ bookingSessionId, paypalOrderId, payerId, language: captureLanguage })
      .then((response) => { setPayPalCaptureResult(response); setBookingConfirmation(response); persistBookingConfirmationState(response); clearPayPalCheckoutState(bookingSessionId); navigate(confirmedBookingPath(language), { replace: true }); })
      .catch((captureError) => { setPayPalCaptureError(getPayPalCaptureErrorMessage(captureError, strings)); })
      .finally(() => { setIsCapturingPayPal(false); });
  }, [isPayPalReturnRoute, language, navigate, searchParams, strings]);

  // Confirmation analytics
  React.useEffect(() => {
    if (!isConfirmationRoute) return;
    const confirmation = readBookingConfirmationState();
    setBookingConfirmation(confirmation);
    if (!confirmation) return;
    const reservationId = confirmation.booking.reservationPublicId;
    if (confirmationTrackedRef.current === reservationId || wasBookingConfirmationTracked(reservationId)) return;
    if (!CookieConsentService.hasConsent('analytics')) return;
    maybeTrackBookingConfirmation(confirmation);
    // Separate from maybeTrackBookingConfirmation, which bails out when the
    // capture response is missing property or price metadata. The funnel's last
    // step must not disappear just because the revenue fields did.
    trackPaymentCompleted({
      payment_type: 'paypal',
      reservation_id: reservationId,
      property_id: confirmation.booking.property?.propertyId ?? '',
      value_cents: confirmation.booking.price?.totalAmountCents ?? null,
      currency: confirmation.booking.price?.currency ?? null,
      outcome: 'confirmed',
      language: confirmation.booking.language,
    });
    markBookingConfirmationTracked(reservationId);
    confirmationTrackedRef.current = reservationId;
  }, [isConfirmationRoute]);

  const handleArrivalChange = (value: string) => {
    setArrivalDate(value); setSearchCaptchaRequired(false);
    const updates: Record<string, string> = { arrivalDate: value };
    if (value && departureDate <= value) { const nd = addDays(value, 1); setDepartureDate(nd); updates.departureDate = nd; }
    updateBookingQuery(updates);
  };
  const handleGuestInputChange = (value: number) => { const n = Number.isFinite(value) ? value : 0; setGuests(n); setSearchCaptchaRequired(false); updateBookingQuery({ guests: n }); };
  const handleGuestStepChange = (value: number) => { const n = Math.max(1, value); setGuests(n); setSearchCaptchaRequired(false); updateBookingQuery({ guests: n }); };

  const doSearch = React.useCallback(async (captchaToken?: string, sourceOverride?: string) => {
    setError(null); setDepositError(null); setCheckoutProperty(null); setHoldError(null); setHoldResponse(null); setHoldFieldErrors({}); setPayPalOrderError(null); setSearchCaptchaRequired(false); setIsSubmitting(true);
    const source = sourceOverride ?? 'booking_page';
    try {
      trackBookingSearch({ arrival_date: arrivalDate, departure_date: departureDate, guests, language, source });
      const response = await searchAvailability({ arrivalDate, departureDate, guests, language, source, ...(captchaToken ? { captchaToken } : {}) });
      setResult(response);
      const minPriceCents = response.properties.length > 0 ? Math.min(...response.properties.map((p) => p.price?.totalAmountCents).filter((v): v is number => v != null)) : null;
      const firstCurrency = response.properties.find((p) => p.price?.currency)?.price?.currency ?? null;
      trackAvailabilityResults({ available_count: response.properties.length, min_price_cents: minPriceCents === Infinity ? null : minPriceCents, currency: firstCurrency, arrival_date: arrivalDate, departure_date: departureDate, guests, language });
    } catch (searchError) {
      if (searchError instanceof BookingApiError && searchError.status === 403 && searchError.code === 'captcha_required' && !captchaToken && executeRecaptcha) {
        setSearchCaptchaRequired(true);
        executeRecaptcha('search').then((token) => { setSearchCaptchaRequired(false); void doSearch(token, source); }).catch(() => setError(strings.captchaError));
      } else { setResult(null); setError(getSearchErrorMessage(searchError, strings)); }
    } finally { setIsSubmitting(false); }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [arrivalDate, departureDate, guests, language, strings, executeRecaptcha]);

  // Auto-search when arriving from BookingSearchWidget with autoSearch=true
  const autoSearchFiredRef = React.useRef(false);
  React.useEffect(() => {
    if (autoSearchFiredRef.current) return;
    if (searchParams.get('autoSearch') !== 'true') return;
    if (!arrivalDate || !departureDate) return;
    if (isPayPalReturnRoute || isConfirmationRoute) return;
    autoSearchFiredRef.current = true;
    // Remove autoSearch param so refreshing doesn't re-trigger. `src` goes too:
    // it describes how this one search was launched, and leaving it in the URL
    // would misattribute every later search on this page to the widget.
    const widgetSource = sanitiseSearchSource(searchParams.get('src'));
    const nextParams = new URLSearchParams(searchParams.toString());
    nextParams.delete('autoSearch');
    nextParams.delete('src');
    setSearchParams(nextParams, { replace: true });
    doSearch(undefined, widgetSource);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    const validation = validateSearch(arrivalDate, departureDate, guests, today, strings);
    setFieldErrors(validation);
    if (Object.keys(validation).length > 0) { setResult(null); return; }
    doSearch();
  };

  // Opens the deposit checkout. The old behaviour — fetching contact details and
  // reserving nothing — is gone; the guest now fills in the same form as the
  // PayPal path and gets real dates held.
  const handleStartDepositCheckout = (property: BookingAvailableProperty) => {
    if (!result?.quoteId || !result.bookingSessionId) { setDepositError(strings.checkoutUnavailable); return; }
    setDepositError(null); setCheckoutProperty(null); setHoldError(null); setHoldResponse(null); setPayPalOrderError(null);
    setDepositProperty(property); setDepositHoldResponse(null); setReceiptState({ status: 'idle' });
    setHoldForm(initialPayPalHoldForm); setHoldFieldErrors({});
    if (property.price) { trackPaymentMethodSelected({ quote_id: result.quoteId, property_id: property.propertyId, payment_type: 'manual_deposit', value_cents: property.price.totalAmountCents, currency: property.price.currency, language }); }
    trackManualDepositHandoffClicked({ contact_method: 'deposit_checkout', quote_id: result.quoteId, property_id: property.propertyId, property_slug: property.slug, language });
    formStartTrackedRef.current = false;
    trackBookingFormViewed({ quote_id: result.quoteId, property_id: property.propertyId, property_slug: property.slug, property_name: property.name, payment_type: 'manual_deposit', value_cents: property.price?.totalAmountCents ?? null, currency: property.price?.currency ?? null, language });
  };

  const handleCreateDepositHold = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!result || !depositProperty) { setDepositError(strings.checkoutUnavailable); return; }

    const validation = validatePayPalHoldForm(holdForm, strings);
    setHoldFieldErrors(validation); setDepositError(null);
    if (Object.keys(validation).length > 0) return;

    persistPortalAutoLogin(holdForm.portalPassword);
    setIsCreatingDepositHold(true);
    try {
      const response = await createDepositHold({ quoteId: result.quoteId, bookingSessionId: result.bookingSessionId, propertyId: depositProperty.propertyId, language, guest: { firstName: holdForm.firstName, lastName: holdForm.lastName, email: holdForm.email, phone: holdForm.phone, country: holdForm.country, message: holdForm.message }, portalPassword: holdForm.portalPassword, termsAccepted: holdForm.termsAccepted, ...(withPet ? { withPet: true } : {}) });
      setDepositHoldResponse(response);
      // The booking is not confirmed yet, but the guest will need these to log in
      // once staff verify the transfer.
      if (response.booking?.reservationPublicId) { savePortalCredentials(response.booking.reservationPublicId, holdForm.portalPassword); }
      if (depositProperty.price) { trackCheckoutStarted({ quote_id: result.quoteId, property_id: depositProperty.propertyId, property_slug: depositProperty.slug, property_name: depositProperty.name, value_cents: depositProperty.price.totalAmountCents, currency: depositProperty.price.currency, arrival_date: result.arrivalDate, departure_date: result.departureDate, guests: result.guests, language }); }
      // The hold response renders the bank details, so the guest is now off to
      // their bank — the deposit path's equivalent of the PayPal redirect.
      trackPaymentStarted({ payment_type: 'manual_deposit', reservation_id: response.booking.reservationPublicId, booking_session_id: response.booking.bookingSessionId, property_id: depositProperty.propertyId, value_cents: depositProperty.price?.totalAmountCents ?? null, currency: depositProperty.price?.currency ?? null, language });
    } catch (error) {
      setDepositError(getHoldErrorMessage(error, strings));
    } finally {
      setIsCreatingDepositHold(false);
    }
  };

  const handleUploadReceipt = async (file: File) => {
    if (!depositHoldResponse) return;
    setReceiptState({ status: 'uploading' });
    try {
      await uploadDepositReceipt({ bookingSessionId: depositHoldResponse.booking.bookingSessionId, depositAccessToken: depositHoldResponse.depositAccessToken, file, language });
      setReceiptState({ status: 'uploaded' });
      // As far as the guest is concerned they have paid. Staff verification
      // happens days later and off-session, hence 'awaiting_verification'
      // rather than 'confirmed' — this is funnel completion, not revenue.
      trackPaymentCompleted({ payment_type: 'manual_deposit', reservation_id: depositHoldResponse.booking.reservationPublicId, property_id: depositProperty?.propertyId ?? '', value_cents: depositProperty?.price?.totalAmountCents ?? null, currency: depositProperty?.price?.currency ?? null, outcome: 'awaiting_verification', language });
    } catch (error) {
      setReceiptState({ status: 'error', message: getReceiptErrorMessage(error, strings) });
    }
  };

  const handleStartPayPalHold = (property: BookingAvailableProperty) => {
    if (!result?.quoteId || !result.bookingSessionId) { setHoldError(strings.checkoutUnavailable); return; }
    setDepositError(null); setCheckoutProperty(property); setHoldForm(initialPayPalHoldForm); setHoldFieldErrors({}); setHoldError(null); setHoldResponse(null); setPayPalOrderError(null);
    if (property.price) { trackPaymentMethodSelected({ quote_id: result.quoteId, property_id: property.propertyId, payment_type: 'paypal', value_cents: property.price.totalAmountCents, currency: property.price.currency, language }); }
    formStartTrackedRef.current = false;
    trackBookingFormViewed({ quote_id: result.quoteId, property_id: property.propertyId, property_slug: property.slug, property_name: property.name, payment_type: 'paypal', value_cents: property.price?.totalAmountCents ?? null, currency: property.price?.currency ?? null, language });
  };

  const updateHoldForm = (updates: Partial<PayPalHoldFormState>) => {
    // First keystroke in the form, whichever field it lands in. Both payment
    // paths render the same form, so the property comes from whichever of the
    // two is open.
    const formProperty = checkoutProperty ?? depositProperty;
    if (!formStartTrackedRef.current && result?.quoteId && formProperty) {
      formStartTrackedRef.current = true;
      trackBookingFormStarted({ quote_id: result.quoteId, property_id: formProperty.propertyId, property_slug: formProperty.slug, payment_type: checkoutProperty ? 'paypal' : 'manual_deposit', first_field: Object.keys(updates)[0] ?? 'unknown', language });
    }
    setHoldForm((c) => ({ ...c, ...updates }));
    setHoldFieldErrors((c) => { const n = { ...c }; Object.keys(updates).forEach((k) => { delete n[k]; }); return n; });
  };

  const handleBackToResults = () => { setCheckoutProperty(null); setHoldError(null); setHoldResponse(null); setHoldFieldErrors({}); setPayPalOrderError(null); setHoldCaptchaRequired(false); setDepositError(null); setDepositProperty(null); setDepositHoldResponse(null); setReceiptState({ status: 'idle' }); };
  const handleBackToSearch = () => { setResult(null); setError(null); handleBackToResults(); };

  const handleCreatePayPalHold = async (event: React.FormEvent, captchaTokenOverride?: string) => {
    event.preventDefault();
    if (!result || !checkoutProperty) { setHoldError(strings.checkoutUnavailable); return; }
    const validation = validatePayPalHoldForm(holdForm, strings);
    setHoldFieldErrors(validation); setHoldError(null); setHoldCaptchaRequired(false);
    if (Object.keys(validation).length > 0) return;
    persistPortalAutoLogin(holdForm.portalPassword);
    setIsCreatingHold(true);
    try {
      const response = await createPayPalHold({ quoteId: result.quoteId, bookingSessionId: result.bookingSessionId, propertyId: checkoutProperty.propertyId, language, guest: { firstName: holdForm.firstName, lastName: holdForm.lastName, email: holdForm.email, phone: holdForm.phone, country: holdForm.country, message: holdForm.message }, portalPassword: holdForm.portalPassword, termsAccepted: holdForm.termsAccepted, ...(nonRefundable ? { nonRefundable: true } : {}), ...(withPet ? { withPet: true } : {}), ...(captchaTokenOverride ? { captchaToken: captchaTokenOverride } : {}) });
      setHoldResponse(response); setPayPalOrderError(null);
      // Persist credentials to the durable cache now that we have the reservation ID.
      if (response.booking?.reservationPublicId) { savePortalCredentials(response.booking.reservationPublicId, holdForm.portalPassword); }
      if (checkoutProperty.price) { trackCheckoutStarted({ quote_id: result.quoteId, property_id: checkoutProperty.propertyId, property_slug: checkoutProperty.slug, property_name: checkoutProperty.name, value_cents: checkoutProperty.price.totalAmountCents, currency: checkoutProperty.price.currency, arrival_date: result.arrivalDate, departure_date: result.departureDate, guests: result.guests, language }); }
    } catch (holdCreationError) {
      if (holdCreationError instanceof BookingApiError && holdCreationError.status === 403 && holdCreationError.code === 'captcha_required' && !captchaTokenOverride && executeRecaptcha) {
        setHoldCaptchaRequired(true);
        executeRecaptcha('hold').then((token) => { setHoldCaptchaRequired(false); void handleCreatePayPalHold({ preventDefault: () => {} } as React.FormEvent, token); }).catch(() => setHoldError(strings.captchaError));
      } else { setHoldResponse(null); setHoldError(getHoldErrorMessage(holdCreationError, strings)); }
    } finally { setIsCreatingHold(false); }
  };

  const handleCreatePayPalOrder = async (captchaTokenOverride?: string) => {
    if (!holdResponse) { setPayPalOrderError(strings.paymentNotReady); return; }
    setIsCreatingPayPalOrder(true); setPayPalOrderError(null);
    try {
      const response = await createPayPalOrder({ bookingSessionId: holdResponse.booking.bookingSessionId, language, ...(captchaTokenOverride ? { captchaToken: captchaTokenOverride } : {}) });
      const paypalOrder = response.paypal;
      if (!paypalOrder?.approvalUrl) { setPayPalOrderError(strings.paymentNotReady); return; }
      persistPayPalCheckoutState({ bookingSessionId: holdResponse.booking.bookingSessionId, paypalOrderId: paypalOrder.orderId, reservationPublicId: holdResponse.booking.reservationPublicId, propertyId: checkoutProperty?.propertyId, language });
      // Fire before the redirect, not after — window.location.assign() tears
      // down the page and anything queued behind it is lost. PostHog sends
      // captures with fetch keepalive, so this survives the navigation.
      if (paymentStartTrackedRef.current !== paypalOrder.orderId) {
        paymentStartTrackedRef.current = paypalOrder.orderId;
        trackPaymentStarted({ payment_type: 'paypal', reservation_id: holdResponse.booking.reservationPublicId, booking_session_id: holdResponse.booking.bookingSessionId, property_id: checkoutProperty?.propertyId ?? '', value_cents: checkoutProperty?.price?.totalAmountCents ?? null, currency: checkoutProperty?.price?.currency ?? null, language });
      }
      redirectToUrl(paypalOrder.approvalUrl);
    } catch (orderError) {
      // The backend's paymentCreate policy escalates to a CAPTCHA challenge; mint a
      // token and retry once before surfacing an error.
      if (orderError instanceof BookingApiError && orderError.status === 403 && orderError.code === 'captcha_required' && !captchaTokenOverride && executeRecaptcha) {
        executeRecaptcha('paypal_order').then((token) => { void handleCreatePayPalOrder(token); }).catch(() => setPayPalOrderError(strings.captchaError));
      } else { setPayPalOrderError(getPayPalOrderErrorMessage(orderError, strings)); }
    }
    finally { setIsCreatingPayPalOrder(false); }
  };

  const handleManageBooking = async (reservationPublicId: string) => {
    // Try the durable credential cache first, then fall back to the session-only auto-login.
    const cached = readPortalCredentials(reservationPublicId);
    const storedPassword = cached?.password ?? readPortalAutoLogin();
    const base = language === 'es' ? '/portalES' : '/portal';
    if (!storedPassword) { navigate(`${base}?reservationId=${encodeURIComponent(reservationPublicId)}`); return; }
    try {
      const response = await portalLogin({ reservationPublicId, password: storedPassword, language });
      persistPortalSession(response.token, response.reservationPublicId);
      clearPortalAutoLogin();
      navigate(`${base}/${encodeURIComponent(response.reservationPublicId)}`);
    } catch { removePortalCredentials(reservationPublicId); clearPortalAutoLogin(); navigate(`${base}?reservationId=${encodeURIComponent(reservationPublicId)}`); }
  };

  // PayPal return — transient processing state
  if (isPayPalReturnRoute && !bookingConfirmation) {
    return (
      <div id="body" className="booking-page">
        <Helmet><title>{strings.paypalReturnTitle} | {strings.siteTitle}</title><meta name="description" content={strings.metaDescription} /><link rel="canonical" href={`${window.location.origin}/${language === 'es' ? 'bookES/return' : 'book/return'}`} /></Helmet>
        <SiteHeader />
        <main className="booking-wizard"><Container><Row className="justify-content-center"><Col lg={8} xl={7}>
          <PayPalReturnPanel strings={strings} language={language} isProcessing={isCapturingPayPal} error={paypalCaptureError} result={paypalCaptureResult} />
        </Col></Row></Container></main>
      </div>
    );
  }

  return (
    <div id="body" className="booking-page">
      <Helmet><title>{isConfirmationRoute ? strings.confirmationTitle : strings.documentTitle} | {strings.siteTitle}</title><meta name="description" content={strings.metaDescription} /><link rel="canonical" href={`${window.location.origin}/${language === 'es' ? 'bookES' : 'book'}`} /></Helmet>
      <SiteHeader />
      <main className="booking-wizard">
        <Container>
          <Row className="justify-content-center"><Col lg={10} xl={9}><StepIndicator currentStep={wizardStep} strings={strings} /></Col></Row>
          <div className="booking-wizard-viewport">
            {/* Step 1: Search */}
            <div className={`booking-wizard-slide${wizardStep === 'search' ? ' booking-wizard-slide--active' : ' booking-wizard-slide--left'}`} aria-hidden={wizardStep !== 'search'}>
              <Row className="justify-content-center"><Col lg={10} xl={9}>
                <section className="booking-search-header" aria-labelledby="booking-search-title">
                  <p className="booking-search-eyebrow">{strings.eyebrow}</p>
                  <h1 id="booking-search-title">{strings.title}</h1>
                  <p>{strings.subtitle}</p>
                </section>
                <SearchForm arrivalDate={arrivalDate} departureDate={departureDate} guests={guests} today={today} minDepartureDate={minDepartureDate} fieldErrors={fieldErrors} isSubmitting={isSubmitting} searchCaptchaRequired={searchCaptchaRequired} strings={strings} compact={false} nonRefundable={nonRefundable} onNonRefundableChange={setNonRefundable} withPet={withPet} onWithPetChange={setWithPet} onArrivalChange={handleArrivalChange} onDepartureChange={(v) => { setDepartureDate(v); setSearchCaptchaRequired(false); updateBookingQuery({ departureDate: v }); }} onGuestInputChange={handleGuestInputChange} onGuestStepChange={handleGuestStepChange} onSubmit={handleSubmit} />
                {error && <Alert className="booking-search-alert" variant="danger" role="alert">{error}</Alert>}
              </Col></Row>
            </div>
            {/* Step 2: Results */}
            <div className={`booking-wizard-slide${wizardStep === 'results' ? ' booking-wizard-slide--active' : stepIndex(wizardStep) > stepIndex('results') ? ' booking-wizard-slide--left' : ' booking-wizard-slide--right'}`} aria-hidden={wizardStep !== 'results'}>
              <Row className="justify-content-center"><Col lg={10} xl={9}>
                <SearchForm arrivalDate={arrivalDate} departureDate={departureDate} guests={guests} today={today} minDepartureDate={minDepartureDate} fieldErrors={fieldErrors} isSubmitting={isSubmitting} searchCaptchaRequired={searchCaptchaRequired} strings={strings} compact={true} nonRefundable={nonRefundable} onNonRefundableChange={setNonRefundable} withPet={withPet} onWithPetChange={setWithPet} onArrivalChange={handleArrivalChange} onDepartureChange={(v) => { setDepartureDate(v); setSearchCaptchaRequired(false); updateBookingQuery({ departureDate: v }); }} onGuestInputChange={handleGuestInputChange} onGuestStepChange={handleGuestStepChange} onSubmit={handleSubmit} onBack={handleBackToSearch} />
                {error && <Alert className="booking-search-alert" variant="danger" role="alert">{error}</Alert>}
                {depositError && <Alert className="booking-search-alert" variant="danger" role="alert">{depositError}</Alert>}
                {result && <BookingSearchResults result={result} strings={strings} language={language} nonRefundable={nonRefundable} withPet={withPet} onManualDepositHandoff={handleStartDepositCheckout} onStartPayPalHold={handleStartPayPalHold} selectedPropertyId={checkoutProperty?.propertyId ?? null} featuredSlug={featuredSlug} />}
              </Col></Row>
            </div>
            {/* Step 3: Checkout / Deposit */}
            <div className={`booking-wizard-slide${wizardStep === 'checkout' || wizardStep === 'deposit' ? ' booking-wizard-slide--active' : stepIndex(wizardStep) > 2 ? ' booking-wizard-slide--left' : ' booking-wizard-slide--right'}`} aria-hidden={wizardStep !== 'checkout' && wizardStep !== 'deposit'}>
              <Row className="justify-content-center"><Col lg={8} xl={7}>
                {result && depositProperty && <DepositCheckoutPanel result={result} property={depositProperty} strings={strings} language={language} withPet={withPet} form={holdForm} fieldErrors={holdFieldErrors} holdError={depositError} holdResponse={depositHoldResponse} isCreatingHold={isCreatingDepositHold} receiptState={receiptState} onChange={updateHoldForm} onSubmit={handleCreateDepositHold} onUploadReceipt={handleUploadReceipt} onBack={handleBackToResults} />}
                {result && checkoutProperty && <PayPalCheckoutPanel result={result} property={checkoutProperty} strings={strings} language={language} withPet={withPet} nonRefundable={nonRefundable} form={holdForm} fieldErrors={holdFieldErrors} holdError={holdError} holdResponse={holdResponse} paypalOrderError={paypalOrderError} isCreatingHold={isCreatingHold} isCreatingPayPalOrder={isCreatingPayPalOrder} onChange={updateHoldForm} onSubmit={handleCreatePayPalHold} onCreatePayPalOrder={handleCreatePayPalOrder} holdCaptchaRequired={holdCaptchaRequired} onBack={handleBackToResults} />}
              </Col></Row>
            </div>
            {/* Step 4: Confirmation */}
            <div className={`booking-wizard-slide${wizardStep === 'confirmation' ? ' booking-wizard-slide--active' : ' booking-wizard-slide--right'}`} aria-hidden={wizardStep !== 'confirmation'}>
              <Row className="justify-content-center"><Col lg={8} xl={7}>
                <BookingConfirmationPanel result={bookingConfirmation} strings={strings} language={language} onManageBooking={handleManageBooking} />
              </Col></Row>
            </div>
          </div>
        </Container>
      </main>
    </div>
  );
};

// SearchForm — full or compact
interface SearchFormProps {
  arrivalDate: string; departureDate: string; guests: number; today: string; minDepartureDate: string;
  fieldErrors: Record<string, string>; isSubmitting: boolean; searchCaptchaRequired: boolean;
  strings: BookingStrings; compact: boolean;
  nonRefundable: boolean; onNonRefundableChange: (value: boolean) => void;
  withPet: boolean; onWithPetChange: (value: boolean) => void;
  onArrivalChange: (value: string) => void; onDepartureChange: (value: string) => void;
  onGuestInputChange: (value: number) => void; onGuestStepChange: (value: number) => void;
  onSubmit: (event: React.FormEvent) => void; onBack?: () => void;
}

const SearchForm = ({ arrivalDate, departureDate, guests, today, minDepartureDate, fieldErrors, isSubmitting, searchCaptchaRequired, strings, compact, nonRefundable, onNonRefundableChange, withPet, onWithPetChange, onArrivalChange, onDepartureChange, onGuestInputChange, onGuestStepChange, onSubmit, onBack }: SearchFormProps) => {
  if (compact) {
    return (
      <div className="booking-search-compact">
        <div className="booking-search-compact__top">
          {onBack && <button type="button" className="booking-search-compact__back" onClick={onBack} aria-label={strings.changeSearch}><FontAwesomeIcon icon={faArrowLeft} /></button>}
          <Form className="booking-search-compact__form" onSubmit={onSubmit} noValidate>
            <div className="booking-search-compact__fields">
              <Form.Group controlId="bookingArrivalDateCompact" className="booking-search-compact__field">
                <Form.Label className="visually-hidden">{strings.checkIn}</Form.Label>
                <Form.Control type="date" value={arrivalDate} min={today} isInvalid={Boolean(fieldErrors.arrivalDate)} onChange={(e) => onArrivalChange(e.target.value)} />
              </Form.Group>
              <Form.Group controlId="bookingDepartureDateCompact" className="booking-search-compact__field">
                <Form.Label className="visually-hidden">{strings.checkOut}</Form.Label>
                <Form.Control type="date" value={departureDate} min={minDepartureDate} isInvalid={Boolean(fieldErrors.departureDate)} onChange={(e) => onDepartureChange(e.target.value)} />
              </Form.Group>
              <Form.Group controlId="bookingGuestCountCompact" className="booking-search-compact__field booking-search-compact__field--guests">
                <Form.Label className="visually-hidden">{strings.guests}</Form.Label>
                <div className="booking-search-compact__guest-control">
                  <Button type="button" variant="outline-secondary" size="sm" aria-label={strings.decreaseGuests} onClick={() => onGuestStepChange(guests - 1)} disabled={guests <= 1}>-</Button>
                  <span className="booking-search-compact__guest-count"><FontAwesomeIcon icon={faUser} /> {guests}</span>
                  <Button type="button" variant="outline-secondary" size="sm" aria-label={strings.increaseGuests} onClick={() => onGuestStepChange(guests + 1)}>+</Button>
                </div>
              </Form.Group>
              <Button className="booking-search-compact__submit" type="submit" disabled={isSubmitting}>
                {isSubmitting ? <Spinner animation="border" size="sm" /> : <FontAwesomeIcon icon={faCalendarDays} />}
                <span className="visually-hidden">{strings.search}</span>
              </Button>
            </div>
          </Form>
        </div>
        <div className="booking-search-compact__rate-row">
          <Form.Check type="switch" id="rateToggleCompact" className="booking-rate-toggle" label={nonRefundable ? strings.rateNonRefundable : strings.rateFlexible} checked={nonRefundable} onChange={(e) => onNonRefundableChange(e.target.checked)} />
          {nonRefundable && <span className="booking-rate-toggle__badge">{strings.nonRefundableSave}</span>}
          <Form.Check type="switch" id="petToggleCompact" className="booking-rate-toggle booking-pet-toggle" label={<><FontAwesomeIcon icon={faPaw} /> {strings.petToggle}</>} checked={withPet} onChange={(e) => onWithPetChange(e.target.checked)} />
          {withPet && <span className="booking-rate-toggle__badge">{strings.petToggleBadge}</span>}
        </div>
        {searchCaptchaRequired && <div className="booking-captcha-widget" aria-live="polite"><Spinner animation="border" size="sm" /> {strings.searching}</div>}
      </div>
    );
  }

  return (
    <>
      <Form className="booking-search-form" onSubmit={onSubmit} noValidate>
        <Row className="g-3 align-items-end">
          <Col md={3}><Form.Group controlId="bookingArrivalDate"><Form.Label>{strings.checkIn}</Form.Label><Form.Control type="date" value={arrivalDate} min={today} isInvalid={Boolean(fieldErrors.arrivalDate)} onChange={(e) => onArrivalChange(e.target.value)} /><Form.Control.Feedback type="invalid">{fieldErrors.arrivalDate}</Form.Control.Feedback></Form.Group></Col>
          <Col md={3}><Form.Group controlId="bookingDepartureDate"><Form.Label>{strings.checkOut}</Form.Label><Form.Control type="date" value={departureDate} min={minDepartureDate} isInvalid={Boolean(fieldErrors.departureDate)} onChange={(e) => onDepartureChange(e.target.value)} /><Form.Control.Feedback type="invalid">{fieldErrors.departureDate}</Form.Control.Feedback></Form.Group></Col>
          <Col md={3}>
            <Form.Group controlId="bookingGuestCount">
              <Form.Label>{strings.guests}</Form.Label>
              <div className="booking-guest-control">
                <Button type="button" variant="outline-secondary" aria-label={strings.decreaseGuests} onClick={() => onGuestStepChange(guests - 1)} disabled={guests <= 1}>-</Button>
                <Form.Control type="number" value={guests} min={1} inputMode="numeric" isInvalid={Boolean(fieldErrors.guests)} onChange={(e) => onGuestInputChange(Number(e.target.value))} />
                <Button type="button" variant="outline-secondary" aria-label={strings.increaseGuests} onClick={() => onGuestStepChange(guests + 1)}>+</Button>
              </div>
              <Form.Text>{strings.guestsHelp}</Form.Text>
              {fieldErrors.guests && <div className="booking-field-error">{fieldErrors.guests}</div>}
            </Form.Group>
          </Col>
          <Col md={3}>
            <Button className="booking-search-submit" type="submit" disabled={isSubmitting}>
              {isSubmitting ? <><Spinner animation="border" size="sm" /> {strings.searching}</> : <><FontAwesomeIcon icon={faCalendarDays} /> {strings.search}</>}
            </Button>
          </Col>
        </Row>
        <div className="booking-rate-toggle-row">
          <Form.Check type="switch" id="rateToggleFull" className="booking-rate-toggle" label={nonRefundable ? strings.rateNonRefundable : strings.rateFlexible} checked={nonRefundable} onChange={(e) => onNonRefundableChange(e.target.checked)} />
          {nonRefundable && <span className="booking-rate-toggle__badge">{strings.nonRefundableSave}</span>}
          <small className="booking-rate-toggle__note">{nonRefundable ? strings.nonRefundableNote : strings.flexibleNote}</small>
        </div>
        <div className="booking-rate-toggle-row">
          <Form.Check type="switch" id="petToggleFull" className="booking-rate-toggle booking-pet-toggle" label={<><FontAwesomeIcon icon={faPaw} /> {strings.petToggle}</>} checked={withPet} onChange={(e) => onWithPetChange(e.target.checked)} />
          {withPet && <span className="booking-rate-toggle__badge">{strings.petToggleBadge}</span>}
          {withPet && <small className="booking-rate-toggle__note">{strings.petToggleNote}</small>}
        </div>
      </Form>
      {searchCaptchaRequired && <div className="booking-captcha-widget" aria-live="polite"><Spinner animation="border" size="sm" /> {strings.searching}</div>}
    </>
  );
};

// BookingSearchResults
const BookingSearchResults = ({ result, strings, language, nonRefundable, withPet, onManualDepositHandoff, onStartPayPalHold, selectedPropertyId, featuredSlug }: { result: BookingSearchResponse; strings: BookingStrings; language: BookingLanguage; nonRefundable: boolean; withPet: boolean; onManualDepositHandoff: (p: BookingAvailableProperty) => void; onStartPayPalHold: (p: BookingAvailableProperty) => void; selectedPropertyId: string | null; featuredSlug: string | null }) => {
  // Filtering here rather than in the search request keeps the toggle instant on
  // this step: flipping it re-renders the same quote instead of spending another
  // search. The hold route re-checks the home server-side before anything is
  // reserved.
  const properties = withPet ? result.properties.filter(isPetFriendly) : result.properties;
  const hiddenByPetFilter = result.properties.length - properties.length;
  const hasResults = properties.length > 0;
  const warnings = result.availabilityWarnings.map((w) => warningMessages[w.code]).filter((k): k is WarningStringKey => Boolean(k));

  // A guest who searched from a listing page came here for that home. Lift it
  // out of the grid and lead with it; the portfolio-wide alternatives still
  // follow underneath so a taken home never dead-ends the search.
  const featured = featuredSlug ? properties.find((p) => p.slug.toLowerCase() === featuredSlug.toLowerCase()) ?? null : null;
  const others = featured ? properties.filter((p) => p.propertyId !== featured.propertyId) : properties;
  const featuredMissing = Boolean(featuredSlug) && !featured;
  const featuredName = featuredSlug ? displayNameForSlug(featuredSlug, result.properties) : '';
  // The home is free — it just does not take pets. Saying "not available" there
  // would send the guest hunting for other dates that would not help.
  const featuredHiddenByPetFilter =
    featuredMissing && withPet && result.properties.some((p) => p.slug.toLowerCase() === featuredSlug?.toLowerCase());

  if (!hasResults) {
    // A pet search that filtered everything out is a different dead end from no
    // availability at all, and it has a different way out.
    if (withPet && hiddenByPetFilter > 0) {
      return (
        <section className="booking-results-empty" aria-live="polite">
          <h2>{strings.petFilterEmptyTitle}</h2>
          <p>{strings.petFilterEmptyBody}</p>
        </section>
      );
    }

    return (<section className="booking-results-empty" aria-live="polite"><h2>{strings.noResultsTitle}</h2><p>{strings.noResultsBody}</p><WarningList warnings={warnings} strings={strings} /></section>);
  }
  return (
    <section className="booking-results" aria-live="polite" aria-labelledby="booking-results-title">
      <div className="booking-results-summary"><div><p className="booking-results-kicker">{strings.resultCount(properties.length)}</p><h2 id="booking-results-title">{strings.resultsTitle}</h2>{withPet && hiddenByPetFilter > 0 && <p className="booking-results-pet-note"><FontAwesomeIcon icon={faPaw} /> {strings.petFilterHidden(hiddenByPetFilter)}</p>}</div><p className="booking-quote-expiry">{strings.quoteExpires}: {formatDateTime(result.quoteExpiresAt, language)}</p></div>

      {featured && (
        <div className="booking-results-featured">
          <h3 className="booking-results-section-title">{strings.featuredTitle}</h3>
          <Row className="booking-results-grid g-4">
            <Col className="booking-results-col" md={8} xl={6}>
              <BookingPropertyCard property={featured} strings={strings} language={language} nonRefundable={nonRefundable} onManualDepositHandoff={onManualDepositHandoff} onStartPayPalHold={onStartPayPalHold} isSelectedForCheckout={selectedPropertyId === featured.propertyId} isFeatured />
            </Col>
          </Row>
        </div>
      )}

      {featuredMissing && (
        <div className="booking-results-featured-missing" role="status">
          <p className="booking-results-featured-missing__title">{featuredHiddenByPetFilter ? strings.featuredNotPetFriendly(featuredName) : strings.featuredUnavailable(featuredName)}</p>
          <p className="booking-results-featured-missing__body">{featuredHiddenByPetFilter ? strings.featuredNotPetFriendlyBody : strings.featuredUnavailableBody}</p>
        </div>
      )}

      {others.length > 0 && (
        <>
          {(featured || featuredMissing) && (
            <div className="booking-results-section">
              <h3 className="booking-results-section-title">{strings.otherHomesTitle}</h3>
              <p className="booking-results-section-count">{strings.otherHomesCount(others.length)}</p>
            </div>
          )}
          <Row className="booking-results-grid g-4">
            {others.map((property) => (<Col className="booking-results-col" key={property.propertyId} md={6} xl={4}><BookingPropertyCard property={property} strings={strings} language={language} nonRefundable={nonRefundable} onManualDepositHandoff={onManualDepositHandoff} onStartPayPalHold={onStartPayPalHold} isSelectedForCheckout={selectedPropertyId === property.propertyId} /></Col>))}
          </Row>
        </>
      )}

      <ColonesEstimateNote strings={strings} language={language} />

      {/* Homes filtered out by Smoobu are explained after the available ones, so
          a restriction on a home the guest cannot book never overshadows the
          homes they can. */}
      <WarningList warnings={warnings} strings={strings} title={strings.excludedHomesTitle} />
    </section>
  );
};

/**
 * The `src` param is attacker-controllable and lands in an analytics property,
 * so it is an allowlist rather than a format check — anything else would let a
 * crafted link mint unlimited distinct values and wreck the funnel breakdown.
 */
const WIDGET_SEARCH_SOURCES = ['widget_hero', 'widget_sidebar'] as const;

function sanitiseSearchSource(value: string | null): string | undefined {
  const trimmed = value?.trim() ?? '';
  return (WIDGET_SEARCH_SOURCES as readonly string[]).includes(trimmed) ? trimmed : undefined;
}

/** Slugs come from the URL, so they are constrained to the shape our routes use. */
function sanitiseSlug(value: string | null): string | null {
  const trimmed = value?.trim() ?? '';
  return /^[A-Za-z]{2,24}$/.test(trimmed) ? trimmed : null;
}

/**
 * Prefers the name the server sent. A home that is taken never appears in the
 * results, so its name comes from the local catalog mirror instead of leaking
 * the bare route slug into a sentence shown to the guest.
 */
function displayNameForSlug(slug: string, properties: BookingAvailableProperty[]): string {
  const fromResults = properties.find((p) => p.slug.toLowerCase() === slug.toLowerCase())?.name;
  if (fromResults) return fromResults;

  const key = Object.keys(PROPERTY_DISPLAY_NAMES).find((k) => k.toLowerCase() === slug.toLowerCase());
  return key ? PROPERTY_DISPLAY_NAMES[key] : slug;
}

/** With a `title` the list reads as a footnote under the results; without one it
 *  carries the empty-state explanation on its own. */
const WarningList = ({ warnings, strings, title }: { warnings: WarningStringKey[]; strings: BookingStrings; title?: string }) => {
  if (warnings.length === 0) return null;
  const items = <ul className="booking-warning-list">{Array.from(new Set(warnings)).map((w) => <li key={w}>{strings[w]}</li>)}</ul>;
  if (!title) return items;
  return (
    <aside className="booking-excluded-note">
      <h3 className="booking-excluded-note__title">{title}</h3>
      {items}
    </aside>
  );
};

// BookingPropertyCard
const BookingPropertyCard = ({ property, strings, language, nonRefundable, onManualDepositHandoff, onStartPayPalHold, isSelectedForCheckout, isFeatured = false }: { property: BookingAvailableProperty; strings: BookingStrings; language: BookingLanguage; nonRefundable: boolean; onManualDepositHandoff: (p: BookingAvailableProperty) => void; onStartPayPalHold: (p: BookingAvailableProperty) => void; isSelectedForCheckout: boolean; isFeatured?: boolean }) => {
  const listingUrl = buildListingUrl(property.slug, language);
  const titleId = `booking-result-title-${property.propertyId}`;
  const canCreatePayPalHold = property.actions?.canCreatePayPalHold !== false;
  const canUseManualDeposit = property.actions?.canUseManualDepositHandoff !== false;
  const [amenitiesExpanded, setAmenitiesExpanded] = React.useState(false);
  const visibleAmenities = property.amenities.slice(0, 5);
  // The listing opens in a new tab, so the listing page itself never gets a
  // chance to report the view back to this session — fire view_item / ViewContent
  // from the click instead.
  const handleListingOpen = () => {
    trackPropertyViewed({
      property_id: property.propertyId,
      property_slug: property.slug,
      property_name: property.name,
      price_cents: property.price?.totalAmountCents ?? null,
      currency: property.price?.currency ?? null,
      language,
    });
  };
  return (
    <article className={`booking-result-card${isFeatured ? ' booking-result-card--featured' : ''}`} aria-labelledby={titleId}>
      <div className="booking-result-card__media-frame">
        <a className="booking-result-card__media" href={listingUrl} target="_blank" rel="noopener noreferrer" onClick={handleListingOpen} aria-label={`${strings.viewListing}: ${property.name}`}>
          <img src={property.thumbnailUrl} alt={property.name} />
          <span className="booking-result-card__media-hover" aria-hidden="true">{strings.viewListing}</span>
        </a>
        <span className="booking-result-card__status">{strings.available}</span>
      </div>
      <div className="booking-result-card__content">
        <h3 className="booking-result-card__content-title" id={titleId}>{property.name}</h3>
        <p className="booking-result-card__location"><FontAwesomeIcon icon={faLocationDot} /> {getPropertyLocation(property.slug, strings)}</p>
        <div className="booking-result-card__heading"><p className="booking-result-card__guest-badge"><FontAwesomeIcon icon={faUser} /> {strings.sleeps(property.guestCapacity)}</p></div>
        <ul className={`booking-result-card__amenities${amenitiesExpanded ? ' booking-result-card__amenities--expanded' : ''}`} aria-label={strings.amenitiesLabel(property.name)}>
          {visibleAmenities.map((a) => (
            <li key={`${property.propertyId}-${a.code}`} title={a.label}>
              <FontAwesomeIcon icon={amenityIcons[a.code] ?? faWifi} />
              <span>{a.label}</span>
            </li>
          ))}
          <li className="booking-result-card__amenities-toggle">
            <button type="button" aria-expanded={amenitiesExpanded} aria-label={amenitiesExpanded ? strings.amenitiesLabel(property.name) : strings.amenitiesLabel(property.name)} onClick={() => setAmenitiesExpanded((v) => !v)}>
              <FontAwesomeIcon icon={faPlus} />
            </button>
          </li>
        </ul>
        {property.price && <PropertyPrice price={property.price} strings={strings} language={language} nonRefundable={nonRefundable} />}
        <a className="booking-result-card__link" href={listingUrl} target="_blank" rel="noopener noreferrer" onClick={handleListingOpen}>{strings.viewListing}</a>
        {canCreatePayPalHold && <Button className="booking-result-card__book-button" type="button" variant="primary" aria-pressed={isSelectedForCheckout} onClick={() => onStartPayPalHold(property)}>{strings.bookNow}</Button>}
        {canUseManualDeposit && <Button className="booking-result-card__deposit-button" type="button" variant="outline-secondary" onClick={() => onManualDepositHandoff(property)}>{strings.manualDepositButton}</Button>}
      </div>
    </article>
  );
};

/**
 * Guest details form shared by the PayPal and deposit checkouts. Both collect
 * exactly the same information — the difference is only what happens after
 * submit — so the fields live in one place.
 *
 * `idPrefix` keeps control ids unique when more than one instance is mounted.
 */
const GuestDetailsFields = ({ idPrefix, form, fieldErrors, strings, onChange }: { idPrefix: string; form: PayPalHoldFormState; fieldErrors: Record<string, string>; strings: BookingStrings; onChange: (u: Partial<PayPalHoldFormState>) => void }) => (
  <Row className="g-3">
    <Col md={6}><Form.Group controlId={`${idPrefix}FirstName`}><Form.Label>{strings.firstName}</Form.Label><Form.Control value={form.firstName} isInvalid={Boolean(fieldErrors.firstName)} onChange={(e) => onChange({ firstName: e.target.value })} /><Form.Control.Feedback type="invalid">{fieldErrors.firstName}</Form.Control.Feedback></Form.Group></Col>
    <Col md={6}><Form.Group controlId={`${idPrefix}LastName`}><Form.Label>{strings.lastName}</Form.Label><Form.Control value={form.lastName} isInvalid={Boolean(fieldErrors.lastName)} onChange={(e) => onChange({ lastName: e.target.value })} /><Form.Control.Feedback type="invalid">{fieldErrors.lastName}</Form.Control.Feedback></Form.Group></Col>
    <Col md={6}><Form.Group controlId={`${idPrefix}Email`}><Form.Label>{strings.email}</Form.Label><Form.Control type="email" value={form.email} isInvalid={Boolean(fieldErrors.email)} onChange={(e) => onChange({ email: e.target.value })} /><Form.Control.Feedback type="invalid">{fieldErrors.email}</Form.Control.Feedback></Form.Group></Col>
    <Col md={6}><Form.Group controlId={`${idPrefix}Phone`}><Form.Label>{strings.phone}</Form.Label><Form.Control value={form.phone} onChange={(e) => onChange({ phone: e.target.value })} /></Form.Group></Col>
    <Col md={6}><Form.Group controlId={`${idPrefix}Country`}><Form.Label>{strings.country}</Form.Label><Form.Control value={form.country} onChange={(e) => onChange({ country: e.target.value })} /></Form.Group></Col>
    <Col md={6}><Form.Group controlId={`${idPrefix}PortalPassword`}><Form.Label>{strings.portalPassword}</Form.Label><Form.Control type="password" autoComplete="new-password" value={form.portalPassword} isInvalid={Boolean(fieldErrors.portalPassword)} onChange={(e) => onChange({ portalPassword: e.target.value })} /><Form.Text>{strings.portalPasswordHelp}</Form.Text><Form.Control.Feedback type="invalid">{fieldErrors.portalPassword}</Form.Control.Feedback></Form.Group></Col>
    <Col xs={12}><Form.Group controlId={`${idPrefix}Message`}><Form.Label>{strings.specialRequests}</Form.Label><Form.Control as="textarea" rows={3} value={form.message} onChange={(e) => onChange({ message: e.target.value })} /></Form.Group></Col>
    <Col xs={12}><Form.Check id={`${idPrefix}TermsAccepted`} label={strings.termsAccepted} checked={form.termsAccepted} isInvalid={Boolean(fieldErrors.termsAccepted)} feedback={fieldErrors.termsAccepted} feedbackType="invalid" onChange={(e) => onChange({ termsAccepted: e.target.checked })} /></Col>
  </Row>
);

// PayPalCheckoutPanel
const PayPalCheckoutPanel = ({ result, property, strings, language, withPet, nonRefundable, form, fieldErrors, holdError, holdResponse, paypalOrderError, isCreatingHold, isCreatingPayPalOrder, onChange, onSubmit, onCreatePayPalOrder, holdCaptchaRequired, onBack }: { result: BookingSearchResponse; property: BookingAvailableProperty; strings: BookingStrings; language: BookingLanguage; withPet: boolean; nonRefundable: boolean; form: PayPalHoldFormState; fieldErrors: Record<string, string>; holdError: string | null; holdResponse: PayPalHoldResponse | null; paypalOrderError: string | null; isCreatingHold: boolean; isCreatingPayPalOrder: boolean; onChange: (u: Partial<PayPalHoldFormState>) => void; onSubmit: (e: React.FormEvent) => void; onCreatePayPalOrder: () => void; holdCaptchaRequired: boolean; onBack: () => void }) => {
  const price = property.price ?? holdResponse?.booking.price;
  return (
    <section className="booking-checkout-panel" aria-labelledby="booking-checkout-title">
      <Button type="button" variant="link" className="booking-wizard-back" onClick={onBack}><FontAwesomeIcon icon={faArrowLeft} /> {strings.backToResults}</Button>
      <div className="booking-checkout-panel__header"><p className="booking-results-kicker">{strings.paypalTitle}</p><h2 id="booking-checkout-title">{strings.checkoutTitle}</h2><p>{strings.paypalDescription}</p></div>
      <div className="booking-checkout-panel__summary" aria-label={strings.checkoutSummary}>
        <div><span>{strings.depositContextTitle}</span><strong>{property.name}</strong><small>{strings.depositDates(formatDate(result.arrivalDate, language), formatDate(result.departureDate, language))}</small></div>
        {price && <CheckoutPrice price={price} strings={strings} language={language} nonRefundablePreview={nonRefundable && !holdResponse} finalOverrideCents={holdResponse?.booking.price?.totalAmountCents} />}
        {withPet && <div><span>{strings.petSummaryLabel}</span><strong><FontAwesomeIcon icon={faPaw} /> {strings.petSummaryValue}</strong></div>}
      </div>
      <ColonesEstimateNote strings={strings} language={language} />
      {holdError && <Alert className="booking-search-alert" variant="danger" role="alert">{holdError}</Alert>}
      {holdResponse ? (
        <div className="booking-checkout-panel__hold" aria-live="polite">
          <h3>{strings.holdActiveTitle}</h3><p>{strings.holdActiveBody}</p>
          <div className="booking-checkout-panel__timer"><span>{strings.holdExpiring}</span><HoldCountdown expiresAt={holdResponse.booking.hold.expiresAt} /><small>{strings.holdExpiresAt(formatDateTime(holdResponse.booking.hold.expiresAt, language))}</small></div>
          <p className="booking-checkout-panel__reservation">{strings.reservationId}: <strong>{holdResponse.booking.reservationPublicId}</strong></p>
          {paypalOrderError && <Alert className="booking-checkout-panel__notice" variant="danger" role="alert">{paypalOrderError}</Alert>}
          <div className="booking-checkout-panel__actions"><Button className="booking-search-submit" type="button" disabled={isCreatingPayPalOrder} onClick={() => onCreatePayPalOrder()}>{isCreatingPayPalOrder ? <><Spinner animation="border" size="sm" /> {strings.creatingPayPalOrder}</> : strings.continueToPayment}</Button></div>
        </div>
      ) : (
        <Form className="booking-checkout-panel__form" onSubmit={onSubmit} noValidate>
          <h3>{strings.guestDetails}</h3>
          <GuestDetailsFields idPrefix="paypalHold" form={form} fieldErrors={fieldErrors} strings={strings} onChange={onChange} />
          {holdCaptchaRequired && <div className="booking-captcha-widget" aria-live="polite"><Spinner animation="border" size="sm" /> {strings.searching}</div>}
          <div className="booking-checkout-panel__actions"><Button type="submit" className="booking-search-submit" disabled={isCreatingHold || holdCaptchaRequired}>{isCreatingHold ? <><Spinner animation="border" size="sm" /> {strings.creatingHold}</> : strings.continueToPayment}</Button></div>
        </Form>
      )}
      <div className="booking-checkout-panel__contacts">
        <h3>{strings.needHelp}</h3>
        <div className="booking-checkout-panel__contacts-grid">
          <a className="booking-checkout-panel__contact" href="https://wa.me/contact" target="_blank" rel="noopener noreferrer"><span>{strings.contactByWhatsapp}</span><strong>https://wa.me/contact</strong></a>
          <a className="booking-checkout-panel__contact" href="mailto:reservations@example.com"><span>{strings.contactByEmail}</span><strong>reservations@example.com</strong></a>
        </div>
      </div>
    </section>
  );
};

const HoldCountdown = ({ expiresAt }: { expiresAt: string }) => {
  const [nowMs, setNowMs] = React.useState(() => Date.now());
  const expiresAtMs = Date.parse(expiresAt);
  React.useEffect(() => { const id = window.setInterval(() => setNowMs(Date.now()), 1000); return () => window.clearInterval(id); }, []);
  return <strong>{formatDuration(Number.isFinite(expiresAtMs) ? expiresAtMs - nowMs : 0)}</strong>;
};

const PayPalReturnPanel = ({ strings, language, isProcessing, error, result }: { strings: BookingStrings; language: BookingLanguage; isProcessing: boolean; error: string | null; result: PayPalCaptureResponse | null }) => {
  const propertyName = result?.booking.property?.name;
  return (
    <section className="booking-return-panel" aria-labelledby="booking-return-title" aria-live="polite">
      <p className="booking-results-kicker">{strings.paypalTitle}</p><h1 id="booking-return-title">{strings.paypalReturnTitle}</h1>
      {isProcessing && <div className="booking-return-panel__status"><Spinner animation="border" role="status" /><div><h2>{strings.paypalReturnProcessing}</h2><p>{strings.paypalReturnProcessingBody}</p></div></div>}
      {!isProcessing && error && <Alert className="booking-return-panel__notice" variant="danger" role="alert">{error}</Alert>}
      {!isProcessing && result && <div className="booking-return-panel__confirmed"><h2>{strings.confirmationTitle}</h2><p>{strings.paypalReturnSuccessBody}</p><dl><div><dt>{strings.reservationId}</dt><dd>{result.booking.reservationPublicId}</dd></div>{propertyName && <div><dt>{strings.depositContextTitle}</dt><dd>{propertyName}</dd></div>}<div><dt>{strings.status}</dt><dd>{formatPaymentStatus(result.payment.status, strings)}</dd></div><div><dt>{strings.depositDates(formatDate(result.booking.arrivalDate, language), formatDate(result.booking.departureDate, language))}</dt><dd>{strings.depositGuests(result.booking.guests)}</dd></div></dl></div>}
    </section>
  );
};

// BookingConfirmationPanel — with auto-login
const BookingConfirmationPanel = ({ result, strings, language, onManageBooking }: { result: PayPalCaptureResponse | null; strings: BookingStrings; language: BookingLanguage; onManageBooking: (id: string) => void }) => {
  const [isNavigating, setIsNavigating] = React.useState(false);
  if (!result) return (<section className="booking-confirmation-panel" aria-labelledby="booking-confirmation-title"><p className="booking-results-kicker">{strings.paypalTitle}</p><h1 id="booking-confirmation-title">{strings.confirmationTitle}</h1><Alert className="booking-return-panel__notice" variant="warning" role="alert">{strings.confirmationMissing}</Alert></section>);
  const propertyName = result.booking.property?.name ?? strings.notAvailable;
  const handleManageClick = () => { setIsNavigating(true); onManageBooking(result.booking.reservationPublicId); };
  return (
    <section className="booking-confirmation-panel" aria-labelledby="booking-confirmation-title">
      <div className="booking-confirmation-panel__icon"><FontAwesomeIcon icon={faCheck} /></div>
      <p className="booking-results-kicker">{strings.paypalTitle}</p><h1 id="booking-confirmation-title">{strings.confirmationTitle}</h1><p>{strings.confirmationSubtitle}</p>
      <dl className="booking-confirmation-panel__details">
        <div><dt>{strings.reservationId}</dt><dd>{result.booking.reservationPublicId}</dd></div>
        <div><dt>{strings.depositContextTitle}</dt><dd>{propertyName}</dd></div>
        <div><dt>{strings.stayDates}</dt><dd>{strings.depositDates(formatDate(result.booking.arrivalDate, language), formatDate(result.booking.departureDate, language))}</dd></div>
        <div><dt>{strings.guests}</dt><dd>{strings.depositGuests(result.booking.guests)}</dd></div>
        <div><dt>{strings.status}</dt><dd>{strings.paymentConfirmed}</dd></div>
      </dl>
      <Button className="booking-confirmation-panel__manage" type="button" disabled={isNavigating} onClick={handleManageClick}>
        {isNavigating ? <><Spinner animation="border" size="sm" /> {strings.manageBooking}</> : strings.manageBooking}
      </Button>
    </section>
  );
};

/**
 * Deposit checkout: collects the same guest details as the PayPal path, creates
 * a real hold that takes the dates off sale, then shows where to send the money
 * and lets the guest attach their receipt.
 *
 * This replaces the old contact-only handoff, which told guests to get in touch
 * and reserved nothing.
 */
const DepositCheckoutPanel = ({ result, property, strings, language, withPet, form, fieldErrors, holdError, holdResponse, isCreatingHold, receiptState, onChange, onSubmit, onUploadReceipt, onBack }: { result: BookingSearchResponse; property: BookingAvailableProperty; strings: BookingStrings; language: BookingLanguage; withPet: boolean; form: PayPalHoldFormState; fieldErrors: Record<string, string>; holdError: string | null; holdResponse: DepositHoldResponse | null; isCreatingHold: boolean; receiptState: DepositReceiptState; onChange: (u: Partial<PayPalHoldFormState>) => void; onSubmit: (e: React.FormEvent) => void; onUploadReceipt: (file: File) => void; onBack: () => void }) => {
  const price = property.price ?? holdResponse?.booking.price;
  const bankInfo = holdResponse?.bankInfo;

  return (
    <section className="booking-checkout-panel booking-deposit-checkout" aria-labelledby="booking-deposit-checkout-title">
      <Button type="button" variant="link" className="booking-wizard-back" onClick={onBack}><FontAwesomeIcon icon={faArrowLeft} /> {strings.backToResults}</Button>
      <div className="booking-checkout-panel__header">
        <p className="booking-results-kicker">{strings.manualDepositTitle}</p>
        <h2 id="booking-deposit-checkout-title">{holdResponse ? strings.depositTitle : strings.checkoutTitle}</h2>
        <p>{holdResponse ? strings.depositInstructions : strings.manualDepositDescription}</p>
      </div>

      <div className="booking-checkout-panel__summary" aria-label={strings.checkoutSummary}>
        <div><span>{strings.depositContextTitle}</span><strong>{property.name}</strong><small>{strings.depositDates(formatDate(result.arrivalDate, language), formatDate(result.departureDate, language))}</small></div>
        {price && <CheckoutPrice price={price} strings={strings} language={language} nonRefundablePreview={false} finalOverrideCents={holdResponse?.booking.price?.totalAmountCents} />}
        {withPet && <div><span>{strings.petSummaryLabel}</span><strong><FontAwesomeIcon icon={faPaw} /> {strings.petSummaryValue}</strong></div>}
      </div>

      <ColonesEstimateNote strings={strings} language={language} />

      {holdError && <Alert className="booking-search-alert" variant="danger" role="alert">{holdError}</Alert>}

      {holdResponse ? (
        <div className="booking-deposit-checkout__held" aria-live="polite">
          <Alert variant="warning" className="booking-deposit-handoff__notice">
            <strong>{strings.depositNotConfirmedTitle}</strong>
            <span>{strings.depositNotConfirmed}</span>
          </Alert>

          <div className="booking-checkout-panel__timer">
            <span>{strings.holdExpiring}</span>
            <HoldCountdown expiresAt={holdResponse.booking.hold.expiresAt} />
            <small>{strings.holdExpiresAt(formatDateTime(holdResponse.booking.hold.expiresAt, language))}</small>
          </div>

          <p className="booking-checkout-panel__reservation">{strings.reservationId}: <strong>{holdResponse.booking.reservationPublicId}</strong></p>

          {bankInfo && (
            <div className="booking-deposit-handoff__bank-info">
              <div className="booking-deposit-handoff__bank-card">
                <h3>{strings.depositSinpeTitle}</h3>
                <dl>
                  <dt>{strings.depositSinpePhone}</dt><dd>{bankInfo.sinpePhone}</dd>
                  <dt>{strings.depositSinpeName}</dt><dd>{bankInfo.sinpeName}</dd>
                </dl>
              </div>
              <div className="booking-deposit-handoff__bank-card">
                <h3>{strings.depositBankTitle}</h3>
                <dl>
                  <dt>{strings.depositBankAccountHolder}</dt><dd>{bankInfo.bankAccount.accountHolder}</dd>
                  <dt>{strings.depositBankColones}</dt><dd className="booking-deposit-handoff__iban">{bankInfo.bankAccount.colonesIban}</dd>
                  <dt>{strings.depositBankDolares}</dt><dd className="booking-deposit-handoff__iban">{bankInfo.bankAccount.dolaresIban}</dd>
                </dl>
                {/* The guest is one tap from their banking app here, so the
                    colón figure belongs next to the colón account rather than
                    only in the summary at the top of the page. */}
                <ColonesTransferAmount amountCents={holdResponse.booking.price.totalAmountCents} currency={holdResponse.booking.price.currency} strings={strings} language={language} />
              </div>
            </div>
          )}

          <div className="booking-deposit-checkout__upload">
            <h3>{strings.depositUploadTitle}</h3>
            <p>{strings.depositUploadReceiptNote}</p>
            {receiptState.status === 'uploaded' ? (
              <Alert variant="success" role="status">{strings.depositUploadSuccess}</Alert>
            ) : (
              <>
                <Alert variant="warning" className="booking-deposit-checkout__upload-warning" role="note">{strings.depositUploadWarning}</Alert>
                <Form.Control
                  type="file"
                  accept="image/jpeg,image/png,application/pdf"
                  disabled={receiptState.status === 'uploading'}
                  onChange={(event) => {
                    const file = (event.target as HTMLInputElement).files?.[0];
                    if (file) onUploadReceipt(file);
                  }}
                />
                {receiptState.status === 'uploading' && <p className="booking-deposit-checkout__uploading"><Spinner animation="border" size="sm" /> {strings.depositUploading}</p>}
                {receiptState.status === 'error' && <Alert variant="danger" role="alert">{receiptState.message}</Alert>}
              </>
            )}
            <p className="booking-deposit-checkout__staff-note">{strings.depositStaffWillConfirm}</p>
          </div>
        </div>
      ) : (
        <Form className="booking-checkout-panel__form" onSubmit={onSubmit} noValidate>
          <h3>{strings.guestDetails}</h3>
          <GuestDetailsFields idPrefix="depositHold" form={form} fieldErrors={fieldErrors} strings={strings} onChange={onChange} />
          <div className="booking-checkout-panel__actions">
            <Button type="submit" className="booking-search-submit" disabled={isCreatingHold}>
              {isCreatingHold ? <><Spinner animation="border" size="sm" /> {strings.creatingHold}</> : strings.depositReserveDates}
            </Button>
          </div>
        </Form>
      )}

      <div className="booking-checkout-panel__contacts">
        <h3>{strings.needHelp}</h3>
        <div className="booking-checkout-panel__contacts-grid">
          <a className="booking-checkout-panel__contact" href="https://wa.me/contact" target="_blank" rel="noopener noreferrer"><span>{strings.contactByWhatsapp}</span><strong>https://wa.me/contact</strong></a>
          <a className="booking-checkout-panel__contact" href="mailto:reservations@example.com"><span>{strings.contactByEmail}</span><strong>reservations@example.com</strong></a>
        </div>
      </div>
    </section>
  );
};



/**
 * Resolves what a price should look like on screen: the rack rate to strike
 * through, the amount actually payable, and the badges explaining the gap.
 *
 * Two discounts reach the guest by different routes and can stack. A long-stay
 * discount is already inside the total Smoobu quoted — the backend only tells us
 * what it would have cost without it. The non-refundable 10% is not applied
 * until the hold is created, so up to that point it is a preview computed here;
 * once the server has priced the booking, `finalOverrideCents` replaces the
 * guess with what was actually reserved.
 */
interface DisplayPrice {
  baseCents: number;
  finalCents: number;
  baseNightlyCents: number;
  finalNightlyCents: number;
  labels: string[];
  hasSaving: boolean;
}

function resolveDisplayPrice(
  price: BookingPrice,
  strings: BookingStrings,
  options: { nonRefundablePreview: boolean; finalOverrideCents?: number }
): DisplayPrice {
  const nights = price.nights > 0 ? price.nights : 1;
  const baseCents = price.discount?.baseTotalCents ?? price.totalAmountCents;
  const finalCents =
    options.finalOverrideCents ??
    (options.nonRefundablePreview ? Math.round(price.totalAmountCents * 0.9) : price.totalAmountCents);

  const labels: string[] = [];
  if (price.discount) {
    labels.push(
      price.discount.source === 'long_stay'
        ? strings.longStaySave(price.discount.percentage)
        : strings.codeSave(price.discount.percentage)
    );
  }
  if (options.nonRefundablePreview) {
    labels.push(strings.nonRefundableSave);
  }

  return {
    baseCents,
    finalCents,
    baseNightlyCents: price.discount?.baseNightlyAverageCents ?? price.nightlyAverageCents,
    finalNightlyCents: Math.round(finalCents / nights),
    labels,
    hasSaving: finalCents < baseCents,
  };
}

/**
 * "≈ ₡378.900" beside a dollar total, Spanish pages only.
 *
 * Renders nothing when the rate has not arrived or its source was unreachable —
 * a missing estimate is invisible, a wrong one is a support ticket. Every price
 * on the page calls this; `useExchangeRate` collapses them into one request.
 */
const ColonesEstimate = ({ amountCents, currency, strings, language }: { amountCents: number; currency: string; strings: BookingStrings; language: BookingLanguage }) => {
  const { status, data } = useExchangeRate(language === 'es');

  // `currency !== base` guards the day a home is quoted in something other than
  // dollars: converting it with a USD rate would be silently wrong.
  if (status !== 'ready' || !data || currency !== data.base) return null;

  const formatted = formatColones(amountCents, data.rate, language);
  return (
    <small className="booking-colones-estimate" aria-label={strings.colonesEstimateAria(formatted)}>
      ≈ {formatted}
    </small>
  );
};

/** The colón figure spelled out beside the colón IBAN on the deposit page. */
const ColonesTransferAmount = ({ amountCents, currency, strings, language }: { amountCents: number; currency: string; strings: BookingStrings; language: BookingLanguage }) => {
  const { status, data } = useExchangeRate(language === 'es');
  if (status !== 'ready' || !data || currency !== data.base) return null;

  return (
    <p className="booking-deposit-handoff__colones-amount">
      {strings.colonesTransferAmount(formatColones(amountCents, data.rate, language))}
    </p>
  );
};

/** The one line that makes every "≈" above it an estimate rather than a quote. */
const ColonesEstimateNote = ({ strings, language }: { strings: BookingStrings; language: BookingLanguage }) => {
  const { status, data } = useExchangeRate(language === 'es');
  if (status !== 'ready' || !data) return null;

  return (
    <p className="booking-colones-note">
      {strings.colonesEstimateNote(formatExchangeRate(data.rate, language), formatDate(data.fetchedAt.slice(0, 10), language))}
    </p>
  );
};

/** The price block on a result card: badges, struck rack rate, payable total. */
const PropertyPrice = ({ price, strings, language, nonRefundable }: { price: BookingPrice; strings: BookingStrings; language: BookingLanguage; nonRefundable: boolean }) => {
  const display = resolveDisplayPrice(price, strings, { nonRefundablePreview: nonRefundable });
  return (
    <div className="booking-result-card__price">
      {display.hasSaving && (
        <>
          <span className="booking-result-card__price-label" title={price.discount?.source === 'long_stay' ? strings.longStayNote : undefined}>{display.labels.join(' · ')}</span>
          <span className="booking-result-card__price-original"><del>{formatMoney(display.baseCents, price.currency, language)}</del></span>
        </>
      )}
      <span>{strings.priceForStay}</span>
      <strong>{formatMoney(display.finalCents, price.currency, language)}</strong>
      <ColonesEstimate amountCents={display.finalCents} currency={price.currency} strings={strings} language={language} />
      <small>
        {display.hasSaving && <del>{formatMoney(display.baseNightlyCents, price.currency, language)} </del>}
        {formatMoney(display.finalNightlyCents, price.currency, language)} {strings.averageNight}
      </small>
    </div>
  );
};

/** The price row in a checkout summary — same numbers, one line. */
const CheckoutPrice = ({ price, strings, language, nonRefundablePreview, finalOverrideCents }: { price: BookingPrice; strings: BookingStrings; language: BookingLanguage; nonRefundablePreview: boolean; finalOverrideCents?: number }) => {
  const display = resolveDisplayPrice(price, strings, { nonRefundablePreview, finalOverrideCents });
  return (
    <div>
      <span>{strings.priceForStay}</span>
      <strong>{formatMoney(display.finalCents, price.currency, language)}</strong>
      <ColonesEstimate amountCents={display.finalCents} currency={price.currency} strings={strings} language={language} />
      {display.hasSaving && (
        <small className="booking-checkout-panel__price-saving">
          <del>{formatMoney(display.baseCents, price.currency, language)}</del> {display.labels.join(' · ')}
        </small>
      )}
    </div>
  );
};

// Helper functions
function validateSearch(arrivalDate: string, departureDate: string, guests: number, today: string, strings: BookingStrings): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!arrivalDate || arrivalDate < today) errors.arrivalDate = strings.validationArrival;
  if (!departureDate || departureDate <= arrivalDate) errors.departureDate = strings.validationDateOrder;
  if (!Number.isInteger(guests) || guests < 1) errors.guests = strings.validationGuests;
  return errors;
}

function validatePayPalHoldForm(form: PayPalHoldFormState, strings: BookingStrings): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!form.firstName.trim()) errors.firstName = strings.validationRequired;
  if (!form.lastName.trim()) errors.lastName = strings.validationRequired;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim())) errors.email = strings.validationEmail;
  if (form.portalPassword.length < 12) errors.portalPassword = strings.validationPortalPassword;
  if (!form.termsAccepted) errors.termsAccepted = strings.validationTerms;
  return errors;
}

function getInitialArrivalDate(value: string | null, today: string): string { return value && isYmd(value) && value >= today ? value : today; }
function getInitialDepartureDate(value: string | null, arrivalValue: string | null, today: string): string { const a = getInitialArrivalDate(arrivalValue, today); return value && isYmd(value) && value > a ? value : addDays(a, 2); }
function getInitialGuestCount(value: string | null): number { const p = Number(value); return Number.isInteger(p) && p >= 1 ? p : 2; }
function isYmd(value: string): boolean { if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false; const d = new Date(`${value}T00:00:00Z`); return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value; }

function getSearchErrorMessage(error: unknown, strings: BookingStrings): string { if (error instanceof BookingApiError && (error.status === 503 || error.retryable)) return strings.providerUnavailable; return strings.genericError; }
function getHoldErrorMessage(error: unknown, strings: BookingStrings): string { if (error instanceof BookingApiError) { if (error.code === 'property_not_pet_friendly') return strings.petNotAllowedError; if (error.code === 'property_no_longer_available' || error.code === 'no_longer_available') return strings.propertyNoLongerAvailable; if (error.status === 503 || error.retryable) return strings.providerUnavailable; } return strings.checkoutUnavailable; }
function getPayPalOrderErrorMessage(error: unknown, strings: BookingStrings): string { if (error instanceof BookingApiError) { if (error.code === 'hold_expired') return strings.bookingExpired; if (error.status === 503 || error.retryable) return strings.providerUnavailable; } return strings.paymentNotReady; }
function getReceiptErrorMessage(error: unknown, strings: BookingStrings): string {
  if (error instanceof BookingApiError) {
    if (error.code === 'invalid_content_type') return strings.depositUploadWrongType;
    if (error.code === 'upload_too_large') return strings.depositUploadTooLarge;
  }
  return strings.depositUploadError;
}

function getPayPalCaptureErrorMessage(error: unknown, strings: BookingStrings): string { if (error instanceof BookingApiError) { if (error.code === 'hold_expired') return strings.bookingExpired; if (error.code === 'paypal_order_not_approved') return strings.paymentNotReady; if (error.status === 503 || error.retryable) return strings.providerUnavailable; } return strings.paypalCaptureError; }

function formatMoney(amountCents: number, currency: string, language: BookingLanguage): string { return new Intl.NumberFormat(language === 'es' ? 'es-CR' : 'en-US', { style: 'currency', currency }).format(amountCents / 100); }
function formatDateTime(value: string, language: BookingLanguage): string { const d = new Date(value); if (Number.isNaN(d.getTime())) return value; return new Intl.DateTimeFormat(language === 'es' ? 'es-CR' : 'en-US', { dateStyle: 'medium', timeStyle: 'short' }).format(d); }
function formatDate(value: string, language: BookingLanguage): string { const d = new Date(`${value}T00:00:00Z`); if (Number.isNaN(d.getTime())) return value; return new Intl.DateTimeFormat(language === 'es' ? 'es-CR' : 'en-US', { dateStyle: 'medium', timeZone: 'UTC' }).format(d); }
/**
 * A PayPal hold lasts about an hour, so mm:ss reads naturally. A deposit hold
 * lasts up to 36 hours, where the same format produces "2159:42" — technically
 * correct and completely unreadable. Switch to hours and minutes past an hour.
 */
function formatDuration(durationMs: number): string {
  const totalSeconds = Math.floor(Math.max(0, durationMs) / 1000);

  if (totalSeconds >= 3600) {
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    return `${hours}h ${minutes.toString().padStart(2, '0')}m`;
  }

  return `${Math.floor(totalSeconds / 60)}:${(totalSeconds % 60).toString().padStart(2, '0')}`;
}
function formatPaymentStatus(status: string, strings: BookingStrings): string { return status === 'captured' ? strings.paymentConfirmed : status; }
function redirectToUrl(url: string): void { window.location.assign(url); }
function isBookingReturnPath(pathname: string): boolean { const n = pathname.replace(/\/+$/, '').toLowerCase(); return n === '/book/return' || n === '/bookes/return'; }
function isBookingConfirmedPath(pathname: string): boolean { const n = pathname.replace(/\/+$/, '').toLowerCase(); return n === '/book/confirmed' || n === '/bookes/confirmed'; }
function confirmedBookingPath(language: BookingLanguage): string { return language === 'es' ? '/bookES/confirmed' : '/book/confirmed'; }
function persistPayPalCheckoutState(state: StoredPayPalCheckout): void { try { window.sessionStorage.setItem(paypalCheckoutStorageKey, JSON.stringify(state)); } catch { /* non-critical */ } }
function readPayPalCheckoutState(): StoredPayPalCheckout | null { try { const raw = window.sessionStorage.getItem(paypalCheckoutStorageKey); if (!raw) return null; const p = JSON.parse(raw) as Partial<StoredPayPalCheckout>; if (typeof p.bookingSessionId !== 'string' || typeof p.paypalOrderId !== 'string' || (p.language !== 'en' && p.language !== 'es')) return null; return { bookingSessionId: p.bookingSessionId, paypalOrderId: p.paypalOrderId, reservationPublicId: typeof p.reservationPublicId === 'string' ? p.reservationPublicId : undefined, language: p.language }; } catch { return null; } }
function clearPayPalCheckoutState(bookingSessionId: string): void { try { const s = readPayPalCheckoutState(); if (!s || s.bookingSessionId === bookingSessionId) window.sessionStorage.removeItem(paypalCheckoutStorageKey); } catch { /* non-critical */ } }
function persistBookingConfirmationState(state: PayPalCaptureResponse): void { try { window.sessionStorage.setItem(bookingConfirmationStorageKey, JSON.stringify(state)); } catch { /* non-critical */ } }
function readBookingConfirmationState(): PayPalCaptureResponse | null { try { const raw = window.sessionStorage.getItem(bookingConfirmationStorageKey); if (!raw) return null; const p = JSON.parse(raw) as PayPalCaptureResponse; if (!p?.booking?.reservationPublicId || !p.booking.bookingSessionId || p.booking.status !== 'booking_confirmed' || !p.payment?.paypalOrderId) return null; return p; } catch { return null; } }
function maybeTrackBookingConfirmation(result: PayPalCaptureResponse): void { const property = result.booking.property; const price = result.booking.price; if (!property?.propertyId || !property.slug || !property.name || !price?.currency || typeof price.totalAmountCents !== 'number') return; trackBookingConfirmed({ reservation_id: result.booking.reservationPublicId, property_id: property.propertyId, property_slug: property.slug, property_name: property.name, value_cents: price.totalAmountCents, currency: price.currency, arrival_date: result.booking.arrivalDate, departure_date: result.booking.departureDate, payment_method: 'paypal', language: result.booking.language }); }
function wasBookingConfirmationTracked(reservationPublicId: string): boolean { try { return window.sessionStorage.getItem(`${bookingConfirmationTrackedPrefix}${reservationPublicId}`) === '1'; } catch { return false; } }
function markBookingConfirmationTracked(reservationPublicId: string): void { try { window.sessionStorage.setItem(`${bookingConfirmationTrackedPrefix}${reservationPublicId}`, '1'); } catch { /* non-critical */ } }
function buildListingUrl(slug: string, language: BookingLanguage): string { return `/${slug.replace(/^\/+/, '')}${language === 'es' ? 'ES' : ''}`; }

// Portal auto-login helpers
// The password is stashed in sessionStorage temporarily during the checkout→confirmation flow.
// Once we have the reservationPublicId (after hold creation / capture), we persist the pair
// into the durable localStorage credential cache via savePortalCredentials.
function persistPortalAutoLogin(password: string): void { try { window.sessionStorage.setItem(portalAutoLoginKey, password); } catch { /* non-critical */ } }
function readPortalAutoLogin(): string | null { try { return window.sessionStorage.getItem(portalAutoLoginKey); } catch { return null; } }
function clearPortalAutoLogin(): void { try { window.sessionStorage.removeItem(portalAutoLoginKey); } catch { /* non-critical */ } }

// Wrapper with reCAPTCHA provider
const BookingPageWithCaptcha = () => {
  const siteKey = process.env.REACT_APP_CAPTCHA_SITE_KEY || '';
  if (!siteKey) return <BookingPage />;
  return <GoogleReCaptchaProvider reCaptchaKey={siteKey}><BookingPage /></GoogleReCaptchaProvider>;
};

export default BookingPageWithCaptcha;
