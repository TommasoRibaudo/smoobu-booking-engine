import { getTrackingIdentifiers, TrackingIdentifiers } from '../utils/trackingIdentifiers';

export type BookingLanguage = 'en' | 'es';

export interface BookingSearchRequest {
  arrivalDate: string;
  departureDate: string;
  guests: number;
  language: BookingLanguage;
  discountCode?: string;
  source?: string;
  captchaToken?: string;
}

export interface BookingAmenity {
  code: string;
  label: string;
}

/**
 * A reduction Smoobu already applied to `totalAmountCents`, reconstructed by the
 * backend from the nightly rate table. Absent when the quote matches the rack
 * rate — or when the rate lookup was unavailable.
 */
export interface BookingPriceDiscount {
  source: 'long_stay' | 'discount_code';
  baseTotalCents: number;
  baseNightlyAverageCents: number;
  amountCents: number;
  percentage: number;
}

export interface BookingPrice {
  currency: string;
  totalAmountCents: number;
  nightlyAverageCents: number;
  nights: number;
  includesTaxes: boolean;
  rateSource: string;
  discount?: BookingPriceDiscount;
}

export interface BookingAvailableProperty {
  propertyId: string;
  slug: string;
  listingUrl: string;
  name: string;
  guestCapacity: number;
  thumbnailUrl: string;
  amenities: BookingAmenity[];
  price?: BookingPrice;
  actions?: {
    viewListingUrl?: string;
    canCreatePayPalHold?: boolean;
    canUseManualDepositHandoff?: boolean;
  };
}

export interface BookingAvailabilityWarning {
  code: string;
  messageKey: string;
  propertyId?: string;
}

export interface BookingSearchResponse {
  bookingSessionId: string;
  quoteId: string;
  quoteExpiresAt: string;
  arrivalDate: string;
  departureDate: string;
  guests: number;
  language: BookingLanguage;
  resultsCount: number;
  properties: BookingAvailableProperty[];
  availabilityWarnings: BookingAvailabilityWarning[];
}

export interface DepositHandoffRequest {
  language: BookingLanguage;
  quoteId?: string;
  propertyId?: string;
}

export interface CreatePayPalHoldRequest {
  quoteId: string;
  bookingSessionId: string;
  propertyId: string;
  language: BookingLanguage;
  guest: {
    firstName: string;
    lastName: string;
    email: string;
    phone?: string;
    country?: string;
    message?: string;
  };
  portalPassword: string;
  termsAccepted: boolean;
  marketingConsent?: boolean;
  nonRefundable?: boolean;
  /** Guest is bringing a pet. The server rejects it for homes that ban pets. */
  withPet?: boolean;
  captchaToken?: string;
}

/**
 * Same shape as a PayPal hold minus the rate options — deposit is always
 * flexible. A pet travels with the guest either way, so `withPet` stays.
 */
export type CreateDepositHoldRequest = Omit<CreatePayPalHoldRequest, 'nonRefundable'>;

export interface DepositBankInfo {
  sinpePhone: string;
  sinpeName: string;
  bankAccount: {
    accountHolder: string;
    colonesIban: string;
    dolaresIban: string;
  };
}

export interface DepositHoldResponse extends PayPalHoldResponse {
  bankInfo: DepositBankInfo;
  /** Scopes the receipt-upload calls to this booking, which has no portal session yet. */
  depositAccessToken: string;
  depositAccessTokenExpiresInSeconds: number;
  nextAction: 'upload_deposit_receipt' | string;
}

export interface DepositReceiptConfirmResponse {
  confirmed: boolean;
  s3Key: string;
  bookingSessionId: string;
  receiptUrl: string;
  receiptUrlExpiresInSeconds: number;
  smoobuNoticeUpdated: boolean;
}

export interface PayPalHoldResponse {
  booking: {
    bookingSessionId: string;
    reservationPublicId: string;
    status: 'hold_active' | string;
    language: BookingLanguage;
    arrivalDate: string;
    departureDate: string;
    guests: number;
    property: {
      propertyId: string;
      slug: string;
      listingUrl: string;
      name: string;
      guestCapacity: number;
      thumbnailUrl: string;
      amenities: BookingAmenity[];
    };
    price: BookingPrice;
    hold: {
      status: 'active' | string;
      expiresAt: string;
    };
    payment: {
      method: 'paypal' | string;
      status: 'pending' | string;
    };
  };
  nextAction: 'create_paypal_order' | string;
}

