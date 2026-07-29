create table properties (
  id uuid primary key default gen_random_uuid(),
  smoobu_apartment_id integer not null unique,
  canonical_slug text not null unique,
  english_slug text not null unique,
  spanish_slug text not null unique,
  display_name_en text not null,
  display_name_es text not null,
  guest_capacity integer not null check (guest_capacity > 0),
  thumbnail_url text,
  amenities jsonb not null default '[]'::jsonb,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint properties_slug_format check (
    canonical_slug ~ '^[A-Za-z0-9]+$'
    and english_slug = canonical_slug
    and spanish_slug = canonical_slug || 'ES'
  )
);

create index properties_active_idx on properties (is_active) where is_active = true;
