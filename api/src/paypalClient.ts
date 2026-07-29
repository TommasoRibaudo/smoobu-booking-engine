import { ApiError } from "./http/errors";
import { BookingApiConfig, PayPalClientConfig, RouteObservability } from "./types";
import { SITE_NAME } from "./branding";

// ─── Default config ──────────────────────────────────────────────────────────

export const DEFAULT_PAYPAL_CONFIG: PayPalClientConfig = {
  baseUrl: "https://api-m.sandbox.paypal.com",
  timeoutMs: 10_000,
  orderReturnUrl: "",
  orderCancelUrl: "",
};

// ─── Domain types ────────────────────────────────────────────────────────────

export interface PayPalOrderInput {
  bookingSessionId: string;
  reservationPublicId: string;
  arrivalDate: string;
  departureDate: string;
  currency: string;
  totalAmountCents: number;
  propertyName: string;
  language: "en" | "es";
  returnUrl?: string;
  cancelUrl?: string;
}

export interface PayPalOrderResult {
  orderId: string;
  approvalUrl: string;
}

export interface PayPalCaptureResult {
  captureId: string;
  status: string;
  currency: string;
  amountCents: number;
}

export interface PayPalOrderDetails {
  orderId: string;
  status: string;
  captureId?: string;
  captureStatus?: string;
}

export interface PayPalVerifySignatureInput {
  auth_algo: string;
  cert_url: string;
  transmission_id: string;
  transmission_sig: string;
  transmission_time: string;
  webhook_id: string;
  webhook_event: unknown;
}

export interface PayPalVerifySignatureResult {
  verification_status: string;
}

// ─── Error class ─────────────────────────────────────────────────────────────

export class PayPalProviderError extends ApiError {
  readonly providerStatusCode?: number;

  constructor(
    statusCode: number,
    code: string,
    message: string,
    options: { retryable?: boolean; providerStatusCode?: number } = {}
  ) {
    super(statusCode, code, message, { retryable: options.retryable ?? false });
    this.providerStatusCode = options.providerStatusCode;
  }
}

// ─── PayPal response shapes ───────────────────────────────────────────────────

interface PayPalTokenResponse {
  access_token?: string;
  expires_in?: number;
}

interface PayPalLink {
  href: string;
  rel: string;
  method?: string;
}

interface PayPalCreateOrderResponse {
  id?: string;
  status?: string;
  links?: PayPalLink[];
}

interface PayPalCaptureAmount {
  currency_code?: string;
  value?: string;
}

interface PayPalCapture {
  id?: string;
  status?: string;
  amount?: PayPalCaptureAmount;
}

interface PayPalCaptureOrderResponse {
  id?: string;
  status?: string;
  purchase_units?: Array<{
    payments?: {
      captures?: PayPalCapture[];
    };
  }>;
}

interface PayPalErrorDetail {
  issue?: string;
  description?: string;
}

interface PayPalErrorResponse {
  name?: string;
  message?: string;
  details?: PayPalErrorDetail[];
}

// ─── Inject types ────────────────────────────────────────────────────────────

type FetchFn = (input: string | URL, init?: RequestInit) => Promise<Response>;

interface CachedToken {
  value: string;
  expiresAtMs: number;
}

// ─── PayPalClient ────────────────────────────────────────────────────────────

export interface PayPalClientOptions {
  clientId: string;
  clientSecret: string;
  config?: Partial<PayPalClientConfig>;
  fetchFn?: FetchFn;
  now?: () => number;
}

export class PayPalClient {
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly config: PayPalClientConfig;
  private readonly fetchFn: FetchFn;
  private readonly now: () => number;
  private cachedToken: CachedToken | null = null;

  constructor(options: PayPalClientOptions) {
    if (!options.clientId.trim() || !options.clientSecret.trim()) {
      throw new PayPalProviderError(503, "provider_auth_failed", "PayPal credentials are not configured.");
    }
    this.clientId = options.clientId.trim();
    this.clientSecret = options.clientSecret.trim();
    this.config = { ...DEFAULT_PAYPAL_CONFIG, ...(options.config ?? {}) };
    this.fetchFn = options.fetchFn ?? fetch;
    this.now = options.now ?? Date.now;
  }

  // ── Public methods ──────────────────────────────────────────────────────

