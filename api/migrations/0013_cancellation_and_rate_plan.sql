-- Guest self-service cancellation support.
--
-- 1. rate_plan — until now the non-refundable rate existed only in flight: the
--    frontend sent `nonRefundable: true`, holds.ts turned it into Smoobu's
--    `#norefundallowed` discount code, and the discounted total was stored with
--    no record of *why* it was discounted. Cancellation policy needs to tell a
--    flexible booking from a non-refundable one, so the rate plan is now persisted.
--
--    Existing rows stay NULL. There is no signal to back-fill them from, and the
--    cancellation policy treats an unknown rate plan as "not self-service
--    cancellable" — those guests are routed to staff instead.
--
-- 2. cancelled_by — booking_sessions already had unused cancelled_at and
--    cancellation_reason columns; this records who initiated it.
--
-- 3. payments.refund_flagged_at — the payment_status enum already carries
--    'refund_flagged'. Guest cancellations flag the payment for a manual PayPal
--    refund by staff; this timestamps that hand-off.

alter table booking_sessions
  add column rate_plan text,
  add column cancelled_by text;

alter table booking_sessions
  add constraint booking_sessions_rate_plan_check
  check (rate_plan is null or rate_plan in ('flexible', 'non_refundable'));

alter table booking_sessions
  add constraint booking_sessions_cancelled_by_check
  check (cancelled_by is null or cancelled_by in ('guest', 'staff', 'system'));

alter table payments
  add column refund_flagged_at timestamptz;

-- Supports the staff-facing "what was cancelled recently" query.
create index booking_sessions_cancelled_idx
  on booking_sessions (cancelled_at desc)
  where cancelled_at is not null;
