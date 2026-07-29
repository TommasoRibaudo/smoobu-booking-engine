import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { ApiError } from "./http/errors";
import { BookingProviderSecrets, BookingSecretProvider, FieldErrors, JsonBody } from "./types";

const DEFAULT_EXTENSION_ENDPOINT = "http://localhost:2773";
const DEFAULT_SECRET_CACHE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_FETCH_TIMEOUT_MS = 2_000;
const REQUIRED_FIELDS: Array<keyof BookingProviderSecrets> = [
  "smoobuApiKey",
  "smoobuApiSecret",
  "smoobuWebhookSecret",
  "paypalClientId",
  "paypalClientSecret",
  "paypalWebhookId",
  "bookingEncryptionKeyBase64",
  "portalSessionSecret",
  "rdsConnectionString",
];

interface CachedSecrets {
  expiresAt: number;
  value: BookingProviderSecrets;
}

export interface LambdaExtensionSecretProviderOptions {
  secretId: string;
  endpoint?: string;
  sessionToken?: string;
  cacheTtlMs?: number;
  fetchTimeoutMs?: number;
  now?: () => number;
}

export class StaticSecretProvider implements BookingSecretProvider {
  readonly source = "static";
  private readonly secrets: BookingProviderSecrets;

  constructor(value: unknown, sourceLabel = "static") {
    this.secrets = validateBookingSecrets(value, sourceLabel);
  }

  async getSecrets(): Promise<BookingProviderSecrets> {
    return this.secrets;
  }
}

export class MissingSecretProvider implements BookingSecretProvider {
  readonly source = "missing";

  async getSecrets(): Promise<BookingProviderSecrets> {
    throw secretProviderError("secrets_not_configured", "Booking API secrets are not configured.", {
      secrets: ["secrets_manager_secret_id_required"],
    });
  }
}

export class InvalidSecretProvider implements BookingSecretProvider {
  readonly source = "invalid";

  constructor(private readonly error: ApiError) {}

  async getSecrets(): Promise<BookingProviderSecrets> {
    throw this.error;
  }
}

export class AwsSdkSecretProvider implements BookingSecretProvider {
  readonly source = "aws-secrets-manager-sdk";
  private readonly secretId: string;
  private readonly region: string;
  private readonly cacheTtlMs: number;
  private readonly now: () => number;
  private cached?: CachedSecrets;
  private client?: SecretsManagerClient;

  constructor(options: LambdaExtensionSecretProviderOptions) {
    this.secretId = options.secretId;
    this.region = process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? "us-east-1";
    this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_SECRET_CACHE_TTL_MS;
    this.now = options.now ?? Date.now;
  }

  async getSecrets(): Promise<BookingProviderSecrets> {
    const now = this.now();
    if (this.cached && this.cached.expiresAt > now) {
      return this.cached.value;
    }

    try {
      if (!this.client) {
        this.client = new SecretsManagerClient({ region: this.region });
      }
      const response = await this.client.send(
        new GetSecretValueCommand({ SecretId: this.secretId })
      );
      const secretString = response.SecretString;
      if (typeof secretString !== "string" || secretString.trim().length === 0) {
        throw secretProviderError("secrets_invalid", "Secrets Manager secret has no SecretString.", {
          secretString: ["required"],
        });
      }
      const parsed = parseSecretJson(secretString, `secret:${this.secretId}`);
      this.cached = { value: parsed, expiresAt: now + this.cacheTtlMs };
      return parsed;
    } catch (error) {
      if (error instanceof ApiError) {
        throw error;
      }
      throw secretProviderError("secrets_unavailable", "Secrets Manager secret could not be loaded.", {
        secretsManager: ["fetch_failed"],
      });
    }
  }
}

