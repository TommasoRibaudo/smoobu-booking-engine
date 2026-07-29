/**
 * Frontend-side mirror of the demo catalog in `api/src/propertyCatalog.ts`.
 * Keep the slugs here in sync with the backend catalog — replace both with
 * your own properties together.
 */
export const PROPERTY_DISPLAY_NAMES: Record<string, string> = {
  SunsetVilla: 'Sunset Villa',
  PalmCottage: 'Palm Cottage',
  OceanBreeze: 'Ocean Breeze House',
  JungleLoft: 'Jungle Loft',
};

export const MAX_PORTFOLIO_GUESTS = 8;

/**
 * Example of a config-driven property attribute (used by the reference
 * checkout page to show a location badge). Any slug not listed here is
 * treated as `'town-center'`.
 */
export const PROPERTY_LOCATIONS: Record<string, 'town-center' | 'countryside'> = {
  SunsetVilla: 'town-center',
  PalmCottage: 'town-center',
  OceanBreeze: 'countryside',
  JungleLoft: 'countryside',
};
