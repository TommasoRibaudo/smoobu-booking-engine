import { BookingSessionQuotedProperty, RdsBookingSessionRepository } from "./bookingSessions";

const QUOTED_PROPERTIES: BookingSessionQuotedProperty[] = [
  {
    propertyId: "11111111-0000-4000-8000-000000000001",
    currency: "USD",
    totalAmountCents: 45000,
    nightlyAverageCents: 15000,
    nights: 3,
    includesTaxes: false,
    rateSource: "smoobu",
  },
];

const BASE_ROW = {
  id: "11111111-1111-4111-8111-111111111111",
  reservation_public_id: "KWL-ABCDEFGH",
  quote_id: "qt_TEST",
  status: "quoted",
  language: "en",
  arrival_date: "2026-05-01",
  departure_date: "2026-05-04",
  guests: 2,
  source: "booking-page",
  quote_expires_at: "2026-04-18T12:10:00.000Z",
  quoted_properties: QUOTED_PROPERTIES,
  property_id: null,
  payment_method: null,
  currency: null,
  total_amount_cents: null,
  guest_first_name: null,
  guest_last_name: null,
  guest_email: null,
  guest_phone: null,
  guest_country: null,
  guest_message: null,
  portal_password_hash: null,
  portal_password_set_at: null,
  expires_at: null,
  paypal_order_id: null,
  confirmed_at: null,
  failure_reason: null,
  created_at: "2026-04-18T12:00:00.000Z",
  updated_at: "2026-04-18T12:00:00.000Z",
};

function createPool(query: jest.Mock) {
  return { query } as unknown as ConstructorParameters<typeof RdsBookingSessionRepository>[0];
}

test("RdsBookingSessionRepository.createQuotedSession inserts and maps a quoted booking session", async () => {
  const query = jest.fn(async (_sql: string, values: unknown[]) => ({
    rows: [
      {
        ...BASE_ROW,
        id: values[0],
        reservation_public_id: values[1],
        quote_id: values[2],
        status: values[3],
        language: values[4],
        arrival_date: values[5],
        departure_date: values[6],
        guests: values[7],
        source: values[8],
        quote_expires_at: values[9],
        quoted_properties: JSON.parse(values[10] as string),
        created_at: values[11],
        updated_at: values[12],
      },
    ],
  }));
  const repo = new RdsBookingSessionRepository(createPool(query));

  const record = await repo.createQuotedSession({
    arrivalDate: "2026-05-01",
    departureDate: "2026-05-04",
    guests: 2,
    language: "en",
    source: "booking-page",
    quotedProperties: BASE_ROW.quoted_properties,
  });

  expect(query).toHaveBeenCalledWith(expect.stringContaining("insert into booking_sessions"), expect.any(Array));
  expect(record.status).toBe("quoted");
  expect(record.arrivalDate).toBe("2026-05-01");
  expect(record.departureDate).toBe("2026-05-04");
  expect(record.source).toBe("booking-page");
  expect(record.quotedProperties).toEqual(BASE_ROW.quoted_properties);
});

test("RdsBookingSessionRepository.createNoAvailabilitySession inserts and maps a no-availability quote", async () => {
  const query = jest.fn(async (_sql: string, values: unknown[]) => ({
    rows: [
      {
        ...BASE_ROW,
        id: values[0],
        reservation_public_id: values[1],
        quote_id: values[2],
        status: values[3],
        language: values[4],
        arrival_date: values[5],
        departure_date: values[6],
        guests: values[7],
        source: values[8],
        quote_expires_at: values[9],
        quoted_properties: JSON.parse(values[10] as string),
        created_at: values[11],
        updated_at: values[12],
      },
    ],
  }));
  const repo = new RdsBookingSessionRepository(createPool(query));

  const record = await repo.createNoAvailabilitySession({
    arrivalDate: "2026-05-01",
    departureDate: "2026-05-04",
    guests: 2,
    language: "en",
    source: "booking-page",
  });

  expect(query).toHaveBeenCalledWith(expect.stringContaining("insert into booking_sessions"), expect.any(Array));
  expect(query.mock.calls[0][1][3]).toBe("no_availability");
  expect(record.status).toBe("no_availability");
  expect(record.quotedProperties).toEqual([]);
});

