-- Allow Smoobu Homepage/Website channel (70) on holds after promotion.
-- Holds are created with channelId 11 (Blocked) or 13 (Direct booking),
-- then promoted to channelId 70 (Homepage) after PayPal payment capture.

alter table holds
  drop constraint if exists holds_smoobu_channel;

alter table holds
  add constraint holds_smoobu_channel check (smoobu_channel_id in (11, 13, 70));
