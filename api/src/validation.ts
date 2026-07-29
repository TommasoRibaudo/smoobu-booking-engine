import { ApiError, validationError } from "./http/errors";
import { FieldErrors, JsonBody } from "./types";

/**
 * Marketing attribution identifiers forwarded from the browser.
 *
 * Never required, never validated strictly: a malformed cookie must degrade
 * tracking, not fail a booking. Anything that is not a sane short string is
 * silently dropped. See parseTrackingIdentifiers below.
 */
export interface TrackingIdentifiersInput {
  gaClientId?: string;
  gaSessionId?: string;
  fbp?: string;
  fbc?: string;
  gclid?: string;
}

export interface SearchRequest {
  arrivalDate: string;
  departureDate: string;
  guests: number;
  language: "en" | "es";
  discountCode?: string;
  source?: string;
  tracking?: TrackingIdentifiersInput;
  marketingConsent?: boolean;
}

export interface GuestDetails {
  firstName: string;
  lastName: string;
  email: string;
  phone?: string;
  country?: string;
  message?: string;
}

export interface HoldRequest {
  quoteId: string;
  bookingSessionId: string;
  propertyId: string;
  paymentMethod: "paypal";
  guest: GuestDetails;
  portalPassword: string;
  termsAccepted: true;
  marketingConsent?: boolean;
  nonRefundable?: boolean;
  /** Guest is bringing a pet. Only pet-friendly homes accept this. */
  withPet?: boolean;
  /** Re-sent at checkout in case consent was granted after the search. */
  tracking?: TrackingIdentifiersInput;
}

export function assertJsonObject(value: unknown): JsonBody {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError(400, "invalid_json", "Request body must be a JSON object.");
  }

  return value as JsonBody;
}

/**
 * Best-effort extraction of the tracking identifiers.
 *
 * Deliberately never raises. These values come from cookies a guest (or an
 * extension) can freely mangle, and no attribution signal is worth rejecting a
 * booking over — a dropped identifier costs an attributed conversion, a 400
 * costs the sale itself. Values are length-capped so a hostile client cannot
 * push arbitrary payloads into the database.
 */
export function parseTrackingIdentifiers(value: unknown): TrackingIdentifiersInput | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const body = value as Record<string, unknown>;
  const keys: Array<keyof TrackingIdentifiersInput> = ["gaClientId", "gaSessionId", "fbp", "fbc", "gclid"];
  const tracking: TrackingIdentifiersInput = {};

  for (const key of keys) {
    const raw = body[key];
    if (typeof raw === "string") {
      const trimmed = raw.trim();
      if (trimmed && trimmed.length <= 256) {
        tracking[key] = trimmed;
      }
    }
  }

  return Object.keys(tracking).length > 0 ? tracking : undefined;
}

export function validateSearchRequest(value: unknown): SearchRequest {
  const body = assertJsonObject(value);
  const errors: FieldErrors = {};

  const arrivalDate = requireYmd(body, "arrivalDate", errors);
  const departureDate = requireYmd(body, "departureDate", errors);
  const guests = requirePositiveInteger(body, "guests", errors);
  const language = requireLanguage(body, "language", errors);
  const discountCode = optionalTrimmedString(body, "discountCode", errors, 64);
  const source = optionalTrimmedString(body, "source", errors, 64);
  const tracking = parseTrackingIdentifiers(body.tracking);

  if (arrivalDate && isBeforeTodayCostaRica(arrivalDate)) {
    addError(errors, "arrivalDate", "arrival_date_must_be_today_or_future");
  }

  if (arrivalDate && departureDate && departureDate <= arrivalDate) {
    addError(errors, "departureDate", "departure_date_must_be_after_arrival_date");
  }

  assertNoErrors(errors);

  return {
    arrivalDate,
    departureDate,
    guests,
    language,
    discountCode,
    source,
    ...(tracking ? { tracking } : {}),
    marketingConsent: body.marketingConsent === true,
  };
}

export function validateCalendarRequest(
  params: Record<string, string>,
  query: Record<string, string>
): { apartmentSlug: string; month: string; language: "en" | "es" } {
  const errors: FieldErrors = {};
  const apartmentSlug = normalizeSlug(params.apartmentSlug, errors);
  const month = query.month;
  const language = optionalLanguage(query.language, errors);

  if (!month || !/^\d{4}-\d{2}$/.test(month)) {
    addError(errors, "month", "month_must_use_yyyy_mm");
  } else {
    const date = new Date(`${month}-01T00:00:00Z`);
    if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 7) !== month) {
      addError(errors, "month", "month_must_be_valid");
    }
  }

  assertNoErrors(errors);
  return { apartmentSlug, month: month as string, language };
}