export interface CreatePayPalOrderRequest {
  bookingSessionId: string;
  language: BookingLanguage;
  /** Sent as X-Captcha-Token when retrying after a 403 captcha_required. */
  captchaToken?: string;
}

export interface PayPalOrderResponse {
  booking: {
    bookingSessionId: string;
    reservationPublicId: string;
    status: 'paypal_order_created' | 'booking_confirmed' | string;
    language: BookingLanguage;
    arrivalDate: string;
    departureDate: string;
    guests: number;
    property?: {
      propertyId: string;
      slug: string;
      listingUrl: string;
      name: string;
    };
    price?: {
      currency?: string;
      totalAmountCents?: number;
    };
    hold?: {
      expiresAt?: string;
    };
  };
  paypal?: {
    orderId: string;
    approvalUrl: string;
  };
  nextAction?: 'approve_paypal_order' | string;
}

/**
 * Note: the backend's `paymentCapture` abuse policy deliberately has no
 * `captchaAfter` — the guest has already paid by this point, so capture is
 * never challenged and needs no token.
 */
export interface CapturePayPalOrderRequest {
  bookingSessionId: string;
  paypalOrderId: string;
  payerId?: string;
  language: BookingLanguage;
}

export interface PayPalCaptureResponse {
  booking: {
    bookingSessionId: string;
    reservationPublicId: string;
    status: 'booking_confirmed' | string;
    language: BookingLanguage;
    arrivalDate: string;
    departureDate: string;
    guests: number;
    confirmedAt?: string;
    property?: {
      propertyId: string;
      slug: string;
      listingUrl: string;
      name: string;
    };
    price?: {
      currency?: string;
      totalAmountCents?: number;
    };
  };
  payment: {
    method: 'paypal' | string;
    status: 'captured' | string;
    paypalOrderId: string;
    paypalCaptureId?: string;
    capturedAt?: string;
  };
}

export interface DepositHandoffEventRequest {
  quoteId: string;
  propertyId: string;
  language: BookingLanguage;
  contactMethod: string;
  analyticsConsent?: boolean;
}

export interface DepositHandoffContactMethod {
  type: 'whatsapp' | 'email' | string;
  label: string;
  url: string;
}

export interface DepositBankAccount {
  accountHolder: string;
  colonesIban: string;
  dolaresIban: string;
}

export interface DepositBankInfo {
  sinpePhone: string;
  sinpeName: string;
  bankAccount: DepositBankAccount;
}

export interface DepositHandoffResponse {
  language: BookingLanguage;
  status: 'manual_deposit_handoff';
  isBookingConfirmed: false;
  doesCreateHold: false;
  messageKey: string;
  instructions: {
    titleKey: string;
    bodyKeys: string[];
    contactMethods: DepositHandoffContactMethod[];
  };
  bankInfo?: DepositBankInfo;
  bookingContext?: {
    quoteId?: string;
    property?: {
      propertyId: string;
      slug: string;
      listingUrl: string;
      name: string;
    };
    arrivalDate?: string;
    departureDate?: string;
    guests?: number;
  };
}

export interface DepositHandoffEventResponse {
  recorded: true;
  status: 'manual_deposit_handoff';
  isBookingConfirmed: false;
  doesCreateHold: false;
  messageKey: string;
}

export interface PortalLoginRequest {
  reservationPublicId: string;
  password: string;
  language: BookingLanguage;
}

export interface PortalLoginResponse {
  token: string;
  reservationPublicId: string;
  expiresIn: number;
}

/** Why the server will not accept a self-service cancellation. */
export type PortalCancellationBlockReason =
  | 'already_cancelled'
  | 'invalid_booking_state'
  | 'non_refundable_rate'
  | 'rate_plan_unknown'
  | 'cancellation_window_closed';

export type PortalRatePlan = 'flexible' | 'non_refundable';

