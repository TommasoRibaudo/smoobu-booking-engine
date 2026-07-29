create table booking_state_transitions (
  id uuid primary key default gen_random_uuid(),
  booking_session_id uuid not null references booking_sessions(id) on delete restrict,
  from_status booking_status,
  to_status booking_status not null,
  trigger text not null,
  actor_type actor_type not null,
  actor_id text,
  idempotency_key_id uuid references idempotency_keys(id) on delete restrict,
  webhook_event_id uuid references webhook_events(id) on delete restrict,
  reason text,
  created_at timestamptz not null default now()
);

create index booking_state_transitions_booking_idx
  on booking_state_transitions (booking_session_id, created_at);

create index booking_state_transitions_to_status_idx
  on booking_state_transitions (to_status, created_at desc);

-- portal_sessions stores short-lived bearer tokens issued after a guest
-- authenticates to the reservation portal (reservation_public_id + password).
-- The composite FK to booking_sessions(id, reservation_public_id) ensures
-- a token cannot be rebound to a different booking by swapping either half.
create table portal_sessions (
  id uuid primary key default gen_random_uuid(),
  booking_session_id uuid not null,
  reservation_public_id text not null,
  token_hash text not null unique,
  status portal_session_status not null default 'active',
  issued_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  last_seen_at timestamptz,
  request_ip inet,
  user_agent_hash text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint portal_sessions_booking_public_fk
    foreign key (booking_session_id, reservation_public_id)
    references booking_sessions(id, reservation_public_id)
    on delete restrict,
  constraint portal_sessions_expiry_order check (expires_at > issued_at),
  constraint portal_sessions_revoked_timestamp check (status <> 'revoked' or revoked_at is not null)
);

create index portal_sessions_booking_idx
  on portal_sessions (booking_session_id, created_at desc);

create index portal_sessions_public_id_idx
  on portal_sessions (reservation_public_id, created_at desc);

create index portal_sessions_active_expiry_idx
  on portal_sessions (expires_at)
  where status = 'active';

create table portal_login_attempts (
  id uuid primary key default gen_random_uuid(),
  reservation_public_id_hash text not null,
  booking_session_id uuid references booking_sessions(id) on delete restrict,
  request_ip inet,
  user_agent_hash text,
  success boolean not null default false,
  failure_reason text,
  created_at timestamptz not null default now()
);

create index portal_login_attempts_rate_idx
  on portal_login_attempts (reservation_public_id_hash, created_at desc);

create index portal_login_attempts_ip_idx
  on portal_login_attempts (request_ip, created_at desc);

create table provider_reconciliation_runs (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  scope text not null,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  status text not null default 'running',
  checked_count integer not null default 0,
  mismatch_count integer not null default 0,
  error_count integer not null default 0,
  details jsonb not null default '{}'::jsonb
);

create index provider_reconciliation_runs_provider_idx
  on provider_reconciliation_runs (provider, started_at desc);
