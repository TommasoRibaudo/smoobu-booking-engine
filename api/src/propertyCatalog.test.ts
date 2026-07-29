import {
  BOOKING_PROPERTIES,
  BOOKING_PROPERTIES_BY_ID,
  BOOKING_PROPERTIES_BY_SMOOBU_ID,
} from "./propertyCatalog";

test("booking property catalog uses unique Smoobu apartment IDs", () => {
  expect(BOOKING_PROPERTIES).toHaveLength(4);

  const ids = BOOKING_PROPERTIES.map((property) => property.smoobuApartmentId);
  expect(new Set(ids).size).toBe(ids.length);
  expect(ids).toEqual([100001, 100002, 100003, 100004]);
  expect(ids).not.toEqual([1, 2, 3, 4]);
});

test("booking property catalog lookup maps cover every configured property", () => {
  for (const property of BOOKING_PROPERTIES) {
    expect(BOOKING_PROPERTIES_BY_ID.get(property.propertyId)).toBe(property);
    expect(BOOKING_PROPERTIES_BY_SMOOBU_ID.get(property.smoobuApartmentId)).toBe(property);
  }
});