export interface PortalReservationResponse {
  reservation: {
    reservationPublicId: string;
    status: string;
    language: BookingLanguage;
    arrivalDate: string;
    departureDate: string;
    guests: number;
    confirmedAt?: string;
    /** Null on bookings made before the rate plan was persisted. */
    ratePlan?: PortalRatePlan | null;
    /** Guest declared a pet at checkout. */
    hasPet?: boolean;
    /**
     * Server-evaluated cancellation policy. The UI renders from this rather than
     * re-deriving the 24-hour rule, so the button always matches what the API
     * will allow.
     */
    cancellation?: {
      cancellable: boolean;
      deadline: string | null;
      reasonCode?: PortalCancellationBlockReason;
    };
    availableActions?: string[];
    cancelledAt?: string;
    cancellationReason?: string;
    property?: {
      propertyId: string;
      slug: string;
      listingUrl: string;
      name: string;
      guestCapacity: number;
      thumbnailUrl: string;
      amenities: BookingAmenity[];
    };
    price?: {
      currency: string;
      totalAmountCents: number;
    };
    guest?: {
      firstName: string;
      lastName: string;
      email: string;
    };
  };
  hold: {
    status: string;
    expiresAt: string;
    smoobuReservationId?: number;
  } | null;
  payment: {
    method: string;
    status: string;
    paypalOrderId?: string;
    currency?: string;
    totalAmountCents?: number;
    capturedAt?: string;
  } | null;
}

export type PortalHelpRequestType =
  | 'general'
  | 'date_change'
  | 'guest_count_change'
  | 'arrival_time'
  | 'other';

export interface PortalHelpRequestBody {
  type: PortalHelpRequestType;
  message: string;
}

export interface PortalCancellationRequestBody {
  reason: string;
  message?: string;
}

export interface PortalCancelBookingResponse {
  status: string;
  message: string;
  reservation: PortalReservationResponse['reservation'];
  hold: PortalReservationResponse['hold'];
  payment: PortalReservationResponse['payment'];
  /**
   * `manual_review` means staff will issue the PayPal refund by hand — the API
   * never moves money on a guest request.
   */
  refund: {
    status: 'manual_review' | 'not_applicable';
    paypalCaptureId?: string;
  };
}

export interface PortalGuestUpdateRequest {
  guests: number;
}

export interface PortalGuestUpdateResponse {
  status: string;
  message: string;
  reservation: PortalReservationResponse['reservation'];
  hold: PortalReservationResponse['hold'];
  payment: PortalReservationResponse['payment'];
}

export interface PortalRequestResponse {
  status: string;
  message: string;
}

export type CalendarDot = 'green' | 'yellow' | 'red' | 'grey';

export interface CalendarProperty {
  propertyId?: string;
  slug: string;
  name?: string;
}

export interface CalendarDay {
  date: string;
  available: boolean;
  priceCents: number | null;
  minStay: number | null;
  dot?: CalendarDot;
  ariaLabelKey?: string;
}

export interface CalendarStats {
  availableNightCount: number;
  minPriceCents: number | null;
  maxPriceCents: number | null;
  averagePriceCents: number | null;
}

export interface CalendarCacheMetadata {
  status?: string;
  ttlSeconds?: number;
  generatedAt?: string;
}

export interface CalendarMonthResponse {
  property: CalendarProperty;
  month: string;
  currency: string;
  days: CalendarDay[];
  stats: CalendarStats;
  cache?: CalendarCacheMetadata;
}

interface CalendarResponseApi {
  property?: CalendarProperty;
  apartment?: string;
  month: string;
  currency?: string;
  days?: CalendarDay[];
  dates?: Record<
    string,
    {
      available: boolean;
      price?: number | null;
      priceCents?: number | null;
      minStay?: number | null;
      min_length_of_stay?: number | null;
      dot?: CalendarDot;
      ariaLabelKey?: string;
    }
  >;
  stats?: Partial<CalendarStats> & {
    avg?: number | null;
    min?: number | null;
    max?: number | null;
  };
  cache?: CalendarCacheMetadata;
}

interface BookingErrorResponse {
  error?: {
    code?: string;
    message?: string;
    fieldErrors?: Record<string, string[]>;
    retryable?: boolean;
    correlationId?: string;
  };
}

export class BookingApiError extends Error {
  status: number;
  code: string;
  fieldErrors: Record<string, string[]>;
  retryable: boolean;
  correlationId?: string;

  constructor(status: number, response: BookingErrorResponse) {
    const error = response.error ?? {};
    super(error.message || 'Booking search failed.');
    this.name = 'BookingApiError';
    this.status = status;
    this.code = error.code || 'booking_api_error';
    this.fieldErrors = error.fieldErrors ?? {};
    this.retryable = error.retryable === true;
    this.correlationId = error.correlationId;
  }
}

const apiBaseUrl = (process.env.REACT_APP_BOOKING_API_BASE_URL || '').replace(/\/$/, '');