  async createOrder(
    input: PayPalOrderInput,
    paypalRequestId: string,
    observability: RouteObservability
  ): Promise<PayPalOrderResult> {
    const accessToken = await this.getAccessToken();
    const startedAtMs = this.now();
    let statusCode: number | undefined;
    let errorCode: string | undefined;

    try {
      const body = buildCreateOrderPayload(input, this.config);
      const response = await this.fetchWithTimeout("/v2/checkout/orders", "POST", body, {
        Authorization: `Bearer ${accessToken}`,
        "PayPal-Request-Id": paypalRequestId,
        "Content-Type": "application/json",
      });
      statusCode = response.status;

      if (!response.ok) {
        const err = await buildPayPalHttpError(response, "paypal_order_create_failed");
        errorCode = err.code;
        throw err;
      }

      const data = await parseJsonResponse<PayPalCreateOrderResponse>(response);
      // PayPal returns "payer-action" for the approval link on Orders v2
      const approvalLink = data.links?.find(
        (link) => link.rel === "approve" || link.rel === "payer-action"
      );

      if (!data.id || !approvalLink?.href) {
        errorCode = "provider_invalid_response";
        throw new PayPalProviderError(503, "provider_invalid_response", "PayPal returned an invalid order response.");
      }

      return { orderId: data.id, approvalUrl: approvalLink.href };
    } finally {
      observability.recordProviderCall({
        provider: "paypal",
        operation: "createOrder",
        durationMs: this.now() - startedAtMs,
        statusCode,
        errorCode,
      });
    }
  }

  async captureOrder(
    orderId: string,
    paypalRequestId: string,
    observability: RouteObservability
  ): Promise<PayPalCaptureResult> {
    const accessToken = await this.getAccessToken();
    const startedAtMs = this.now();
    let statusCode: number | undefined;
    let errorCode: string | undefined;

    try {
      const encodedId = encodeURIComponent(orderId);
      const response = await this.fetchWithTimeout(
        `/v2/checkout/orders/${encodedId}/capture`,
        "POST",
        {},
        {
          Authorization: `Bearer ${accessToken}`,
          "PayPal-Request-Id": paypalRequestId,
          "Content-Type": "application/json",
        }
      );
      statusCode = response.status;

      // 422 = unprocessable — payment declined / not approved
      if (response.status === 422) {
        const errorBody = await safeParseJson<PayPalErrorResponse>(response);
        const issue = errorBody?.details?.[0]?.issue ?? "CAPTURE_FAILED";
        errorCode = paypalIssueToErrorCode(issue);

        // ORDER_NOT_APPROVED is a client error (buyer hasn't approved yet)
        if (issue === "ORDER_NOT_APPROVED") {
          throw new PayPalProviderError(409, errorCode, "The PayPal order has not been approved by the buyer.", {
            providerStatusCode: response.status,
          });
        }

        // INSTRUMENT_DECLINED etc — payment was declined
        throw new PayPalProviderError(402, errorCode, "PayPal declined the payment.", {
          providerStatusCode: response.status,
        });
      }

      if (!response.ok) {
        const err = await buildPayPalHttpError(response, "paypal_capture_failed");
        errorCode = err.code;
        throw err;
      }

      const data = await parseJsonResponse<PayPalCaptureOrderResponse>(response);
      const capture = data.purchase_units?.[0]?.payments?.captures?.[0];

      if (!capture?.id) {
        errorCode = "provider_invalid_response";
        throw new PayPalProviderError(503, "provider_invalid_response", "PayPal returned an invalid capture response.");
      }

      return {
        captureId: capture.id,
        status: capture.status ?? "COMPLETED",
        currency: (capture.amount?.currency_code ?? "USD").toUpperCase(),
        amountCents: parseCentsFromPayPalAmount(capture.amount?.value),
      };
    } finally {
      observability.recordProviderCall({
        provider: "paypal",
        operation: "captureOrder",
        durationMs: this.now() - startedAtMs,
        statusCode,
        errorCode,
      });
    }
  }

