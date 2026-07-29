create table webhook_events (
  id uuid primary key default gen_random_uuid(),
  provider webhook_provider not null,
  external_event_id text,
  dedupe_key text not null,
  event_type text not null,
  provider_object_id text,
  event_created_at timestamptz,

  payload_hash text not null,
  payload jsonb not null,
  headers_hash text,
  verification_status text,
  processing_status webhook_processing_status not null default 'received',
  processing_attempts integer not null default 0,
  processed_at timestamptz,
  last_error text,

  booking_session_id uuid references booking_sessions(id) on delete restrict,
  payment_id uuid references payments(id) on delete restrict,
  hold_id uuid references holds(id) on delete restrict,

  received_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index webhook_events_provider_dedupe_uidx
  on webhook_events (provider, dedupe_key);

create unique index webhook_events_provider_external_uidx
  on webhook_events (provider, external_event_id)
  where external_event_id is not null;

create index webhook_events_processing_idx
  on webhook_events (processing_status, received_at);

create index webhook_events_provider_object_idx
  on webhook_events (provider, provider_object_id, received_at desc)
  where provider_object_id is not null;