/**
 * Attribution identifiers for the API's server-side conversion reporting.
 *
 * Spreads to `{}` when the guest has not granted marketing consent, so the
 * request body is unchanged and nothing is stored — see trackingIdentifiers.ts.
 */
function buildTrackingPayload(): { tracking?: TrackingIdentifiers; marketingConsent?: boolean } {
  const tracking = getTrackingIdentifiers();
  if (!tracking) return {};

  return { tracking, marketingConsent: true };
}

export async function searchAvailability(request: BookingSearchRequest): Promise<BookingSearchResponse> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'Accept-Language': request.language,
    'Content-Type': 'application/json',
  };
  if (request.captchaToken) {
    headers['X-Captcha-Token'] = request.captchaToken;
  }

  const { captchaToken: _captchaToken, ...requestBody } = request;

  const response = await fetch(`${apiBaseUrl}/api/search`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      ...requestBody,
      // Captured at session creation so every later funnel event the API reports
      // can be attributed to the campaign that produced this search.
      ...buildTrackingPayload(),
    }),
  });

  const body = await parseJson(response);

  if (!response.ok) {
    throw new BookingApiError(response.status, body as BookingErrorResponse);
  }

  return body as BookingSearchResponse;
}

export async function createPayPalHold(request: CreatePayPalHoldRequest): Promise<PayPalHoldResponse> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'Accept-Language': request.language,
    'Content-Type': 'application/json',
    'Idempotency-Key': createIdempotencyKey('hold'),
  };
  if (request.captchaToken) {
    headers['X-Captcha-Token'] = request.captchaToken;
  }

  const response = await fetch(`${apiBaseUrl}/api/holds`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      quoteId: request.quoteId,
      bookingSessionId: request.bookingSessionId,
      propertyId: request.propertyId,
      paymentMethod: 'paypal',
      guest: pruneOptionalFields(request.guest),
      portalPassword: request.portalPassword,
      termsAccepted: request.termsAccepted,
      marketingConsent: request.marketingConsent === true,
      // Re-sent because the guest may have accepted the cookie banner after searching.
      ...buildTrackingPayload(),
      ...(request.nonRefundable ? { nonRefundable: true } : {}),
      ...(request.withPet ? { withPet: true } : {}),
    }),
  });

  const body = await parseJson(response);

  if (!response.ok) {
    throw new BookingApiError(response.status, body as BookingErrorResponse);
  }

  return body as PayPalHoldResponse;
}

/**
 * Creates a manual-deposit booking: guest details, portal password, and a real
 * Smoobu hold that takes the dates off sale while the transfer clears.
 *
 * Unlike the PayPal path this does not confirm anything — staff verify the
 * transfer and confirm from their notification email.
 */
export async function createDepositHold(request: CreateDepositHoldRequest): Promise<DepositHoldResponse> {
  const response = await fetch(`${apiBaseUrl}/api/deposit-holds`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Accept-Language': request.language,
      'Content-Type': 'application/json',
      'Idempotency-Key': createIdempotencyKey('deposit-hold'),
    },
    body: JSON.stringify({
      quoteId: request.quoteId,
      bookingSessionId: request.bookingSessionId,
      propertyId: request.propertyId,
      guest: pruneOptionalFields(request.guest),
      portalPassword: request.portalPassword,
      termsAccepted: request.termsAccepted,
      marketingConsent: request.marketingConsent === true,
      // Re-sent because the guest may have accepted the cookie banner after searching.
      ...buildTrackingPayload(),
      ...(request.withPet ? { withPet: true } : {}),
    }),
  });

  const body = await parseJson(response);

  if (!response.ok) {
    throw new BookingApiError(response.status, body as BookingErrorResponse);
  }

  return body as DepositHoldResponse;
}

/**
 * Uploads a deposit receipt straight to S3 with a presigned URL, then tells the
 * API where it landed. The file never passes through the booking API.
 *
 * `depositAccessToken` comes from createDepositHold and scopes both calls to
 * that one booking, which has no portal session yet.
 */
