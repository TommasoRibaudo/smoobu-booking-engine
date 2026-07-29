import { BookingApiConfig, CaptchaProvider, CaptchaVerifierConfig, DepositBankAccountConfig, ExchangeRateConfig, LogLevel, S3UploadConfig } from "./types";
import { SmoobuHoldChannelId } from "./holds";
import { createSecretProvider } from "./secrets";

const DEFAULT_MAX_BODY_BYTES = 64 * 1024;
const DEFAULT_MAX_TRACKED_RATE_LIMIT_BUCKETS = 10_000;
const DEFAULT_SERVICE_NAME = "booking-api";
const DEFAULT_SMOOBU_BASE_URL = "https://login.smoobu.com";
const DEFAULT_SMOOBU_TIMEOUT_MS = 8_000;
const DEFAULT_SMOOBU_MAX_RETRIES = 3;
const DEFAULT_SMOOBU_BASE_BACKOFF_MS = 250;
const DEFAULT_SMOOBU_MAX_BACKOFF_MS = 2_000;
const DEFAULT_SMOOBU_MAX_RATE_LIMIT_DELAY_MS = 60_000;
const DEFAULT_SMOOBU_HOLD_CHANNEL_ID = 11;
const DEFAULT_PAYPAL_BASE_URL = "https://api-m.sandbox.paypal.com";
const DEFAULT_PAYPAL_TIMEOUT_MS = 10_000;
const DEFAULT_PAYPAL_HOLD_TTL_MINUTES = 60;
const DEFAULT_IDEMPOTENCY_TTL_MINUTES = 24 * 60;
const DEFAULT_STALE_IDEMPOTENCY_LOCK_SECONDS = 120;
// Long enough for a bank transfer or SINPE to clear and for staff to see it,
// short enough that an abandoned deposit does not hold inventory for days.
const DEFAULT_DEPOSIT_HOLD_TTL_HOURS = 36;
// The staff confirm link outlives the hold on purpose: a transfer that arrives
// late should still be actionable, and confirming re-checks the hold state.
const DEFAULT_DEPOSIT_CONFIRM_TOKEN_TTL_HOURS = 168;
const DEFAULT_SES_REGION = "us-east-1";
const DEFAULT_SES_FROM_ADDRESS = "reservations@example.com";
const DEFAULT_S3_PRESIGNED_PUT_EXPIRY_SECONDS = 300;
const DEFAULT_S3_PRESIGNED_GET_EXPIRY_SECONDS = 604_800;
const DEFAULT_S3_MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB
const DEFAULT_S3_ALLOWED_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "application/pdf",
];

function splitCsv(value: string | undefined): string[] {
  if (!value) {
    return [];
  }

  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseMaxBodyBytes(value: string | undefined): number {
  if (!value) {
    return DEFAULT_MAX_BODY_BYTES;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return DEFAULT_MAX_BODY_BYTES;
  }

  return parsed;
}

function parseBoolean(value: string | undefined, defaultValue: boolean): boolean {
  if (!value) {
    return defaultValue;
  }

  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }

  return defaultValue;
}

function parsePositiveInteger(value: string | undefined, defaultValue: number): number {
  if (!value) {
    return defaultValue;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return defaultValue;
  }

  return parsed;
}

