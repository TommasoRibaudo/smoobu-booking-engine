-- Marketing attribution identifiers, captured so conversions can be reported
-- from the API instead of the browser.
--
-- The browser is not a reliable place to report a sale. Ad blockers and ITP drop
-- a large share of Purchase beacons, and a manual-deposit booking is confirmed by
-- staff hours later via the signed link in depositConfirm.ts — by which point the
-- guest's browser is long gone and no client-side event can ever fire. That whole
-- revenue channel currently reports zero conversions.
--
-- Reporting server-side needs identifiers the API has never seen:
--
--   * ga_client_id  — GA4 Measurement Protocol rejects events without it.
--   * ga_session_id — without it the purchase is attributed to a new session and
--                     lands in Direct/None, crediting no campaign.
--   * fbp / fbc     — Meta's primary match signals; the current CAPI source sits
--                     at an event match quality of 3.2/10 for want of them.
--   * gclid         — Google Ads click attribution.
--
-- They are captured at session creation (the search request) rather than at hold
-- creation, so the earlier funnel events have them too.
--
-- All five are nullable: the guest may decline marketing cookies, in which case
-- the frontend sends nothing at all and no server conversion is emitted.
--
-- marketing_consent defaults to false rather than null. Every existing row
-- predates capture, and "did not consent" is the safe reading of silence — this
-- column is the gate that decides whether a booking is reported to Google and
-- Meta at all, so it must fail closed.

alter table booking_sessions
  add column ga_client_id text,
  add column ga_session_id text,
  add column fbp text,
  add column fbc text,
  add column gclid text,
  add column marketing_consent boolean not null default false;