  async getOrderDetails(
    orderId: string,
    observability: RouteObservability
  ): Promise<PayPalOrderDetails> {
    const accessToken = await this.getAccessToken();
    const startedAtMs = this.now();
    let statusCode: number | undefined;
    let errorCode: string | undefined;

    try {
      const encodedId = encodeURIComponent(orderId);
      const response = await this.fetchWithTimeout(
        `/v2/checkout/orders/${encodedId}`,
        "GET",
        undefined,
        {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        }
      );
      statusCode = response.status;

      if (!response.ok) {
        const err = await buildPayPalHttpError(response, "paypal_get_order_failed");
        errorCode = err.code;
        throw err;
      }

      const data = await parseJsonResponse<PayPalCaptureOrderResponse>(response);
      const capture = data.purchase_units?.[0]?.payments?.captures?.[0];

      return {
        orderId: data.id ?? orderId,
        status: data.status ?? "UNKNOWN",
        captureId: capture?.id,
        captureStatus: capture?.status,
      };
    } finally {
      observability.recordProviderCall({
        provider: "paypal",
        operation: "getOrderDetails",
        durationMs: this.now() - startedAtMs,
        statusCode,
        errorCode,
      });
    }
  }

  async verifyWebhookSignature(
    input: PayPalVerifySignatureInput,
    observability: RouteObservability
  ): Promise<PayPalVerifySignatureResult> {
    const accessToken = await this.getAccessToken();
    const startedAtMs = this.now();
    let statusCode: number | undefined;
    let errorCode: string | undefined;

    try {
      const response = await this.fetchWithTimeout(
        "/v1/notifications/verify-webhook-signature",
        "POST",
        input,
        {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        }
      );
      statusCode = response.status;

      if (!response.ok) {
        const err = await buildPayPalHttpError(response, "paypal_verify_signature_failed");
        errorCode = err.code;
        throw err;
      }

      const data = await parseJsonResponse<{ verification_status?: string }>(response);
      return { verification_status: data.verification_status ?? "FAILURE" };
    } finally {
      observability.recordProviderCall({
        provider: "paypal",
        operation: "verifyWebhookSignature",
        durationMs: this.now() - startedAtMs,
        statusCode,
        errorCode,
      });
    }
  }

  // ── Token management ────────────────────────────────────────────────────

  private async getAccessToken(): Promise<string> {
    // Return cached token with a 30-second buffer before expiry
    if (this.cachedToken && this.now() < this.cachedToken.expiresAtMs - 30_000) {
      return this.cachedToken.value;
    }

    const credentials = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString("base64");
    const response = await this.fetchWithTimeout("/v1/oauth2/token", "POST", "grant_type=client_credentials", {
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/x-www-form-urlencoded",
    });

    if (!response.ok) {
      throw new PayPalProviderError(503, "provider_auth_failed", "PayPal OAuth token request failed.", {
        providerStatusCode: response.status,
      });
    }

    const data = await parseJsonResponse<PayPalTokenResponse>(response);
    if (!data.access_token) {
      throw new PayPalProviderError(503, "provider_auth_failed", "PayPal returned no access token.");
    }

    this.cachedToken = {
      value: data.access_token,
      expiresAtMs: this.now() + (data.expires_in ?? 3600) * 1_000,
    };

    return this.cachedToken.value;
  }

  // ── HTTP ────────────────────────────────────────────────────────────────