export function validateHoldRequest(value: unknown): HoldRequest {
  const body = assertJsonObject(value);
  const errors: FieldErrors = {};
  const guest = validateGuestDetails(body.guest, errors);

  const quoteId = requireTrimmedString(body, "quoteId", errors, 128);
  const bookingSessionId = requireUuid(body, "bookingSessionId", errors);
  const propertyId = requireUuid(body, "propertyId", errors);
  const paymentMethod = body.paymentMethod;
  const portalPassword = requireTrimmedString(body, "portalPassword", errors, 256);

  if (paymentMethod !== "paypal") {
    addError(errors, "paymentMethod", "payment_method_must_be_paypal");
  }

  if (portalPassword && portalPassword.length < 12) {
    addError(errors, "portalPassword", "portal_password_too_short");
  }

  if (body.termsAccepted !== true) {
    addError(errors, "termsAccepted", "terms_must_be_accepted");
  }

  assertNoErrors(errors);

  return {
    quoteId,
    bookingSessionId,
    propertyId,
    paymentMethod: "paypal",
    guest,
    portalPassword,
    termsAccepted: true,
    marketingConsent: body.marketingConsent === true,
    nonRefundable: body.nonRefundable === true,
    withPet: body.withPet === true,
    ...(parseTrackingIdentifiers(body.tracking) ? { tracking: parseTrackingIdentifiers(body.tracking) } : {}),
  };
}

/**
 * Deposit holds take the same shape as PayPal holds minus the payment method and
 * rate options: the deposit path is always the flexible rate, and the discount
 * code is tied to immediate card capture. A pet travels with the guest whichever
 * way they pay, so `withPet` is accepted here too.
 */
export function validateDepositHoldRequest(value: unknown): HoldRequest {
  const body = assertJsonObject(value);
  const errors: FieldErrors = {};
  const guest = validateGuestDetails(body.guest, errors);

  const quoteId = requireTrimmedString(body, "quoteId", errors, 128);
  const bookingSessionId = requireUuid(body, "bookingSessionId", errors);
  const propertyId = requireUuid(body, "propertyId", errors);
  const portalPassword = requireTrimmedString(body, "portalPassword", errors, 256);

  if (portalPassword && portalPassword.length < 12) {
    addError(errors, "portalPassword", "portal_password_too_short");
  }

  if (body.termsAccepted !== true) {
    addError(errors, "termsAccepted", "terms_must_be_accepted");
  }

  assertNoErrors(errors);

  return {
    quoteId,
    bookingSessionId,
    propertyId,
    paymentMethod: "paypal",
    guest,
    portalPassword,
    termsAccepted: true,
    marketingConsent: body.marketingConsent === true,
    nonRefundable: false,
    withPet: body.withPet === true,
    ...(parseTrackingIdentifiers(body.tracking) ? { tracking: parseTrackingIdentifiers(body.tracking) } : {}),
  };
}

/** Extracts the signed staff token from a path parameter. */
export function validateStaffReviewToken(pathParams: Record<string, string>): string {
  const token = pathParams.token?.trim();
  if (!token || token.length < 32 || token.length > 4096) {
    throw new ApiError(400, "invalid_token", "This link is not valid.");
  }
  return token;
}

/**
 * Extracts the signed staff token from the review page's submission.
 *
 * The page is plain HTML with no JavaScript — its CSP allows inline styles and
 * nothing else — so the browser sends `application/x-www-form-urlencoded` rather
 * than JSON. JSON is still accepted for scripted callers and tests.
 */
export function validateStaffReviewSubmit(rawBody: string | undefined, parsedBody: unknown): string {
  let token = "";

  if (parsedBody && typeof parsedBody === "object" && !Array.isArray(parsedBody)) {
    const candidate = (parsedBody as Record<string, unknown>).token;
    if (typeof candidate === "string") {
      token = candidate.trim();
    }
  }

  if (!token && rawBody) {
    token = new URLSearchParams(rawBody).get("token")?.trim() ?? "";
  }

  if (!token || token.length < 32 || token.length > 4096) {
    throw new ApiError(400, "invalid_token", "This link is not valid.");
  }

  return token;
}

export function validateBookingSessionRequest(value: unknown): { bookingSessionId: string } {
  const body = assertJsonObject(value);
  const errors: FieldErrors = {};
  const bookingSessionId = requireUuid(body, "bookingSessionId", errors);
  assertNoErrors(errors);
  return { bookingSessionId };
}

export function validateBookingSessionPathParams(params: Record<string, string>): { bookingSessionId: string } {
  const errors: FieldErrors = {};
  const bookingSessionId = requireUuid(params, "bookingSessionId", errors);
  assertNoErrors(errors);
  return { bookingSessionId };
}

