# Booking API

A backend-only booking engine for Smoobu-connected vacation rental sites:
availability search, PayPal payments, manual bank transfer / SINPE deposits,
and a guest self-service portal.

This service is intentionally separate from any frontend so Smoobu, PayPal,
database, and webhook secrets never enter the browser bundle. See
`../AGENTS.md` for the full architecture, state machine, and a step-by-step
integration guide.

## Scope

- Lambda/API Gateway-compatible TypeScript entrypoint (also runs as a plain
  Node HTTP server locally — see `scripts/devServer.js`).
- Minimal internal router with path parameters.
- JSON request parsing with raw-body preservation for webhooks.
- Public endpoint hardening:
  - correlation IDs,
  - security headers,
  - CORS allowlist,
  - `Cache-Control` defaults,
  - request body size limit,
  - JSON content-type checks,
  - idempotency key enforcement for public write endpoints,
  - per-IP and per-device rate limits,
  - CAPTCHA challenge triggers for repeated hold/order creation attempts,
  - no query-string secrets on the Smoobu webhook route,
  - Secrets Manager-backed provider credentials with fail-closed validation.
- Observability baseline:
  - structured JSON request logs,
  - correlation IDs on responses and logs,
  - hashed client identifiers in logs,
  - recursive secret redaction,
  - CloudWatch Embedded Metric Format metrics,
  - operational alert signals for webhook failures, rate limits, CAPTCHA
    escalations, provider degradation, and state-transition failures.
- Availability search + calendar price-dot endpoint, backed by Smoobu's rates
  and availability APIs.
- PayPal hold creation and capture: quote/session validation, just-in-time
  Smoobu availability recheck, local hold state with overlap protection,
  Smoobu provisional reservation creation (blocked channel by default),
  idempotent success replay for hold creation retries.
- Manual deposit (bank transfer / SINPE) hold creation, receipt upload via
  presigned S3 URLs, and a signed one-click staff confirm/reject link — no
  admin panel or staff login anywhere in the system.
- Guest portal: reservation ID + password login, self-service cancellation.
- `GET /api/exchange-rate`: cached USD→CRC reference rate for a Spanish
  booking UI. Display only — every quote, hold and payment stays in USD.

Replace the demo property catalog in `src/propertyCatalog.ts` and
`migrations/0010_seed_properties.sql` with your own properties. Set your
brand name once in `src/branding.ts`.

## Scripts

```bash
npm install
npm run typecheck
npm run build
npm test
npm run migrate          # applies pending migrations against $DATABASE_URL / RDS
npm run migrate:local    # same, against the local docker-compose Postgres
npm run dev              # mock Smoobu/PayPal + booking API together, on :4000
```

## Writing migrations

`scripts/migrate.js` applies every pending file in **one transaction**, and
checksums each one after it is applied — so a file that has already run can
never be edited. Fix a mistake with a new numbered migration.

Two rules that are easy to trip over:

- **Extending an enum needs its own run.** PostgreSQL allows
  `alter type ... add value` inside a transaction block, but the new label cannot
  be *used* until that transaction commits. Keep the `alter type` as a
  top-level statement (it is rejected inside a `do $$` block), and make sure no
  migration pending in the same run references the new value in a CHECK, index
  predicate, INSERT or UPDATE. Land it, then deploy the code that writes it.
  See `migrations/0014_manual_deposit.sql`.
- **Local Postgres has no TLS.** `npm run migrate:local` sets
  `BOOKING_API_MIGRATION_SSL=false` and loads `.env.local` for you; the plain
  `npm run migrate` keeps TLS on for RDS.

## Environment