export function createSecretProvider(env: NodeJS.ProcessEnv = process.env): BookingSecretProvider {
  const secretId = trimOptional(env.BOOKING_API_SECRETS_MANAGER_SECRET_ID);
  if (secretId) {
    return new AwsSdkSecretProvider({
      secretId,
      cacheTtlMs: parsePositiveInteger(env.BOOKING_API_SECRETS_CACHE_TTL_MS, DEFAULT_SECRET_CACHE_TTL_MS),
      fetchTimeoutMs: parsePositiveInteger(env.BOOKING_API_SECRETS_FETCH_TIMEOUT_MS, DEFAULT_FETCH_TIMEOUT_MS),
    });
  }

  const inlineSecretJson = trimOptional(env.BOOKING_API_SECRETS_JSON);
  if (inlineSecretJson) {
    if (!allowInsecureEnvSecrets(env)) {
      return new InvalidSecretProvider(
        secretProviderError("raw_env_secrets_not_allowed", "Raw provider secrets must be loaded from Secrets Manager.", {
          secrets: ["set_BOOKING_API_SECRETS_MANAGER_SECRET_ID_or_enable_local_override"],
        })
      );
    }

    try {
      return new StaticSecretProvider(JSON.parse(inlineSecretJson), "BOOKING_API_SECRETS_JSON");
    } catch (error) {
      return invalidSecretProviderFrom(error);
    }
  }

  const rawEnvSecrets = readRawEnvSecrets(env);
  if (rawEnvSecrets) {
    if (!allowInsecureEnvSecrets(env)) {
      return new InvalidSecretProvider(
        secretProviderError("raw_env_secrets_not_allowed", "Raw provider secrets must be loaded from Secrets Manager.", {
          secrets: ["set_BOOKING_API_SECRETS_MANAGER_SECRET_ID_or_enable_local_override"],
        })
      );
    }

    try {
      return new StaticSecretProvider(rawEnvSecrets, "local env");
    } catch (error) {
      return invalidSecretProviderFrom(error);
    }
  }

  return new MissingSecretProvider();
}

export function parseSecretJson(value: string, sourceLabel = "secret json"): BookingProviderSecrets {
  try {
    return validateBookingSecrets(JSON.parse(value), sourceLabel);
  } catch (error) {
    if (error instanceof ApiError) {
      throw error;
    }
    throw secretProviderError("secrets_invalid", "Secret payload must be valid JSON.", {
      secrets: ["invalid_json"],
    });
  }
}

export function validateBookingSecrets(value: unknown, sourceLabel = "secrets"): BookingProviderSecrets {
  const errors: FieldErrors = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw secretProviderError("secrets_invalid", "Secret payload must be a JSON object.", {
      secrets: ["object_required"],
    });
  }

  const body = value as Record<string, unknown>;
  const result = {} as BookingProviderSecrets;

  for (const field of REQUIRED_FIELDS) {
    const stringValue = requireSecretString(body, field, errors);
    if (stringValue) {
      result[field] = stringValue;
    }
  }

  // Optional fields: absence is valid, but a present-and-non-string value is not.
  const optionalFields: Array<keyof BookingProviderSecrets> = [
    "captchaSecretKey",
    "ga4ApiSecret",
    "metaCapiAccessToken",
  ];

  for (const field of optionalFields) {
    const raw = body[field];
    if (typeof raw === "string" && raw.trim()) {
      result[field] = raw.trim();
    } else if (raw !== undefined && raw !== null && typeof raw !== "string") {
      errors[field] = ["string_required"];
    }
  }

  validateBase64Key(result.bookingEncryptionKeyBase64, "bookingEncryptionKeyBase64", errors);
  validateRdsConnectionString(result.rdsConnectionString, "rdsConnectionString", errors);

  if (Object.keys(errors).length > 0) {
    throw secretProviderError("secrets_invalid", `Secret payload '${sourceLabel}' is invalid.`, errors);
  }

  return result;
}

