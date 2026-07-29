-- Demo seed data. Replace with your own properties — see propertyCatalog.ts
-- for the matching in-memory catalog and the field-by-field explanation.
insert into properties (
  id,
  smoobu_apartment_id,
  canonical_slug,
  english_slug,
  spanish_slug,
  display_name_en,
  display_name_es,
  guest_capacity,
  thumbnail_url,
  amenities
) values
  (
    '11111111-0000-4000-8000-000000000001',
    100001,
    'SunsetVilla',
    'SunsetVilla',
    'SunsetVillaES',
    'Sunset Villa',
    'Sunset Villa',
    6,
    'https://picsum.photos/seed/sunset-villa/1000/700',
    '[{"code":"bath","label":"Private equipped bathroom"},{"code":"kitchen","label":"Private equipped kitchen"},{"code":"ac","label":"A/C"},{"code":"parking","label":"Private fenced parking"},{"code":"wifi","label":"100Mbps WiFi"},{"code":"pet","label":"Pet friendly"}]'::jsonb
  ),
  (
    '11111111-0000-4000-8000-000000000002',
    100002,
    'PalmCottage',
    'PalmCottage',
    'PalmCottageES',
    'Palm Cottage',
    'Palm Cottage',
    4,
    'https://picsum.photos/seed/palm-cottage/1000/700',
    '[{"code":"bath","label":"Private equipped bathroom"},{"code":"kitchen","label":"Private equipped kitchen"},{"code":"ac","label":"A/C"},{"code":"wifi","label":"100Mbps WiFi"},{"code":"parking","label":"Outside parking"},{"code":"pet","label":"Pet friendly"}]'::jsonb
  ),
  (
    '11111111-0000-4000-8000-000000000003',
    100003,
    'OceanBreeze',
    'OceanBreeze',
    'OceanBreezeES',
    'Ocean Breeze House',
    'Ocean Breeze House',
    2,
    'https://picsum.photos/seed/ocean-breeze/1000/700',
    '[{"code":"pool","label":"Private pool"},{"code":"bath","label":"Private equipped bathroom"},{"code":"kitchen","label":"Private equipped kitchen"},{"code":"ac","label":"A/C"},{"code":"parking","label":"Private unfenced parking"},{"code":"wifi","label":"100Mbps WiFi"}]'::jsonb
  ),
  (
    '11111111-0000-4000-8000-000000000004',
    100004,
    'JungleLoft',
    'JungleLoft',
    'JungleLoftES',
    'Jungle Loft',
    'Jungle Loft',
    8,
    'https://picsum.photos/seed/jungle-loft/1000/700',
    '[{"code":"bath","label":"2 bathrooms"},{"code":"kitchen","label":"Private equipped kitchen"},{"code":"ac","label":"A/C"},{"code":"wifi","label":"100Mbps WiFi"},{"code":"parking","label":"Private fenced parking"}]'::jsonb
  )
on conflict (id) do update set
  smoobu_apartment_id = excluded.smoobu_apartment_id,
  canonical_slug = excluded.canonical_slug,
  english_slug = excluded.english_slug,
  spanish_slug = excluded.spanish_slug,
  display_name_en = excluded.display_name_en,
  display_name_es = excluded.display_name_es,
  guest_capacity = excluded.guest_capacity,
  thumbnail_url = excluded.thumbnail_url,
  amenities = excluded.amenities,
  is_active = true,
  updated_at = now();
