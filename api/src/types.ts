import type { BookingSessionRepository } from "./bookingSessions";
import type { EmailConfig } from "./email";
import type { HoldRepository, SmoobuHoldChannelId } from "./holds";
import type { PaymentRepository } from "./payments";
import type { WebhookEventRepository } from "./paypalWebhooks";
import type { PortalSessionRepository } from "./portalSessions";
import type { ServerConversionConfig } from "./serverConversions";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS";

export type HeadersMap = Record<string, string>;

export interface LambdaHttpRequest {
  version?: string;
  routeKey?: string;
  rawPath?: string;
  path?: string;
  httpMethod?: string;
  rawQueryString?: string;
  queryStringParameters?: Record<string, string | undefined> | null;
  headers?: Record<string, string | undefined> | null;
  body?: string | null;
  isBase64Encoded?: boolean;
  requestContext?: {
    requestId?: string;
    http?: {
      method?: string;
      path?: string;
      sourceIp?: string;
      userAgent?: string;
    };
    identity?: {
      sourceIp?: string;
      userAgent?: string;
    };
  };
}

export interface ApiResponse {
  statusCode: number;
  headers: HeadersMap;
  body: string;
  isBase64Encoded?: false;
}

export interface RouteRequest {
  method: HttpMethod;
  path: string;
  headers: HeadersMap;
  responseHeaders: HeadersMap;
  query: Record<string, string>;
  pathParams: Record<string, string>;
  body: unknown;
  rawBody: string;
  correlationId: string;
  clientIp?: string;
  userAgent?: string;
  awsRequestId?: string;
  observability: RouteObservability;
}

export interface JsonBody {
  [key: string]: unknown;
}

export type RouteHandler = (request: RouteRequest) => Promise<ApiResponse> | ApiResponse;

export type AbuseProtectionPolicyName =
  | "publicRead"
  | "availabilitySearch"
  | "holdCreate"
  | "paymentCreate"
  | "paymentCapture"
  | "depositEvent"
  | "webhook"
  | "portalLogin"
  | "portalRead"
  | "portalWrite";

export interface RouteOptions {
  requireJsonBody?: boolean;
  requireIdempotencyKey?: boolean;
  preserveRawBody?: boolean;
  rejectQuerySecrets?: boolean;
  /**
   * Accept `application/x-www-form-urlencoded` instead of rejecting it with 415.
   * Only the staff deposit-review page needs this: it is server-rendered HTML
   * whose CSP forbids scripts, so the browser submits a native form rather than
   * a JSON fetch. The handler reads `request.rawBody`.
   */
  allowFormEncodedBody?: boolean;
  abuseProtection?: AbuseProtectionPolicyName;
}

export interface RouteDefinition {
  method: HttpMethod;
  pattern: string;
  options: RouteOptions;
  handler: RouteHandler;
}

export interface PayPalClientConfig {
  /** Base URL of the PayPal API. Use the sandbox URL for non-production environments. */
  baseUrl: string;
  timeoutMs: number;
  /** Return URL after buyer approves (redirect flow). Leave empty when using the JS SDK. */
  orderReturnUrl: string;
  /** Cancel URL if buyer cancels (redirect flow). Leave empty when using the JS SDK. */
  orderCancelUrl: string;
}

export interface DepositConfig {
  /**
   * How long the Smoobu hold survives while the bank transfer clears. Longer
   * than a PayPal hold by design, but it blocks inventory on all channels for
   * that whole window, so it is capped by the sliding rule in depositHolds.ts.
   */
  holdTtlHours: number;
  /** Lifetime of the signed confirm/reject link emailed to staff. */
  confirmTokenTtlHours: number;
  /** Public base URL the staff confirmation link points at. */
  staffConfirmBaseUrl: string;
  /** Default bank transfer / SINPE details shown to guests paying by manual deposit. */
  bank?: DepositBankAccountConfig;
  /**
   * Optional per-property override, keyed by property slug, for portfolios that
   * settle different properties into different bank accounts (e.g. separate
   * legal entities). Falls back to `bank` for any slug not listed here.
   */
  bankByPropertySlug?: Record<string, DepositBankAccountConfig>;
}

export interface DepositBankAccountConfig {
  accountHolder: string;
  /** Label + account/IBAN for the primary currency, e.g. USD. */
  primaryAccountLabel: string;
  primaryAccount: string;
  /** Label + account/IBAN for a secondary currency, e.g. the local currency. */
  secondaryAccountLabel?: string;
  secondaryAccount?: string;
  /** Costa Rica SINPE Móvil details, if applicable. Omit outside that market. */
  sinpePhone?: string;
  sinpeName?: string;
}

export interface S3UploadConfig {
  /** S3 bucket name for deposit receipt uploads. */
  bucketName: string;
  /** AWS region of the S3 bucket. */
  region: string;
  /** Presigned PUT URL expiry in seconds. Default: 300 (5 minutes). */
  presignedPutExpirySeconds: number;
  /** Presigned GET URL expiry in seconds. Default: 604800 (7 days). */
  presignedGetExpirySeconds: number;
  /** Maximum upload size in bytes. Default: 10 MB. */
  maxFileSizeBytes: number;
  /** Allowed MIME types for deposit receipt uploads. */
  allowedMimeTypes: string[];
  /**
   * Override the S3 endpoint. Only set for local development against MinIO —
   * unset in AWS so the SDK resolves the real regional endpoint.
   */
  endpointUrl?: string;
}