function readRawEnvSecrets(env: NodeJS.ProcessEnv): Partial<BookingProviderSecrets> | null {
  const raw: Partial<BookingProviderSecrets> = {
    smoobuApiKey: trimOptional(env.SMOOBU_API_KEY),
    smoobuApiSecret: trimOptional(env.SMOOBU_API_SECRET),
    smoobuWebhookSecret: trimOptional(env.SMOOBU_WEBHOOK_SECRET),
    paypalClientId: trimOptional(env.PAYPAL_CLIENT_ID),
    paypalClientSecret: trimOptional(env.PAYPAL_CLIENT_SECRET),
    paypalWebhookId: trimOptional(env.PAYPAL_WEBHOOK_ID),
    bookingEncryptionKeyBase64: trimOptional(env.BOOKING_API_ENCRYPTION_KEY_BASE64),
    portalSessionSecret: trimOptional(env.BOOKING_API_PORTAL_SESSION_SECRET),
    rdsConnectionString: trimOptional(env.BOOKING_API_RDS_CONNECTION_STRING),
  };

  // These are optional and must not, on their own, switch the API into
  // env-secret mode — doing so would fail required-field validation and 503.
  if (!Object.values(raw).some(Boolean)) {
    return null;
  }

  const captchaSecretKey = trimOptional(env.CAPTCHA_SECRET_KEY);
  const ga4ApiSecret = trimOptional(env.GA4_API_SECRET);
  const metaCapiAccessToken = trimOptional(env.META_CAPI_ACCESS_TOKEN);

  return {
    ...raw,
    ...(captchaSecretKey ? { captchaSecretKey } : {}),
    ...(ga4ApiSecret ? { ga4ApiSecret } : {}),
    ...(metaCapiAccessToken ? { metaCapiAccessToken } : {}),
  };
}

function requireSecretString(
  body: Record<string, unknown>,
  field: keyof BookingProviderSecrets,
  errors: FieldErrors
): string | undefined {
  const value = body[field];
  if (typeof value !== "string" || value.trim().length === 0) {
    addError(errors, field, "required");
    return undefined;
  }

  const trimmed = value.trim();
  if (trimmed.length < 16) {
    addError(errors, field, "too_short");
  }

  return trimmed;
}

function validateBase64Key(value: string | undefined, field: string, errors: FieldErrors): void {
  if (!value) {
    return;
  }

  const decoded = Buffer.from(value, "base64");
  const normalizedInput = value.replace(/=+$/, "");
  const normalizedRoundTrip = decoded.toString("base64").replace(/=+$/, "");
  if (decoded.length !== 32 || normalizedInput !== normalizedRoundTrip) {
    addError(errors, field, "must_be_base64_32_bytes");
  }
}

function validateRdsConnectionString(value: string | undefined, field: string, errors: FieldErrors): void {
  if (!value) {
    return;
  }

  try {
    const parsed = new URL(value);
    const isPostgres = parsed.protocol === "postgres:" || parsed.protocol === "postgresql:";
    if (!isPostgres || !parsed.hostname) {
      addError(errors, field, "must_be_postgres_connection_string");
    }
  } catch {
    addError(errors, field, "must_be_postgres_connection_string");
  }
}

function allowInsecureEnvSecrets(env: NodeJS.ProcessEnv): boolean {
  const override = trimOptional(env.BOOKING_API_ALLOW_INSECURE_ENV_SECRETS);
  if (override) {
    return ["1", "true", "yes", "on"].includes(override.toLowerCase());
  }

  return env.NODE_ENV === "test";
}

function invalidSecretProviderFrom(error: unknown): BookingSecretProvider {
  if (error instanceof ApiError) {
    return new InvalidSecretProvider(error);
  }

  return new InvalidSecretProvider(
    secretProviderError("secrets_invalid", "Secret configuration is invalid.", {
      secrets: ["invalid"],
    })
  );
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

function trimOptional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function addError(errors: FieldErrors, field: string, code: string): void {
  errors[field] = [...(errors[field] ?? []), code];
}

function secretProviderError(code: string, message: string, fieldErrors: FieldErrors): ApiError {
  return new ApiError(503, code, message, {
    fieldErrors,
    retryable: true,
  });
}
