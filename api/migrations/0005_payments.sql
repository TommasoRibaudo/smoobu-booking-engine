create table payments (
  id uuid primary key default gen_random_uuid(),
  booking_session_id uuid not null unique references booking_sessions(id) on delete restrict,
  provider payment_provider not null,
  method payment_method not null,
  status payment_status not null default 'pending',

  amount_cents integer not null check (amount_cents >= 0),
  currency char(3) not null,

  paypal_order_id text,
  paypal_capture_id text,
  paypal_order_request_id text,
  paypal_capture_request_id text,
  paypal_payer_id text,
  paypal_capture_status text,

  provider_payload jsonb,
  paid_at timestamptz,
  failed_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint payments_provider_method_match check (provider = 'paypal' and method = 'paypal'),
  constraint payments_currency_uppercase check (currency = upper(currency))
);

create unique index payments_paypal_order_id_uidx on payments (paypal_order_id)
  where paypal_order_id is not null;

create unique index payments_paypal_capture_id_uidx on payments (paypal_capture_id)
  where paypal_capture_id is not null;

create unique index payments_paypal_order_request_uidx on payments (paypal_order_request_id)
  where paypal_order_request_id is not null;

create unique index payments_paypal_capture_request_uidx on payments (paypal_capture_request_id)
  where paypal_capture_request_id is not null;

create index payments_status_idx on payments (provider, status, created_at desc);
