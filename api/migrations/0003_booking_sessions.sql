create table booking_sessions (
  id uuid primary key default gen_random_uuid(),
  reservation_public_id text not null unique,
  status booking_status not null default 'search_started',
  language booking_language not null,

  property_id uuid references properties(id),
  arrival_date date not null,
  departure_date date not null,
  guests integer not null check (guests > 0),
  source text,

  payment_method payment_method,
  currency char(3),
  total_amount_cents integer check (total_amount_cents is null or total_amount_cents >= 0),
  quote_id text unique,
  quote_hash text,
  quote_expires_at timestamptz,
  quoted_properties jsonb not null default '[]'::jsonb,

  paypal_order_id text,

  guest_first_name text,
  guest_last_name text,
  guest_email text,
  guest_phone text,
  guest_country text,
  guest_message text,

  portal_password_hash text,
  portal_password_set_at timestamptz,
  portal_locked_until timestamptz,

  expires_at timestamptz,
  confirmed_at timestamptz,
  cancelled_at timestamptz,
  cancellation_reason text,
  failure_reason text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint booking_sessions_date_order check (arrival_date < departure_date),
  constraint booking_sessions_amount_currency check (
    (currency is null and total_amount_cents is null)
    or (currency is not null and total_amount_cents is not null)
  ),
  constraint booking_sessions_currency_uppercase check (currency is null or currency = upper(currency)),
  constraint booking_sessions_language_required check (language in ('en', 'es')),
  -- Composite unique used as the target of the portal_sessions composite FK,
  -- which ties a portal session to both the internal UUID and the public ID
  -- so that neither can be swapped independently.
  constraint booking_sessions_id_public_id_uidx unique (id, reservation_public_id)
);

create index booking_sessions_status_idx on booking_sessions (status, created_at desc);
create index booking_sessions_property_dates_idx on booking_sessions (property_id, arrival_date, departure_date);
create index booking_sessions_guest_email_idx on booking_sessions (lower(guest_email)) where guest_email is not null;
create index booking_sessions_quote_expiry_idx on booking_sessions (quote_expires_at)
  where status in ('quoted', 'no_availability');
create index booking_sessions_expiry_idx on booking_sessions (expires_at)
  where status in ('hold_active', 'paypal_pending', 'paypal_order_created');
