create table audit_log (
  id uuid primary key default gen_random_uuid(),
  actor_type actor_type not null,
  actor_id text,
  action text not null,
  object_type text not null,
  object_id text not null,

  booking_session_id uuid references booking_sessions(id) on delete restrict,
  before_state jsonb,
  after_state jsonb,
  reason text,
  correlation_id text,
  request_ip inet,
  user_agent_hash text,

  created_at timestamptz not null default now()
);

create index audit_log_booking_idx on audit_log (booking_session_id, created_at desc);
create index audit_log_object_idx on audit_log (object_type, object_id, created_at desc);
create index audit_log_action_idx on audit_log (action, created_at desc);