function parseLogLevel(value: string | undefined): LogLevel {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "debug" || normalized === "info" || normalized === "warn" || normalized === "error" || normalized === "silent") {
    return normalized;
  }

  return "info";
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): BookingApiConfig {
  const secrets = createSecretProvider(env);
  return {
    allowedOrigins: splitCsv(env.BOOKING_API_ALLOWED_ORIGINS),
    maxBodyBytes: parseMaxBodyBytes(env.BOOKING_API_MAX_BODY_BYTES),
    secrets,
    smoobu: {
      baseUrl: normalizeBaseUrl(env.SMOOBU_BASE_URL, DEFAULT_SMOOBU_BASE_URL),
      customerId: parseOptionalPositiveInteger(env.SMOOBU_CUSTOMER_ID, "SMOOBU_CUSTOMER_ID"),
      timeoutMs: parsePositiveInteger(env.SMOOBU_TIMEOUT_MS, DEFAULT_SMOOBU_TIMEOUT_MS),
      maxRetries: parseNonNegativeInteger(env.SMOOBU_MAX_RETRIES, DEFAULT_SMOOBU_MAX_RETRIES),
      baseBackoffMs: parsePositiveInteger(env.SMOOBU_BASE_BACKOFF_MS, DEFAULT_SMOOBU_BASE_BACKOFF_MS),
      maxBackoffMs: parsePositiveInteger(env.SMOOBU_MAX_BACKOFF_MS, DEFAULT_SMOOBU_MAX_BACKOFF_MS),
      maxRateLimitDelayMs: parsePositiveInteger(
        env.SMOOBU_MAX_RATE_LIMIT_DELAY_MS,
        DEFAULT_SMOOBU_MAX_RATE_LIMIT_DELAY_MS
      ),
      holdChannelId: parseSmoobuHoldChannelId(env.SMOOBU_HOLD_CHANNEL_ID),
    },
    paypal: {
      baseUrl: normalizeBaseUrl(env.PAYPAL_BASE_URL, DEFAULT_PAYPAL_BASE_URL),
      timeoutMs: parsePositiveInteger(env.PAYPAL_TIMEOUT_MS, DEFAULT_PAYPAL_TIMEOUT_MS),
      orderReturnUrl: env.PAYPAL_ORDER_RETURN_URL?.trim() ?? "",
      orderCancelUrl: env.PAYPAL_ORDER_CANCEL_URL?.trim() ?? "",
    },
    hold: {
      defaultTtlMinutes: parsePositiveInteger(env.PAYPAL_HOLD_TTL_MINUTES, DEFAULT_PAYPAL_HOLD_TTL_MINUTES),
      idempotencyTtlMinutes: parsePositiveInteger(
        env.BOOKING_API_IDEMPOTENCY_TTL_MINUTES,
        DEFAULT_IDEMPOTENCY_TTL_MINUTES
      ),
      staleIdempotencyLockSeconds: parsePositiveInteger(
        env.BOOKING_API_STALE_IDEMPOTENCY_LOCK_SECONDS,
        DEFAULT_STALE_IDEMPOTENCY_LOCK_SECONDS
      ),
    },
    abuseProtection: {
      enabled: parseBoolean(env.BOOKING_API_ABUSE_PROTECTION_ENABLED, true),
      captchaChallengesEnabled: parseBoolean(env.BOOKING_API_CAPTCHA_CHALLENGES_ENABLED, true),
      maxTrackedBuckets: parsePositiveInteger(
        env.BOOKING_API_RATE_LIMIT_MAX_BUCKETS,
        DEFAULT_MAX_TRACKED_RATE_LIMIT_BUCKETS
      ),
      captchaVerifier: parseCaptchaVerifierConfig(env),
    },
    email: {
      fromAddress: env.SES_FROM_ADDRESS?.trim() || DEFAULT_SES_FROM_ADDRESS,
      region: env.SES_REGION?.trim() || env.AWS_REGION?.trim() || DEFAULT_SES_REGION,
      disabled: parseBoolean(env.EMAIL_DISABLED, false),
      configurationSetName: env.SES_CONFIG_SET?.trim() || undefined,
      staffNotificationEmail: env.STAFF_NOTIFICATION_EMAIL?.trim() || undefined,
      contactWhatsAppUrl: env.CONTACT_WHATSAPP_URL?.trim() || undefined,
      contactEmail: env.CONTACT_EMAIL?.trim() || undefined,
    },
    s3Upload: parseS3UploadConfig(env),
    exchangeRate: parseExchangeRateConfig(env),
    deposit: {
      holdTtlHours: parsePositiveInteger(env.DEPOSIT_HOLD_TTL_HOURS, DEFAULT_DEPOSIT_HOLD_TTL_HOURS),
      confirmTokenTtlHours: parsePositiveInteger(
        env.DEPOSIT_CONFIRM_TOKEN_TTL_HOURS,
        DEFAULT_DEPOSIT_CONFIRM_TOKEN_TTL_HOURS
      ),
      staffConfirmBaseUrl: env.DEPOSIT_STAFF_CONFIRM_BASE_URL?.trim() || "",
      bank: parseDepositBankConfig(env),
      bankByPropertySlug: parseDepositBankAccountsBySlug(env),
    },
    observability: {
      serviceName: env.BOOKING_API_SERVICE_NAME?.trim() || DEFAULT_SERVICE_NAME,
      environment: env.BOOKING_API_ENVIRONMENT?.trim() || env.NODE_ENV?.trim() || "local",
      logLevel: parseLogLevel(env.BOOKING_API_LOG_LEVEL),
      metricsEnabled: parseBoolean(env.BOOKING_API_METRICS_ENABLED, true),
    },
    // The API secret and CAPI token are resolved lazily from Secrets Manager at
    // call time, so only the public IDs live here. With both halves absent the
    // reporter is inert, which is what lets this ship before the secrets exist.
    serverConversions: {
      ...(env.GA4_MEASUREMENT_ID?.trim() ? { ga4MeasurementId: env.GA4_MEASUREMENT_ID.trim() } : {}),
      ...(env.META_PIXEL_ID?.trim() ? { metaPixelId: env.META_PIXEL_ID.trim() } : {}),
      ...(env.META_TEST_EVENT_CODE?.trim() ? { metaTestEventCode: env.META_TEST_EVENT_CODE.trim() } : {}),
      debug: parseBoolean(env.SERVER_CONVERSIONS_DEBUG, false),
    },
  };
}

