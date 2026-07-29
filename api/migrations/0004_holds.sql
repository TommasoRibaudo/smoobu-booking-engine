create table holds (
  id uuid primary key default gen_random_uuid(),
  booking_session_id uuid not null unique references booking_sessions(id) on delete restrict,
  property_id uuid not null references properties(id),

  arrival_date date not null,
  departure_date date not null,
  status hold_status not null default 'creating',
  expires_at timestamptz not null,

  smoobu_reservation_id bigint unique,
  smoobu_channel_id integer not null default 11,
  smoobu_create_payload_hash text,
  smoobu_create_response jsonb,
  smoobu_cancelled_at timestamptz,
  smoobu_cancel_attempts integer not null default 0,
  last_smoobu_error text,

  converted_at timestamptz,
  cancelled_at timestamptz,
  expired_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint holds_date_order check (arrival_date < departure_date),
  constraint holds_smoobu_channel check (smoobu_channel_id in (11, 13)),
  constraint holds_terminal_timestamps check (
    (status <> 'expired' or expired_at is not null)
    and (status <> 'cancelled' or cancelled_at is not null)
    and (status <> 'converted' or converted_at is not null)
  )
);

alter table holds
  add constraint holds_no_overlapping_active_inventory
  exclude using gist (
    property_id with =,
    daterange(arrival_date, departure_date, '[)') with &&
  )
  where (status in ('creating', 'active', 'converted'));

create index holds_expiry_worker_idx on holds (expires_at)
  where status in ('creating', 'active');

create index holds_smoobu_reservation_idx on holds (smoobu_reservation_id)
  where smoobu_reservation_id is not null;

create index holds_booking_status_idx on holds (booking_session_id, status);
