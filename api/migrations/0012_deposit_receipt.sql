-- Add deposit receipt S3 key to booking_sessions.
-- Stores the S3 object key (not the full URL) of the uploaded deposit receipt image.
-- The presigned download URL is generated on demand from this key.

alter table booking_sessions
  add column deposit_receipt_s3_key text;

create index booking_sessions_deposit_receipt_idx
  on booking_sessions (deposit_receipt_s3_key)
  where deposit_receipt_s3_key is not null;