export async function uploadDepositReceipt(request: {
  bookingSessionId: string;
  depositAccessToken: string;
  file: File;
  language: BookingLanguage;
}): Promise<DepositReceiptConfirmResponse> {
  const urlResponse = await fetch(`${apiBaseUrl}/api/deposit-receipt/upload-url`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Accept-Language': request.language,
      'Content-Type': 'application/json',
      Authorization: `Bearer ${request.depositAccessToken}`,
    },
    body: JSON.stringify({
      bookingSessionId: request.bookingSessionId,
      fileName: request.file.name,
      contentType: request.file.type,
    }),
  });

  const urlBody = await parseJson(urlResponse);
  if (!urlResponse.ok) {
    throw new BookingApiError(urlResponse.status, urlBody as BookingErrorResponse);
  }

  const { uploadUrl, s3Key } = urlBody as { uploadUrl: string; s3Key: string };

  // Direct to S3 — not our API, so a failure here is not a BookingApiError.
  const putResponse = await fetch(uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Type': request.file.type },
    body: request.file,
  });

  if (!putResponse.ok) {
    throw new Error(`Receipt upload failed with status ${putResponse.status}`);
  }

  const confirmResponse = await fetch(`${apiBaseUrl}/api/deposit-receipt/confirm`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Accept-Language': request.language,
      'Content-Type': 'application/json',
      Authorization: `Bearer ${request.depositAccessToken}`,
      'Idempotency-Key': createIdempotencyKey('deposit-receipt'),
    },
    body: JSON.stringify({ bookingSessionId: request.bookingSessionId, s3Key }),
  });

  const confirmBody = await parseJson(confirmResponse);
  if (!confirmResponse.ok) {
    throw new BookingApiError(confirmResponse.status, confirmBody as BookingErrorResponse);
  }

  return confirmBody as DepositReceiptConfirmResponse;
}

export async function createPayPalOrder(request: CreatePayPalOrderRequest): Promise<PayPalOrderResponse> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'Accept-Language': request.language,
    'Idempotency-Key': createIdempotencyKey('paypal-order'),
  };
  if (request.captchaToken) {
    headers['X-Captcha-Token'] = request.captchaToken;
  }

  const response = await fetch(
    `${apiBaseUrl}/api/bookings/${encodeURIComponent(request.bookingSessionId)}/paypal/create-order`,
    {
      method: 'POST',
      headers,
    }
  );

  const body = await parseJson(response);

  if (!response.ok) {
    throw new BookingApiError(response.status, body as BookingErrorResponse);
  }

  return body as PayPalOrderResponse;
}

export async function capturePayPalOrder(request: CapturePayPalOrderRequest): Promise<PayPalCaptureResponse> {
  const response = await fetch(
    `${apiBaseUrl}/api/bookings/${encodeURIComponent(request.bookingSessionId)}/paypal/capture`,
    {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Accept-Language': request.language,
        'Content-Type': 'application/json',
        'Idempotency-Key': createIdempotencyKey('paypal-capture'),
      },
      body: JSON.stringify({
        paypalOrderId: request.paypalOrderId,
        payerId: request.payerId,
      }),
    }
  );

  const body = await parseJson(response);

  if (!response.ok) {
    throw new BookingApiError(response.status, body as BookingErrorResponse);
  }

  return body as PayPalCaptureResponse;
}

export async function getDepositHandoff(request: DepositHandoffRequest): Promise<DepositHandoffResponse> {
  const params = new URLSearchParams({ language: request.language });
  if (request.quoteId) {
    params.set('quoteId', request.quoteId);
  }
  if (request.propertyId) {
    params.set('propertyId', request.propertyId);
  }

  const response = await fetch(`${apiBaseUrl}/api/deposit-handoff?${params.toString()}`, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      'Accept-Language': request.language,
    },
  });

  const body = await parseJson(response);

  if (!response.ok) {
    throw new BookingApiError(response.status, body as BookingErrorResponse);
  }

  return body as DepositHandoffResponse;
}

export async function recordDepositHandoffEvent(
  request: DepositHandoffEventRequest
): Promise<DepositHandoffEventResponse> {
  const response = await fetch(`${apiBaseUrl}/api/deposit-handoff/events`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Accept-Language': request.language,
      'Content-Type': 'application/json',
      'Idempotency-Key': createIdempotencyKey('deposit'),
    },
    body: JSON.stringify(request),
    keepalive: true,
  });

  const body = await parseJson(response);

  if (!response.ok) {
    throw new BookingApiError(response.status, body as BookingErrorResponse);
  }

  return body as DepositHandoffEventResponse;
}