| Variable | Purpose |
| --- | --- |
| `BOOKING_API_ALLOWED_ORIGINS` | Comma-separated CORS allowlist. |
| `BOOKING_API_MAX_BODY_BYTES` | Optional JSON body limit, defaults to `65536`. |
| `BOOKING_API_SECRETS_MANAGER_SECRET_ID` | AWS Secrets Manager secret ID/ARN for the booking provider secret bundle. Required outside local/test. |
| `BOOKING_API_SECRETS_EXTENSION_ENDPOINT` | Optional AWS Parameters and Secrets Lambda Extension endpoint, defaults to `http://localhost:2773`. |
| `BOOKING_API_SECRETS_CACHE_TTL_MS` | Optional in-process secret cache TTL, defaults to `300000`. |
| `BOOKING_API_SECRETS_FETCH_TIMEOUT_MS` | Optional Secrets Manager extension fetch timeout, defaults to `2000`. |
| `BOOKING_API_ABUSE_PROTECTION_ENABLED` | Optional boolean, defaults to `true`. |
| `BOOKING_API_CAPTCHA_CHALLENGES_ENABLED` | Optional boolean, defaults to `true`. |
| `BOOKING_API_RATE_LIMIT_MAX_BUCKETS` | Optional in-memory limiter bucket cap, defaults to `10000`. |
| `CAPTCHA_PROVIDER` | `recaptcha` (default) or `hcaptcha`. Must match the widget the frontend ships — a mismatch fails every verification and makes challenges unclearable. |
| `CAPTCHA_SECRET_KEY` | Optional local-dev override for the verification secret. Deployed environments read `captchaSecretKey` from the combined Secrets Manager entry instead. |
| `CAPTCHA_VERIFY_URL` | Optional verification endpoint override, for tests only. Defaults to the provider's production URL. |
| `BOOKING_API_SERVICE_NAME` | Optional structured-log/metric service name, defaults to `booking-api`. |
| `BOOKING_API_ENVIRONMENT` | Optional structured-log/metric environment, defaults to `NODE_ENV` or `local`. |
| `BOOKING_API_LOG_LEVEL` | Optional log level: `debug`, `info`, `warn`, `error`, or `silent`; defaults to `info`. |
| `BOOKING_API_METRICS_ENABLED` | Optional boolean for CloudWatch EMF metrics, defaults to `true`. |
| `BOOKING_API_RDS_CONNECTION_STRING` | Local-only raw RDS/PostgreSQL connection string when insecure env secrets are explicitly enabled. Prefer Secrets Manager for deployed environments. |
| `DATABASE_URL` | Optional fallback connection string for `npm run migrate` only. |
| `BOOKING_API_MIGRATION_SSL` | Optional migration runner override. Defaults to TLS enabled; set to `false` only for local PostgreSQL. |
| `BOOKING_API_MIGRATION_SSL_REJECT_UNAUTHORIZED` | Optional migration runner override. Defaults to `true`; set to `false` only when using a local/self-signed test database. |
| `SMOOBU_BASE_URL` | Optional Smoobu API origin, defaults to `https://login.smoobu.com`. |
| `SMOOBU_CUSTOMER_ID` | Required for `POST /api/search`; Smoobu customer/user ID used with configured apartment IDs. |
| `SMOOBU_TIMEOUT_MS` | Optional outbound Smoobu fetch timeout, defaults to `8000`. |
| `SMOOBU_MAX_RETRIES` | Optional retry count for idempotent Smoobu calls, defaults to `3`. |
| `SMOOBU_BASE_BACKOFF_MS` | Optional first retry backoff, defaults to `250`. |
| `SMOOBU_MAX_BACKOFF_MS` | Optional max exponential backoff, defaults to `2000`. |
| `SMOOBU_MAX_RATE_LIMIT_DELAY_MS` | Optional cap for honoring Smoobu retry-after waits, defaults to `60000`. |
| `SMOOBU_HOLD_CHANNEL_ID` | Optional Smoobu channel for unpaid PayPal holds. Defaults to `11` (Blocked channel); `13` is the config-gated Direct booking fallback. |
| `PAYPAL_HOLD_TTL_MINUTES` | Optional PayPal hold duration, defaults to `60`. |
| `BOOKING_API_IDEMPOTENCY_TTL_MINUTES` | Optional public write idempotency retention window, defaults to `1440`. |
| `BOOKING_API_STALE_IDEMPOTENCY_LOCK_SECONDS` | Optional stale in-progress idempotency lock timeout, defaults to `120`. |
| `EXCHANGE_RATE_PROVIDER_URLS` | Optional comma-separated HTTPS rate sources for `GET /api/exchange-rate`, tried in order. Defaults to `open.er-api.com` then the jsDelivr currency API. |
| `EXCHANGE_RATE_TTL_SECONDS` | Optional cache lifetime for the USD→CRC rate, defaults to `21600` (6 h). |
| `EXCHANGE_RATE_TIMEOUT_MS` | Optional per-provider fetch timeout, defaults to `4000`. |
| `EXCHANGE_RATE_STALE_MAX_AGE_SECONDS` | Optional age past which a cached rate is no longer served after providers fail, defaults to `172800` (48 h). |
| `CONTACT_WHATSAPP_URL` / `CONTACT_EMAIL` | Guest-facing contact info shown in deposit handoff instructions and emails. |
| `DEPOSIT_BANK_ACCOUNT_HOLDER` / `DEPOSIT_BANK_PRIMARY_LABEL` / `DEPOSIT_BANK_PRIMARY_ACCOUNT` / `DEPOSIT_BANK_SECONDARY_LABEL` / `DEPOSIT_BANK_SECONDARY_ACCOUNT` | Manual-deposit bank details shown to guests. Leave unset to show a placeholder telling staff the flow still needs configuring. |
| `DEPOSIT_SINPE_PHONE` / `DEPOSIT_SINPE_NAME` | Costa Rica SINPE Móvil details, if applicable. |
| `DEPOSIT_BANK_ACCOUNTS_BY_SLUG_JSON` | Optional per-property override (JSON object keyed by property slug) for portfolios that settle different properties into different bank accounts. |

The Secrets Manager value must be a JSON object with this shape:

```json
{
  "smoobuApiKey": "stored only in Secrets Manager",
  "paypalClientId": "stored only in Secrets Manager",
  "paypalClientSecret": "stored only in Secrets Manager",
  "paypalWebhookId": "stored only in Secrets Manager",
  "smoobuWebhookSecret": "shared header value for X-Smoobu-Webhook-Secret",
  "bookingEncryptionKeyBase64": "base64-encoded 32-byte key",
  "portalSessionSecret": "high-entropy signing secret",
  "rdsConnectionString": "postgres://user:password@host:5432/booking_engine"
}
```

For local tests only, `BOOKING_API_SECRETS_JSON` or individual raw env vars can
be enabled with `BOOKING_API_ALLOW_INSECURE_ENV_SECRETS=true`. Do not use those
raw secret modes for deployed environments.

See `../AGENTS.md` for the full data model, state machine, and deployment
guide.
