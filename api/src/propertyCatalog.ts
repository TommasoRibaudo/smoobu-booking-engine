export interface PublicAmenity {
  code: string;
  label: string;
}

export interface BookingProperty {
  propertyId: string;
  smoobuApartmentId: number;
  slug: string;
  name: string;
  guestCapacity: number;
  thumbnailUrl: string;
  amenities: PublicAmenity[];
}

/**
 * Demo catalog. Replace with your own properties — each `smoobuApartmentId`
 * must match the apartment ID Smoobu assigns to that listing (visible in the
 * Smoobu dashboard URL when you open an apartment). `propertyId` is your own
 * stable internal ID (any unique string; the values below are just examples)
 * and `slug` is the URL-safe identifier used to build listing links — see
 * `listingUrlForLanguage` below.
 */
export const BOOKING_PROPERTIES: BookingProperty[] = [
  {
    propertyId: "11111111-0000-4000-8000-000000000001",
    smoobuApartmentId: 100001,
    slug: "SunsetVilla",
    name: "Sunset Villa",
    guestCapacity: 6,
    thumbnailUrl: "https://picsum.photos/seed/sunset-villa/1000/700",
    amenities: [
      { code: "bath", label: "Private equipped bathroom" },
      { code: "kitchen", label: "Private equipped kitchen" },
      { code: "ac", label: "A/C" },
      { code: "parking", label: "Private fenced parking" },
      { code: "wifi", label: "100Mbps WiFi" },
      { code: "pet", label: "Pet friendly" },
    ],
  },
  {
    propertyId: "11111111-0000-4000-8000-000000000002",
    smoobuApartmentId: 100002,
    slug: "PalmCottage",
    name: "Palm Cottage",
    guestCapacity: 4,
    thumbnailUrl: "https://picsum.photos/seed/palm-cottage/1000/700",
    amenities: [
      { code: "bath", label: "Private equipped bathroom" },
      { code: "kitchen", label: "Private equipped kitchen" },
      { code: "ac", label: "A/C" },
      { code: "wifi", label: "100Mbps WiFi" },
      { code: "parking", label: "Outside parking" },
      { code: "pet", label: "Pet friendly" },
    ],
  },
  {
    propertyId: "11111111-0000-4000-8000-000000000003",
    smoobuApartmentId: 100003,
    slug: "OceanBreeze",
    name: "Ocean Breeze House",
    guestCapacity: 2,
    thumbnailUrl: "https://picsum.photos/seed/ocean-breeze/1000/700",
    amenities: [
      { code: "pool", label: "Private pool" },
      { code: "bath", label: "Private equipped bathroom" },
      { code: "kitchen", label: "Private equipped kitchen" },
      { code: "ac", label: "A/C" },
      { code: "parking", label: "Private unfenced parking" },
      { code: "wifi", label: "100Mbps WiFi" },
    ],
  },
  {
    propertyId: "11111111-0000-4000-8000-000000000004",
    smoobuApartmentId: 100004,
    slug: "JungleLoft",
    name: "Jungle Loft",
    guestCapacity: 8,
    thumbnailUrl: "https://picsum.photos/seed/jungle-loft/1000/700",
    amenities: [
      { code: "bath", label: "2 bathrooms" },
      { code: "kitchen", label: "Private equipped kitchen" },
      { code: "ac", label: "A/C" },
      { code: "wifi", label: "100Mbps WiFi" },
      { code: "parking", label: "Private fenced parking" },
    ],
  },
];

/**
 * Whether the home accepts a pet. Derived from the `pet` amenity so the badge a
 * guest sees on the card and the filter behind the "travelling with a pet"
 * toggle can never disagree.
 */
export function isPetFriendly(property: BookingProperty): boolean {
  return property.amenities.some((amenity) => amenity.code === "pet");
}

export const BOOKING_PROPERTIES_BY_SMOOBU_ID = new Map(
  BOOKING_PROPERTIES.map((property) => [property.smoobuApartmentId, property])
);

export const BOOKING_PROPERTIES_BY_ID = new Map(BOOKING_PROPERTIES.map((property) => [property.propertyId, property]));

export function listingUrlForLanguage(slug: string, language: "en" | "es"): string {
  return `/${slug}${language === "es" ? "ES" : ""}`;
}
