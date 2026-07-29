create table idempotency_keys (
  id uuid primary key default gen_random_uuid(),
  scope text not null,
  idempotency_key text not null,
  request_hash text not null,
  status idempotency_status not null default 'in_progress',

  booking_session_id uuid references booking_sessions(id) on delete restrict,
  response_status integer,
  response_body jsonb,
  locked_until timestamptz,
  expires_at timestamptz not null,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint idempotency_keys_scope_not_empty check (length(scope) > 0),
  constraint idempotency_keys_key_not_empty check (length(idempotency_key) >= 16)
);

create unique index idempotency_keys_scope_key_uidx
  on idempotency_keys (scope, idempotency_key);

create index idempotency_keys_expiry_idx on idempotency_keys (expires_at);
create index idempotency_keys_booking_idx on idempotency_keys (booking_session_id, created_at desc);