test("RdsBookingSessionRepository.markHoldCreating persists selected property, price, guest, and portal password", async () => {
  const query = jest.fn(async (_sql: string, values: unknown[]) => ({
    rows: [
      {
        ...BASE_ROW,
        id: values[0],
        status: "hold_creating",
        property_id: values[1],
        payment_method: values[2],
        rate_plan: values[3],
        has_pet: values[4],
        currency: values[5],
        total_amount_cents: values[6],
        guest_first_name: values[7],
        guest_last_name: values[8],
        guest_email: values[9],
        guest_phone: values[10],
        guest_country: values[11],
        guest_message: values[12],
        portal_password_hash: values[13],
        portal_password_set_at: "2026-04-18T12:01:00.000Z",
        expires_at: values[14],
        updated_at: "2026-04-18T12:01:00.000Z",
      },
    ],
  }));
  const repo = new RdsBookingSessionRepository(createPool(query));

  const record = await repo.markHoldCreating({
    bookingSessionId: BASE_ROW.id,
    propertyId: "11111111-0000-4000-8000-000000000001",
    paymentMethod: "paypal",
    ratePlan: "flexible",
    hasPet: true,
    price: BASE_ROW.quoted_properties[0],
    guest: {
      firstName: "Jane",
      lastName: "Doe",
      email: "jane@example.com",
      phone: "+50688888888",
    },
    portalPasswordHash: "scrypt$hash",
    expiresAt: "2026-04-18T13:00:00.000Z",
  });

  expect(record.status).toBe("hold_creating");
  expect(record.propertyId).toBe("11111111-0000-4000-8000-000000000001");
  expect(record.paymentMethod).toBe("paypal");
  expect(record.ratePlan).toBe("flexible");
  expect(record.hasPet).toBe(true);
  expect(record.currency).toBe("USD");
  expect(record.totalAmountCents).toBe(45000);
  expect(record.guest).toMatchObject({ firstName: "Jane", lastName: "Doe", email: "jane@example.com" });
  expect(record.portalPasswordHash).toBe("scrypt$hash");
  expect(record.expiresAt).toBe("2026-04-18T13:00:00.000Z");
});

test("RdsBookingSessionRepository.markCancelled records the reason, actor and timestamp", async () => {
  const query = jest.fn(async (_sql: string, values: unknown[]) => ({
    rows: [
      {
        ...BASE_ROW,
        status: "cancelled",
        cancelled_at: values[3],
        cancellation_reason: values[1],
        cancelled_by: values[2],
      },
    ],
  }));
  const repo = new RdsBookingSessionRepository(createPool(query));

  const record = await repo.markCancelled({
    bookingSessionId: BASE_ROW.id,
    reason: "change_of_plans",
    cancelledBy: "guest",
    cancelledAt: "2026-04-20T09:00:00.000Z",
  });

  expect(record.status).toBe("cancelled");
  expect(record.cancellationReason).toBe("change_of_plans");
  expect(record.cancelledBy).toBe("guest");
  expect(record.cancelledAt).toBe("2026-04-20T09:00:00.000Z");

  const [sql] = query.mock.calls[0];
  // 'cancelled' is in the guard so a repeat cancellation is a no-op, not a throw.
  expect(sql).toContain("status in ('booking_confirmed', 'hold_active', 'cancelled')");
  // coalesce preserves the first cancellation's reason and actor.
  expect(sql).toContain("cancelled_at = coalesce(cancelled_at, $4)");
  expect(sql).toContain("cancellation_reason = coalesce(cancellation_reason, $2)");
});

test("RdsBookingSessionRepository.markCancelled rejects sessions that were never confirmed", async () => {
  const query = jest
    .fn()
    .mockResolvedValueOnce({ rows: [] })
    .mockResolvedValueOnce({ rows: [{ ...BASE_ROW, status: "quoted" }] });
  const repo = new RdsBookingSessionRepository(createPool(query));

  await expect(
    repo.markCancelled({
      bookingSessionId: BASE_ROW.id,
      reason: "change_of_plans",
      cancelledBy: "guest",
      cancelledAt: "2026-04-20T09:00:00.000Z",
    })
  ).rejects.toThrow(
    `Cannot transition booking session ${BASE_ROW.id} to cancelled: expected booking_confirmed, got quoted.`
  );
});

