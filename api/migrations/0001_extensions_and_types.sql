create extension if not exists pgcrypto;
create extension if not exists btree_gist;

do $$
begin
  if not exists (select 1 from pg_type where typname = 'booking_language') then
    create type booking_language as enum ('en', 'es');
  end if;

  if not exists (select 1 from pg_type where typname = 'booking_status') then
    create type booking_status as enum (
      'search_started',
      'quoted',
      'no_availability',
      'hold_creating',
      'hold_active',
      'paypal_pending',
      'paypal_order_created',
      'paypal_captured',
      'paid',
      'confirmed',
      'booking_confirmed',
      'hold_expired',
      'expired',
      'cancelled',
      'failed'
    );
  end if;

  if not exists (select 1 from pg_type where typname = 'payment_method') then
    create type payment_method as enum ('paypal');
  end if;

  if not exists (select 1 from pg_type where typname = 'hold_status') then
    create type hold_status as enum (
      'creating',
      'active',
      'expired',
      'cancelled',
      'converted',
      'failed'
    );
  end if;

  if not exists (select 1 from pg_type where typname = 'payment_status') then
    create type payment_status as enum (
      'pending',
      'order_created',
      'captured',
      'paid',
      'failed',
      'cancelled',
      'refund_flagged'
    );
  end if;

  if not exists (select 1 from pg_type where typname = 'payment_provider') then
    create type payment_provider as enum ('paypal');
  end if;

  if not exists (select 1 from pg_type where typname = 'webhook_provider') then
    create type webhook_provider as enum ('paypal', 'smoobu');
  end if;

  if not exists (select 1 from pg_type where typname = 'webhook_processing_status') then
    create type webhook_processing_status as enum (
      'received',
      'pending',
      'verified',
      'processing',
      'processed',
      'ignored',
      'duplicate',
      'rejected_signature',
      'failed'
    );
  end if;

  if not exists (select 1 from pg_type where typname = 'idempotency_status') then
    create type idempotency_status as enum (
      'in_progress',
      'completed',
      'failed'
    );
  end if;

  if not exists (select 1 from pg_type where typname = 'actor_type') then
    create type actor_type as enum ('guest', 'system', 'provider');
  end if;

  if not exists (select 1 from pg_type where typname = 'portal_session_status') then
    create type portal_session_status as enum ('active', 'expired', 'revoked');
  end if;
end
$$;