export async function portalLogin(request: PortalLoginRequest): Promise<PortalLoginResponse> {
  const response = await fetch(`${apiBaseUrl}/api/portal/login`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Accept-Language': request.language,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      reservationPublicId: request.reservationPublicId,
      password: request.password,
      language: request.language,
    }),
  });

  const body = await parseJson(response);

  if (!response.ok) {
    throw new BookingApiError(response.status, body as BookingErrorResponse);
  }

  return body as PortalLoginResponse;
}

export async function getPortalReservation(
  reservationPublicId: string,
  token: string,
  language: BookingLanguage
): Promise<PortalReservationResponse> {
  const response = await fetch(
    `${apiBaseUrl}/api/portal/reservation/${encodeURIComponent(reservationPublicId)}`,
    {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'Accept-Language': language,
        Authorization: `Bearer ${token}`,
      },
    }
  );

  const body = await parseJson(response);

  if (!response.ok) {
    throw new BookingApiError(response.status, body as BookingErrorResponse);
  }

  return body as PortalReservationResponse;
}

export async function submitPortalHelpRequest(
  reservationPublicId: string,
  token: string,
  request: PortalHelpRequestBody,
  language: BookingLanguage
): Promise<PortalRequestResponse> {
  const response = await fetch(
    `${apiBaseUrl}/api/portal/reservation/${encodeURIComponent(reservationPublicId)}/help-request`,
    {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Accept-Language': language,
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        'Idempotency-Key': createIdempotencyKey('portal-help'),
      },
      body: JSON.stringify(request),
    }
  );

  const body = await parseJson(response);

  if (!response.ok) {
    throw new BookingApiError(response.status, body as BookingErrorResponse);
  }

  return body as PortalRequestResponse;
}

export async function submitPortalCancellationRequest(
  reservationPublicId: string,
  token: string,
  request: PortalCancellationRequestBody,
  language: BookingLanguage
): Promise<PortalRequestResponse> {
  const response = await fetch(
    `${apiBaseUrl}/api/portal/reservation/${encodeURIComponent(reservationPublicId)}/cancellation-request`,
    {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Accept-Language': language,
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        'Idempotency-Key': createIdempotencyKey('portal-cancel'),
      },
      body: JSON.stringify(request),
    }
  );

  const body = await parseJson(response);

  if (!response.ok) {
    throw new BookingApiError(response.status, body as BookingErrorResponse);
  }

  return body as PortalRequestResponse;
}

/**
 * Cancels the booking for real: the Smoobu reservation is released and any
 * captured payment is flagged for a manual refund by staff.
 *
 * Distinct from submitPortalCancellationRequest, which only files a request for
 * a human to action and changes nothing.
 */
export async function cancelPortalBooking(
  reservationPublicId: string,
  token: string,
  request: PortalCancellationRequestBody,
  language: BookingLanguage
): Promise<PortalCancelBookingResponse> {
  const response = await fetch(
    `${apiBaseUrl}/api/portal/reservation/${encodeURIComponent(reservationPublicId)}/cancel`,
    {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Accept-Language': language,
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        'Idempotency-Key': createIdempotencyKey('portal-cancel'),
      },
      body: JSON.stringify(request),
    }
  );

  const body = await parseJson(response);

  if (!response.ok) {
    throw new BookingApiError(response.status, body as BookingErrorResponse);
  }

  return body as PortalCancelBookingResponse;
}

export async function updatePortalGuests(
  reservationPublicId: string,
  token: string,
  request: PortalGuestUpdateRequest,
  language: BookingLanguage
): Promise<PortalGuestUpdateResponse> {
  const response = await fetch(
    `${apiBaseUrl}/api/portal/reservation/${encodeURIComponent(reservationPublicId)}/guests`,
    {
      method: 'PUT',
      headers: {
        Accept: 'application/json',
        'Accept-Language': language,
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(request),
    }
  );

  const body = await parseJson(response);

  if (!response.ok) {
    throw new BookingApiError(response.status, body as BookingErrorResponse);
  }

  return body as PortalGuestUpdateResponse;
}

/**
 * Display-only currency conversion. Everything is quoted and charged in USD —
 * this exists so a guest paying by SINPE or bank transfer can see roughly what
 * the stay comes to in colones.
 */
export interface ExchangeRateResponse {
  base: string;
  quote: string;
  /** Colones per one dollar. */
  rate: number;
  source: string;
  fetchedAt: string;
  /** The rate source was unreachable; this is the last one the API had. */
  stale: boolean;
}

export async function getExchangeRate(): Promise<ExchangeRateResponse> {
  const response = await fetch(`${apiBaseUrl}/api/exchange-rate`, {
    method: 'GET',
    headers: { Accept: 'application/json' },
  });

  const body = await parseJson(response);

  if (!response.ok) {
    throw new BookingApiError(response.status, body as BookingErrorResponse);
  }

  return body as ExchangeRateResponse;
}

export async function getCalendarMonth(
  apartmentSlug: string,
  month: string,
  language: BookingLanguage
): Promise<CalendarMonthResponse> {
  const params = new URLSearchParams({ month, language });
  const response = await fetch(`${apiBaseUrl}/api/calendar/${encodeURIComponent(apartmentSlug)}?${params.toString()}`, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      'Accept-Language': language,
    },
  });

  const body = await parseJson(response);

  if (!response.ok) {
    throw new BookingApiError(response.status, body as BookingErrorResponse);
  }

  return normalizeCalendarResponse(body as CalendarResponseApi, apartmentSlug, month);
}