test("RdsBookingSessionRepository.markPaypalOrderCreated rejects non-hold_active sessions", async () => {
  const query = jest
    .fn()
    .mockResolvedValueOnce({ rows: [] })
    .mockResolvedValueOnce({ rows: [{ ...BASE_ROW, status: "quoted" }] });
  const repo = new RdsBookingSessionRepository(createPool(query));

  await expect(
    repo.markPaypalOrderCreated({
      bookingSessionId: BASE_ROW.id,
      paypalOrderId: "PAYPAL-ORDER-1",
    })
  ).rejects.toThrow(
    `Cannot transition booking session ${BASE_ROW.id} to paypal_order_created: expected hold_active, got quoted.`
  );

  expect(query).toHaveBeenNthCalledWith(
    1,
    expect.stringContaining("where id = $1 and status = 'hold_active'"),
    [BASE_ROW.id, "PAYPAL-ORDER-1"]
  );
});

test("RdsBookingSessionRepository.markHoldCreating guards on quoted status", async () => {
  // UPDATE returns no rows because status is not 'quoted'; follow-up SELECT returns the session.
  const query = jest
    .fn()
    .mockResolvedValueOnce({ rows: [] })
    .mockResolvedValueOnce({ rows: [{ ...BASE_ROW, status: "hold_active" }] });
  const repo = new RdsBookingSessionRepository(createPool(query));

  await expect(
    repo.markHoldCreating({
      bookingSessionId: BASE_ROW.id,
      propertyId: "11111111-0000-4000-8000-000000000001",
      paymentMethod: "paypal",
      ratePlan: "flexible",
      price: BASE_ROW.quoted_properties[0],
      guest: { firstName: "Jane", lastName: "Doe", email: "jane@example.com" },
      portalPasswordHash: "scrypt$hash",
      expiresAt: "2026-04-18T13:00:00.000Z",
    })
  ).rejects.toThrow(
    `Cannot transition booking session ${BASE_ROW.id} to hold_creating: expected quoted, got hold_active.`
  );

  expect(query).toHaveBeenNthCalledWith(
    1,
    expect.stringContaining("where id = $1 and status = 'quoted'"),
    expect.any(Array)
  );
});

test("RdsBookingSessionRepository.markHoldActive guards on hold_creating status", async () => {
  const query = jest
    .fn()
    .mockResolvedValueOnce({ rows: [] })
    .mockResolvedValueOnce({ rows: [{ ...BASE_ROW, status: "quoted" }] });
  const repo = new RdsBookingSessionRepository(createPool(query));

  await expect(
    repo.markHoldActive({ bookingSessionId: BASE_ROW.id, expiresAt: "2026-04-18T13:00:00.000Z" })
  ).rejects.toThrow(
    `Cannot transition booking session ${BASE_ROW.id} to hold_active: expected hold_creating, got quoted.`
  );

  expect(query).toHaveBeenNthCalledWith(
    1,
    expect.stringContaining("where id = $1 and status = 'hold_creating'"),
    [BASE_ROW.id, "2026-04-18T13:00:00.000Z"]
  );
});

test("RdsBookingSessionRepository.markHoldActive succeeds and maps the updated row", async () => {
  const expiresAt = "2026-04-18T13:00:00.000Z";
  const query = jest.fn(async (_sql: string, values: unknown[]) => ({
    rows: [{ ...BASE_ROW, status: "hold_active", expires_at: values[1] }],
  }));
  const repo = new RdsBookingSessionRepository(createPool(query));

  const record = await repo.markHoldActive({ bookingSessionId: BASE_ROW.id, expiresAt });

  expect(record.status).toBe("hold_active");
  expect(record.expiresAt).toBe(expiresAt);
});

test("RdsBookingSessionRepository.markBookingConfirmed succeeds and maps the updated row", async () => {
  const confirmedAt = "2026-04-18T14:00:00.000Z";
  const query = jest.fn(async (_sql: string, values: unknown[]) => ({
    rows: [{ ...BASE_ROW, status: "booking_confirmed", confirmed_at: values[1] }],
  }));
  const repo = new RdsBookingSessionRepository(createPool(query));

  const record = await repo.markBookingConfirmed({ bookingSessionId: BASE_ROW.id, confirmedAt });

  expect(record.status).toBe("booking_confirmed");
  expect(record.confirmedAt).toBe(confirmedAt);
});