function parseSmoobuHoldChannelId(value: string | undefined): SmoobuHoldChannelId {
  if (!value) {
    return DEFAULT_SMOOBU_HOLD_CHANNEL_ID;
  }

  const parsed = Number(value);
  if (parsed === 11 || parsed === 13) {
    return parsed;
  }

  // eslint-disable-next-line no-console
  console.warn(`[booking-api] Ignoring invalid SMOOBU_HOLD_CHANNEL_ID value: expected 11 or 13, got "${value}"`);
  return DEFAULT_SMOOBU_HOLD_CHANNEL_ID;
}

function parseOptionalPositiveInteger(value: string | undefined, envName?: string): number | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = Number(value);
  if (Number.isInteger(parsed) && parsed > 0) {
    return parsed;
  }

  if (envName) {
    // eslint-disable-next-line no-console
    console.warn(`[booking-api] Ignoring invalid ${envName} value: expected a positive integer, got "${value}"`);
  }

  return undefined;
}

function parseNonNegativeInteger(value: string | undefined, defaultValue: number): number {
  if (!value) {
    return defaultValue;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    return defaultValue;
  }

  return parsed;
}

function normalizeBaseUrl(value: string | undefined, defaultValue: string): string {
  const raw = value?.trim() || defaultValue;
  try {
    const parsed = new URL(raw);
    // Env parsing fails closed to the production Smoobu origin; the client
    // constructor still re-validates for manually constructed test clients.
    if (parsed.protocol !== "https:" && parsed.hostname !== "localhost") {
      return defaultValue;
    }
    return parsed.toString().replace(/\/+$/, "");
  } catch {
    return defaultValue;
  }
}

/**
 * The browser mints Google reCAPTCHA v3 tokens (see `REACT_APP_CAPTCHA_SITE_KEY` and
 * `react-google-recaptcha-v3` in the frontend), so "recaptcha" is the default here.
 * A mismatched provider silently fails every verification and makes CAPTCHA
 * challenges unbypassable, so the default must track what the client actually sends.
 */
const DEFAULT_CAPTCHA_PROVIDER: CaptchaProvider = "recaptcha";

function parseCaptchaVerifierConfig(env: NodeJS.ProcessEnv): CaptchaVerifierConfig | undefined {
  const secretKey = env.CAPTCHA_SECRET_KEY?.trim();
  const rawProvider = env.CAPTCHA_PROVIDER?.trim().toLowerCase();

  // No explicit configuration at all: the secret may still arrive via Secrets Manager,
  // so build a verifier on the default provider rather than disabling verification.
  let provider: CaptchaProvider;
  if (rawProvider === "recaptcha" || rawProvider === "hcaptcha") {
    provider = rawProvider;
  } else {
    if (rawProvider) {
      // eslint-disable-next-line no-console
      console.warn(
        `[booking-api] Unrecognized CAPTCHA_PROVIDER value "${env.CAPTCHA_PROVIDER}"; expected "hcaptcha" or "recaptcha". Defaulting to "${DEFAULT_CAPTCHA_PROVIDER}".`
      );
    }
    provider = DEFAULT_CAPTCHA_PROVIDER;
  }

  const verifyUrl = env.CAPTCHA_VERIFY_URL?.trim() || undefined;

  return {
    provider,
    ...(secretKey ? { secretKey } : {}),
    ...(verifyUrl ? { verifyUrl } : {}),
  };
}

/**
 * Every field is an override; returning `undefined` leaves `exchangeRate.ts` on
 * its built-in providers and TTLs. Provider URLs must be HTTPS — the rate is
 * rendered as a payable amount, so a plaintext source is a tampering vector even
 * though nothing is charged in colones.
 */