async function parseJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    if (!response.ok) {
      return {
        error: {
          code: 'invalid_json_response',
          message: 'The booking service returned an invalid response.',
          retryable: true,
        },
      };
    }
    throw new Error('The booking service returned an invalid response.');
  }
}

function normalizeCalendarResponse(
  response: CalendarResponseApi,
  apartmentSlug: string,
  requestedMonth: string
): CalendarMonthResponse {
  const days = response.days
    ? response.days.map((day) => ({
        date: day.date,
        available: day.available,
        priceCents: day.priceCents,
        minStay: day.minStay,
        dot: day.dot,
        ariaLabelKey: day.ariaLabelKey,
      }))
    : Object.entries(response.dates ?? {}).map(([date, day]) => ({
        date,
        available: day.available,
        priceCents: typeof day.priceCents === 'number' ? day.priceCents : dollarsToCents(day.price),
        minStay: typeof day.minStay === 'number' ? day.minStay : day.min_length_of_stay ?? null,
        dot: day.dot,
        ariaLabelKey: day.ariaLabelKey,
      }));

  const availablePrices = days
    .filter((day) => day.available && typeof day.priceCents === 'number')
    .map((day) => day.priceCents as number);

  const stats = response.stats ?? {};
  const minPriceCents =
    typeof stats.minPriceCents === 'number' ? stats.minPriceCents : dollarsToCents(stats.min);
  const maxPriceCents =
    typeof stats.maxPriceCents === 'number' ? stats.maxPriceCents : dollarsToCents(stats.max);
  const averagePriceCents =
    typeof stats.averagePriceCents === 'number'
      ? stats.averagePriceCents
      : dollarsToCents(stats.avg) ?? average(availablePrices);

  return {
    property: response.property ?? {
      slug: response.apartment ?? apartmentSlug,
      name: response.apartment ?? apartmentSlug,
    },
    month: response.month || requestedMonth,
    currency: response.currency || 'USD',
    days: days.sort((left, right) => left.date.localeCompare(right.date)),
    stats: {
      availableNightCount:
        typeof stats.availableNightCount === 'number' ? stats.availableNightCount : availablePrices.length,
      minPriceCents: minPriceCents ?? min(availablePrices),
      maxPriceCents: maxPriceCents ?? max(availablePrices),
      averagePriceCents,
    },
    cache: response.cache,
  };
}

function dollarsToCents(value: number | null | undefined): number | null {
  return typeof value === 'number' ? Math.round(value * 100) : null;
}

function average(values: number[]): number | null {
  if (values.length === 0) {
    return null;
  }

  return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function min(values: number[]): number | null {
  return values.length > 0 ? Math.min(...values) : null;
}

function max(values: number[]): number | null {
  return values.length > 0 ? Math.max(...values) : null;
}

function createIdempotencyKey(prefix: string): string {
  const randomId =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

  return `${prefix}-${randomId}`;
}

function pruneOptionalFields<T extends Record<string, unknown>>(value: T): T {
  return Object.entries(value).reduce<Record<string, unknown>>((accumulator, [key, item]) => {
    if (typeof item === 'string') {
      const trimmed = item.trim();
      if (trimmed) {
        accumulator[key] = trimmed;
      }
      return accumulator;
    }

    if (item !== undefined && item !== null) {
      accumulator[key] = item;
    }

    return accumulator;
  }, {}) as T;
}
