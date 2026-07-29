-- Pet-friendly reservations.
--
-- A guest can now tick "travelling with a pet" during checkout. Only properties
-- with the `pet` amenity in propertyCatalog.ts accept pets, and the hold route
-- rejects the combination for any other home — but the fact that a pet is
-- coming has to survive the booking, because
-- housekeeping and staff read it off the reservation long after checkout.
--
-- Defaults to false rather than null: every existing booking was made before the
-- option existed, so "no pet" is the correct reading rather than "unknown".

alter table booking_sessions
  add column has_pet boolean not null default false;