export function validatePayPalCaptureRequest(value: unknown): {
  bookingSessionId: string;
  paypalOrderId: string;
} {
  const body = assertJsonObject(value);
  const errors: FieldErrors = {};
  const bookingSessionId = requireUuid(body, "bookingSessionId", errors);
  const paypalOrderId = requireTrimmedString(body, "paypalOrderId", errors, 128);
  assertNoErrors(errors);
  return { bookingSessionId, paypalOrderId };
}

export function validatePayPalCapturePathRequest(
  params: Record<string, string>,
  value: unknown
): {
  bookingSessionId: string;
  paypalOrderId: string;
} {
  const body = assertJsonObject(value);
  const errors: FieldErrors = {};
  const bookingSessionId = requireUuid(params, "bookingSessionId", errors);
  const paypalOrderId = requireTrimmedString(body, "paypalOrderId", errors, 128);
  assertNoErrors(errors);
  return { bookingSessionId, paypalOrderId };
}

export function validateDepositHandoffQuery(query: Record<string, string>): {
  language: "en" | "es";
  quoteId?: string;
  propertyId?: string;
} {
  const errors: FieldErrors = {};
  const language = requireQueryLanguage(query.language, errors);
  const quoteId = optionalQueryString(query.quoteId, "quoteId", errors, 128);
  const propertyId = optionalUuid(query.propertyId, "propertyId", errors);
  assertNoErrors(errors);
  return { language, quoteId, propertyId };
}

export function validateDepositHandoffEvent(value: unknown): {
  quoteId: string;
  propertyId: string;
  language: "en" | "es";
  contactMethod: string;
  analyticsConsent: boolean;
} {
  const body = assertJsonObject(value);
  const errors: FieldErrors = {};
  const quoteId = requireTrimmedString(body, "quoteId", errors, 128);
  const propertyId = requireUuid(body, "propertyId", errors);
  const language = requireLanguage(body, "language", errors);
  const contactMethod = requireTrimmedString(body, "contactMethod", errors, 32);

  assertNoErrors(errors);

  return {
    quoteId,
    propertyId,
    language,
    contactMethod,
    analyticsConsent: body.analyticsConsent === true,
  };
}

export function validateDepositReceiptUploadUrlRequest(value: unknown): {
  bookingSessionId: string;
  fileName: string;
  contentType: string;
} {
  const body = assertJsonObject(value);
  const errors: FieldErrors = {};
  const bookingSessionId = requireUuid(body, "bookingSessionId", errors);
  const fileName = requireTrimmedString(body, "fileName", errors, 128);
  const contentType = requireTrimmedString(body, "contentType", errors, 64);

  assertNoErrors(errors);
  return { bookingSessionId, fileName, contentType };
}

export function validateDepositReceiptConfirmRequest(value: unknown): {
  bookingSessionId: string;
  s3Key: string;
} {
  const body = assertJsonObject(value);
  const errors: FieldErrors = {};
  const bookingSessionId = requireUuid(body, "bookingSessionId", errors);
  const s3Key = requireTrimmedString(body, "s3Key", errors, 512);

  assertNoErrors(errors);
  return { bookingSessionId, s3Key };
}

export function validatePortalLogin(value: unknown): {
  reservationPublicId: string;
  password: string;
  language: "en" | "es";
} {
  const body = assertJsonObject(value);
  const errors: FieldErrors = {};
  const reservationPublicId = requireTrimmedString(body, "reservationPublicId", errors, 64);
  const password = requireTrimmedString(body, "password", errors, 256);
  const language = requireLanguage(body, "language", errors);
  assertNoErrors(errors);
  return { reservationPublicId, password, language };
}

export function validatePortalMessage(value: unknown): { type?: string; message: string } {
  const body = assertJsonObject(value);
  const errors: FieldErrors = {};
  const type = optionalTrimmedString(body, "type", errors, 32);
  const message = requireTrimmedString(body, "message", errors, 2000);
  assertNoErrors(errors);
  return { type, message };
}

export function validateCancellationRequest(value: unknown): { reason: string; message?: string } {
  const body = assertJsonObject(value);
  const errors: FieldErrors = {};
  const reason = requireTrimmedString(body, "reason", errors, 512);
  const message = optionalTrimmedString(body, "message", errors, 2000);
  assertNoErrors(errors);
  return { reason, message };
}

export function validateReservationPublicId(params: Record<string, string>): string {
  const value = params.reservationPublicId;
  if (!value || !/^[A-Za-z0-9-]{6,64}$/.test(value)) {
    throw validationError({ reservationPublicId: ["reservation_public_id_invalid"] });
  }

  return value;
}

export function validateGuestUpdateRequest(value: unknown): { guests: number } {
  const body = assertJsonObject(value);
  const errors: FieldErrors = {};
  const guests = requirePositiveInteger(body, "guests", errors);
  assertNoErrors(errors);
  return { guests };
}