export interface BookingApiConfig {
  allowedOrigins: string[];
  maxBodyBytes: number;
  secrets: BookingSecretProvider;
  smoobu: SmoobuClientConfig;
  paypal: PayPalClientConfig;
  email: EmailConfig;
  s3Upload?: S3UploadConfig;
  deposit?: DepositConfig;
  bookingSessions?: BookingSessionRepository;
  holds?: HoldRepository;
  payments?: PaymentRepository;
  webhookEvents?: WebhookEventRepository;
  portalSessions?: PortalSessionRepository;
  hold: HoldConfig;
  abuseProtection: AbuseProtectionConfig;
  observability: ObservabilityConfig;
  /** USD → CRC display rate. Omitted entirely falls back to the built-in providers. */
  exchangeRate?: ExchangeRateConfig;
  /**
   * Server-side conversion reporting. Optional like `s3Upload` and `deposit`:
   * omitted entirely — or present without a measurement/pixel ID and the
   * matching secret — leaves the reporter inert.
   */
  serverConversions?: ServerConversionConfig;
}

export interface SmoobuClientConfig {
  baseUrl: string;
  customerId?: number;
  timeoutMs: number;
  maxRetries: number;
  baseBackoffMs: number;
  maxBackoffMs: number;
  maxRateLimitDelayMs: number;
  holdChannelId: SmoobuHoldChannelId;
}

/**
 * Display-only currency conversion — see `exchangeRate.ts`. Every value is
 * optional so the endpoint works out of the box and can still be repointed at a
 * different rate source per environment.
 */
export interface ExchangeRateConfig {
  /** Tried in order until one answers with a plausible rate. */
  providerUrls?: string[];
  ttlSeconds?: number;
  timeoutMs?: number;
  /** Oldest a cached rate may be before the endpoint stops serving it. */
  staleMaxAgeSeconds?: number;
}

export interface HoldConfig {
  defaultTtlMinutes: number;
  idempotencyTtlMinutes: number;
  staleIdempotencyLockSeconds: number;
}

export type CaptchaProvider = "hcaptcha" | "recaptcha";

export interface CaptchaVerifierConfig {
  provider: CaptchaProvider;
  /**
   * Verification secret. When omitted, it is resolved lazily from the combined
   * Secrets Manager entry (`BookingProviderSecrets.captchaSecretKey`) so the live
   * secret never has to be materialised into a Lambda environment variable.
   */
  secretKey?: string;
  /** Override the verification endpoint (useful for tests). Defaults to the provider's production URL. */
  verifyUrl?: string;
}

export interface AbuseProtectionConfig {
  enabled: boolean;
  captchaChallengesEnabled: boolean;
  maxTrackedBuckets: number;
  /** When set, inbound X-Captcha-Token headers are verified against the provider before allowing bypass. */
  captchaVerifier?: CaptchaVerifierConfig;
}

export type FieldErrors = Record<string, string[]>;

export interface BookingProviderSecrets {
  smoobuApiKey: string;
  /** HMAC signing secret — see docs.smoobu.com/#hmac-authentication. Every request is signed with this. */
  smoobuApiSecret: string;
  smoobuWebhookSecret: string;
  paypalClientId: string;
  paypalClientSecret: string;
  paypalWebhookId: string;
  bookingEncryptionKeyBase64: string;
  portalSessionSecret: string;
  rdsConnectionString: string;
  /**
   * Optional — CAPTCHA provider verification secret. Absent entries simply leave
   * CAPTCHA challenges unbypassable rather than failing secret validation.
   */
  captchaSecretKey?: string;
  /**
   * Optional — GA4 Measurement Protocol API secret, created under the data
   * stream. Absent simply disables server-side GA4 reporting.
   */
  ga4ApiSecret?: string;
  /**
   * Optional — Meta Conversions API access token. Absent simply disables
   * server-side Meta reporting.
   */
  metaCapiAccessToken?: string;
}

export interface BookingSecretProvider {
  readonly source: "aws-secrets-manager-extension" | "aws-secrets-manager-sdk" | "static" | "missing" | "invalid";
  getSecrets(): Promise<BookingProviderSecrets>;
}

export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";

export interface ObservabilityConfig {
  serviceName: string;
  environment: string;
  logLevel: LogLevel;
  metricsEnabled: boolean;
}

export interface ObservabilityLogger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export type ProviderName = "smoobu" | "paypal" | "database" | "cache" | "email" | "internal";

export interface ProviderCallObservation {
  provider: ProviderName;
  operation: string;
  durationMs: number;
  statusCode?: number;
  retryable?: boolean;
  rateLimitRemaining?: number;
  rateLimitResetSeconds?: number;
  errorCode?: string;
  /** Raw provider-side error detail (e.g. PayPal's `details[0].description`), kept alongside the mapped `errorCode` so logs stay diagnosable even when `errorCode` falls back to a generic bucket. */
  errorDetail?: string;
}

export interface StateTransitionObservation {
  entityType: "booking_session" | "hold" | "payment" | "webhook_event" | "portal_session";
  fromState?: string;
  toState: string;
  action: string;
  success: boolean;
  bookingSessionId?: string;
  reservationPublicId?: string;
  provider?: ProviderName;
  providerObjectId?: string;
  errorCode?: string;
  errorDetail?: string;
}

export interface SecurityEventObservation {
  name: string;
  severity: "info" | "warn" | "error";
  route?: string;
  provider?: ProviderName;
  errorCode?: string;
  bookingSessionId?: string;
}

export interface RouteObservability {
  logger: ObservabilityLogger;
  recordProviderCall(observation: ProviderCallObservation): void;
  recordStateTransition(observation: StateTransitionObservation): void;
  recordSecurityEvent(observation: SecurityEventObservation): void;
}