function parseExchangeRateConfig(env: NodeJS.ProcessEnv): ExchangeRateConfig | undefined {
  const providerUrls = splitCsv(env.EXCHANGE_RATE_PROVIDER_URLS).filter((url) => {
    try {
      return new URL(url).protocol === "https:";
    } catch {
      // eslint-disable-next-line no-console
      console.warn(`[booking-api] Ignoring invalid EXCHANGE_RATE_PROVIDER_URLS entry: "${url}"`);
      return false;
    }
  });

  const ttlSeconds = parseOptionalPositiveInteger(env.EXCHANGE_RATE_TTL_SECONDS, "EXCHANGE_RATE_TTL_SECONDS");
  const timeoutMs = parseOptionalPositiveInteger(env.EXCHANGE_RATE_TIMEOUT_MS, "EXCHANGE_RATE_TIMEOUT_MS");
  const staleMaxAgeSeconds = parseOptionalPositiveInteger(
    env.EXCHANGE_RATE_STALE_MAX_AGE_SECONDS,
    "EXCHANGE_RATE_STALE_MAX_AGE_SECONDS"
  );

  if (providerUrls.length === 0 && ttlSeconds === undefined && timeoutMs === undefined && staleMaxAgeSeconds === undefined) {
    return undefined;
  }

  return {
    ...(providerUrls.length > 0 ? { providerUrls } : {}),
    ...(ttlSeconds !== undefined ? { ttlSeconds } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(staleMaxAgeSeconds !== undefined ? { staleMaxAgeSeconds } : {}),
  };
}

/**
 * Manual-deposit bank/SINPE details are entirely deployment-specific, so there
 * is no baked-in default account — omitting these env vars simply leaves
 * `deposit.bank` undefined and `depositHandoff.ts` falls back to an inert
 * placeholder that tells staff to finish configuring it.
 */
function parseDepositBankConfig(env: NodeJS.ProcessEnv): DepositBankAccountConfig | undefined {
  const accountHolder = env.DEPOSIT_BANK_ACCOUNT_HOLDER?.trim();
  const primaryAccount = env.DEPOSIT_BANK_PRIMARY_ACCOUNT?.trim();
  if (!accountHolder || !primaryAccount) {
    return undefined;
  }

  return {
    accountHolder,
    primaryAccountLabel: env.DEPOSIT_BANK_PRIMARY_LABEL?.trim() || "Bank account",
    primaryAccount,
    ...(env.DEPOSIT_BANK_SECONDARY_ACCOUNT?.trim()
      ? {
          secondaryAccountLabel: env.DEPOSIT_BANK_SECONDARY_LABEL?.trim() || "Alternate account",
          secondaryAccount: env.DEPOSIT_BANK_SECONDARY_ACCOUNT.trim(),
        }
      : {}),
    ...(env.DEPOSIT_SINPE_PHONE?.trim()
      ? {
          sinpePhone: env.DEPOSIT_SINPE_PHONE.trim(),
          sinpeName: env.DEPOSIT_SINPE_NAME?.trim() || accountHolder,
        }
      : {}),
  };
}

/**
 * Optional per-property override for portfolios that settle different
 * properties into different bank accounts (e.g. separate legal entities).
 * Expects a JSON object keyed by property slug, each value shaped like
 * `DepositBankAccountConfig`.
 */
function parseDepositBankAccountsBySlug(env: NodeJS.ProcessEnv): Record<string, DepositBankAccountConfig> | undefined {
  const raw = env.DEPOSIT_BANK_ACCOUNTS_BY_SLUG_JSON?.trim();
  if (!raw) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, DepositBankAccountConfig>;
    }
  } catch {
    // eslint-disable-next-line no-console
    console.warn("[booking-api] Ignoring invalid DEPOSIT_BANK_ACCOUNTS_BY_SLUG_JSON: not valid JSON");
  }

  return undefined;
}

function parseS3UploadConfig(env: NodeJS.ProcessEnv): S3UploadConfig | undefined {
  const bucketName = env.S3_DEPOSIT_RECEIPT_BUCKET?.trim();
  if (!bucketName) {
    return undefined;
  }

  return {
    bucketName,
    region: env.S3_DEPOSIT_RECEIPT_REGION?.trim() || env.AWS_REGION?.trim() || "us-east-1",
    presignedPutExpirySeconds: parsePositiveInteger(
      env.S3_PRESIGNED_PUT_EXPIRY_SECONDS,
      DEFAULT_S3_PRESIGNED_PUT_EXPIRY_SECONDS
    ),
    presignedGetExpirySeconds: parsePositiveInteger(
      env.S3_PRESIGNED_GET_EXPIRY_SECONDS,
      DEFAULT_S3_PRESIGNED_GET_EXPIRY_SECONDS
    ),
    maxFileSizeBytes: parsePositiveInteger(
      env.S3_MAX_FILE_SIZE_BYTES,
      DEFAULT_S3_MAX_FILE_SIZE_BYTES
    ),
    allowedMimeTypes: env.S3_ALLOWED_MIME_TYPES
      ? splitCsv(env.S3_ALLOWED_MIME_TYPES)
      : DEFAULT_S3_ALLOWED_MIME_TYPES,
    // Local development only (MinIO). Never set in AWS.
    ...(env.S3_ENDPOINT_URL?.trim() ? { endpointUrl: env.S3_ENDPOINT_URL.trim() } : {}),
  };
}