function validateGuestDetails(value: unknown, errors: FieldErrors): GuestDetails {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    addError(errors, "guest", "guest_must_be_object");
    return { firstName: "", lastName: "", email: "" };
  }

  const body = value as JsonBody;
  const firstName = requireTrimmedString(body, "firstName", errors, 80, "guest.firstName");
  const lastName = requireTrimmedString(body, "lastName", errors, 80, "guest.lastName");
  const email = requireTrimmedString(body, "email", errors, 254, "guest.email");
  const phone = optionalTrimmedString(body, "phone", errors, 40, "guest.phone");
  const country = optionalTrimmedString(body, "country", errors, 100, "guest.country");
  const message = optionalTrimmedString(body, "message", errors, 2000, "guest.message");

  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    addError(errors, "guest.email", "email_invalid");
  }

  return { firstName, lastName, email, phone, country, message };
}

function requireTrimmedString(
  body: JsonBody,
  key: string,
  errors: FieldErrors,
  maxLength: number,
  errorKey = key
): string {
  const value = body[key];
  if (typeof value !== "string" || !value.trim()) {
    addError(errors, errorKey, "required");
    return "";
  }

  const trimmed = value.trim();
  if (trimmed.length > maxLength) {
    addError(errors, errorKey, "too_long");
  }

  return trimmed;
}

function optionalTrimmedString(
  body: JsonBody,
  key: string,
  errors: FieldErrors,
  maxLength: number,
  errorKey = key
): string | undefined {
  const value = body[key];
  if (value === undefined || value === null || value === "") {
    return undefined;
  }

  if (typeof value !== "string") {
    addError(errors, errorKey, "must_be_string");
    return undefined;
  }

  const trimmed = value.trim();
  if (trimmed.length > maxLength) {
    addError(errors, errorKey, "too_long");
  }

  return trimmed;
}

function optionalQueryString(
  value: string | undefined,
  key: string,
  errors: FieldErrors,
  maxLength: number
): string | undefined {
  if (!value) {
    return undefined;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }

  if (trimmed.length > maxLength) {
    addError(errors, key, "too_long");
  }

  return trimmed;
}

function requireYmd(body: JsonBody, key: string, errors: FieldErrors): string {
  const value = requireTrimmedString(body, key, errors, 10);
  if (value && !isYmd(value)) {
    addError(errors, key, "date_must_use_yyyy_mm_dd");
  }

  return value;
}

function requirePositiveInteger(body: JsonBody, key: string, errors: FieldErrors): number {
  const value = body[key];
  if (!Number.isInteger(value) || Number(value) <= 0) {
    addError(errors, key, "must_be_positive_integer");
    return 0;
  }

  return Number(value);
}

function requireLanguage(body: JsonBody, key: string, errors: FieldErrors): "en" | "es" {
  const value = body[key];
  if (value !== "en" && value !== "es") {
    addError(errors, key, "language_must_be_en_or_es");
    return "en";
  }

  return value;
}

function requireQueryLanguage(value: string | undefined, errors: FieldErrors): "en" | "es" {
  if (value !== "en" && value !== "es") {
    addError(errors, "language", "language_must_be_en_or_es");
    return "en";
  }

  return value;
}

function optionalLanguage(value: string | undefined, errors: FieldErrors): "en" | "es" {
  if (!value) {
    return "en";
  }

  if (value !== "en" && value !== "es") {
    addError(errors, "language", "language_must_be_en_or_es");
    return "en";
  }

  return value;
}

function requireUuid(body: JsonBody, key: string, errors: FieldErrors): string {
  const value = requireTrimmedString(body, key, errors, 36);
  if (value && !isUuid(value)) {
    addError(errors, key, "uuid_invalid");
  }

  return value;
}

function optionalUuid(value: string | undefined, key: string, errors: FieldErrors): string | undefined {
  if (!value) {
    return undefined;
  }

  if (!isUuid(value)) {
    addError(errors, key, "uuid_invalid");
  }

  return value;
}

function normalizeSlug(value: string | undefined, errors: FieldErrors): string {
  if (!value) {
    addError(errors, "apartmentSlug", "slug_required");
    return "";
  }

  const canonical = value.endsWith("ES") ? value.slice(0, -2) : value;
  if (!/^[A-Za-z0-9]+$/.test(canonical)) {
    addError(errors, "apartmentSlug", "slug_invalid");
  }

  return canonical;
}

function isYmd(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }

  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function isBeforeTodayCostaRica(value: string): boolean {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Costa_Rica",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());

  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const today = `${byType.year}-${byType.month}-${byType.day}`;

  return value < today;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value
  );
}

function addError(errors: FieldErrors, field: string, code: string): void {
  errors[field] = [...(errors[field] ?? []), code];
}

function assertNoErrors(errors: FieldErrors): void {
  if (Object.keys(errors).length > 0) {
    throw validationError(errors);
  }
}
