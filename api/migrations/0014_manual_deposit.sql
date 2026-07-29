-- Manual deposit bookings: guests paying by bank transfer or SINPE now get a
-- real booking session, a Smoobu hold that blocks the dates while the transfer
-- clears, and portal access once staff confirm the payment.
--
-- IMPORTANT — enum extension and transaction boundaries.
--
-- scripts/migrate.js wraps the entire run in a single transaction. PostgreSQL
-- permits `alter type ... add value` inside a transaction block, but the new
-- label cannot be *used* until that transaction commits. So:
--
--   * `alter type` must be a top-level statement, not inside a do $$ block —
--     PostgreSQL rejects ALTER TYPE ... ADD from a function body.
--   * nothing in this file, or in any migration still pending in the same run,
--     may reference the literal 'manual_deposit' in a CHECK, index predicate,
--     INSERT or UPDATE.
--
-- Land this migration in its own `npm run migrate` before deploying code that
-- writes the new value.

alter type payment_method add value if not exists 'manual_deposit';

-- Confirmation bookkeeping. `deposit_confirm_token_jti` records which signed
-- staff link was spent, so a forwarded or reused link is auditable after the
-- fact even though the confirm itself is idempotent by status guard.
alter table booking_sessions
  add column deposit_confirmed_at timestamptz,
  add column deposit_confirmed_by text,
  add column deposit_confirm_token_jti text,
  add column deposit_receipt_uploaded_at timestamptz;

create unique index booking_sessions_deposit_jti_uidx
  on booking_sessions (deposit_confirm_token_jti)
  where deposit_confirm_token_jti is not null;

-- Supports the staff-facing "deposit bookings awaiting confirmation" query.
create index booking_sessions_deposit_pending_idx
  on booking_sessions (status, created_at desc)
  where deposit_confirmed_at is null;