test("RdsBookingSessionRepository.markFailed succeeds and maps the updated row", async () => {
  const query = jest.fn(async () => ({
    rows: [{ ...BASE_ROW, status: "failed", failure_reason: "smoobu_error" }],
  }));
  const repo = new RdsBookingSessionRepository(createPool(query));

  const record = await repo.markFailed({ bookingSessionId: BASE_ROW.id, reason: "smoobu_error" });

  expect(record.status).toBe("failed");
  expect(record.failureReason).toBe("smoobu_error");
});

test("RdsBookingSessionRepository.markFailed is a no-op on already-terminal sessions", async () => {
  // UPDATE returns no rows (status guard blocked it); follow-up SELECT returns confirmed session.
  const confirmedRow = { ...BASE_ROW, status: "booking_confirmed", confirmed_at: "2026-04-18T14:00:00.000Z" };
  const query = jest
    .fn()
    .mockResolvedValueOnce({ rows: [] })
    .mockResolvedValueOnce({ rows: [confirmedRow] });
  const repo = new RdsBookingSessionRepository(createPool(query));

  const record = await repo.markFailed({ bookingSessionId: BASE_ROW.id, reason: "late_error" });

  // Should return the existing confirmed record unchanged, not throw.
  expect(record.status).toBe("booking_confirmed");
});

test("RdsBookingSessionRepository.markHoldExpired succeeds and maps the updated row", async () => {
  const query = jest.fn(async () => ({
    rows: [{ ...BASE_ROW, status: "hold_expired" }],
  }));
  const repo = new RdsBookingSessionRepository(createPool(query));

  const record = await repo.markHoldExpired({ bookingSessionId: BASE_ROW.id });

  expect(record.status).toBe("hold_expired");
});

test("RdsBookingSessionRepository.getByQuoteId returns undefined when not found", async () => {
  const query = jest.fn(async () => ({ rows: [] }));
  const repo = new RdsBookingSessionRepository(createPool(query));

  const result = await repo.getByQuoteId("qt_NOTEXIST");

  expect(result).toBeUndefined();
  expect(query).toHaveBeenCalledWith(
    expect.stringContaining("where quote_id = $1"),
    ["qt_NOTEXIST"]
  );
});

test("RdsBookingSessionRepository.getByReservationPublicId returns the mapped record", async () => {
  const query = jest.fn(async () => ({ rows: [BASE_ROW] }));
  const repo = new RdsBookingSessionRepository(createPool(query));

  const result = await repo.getByReservationPublicId("KWL-ABCDEFGH");

  expect(result?.reservationPublicId).toBe("KWL-ABCDEFGH");
  expect(query).toHaveBeenCalledWith(
    expect.stringContaining("where reservation_public_id = $1"),
    ["KWL-ABCDEFGH"]
  );
});

test("RdsBookingSessionRepository.listByStatus returns all matching rows", async () => {
  const rows = [
    { ...BASE_ROW, id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
    { ...BASE_ROW, id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" },
  ];
  const query = jest.fn(async () => ({ rows }));
  const repo = new RdsBookingSessionRepository(createPool(query));

  const results = await repo.listByStatus("quoted");

  expect(results).toHaveLength(2);
  expect(results[0].id).toBe(rows[0].id);
  expect(results[1].id).toBe(rows[1].id);
  expect(query).toHaveBeenCalledWith(
    expect.stringContaining("where status = $1"),
    ["quoted"]
  );
});

test("RdsBookingSessionRepository.throwMissingOrInvalidTransition throws not-found when session is absent", async () => {
  // First call: guarded UPDATE returns nothing. Second call: SELECT also returns nothing.
  const query = jest.fn().mockResolvedValue({ rows: [] });
  const repo = new RdsBookingSessionRepository(createPool(query));

  await expect(
    repo.markPaypalOrderCreated({ bookingSessionId: BASE_ROW.id, paypalOrderId: "PAYPAL-ORDER-X" })
  ).rejects.toThrow(`Booking session ${BASE_ROW.id} was not found.`);
});