  private async fetchWithTimeout(
    path: string,
    method: string,
    body: unknown,
    headers: Record<string, string>
  ): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);

    try {
      const isFormEncoded = typeof body === "string";
      const serializedBody =
        method === "GET"
          ? undefined
          : isFormEncoded
            ? body
            : JSON.stringify(body);

      return await this.fetchFn(`${this.config.baseUrl}${path}`, {
        method,
        headers,
        body: serializedBody,
        signal: controller.signal,
      });
    } catch (error) {
      if (error instanceof PayPalProviderError || error instanceof ApiError) {
        throw error;
      }
      const isAbort = error instanceof Error && error.name === "AbortError";
      throw new PayPalProviderError(
        503,
        isAbort ? "provider_timeout" : "provider_unavailable",
        "PayPal is temporarily unavailable."
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}

// ─── Factory ─────────────────────────────────────────────────────────────────

// Cache one PayPalClient per config object so the OAuth token is reused across requests.
const clientCache = new WeakMap<BookingApiConfig, PayPalClient>();

export async function createPayPalClient(config: BookingApiConfig): Promise<PayPalClient> {
  const cached = clientCache.get(config);
  if (cached) return cached;

  const { paypalClientId, paypalClientSecret } = await config.secrets.getSecrets();
  const client = new PayPalClient({
    clientId: paypalClientId,
    clientSecret: paypalClientSecret,
    config: config.paypal,
  });
  clientCache.set(config, client);
  return client;
}

// ─── Payload builders ─────────────────────────────────────────────────────────

function buildCreateOrderPayload(input: PayPalOrderInput, config: PayPalClientConfig): Record<string, unknown> {
  const nights = nightsBetween(input.arrivalDate, input.departureDate);
  const amountStr = (input.totalAmountCents / 100).toFixed(2);

  const description =
    input.language === "es"
      ? `${SITE_NAME} ${input.propertyName} — ${input.arrivalDate} a ${input.departureDate} (${nights} noches)`
      : `${SITE_NAME} ${input.propertyName} — ${input.arrivalDate} to ${input.departureDate} (${nights} nights)`;

  const applicationContext: Record<string, unknown> = {
    brand_name: SITE_NAME,
    locale: input.language === "es" ? "es-CR" : "en-US",
    landing_page: "NO_PREFERENCE",
    shipping_preference: "NO_SHIPPING",
    user_action: "PAY_NOW",
  };

  const returnUrl = input.returnUrl || config.orderReturnUrl;
  const cancelUrl = input.cancelUrl || config.orderCancelUrl;
  if (returnUrl) {
    applicationContext.return_url = returnUrl;
  }
  if (cancelUrl) {
    applicationContext.cancel_url = cancelUrl;
  }

  return {
    intent: "CAPTURE",
    purchase_units: [
      {
        reference_id: input.bookingSessionId,
        description: description.slice(0, 127),
        amount: {
          currency_code: input.currency,
          value: amountStr,
        },
        custom_id: input.reservationPublicId,
      },
    ],
    application_context: applicationContext,
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function nightsBetween(arrivalDate: string, departureDate: string): number {
  const arrivalMs = Date.parse(`${arrivalDate}T00:00:00Z`);
  const departureMs = Date.parse(`${departureDate}T00:00:00Z`);
  return Math.max(1, Math.round((departureMs - arrivalMs) / 86_400_000));
}

function parseCentsFromPayPalAmount(value: string | undefined): number {
  if (!value) return 0;
  const parsed = parseFloat(value);
  return Number.isFinite(parsed) ? Math.round(parsed * 100) : 0;
}

function paypalIssueToErrorCode(issue: string): string {
  const map: Record<string, string> = {
    INSTRUMENT_DECLINED: "payment_instrument_declined",
    PAYER_CANNOT_PAY: "payer_cannot_pay",
    TRANSACTION_REFUSED: "transaction_refused",
    DUPLICATE_INVOICE_ID: "duplicate_invoice",
    ORDER_NOT_APPROVED: "paypal_order_not_approved",
    COMPLIANCE_VIOLATION: "payment_compliance_violation",
  };
  return map[issue] ?? "payment_declined";
}

async function buildPayPalHttpError(response: Response, defaultCode: string): Promise<PayPalProviderError> {
  const text = await response.text().catch(() => "");
  let issue: string | undefined;
  try {
    const parsed = JSON.parse(text) as PayPalErrorResponse;
    issue = parsed.details?.[0]?.issue;
  } catch {
    // ignore parse failure
  }

  if (response.status === 401 || response.status === 403) {
    return new PayPalProviderError(503, "provider_auth_failed", "PayPal authentication failed.", {
      providerStatusCode: response.status,
    });
  }

  if (response.status >= 500 || response.status === 408 || response.status === 429) {
    return new PayPalProviderError(503, "provider_unavailable", "PayPal is temporarily unavailable.", {
      retryable: true,
      providerStatusCode: response.status,
    });
  }

  const code = issue ? paypalIssueToErrorCode(issue) : defaultCode;
  return new PayPalProviderError(502, code, "PayPal rejected the request.", {
    providerStatusCode: response.status,
  });
}

async function parseJsonResponse<T>(response: Response): Promise<T> {
  const text = await response.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new PayPalProviderError(503, "provider_invalid_response", "PayPal returned an invalid JSON response.");
  }
}

async function safeParseJson<T>(response: Response): Promise<T | undefined> {
  try {
    const text = await response.text();
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}
