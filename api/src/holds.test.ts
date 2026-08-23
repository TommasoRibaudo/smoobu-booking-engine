import { createBookingApiHandler } from "./app";
import { InMemoryBookingSessionRepository } from "./bookingSessions";
import { InMemoryHoldRepository, RdsHoldRepository } from "./holds";
import { SITE_NAME } from "./branding";
import { StaticSecretProvider } from "./secrets";
import { BookingApiConfig, LambdaHttpRequest } from "./types";

let bookingSessions: InMemoryBookingSessionRepository;
let holds: InMemoryHoldRepository;
let config: BookingApiConfig;

const BASE_HOLD_ROW = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  booking_session_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  property_id: "11111111-0000-4000-8000-000000000001",
  arrival_date: "2099-06-10",
  departure_date: "2099-06-14",
  status: "creating",
  expires_at: "2026-04-15T19:00:00.000Z",
  smoobu_reservation_id: null,
  smoobu_channel_id: 11,
  smoobu_create_payload_hash: "payload-hash",
  last_smoobu_error: null,
  created_at: "2026-04-15T18:00:00.000Z",
  updated_at: "2026-04-15T18:00:00.000Z",
};

function createPool(query: jest.Mock) {
  return { query } as unknown as ConstructorParameters<typeof RdsHoldRepository>[0];
}

function createTestConfig(): BookingApiConfig {
  bookingSessions = new InMemoryBookingSessionRepository();
  holds = new InMemoryHoldRepository();
  return {
    allowedOrigins: ["https://booking.test"],
    maxBodyBytes: 64 * 1024,
    secrets: new StaticSecretProvider({
      smoobuApiKey: "smoobu-secret-value",
      smoobuApiSecret: "smoobu-api-secret-value",
      smoobuWebhookSecret: "smoobu-webhook-secret-value",
      paypalClientId: "paypal-client-id-value",
      paypalClientSecret: "paypal-client-secret-value",
      paypalWebhookId: "paypal-webhook-id-value",
      bookingEncryptionKeyBase64: Buffer.alloc(32, 7).toString("base64"),
      portalSessionSecret: "portal-session-secret-value",
      rdsConnectionString: "postgres://booking_user:booking_password@db.example.com:5432/booking_engine",
    }),
    smoobu: {
      baseUrl: "https://login.smoobu.com",
      customerId: 9,
      timeoutMs: 8_000,
      maxRetries: 0,
      baseBackoffMs: 250,
      maxBackoffMs: 2_000,
      maxRateLimitDelayMs: 60_000,
      holdChannelId: 11,
    },
    paypal: {
      baseUrl: "https://api-m.sandbox.paypal.com",
      timeoutMs: 10_000,
      orderReturnUrl: "",
      orderCancelUrl: "",
    },
    bookingSessions,
    holds,
    hold: {
      defaultTtlMinutes: 60,
      idempotencyTtlMinutes: 1440,
      staleIdempotencyLockSeconds: 120,
    },
    abuseProtection: {
      enabled: false,
      captchaChallengesEnabled: false,
      maxTrackedBuckets: 100,
    },
    email: {
      fromAddress: "test@example.com",
      region: "us-east-1",
      disabled: true,
    },
    observability: {
      serviceName: "booking-api",
      environment: "test",
      logLevel: "silent",
      metricsEnabled: false,
    },
  };
}

const originalFetch = global.fetch;

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date("2026-04-15T18:00:00Z"));
  config = createTestConfig();
});

afterEach(() => {
  jest.useRealTimers();
  global.fetch = originalFetch;
  jest.restoreAllMocks();
});

function makeSearchEvent(): LambdaHttpRequest {
  return {
    version: "2.0",
    rawPath: "/api/search",
    headers: {
      "content-type": "application/json",
      origin: "https://booking.test",
      "user-agent": "Jest Browser",
      "x-booking-device-id": "device-hold-123",
    },
    body: JSON.stringify({
      arrivalDate: "2099-06-10",
      departureDate: "2099-06-14",
      guests: 2,
      language: "en",
      source: "booking_page",
    }),
    requestContext: {
      http: {
        method: "POST",
        path: "/api/search",
        sourceIp: "203.0.113.30",
        userAgent: "Jest Browser",
      },
    },
  };
}

function makeHoldEvent(body: unknown, idempotencyKey = "idem-hold-0000000001"): LambdaHttpRequest {
  return {
    version: "2.0",
    rawPath: "/api/holds",
    headers: {
      "content-type": "application/json",
      "idempotency-key": idempotencyKey,
      origin: "https://booking.test",
      "user-agent": "Jest Browser",
      "x-booking-device-id": "device-hold-123",
    },
    body: JSON.stringify(body),
    requestContext: {
      http: {
        method: "POST",
        path: "/api/holds",
        sourceIp: "203.0.113.30",
        userAgent: "Jest Browser",
      },
    },
  };
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init.headers as Record<string, string> | undefined),
    },
  });
}

test("RdsHoldRepository.createCreatingHold inserts and maps a creating hold", async () => {
  const query = jest.fn(async (_sql: string, values: unknown[]) => ({
    rows: [
      {
        ...BASE_HOLD_ROW,
        booking_session_id: values[0],
        property_id: values[1],
        arrival_date: values[2],
        departure_date: values[3],
        expires_at: values[4],
        smoobu_channel_id: values[5],
        smoobu_create_payload_hash: values[6],
      },
    ],
  }));
  const repo = new RdsHoldRepository(createPool(query));

  const record = await repo.createCreatingHold({
    bookingSessionId: BASE_HOLD_ROW.booking_session_id,
    propertyId: BASE_HOLD_ROW.property_id,
    arrivalDate: "2099-06-10",
    departureDate: "2099-06-14",
    expiresAt: "2026-04-15T19:00:00.000Z",
    smoobuChannelId: 11,
    smoobuCreatePayloadHash: "payload-hash",
  });

  expect(query).toHaveBeenCalledWith(expect.stringContaining("insert into holds"), expect.any(Array));
  expect(record).toMatchObject({
    bookingSessionId: BASE_HOLD_ROW.booking_session_id,
    propertyId: BASE_HOLD_ROW.property_id,
    status: "creating",
    arrivalDate: "2099-06-10",
    departureDate: "2099-06-14",
    smoobuChannelId: 11,
    smoobuCreatePayloadHash: "payload-hash",
  });
});

test("RdsHoldRepository.createCreatingHold maps overlap constraint failures to no-longer-available", async () => {
  const query = jest.fn(async () => {
    throw { code: "23P01", constraint: "holds_no_overlapping_active_inventory" };
  });
  const repo = new RdsHoldRepository(createPool(query));

  await expect(
    repo.createCreatingHold({
      bookingSessionId: BASE_HOLD_ROW.booking_session_id,
      propertyId: BASE_HOLD_ROW.property_id,
      arrivalDate: "2099-06-10",
      departureDate: "2099-06-14",
      expiresAt: "2026-04-15T19:00:00.000Z",
      smoobuChannelId: 11,
      smoobuCreatePayloadHash: "payload-hash",
    })
  ).rejects.toMatchObject({
    statusCode: 409,
    code: "property_no_longer_available",
    retryable: false,
  });
});

test("RdsHoldRepository.activateHold stores the Smoobu reservation id", async () => {
  const query = jest.fn(async (_sql: string, values: unknown[]) => ({
    rows: [
      {
        ...BASE_HOLD_ROW,
        status: "active",
        smoobu_reservation_id: values[1],
        updated_at: "2026-04-15T18:01:00.000Z",
      },
    ],
  }));
  const repo = new RdsHoldRepository(createPool(query));

  const record = await repo.activateHold({ holdId: BASE_HOLD_ROW.id, smoobuReservationId: 987654 });

  expect(record.status).toBe("active");
  expect(record.smoobuReservationId).toBe(987654);
  expect(query).toHaveBeenCalledWith(expect.stringContaining("smoobu_reservation_id = $2"), [
    BASE_HOLD_ROW.id,
    987654,
  ]);
});

test("RdsHoldRepository.activateHold guards on creating status", async () => {
  const query = jest
    .fn()
    .mockResolvedValueOnce({ rows: [] })
    .mockResolvedValueOnce({ rows: [{ ...BASE_HOLD_ROW, status: "expired" }] });
  const repo = new RdsHoldRepository(createPool(query));

  await expect(repo.activateHold({ holdId: BASE_HOLD_ROW.id, smoobuReservationId: 987654 })).rejects.toThrow(
    `Cannot transition hold ${BASE_HOLD_ROW.id} to active: expected creating, got expired.`
  );

  expect(query).toHaveBeenNthCalledWith(1, expect.stringContaining("and status = 'creating'"), [
    BASE_HOLD_ROW.id,
    987654,
  ]);
});

test("RdsHoldRepository.convertHold records converted_at", async () => {
  const query = jest.fn(async (_sql: string, values: unknown[]) => ({
    rows: [
      {
        ...BASE_HOLD_ROW,
        status: "converted",
        smoobu_reservation_id: values[1],
        smoobu_channel_id: values[2],
        updated_at: "2026-04-15T18:02:00.000Z",
      },
    ],
  }));
  const repo = new RdsHoldRepository(createPool(query));

  const record = await repo.convertHold({
    holdId: BASE_HOLD_ROW.id,
    newSmoobuReservationId: 5544332,
    newSmoobuChannelId: 70,
  });

  expect(record.status).toBe("converted");
  expect(record.smoobuReservationId).toBe(5544332);
  expect(query).toHaveBeenCalledWith(expect.stringContaining("converted_at = coalesce(converted_at, now())"), [
    BASE_HOLD_ROW.id,
    5544332,
    70,
  ]);
});

/**
 * migrations/0004_holds.sql declares `holds_terminal_timestamps`, which requires the
 * matching timestamp column to be set whenever a hold reaches a terminal status.
 * The in-memory repository has no such constraint, so a missing timestamp here is
 * invisible to every handler-level test and only fails against RDS (SQLSTATE 23514).
 * This asserts the invariant against the emitted SQL instead.
 */
test.each([
  ["expireHold", "expired", "expired_at", (repo: RdsHoldRepository) => repo.expireHold(BASE_HOLD_ROW.id)],
  ["cancelHold", "cancelled", "cancelled_at", (repo: RdsHoldRepository) => repo.cancelHold(BASE_HOLD_ROW.id)],
  [
    "convertHold",
    "converted",
    "converted_at",
    (repo: RdsHoldRepository) =>
      repo.convertHold({ holdId: BASE_HOLD_ROW.id, newSmoobuReservationId: 5544332, newSmoobuChannelId: 70 }),
  ],
] as const)(
  "RdsHoldRepository.%s satisfies holds_terminal_timestamps by setting %s -> %s",
  async (_method, status, timestampColumn, call) => {
    const query = jest.fn(async (_sql: string) => ({ rows: [{ ...BASE_HOLD_ROW, status }] }));
    const repo = new RdsHoldRepository(createPool(query));

    await call(repo);

    const [sql] = query.mock.calls[0];
    expect(sql).toContain(`status = '${status}'`);
    expect(sql).toContain(`${timestampColumn} = coalesce(${timestampColumn}, now())`);
  }
);

test("RdsHoldRepository.failHold leaves terminal holds unchanged", async () => {
  const terminalRow = {
    ...BASE_HOLD_ROW,
    status: "converted",
    smoobu_reservation_id: 987654,
  };
  const query = jest
    .fn()
    .mockResolvedValueOnce({ rows: [] })
    .mockResolvedValueOnce({ rows: [terminalRow] });
  const repo = new RdsHoldRepository(createPool(query));

  const record = await repo.failHold({ holdId: BASE_HOLD_ROW.id, reason: "late_smoobu_error" });

  expect(record.status).toBe("converted");
  expect(record.lastSmoobuError).toBeUndefined();
  expect(query).toHaveBeenNthCalledWith(1, expect.stringContaining("status not in ('converted', 'expired', 'cancelled')"), [
    BASE_HOLD_ROW.id,
    "late_smoobu_error",
  ]);
});

test("RdsHoldRepository.listExpiredHolds atomically claims rows with skip-locked semantics", async () => {
  const query = jest.fn(async () => ({
    rows: [
      {
        ...BASE_HOLD_ROW,
        status: "expired",
        smoobu_reservation_id: 987654,
        updated_at: "2026-04-15T19:01:00.000Z",
      },
    ],
  }));
  const repo = new RdsHoldRepository(createPool(query));

  const records = await repo.listExpiredHolds("2026-04-15T19:01:00.000Z");

  expect(records).toHaveLength(1);
  expect(records[0]).toMatchObject({ status: "expired", smoobuReservationId: 987654 });
  expect(query).toHaveBeenCalledWith(expect.stringContaining("for update of h skip locked"), [
    "2026-04-15T19:01:00.000Z",
  ]);
  expect(query).toHaveBeenCalledWith(expect.stringContaining("update holds"), [
    "2026-04-15T19:01:00.000Z",
  ]);
});

test("RdsHoldRepository reserves, completes, replays, and releases idempotency keys", async () => {
  const completedBody = { ok: true };
  const query = jest
    .fn()
    // reserve insert succeeds
    .mockResolvedValueOnce({ rows: [{ id: "idem-row" }] })
    // store response succeeds
    .mockResolvedValueOnce({ rows: [{ id: "idem-row" }] })
    // get replay
    .mockResolvedValueOnce({
      rows: [
        {
          scope: "booking.hold.create",
          idempotency_key: "idem-hold-0000000001",
          request_hash: "hash-a",
          status: "completed",
          response_status: 200,
          response_body: completedBody,
          expires_at: "2026-04-16T18:00:00.000Z",
          created_at: "2026-04-15T18:00:00.000Z",
        },
      ],
    })
    // release
    .mockResolvedValueOnce({ rows: [] });
  const repo = new RdsHoldRepository(createPool(query));

  await repo.reserveIdempotencyKey({
    scope: "booking.hold.create",
    key: "idem-hold-0000000001",
    requestHash: "hash-a",
    expiresAt: "2026-04-16T18:00:00.000Z",
    staleBefore: "2026-04-15T17:58:00.000Z",
  });
  await repo.storeIdempotencyResponse({
    scope: "booking.hold.create",
    key: "idem-hold-0000000001",
    requestHash: "hash-a",
    response: { statusCode: 200, body: completedBody },
  });
  const replay = await repo.getIdempotencyRecord("booking.hold.create", "idem-hold-0000000001");
  await repo.releaseIdempotencyKey("booking.hold.create", "idem-hold-0000000001", "hash-a");

  expect(replay).toMatchObject({
    scope: "booking.hold.create",
    key: "idem-hold-0000000001",
    requestHash: "hash-a",
    status: "completed",
    response: { statusCode: 200, body: completedBody },
  });
  expect(query).toHaveBeenNthCalledWith(
    2,
    expect.stringContaining("response_body = $5::jsonb"),
    ["booking.hold.create", "idem-hold-0000000001", "hash-a", 200, JSON.stringify(completedBody)]
  );
});

test("RdsHoldRepository.reserveIdempotencyKey rejects fresh conflicting requests", async () => {
  const query = jest
    .fn()
    .mockResolvedValueOnce({ rows: [] })
    .mockResolvedValueOnce({ rows: [] })
    .mockResolvedValueOnce({
      rows: [
        {
          scope: "booking.hold.create",
          idempotency_key: "idem-hold-0000000001",
          request_hash: "hash-existing",
          status: "in_progress",
          response_status: null,
          response_body: null,
          expires_at: "2026-04-16T18:00:00.000Z",
          created_at: "2026-04-15T18:00:00.000Z",
        },
      ],
    });
  const repo = new RdsHoldRepository(createPool(query));

  await expect(
    repo.reserveIdempotencyKey({
      scope: "booking.hold.create",
      key: "idem-hold-0000000001",
      requestHash: "hash-new",
      expiresAt: "2026-04-16T18:00:00.000Z",
      staleBefore: "2026-04-15T17:58:00.000Z",
    })
  ).rejects.toMatchObject({
    statusCode: 409,
    code: "idempotency_conflict",
  });
});

test("POST /api/holds creates a local hold and Smoobu blocked-channel provisional reservation", async () => {
  const fetchFn = jest.fn(async (url: string | URL, _init?: RequestInit) => {
    const pathname = new URL(url.toString()).pathname;
    if (pathname === "/booking/checkApartmentAvailability") {
      return jsonResponse({
        availableApartments: [100001],
        prices: {
          "100001": { price: 510, currency: "USD" },
        },
        errorMessages: {},
      });
    }
    if (pathname === "/api/reservations") {
      return jsonResponse({ id: 987654 });
    }
    return jsonResponse({ detail: "unexpected" }, { status: 500 });
  });
  global.fetch = fetchFn as typeof fetch;
  const handler = createBookingApiHandler(config);

  const searchResponse = await handler(makeSearchEvent());
  const searchBody = JSON.parse(searchResponse.body);
  const getByQuoteIdSpy = jest.spyOn(bookingSessions, "getByQuoteId");
  const holdRequest = {
    quoteId: searchBody.quoteId,
    bookingSessionId: searchBody.bookingSessionId,
    propertyId: searchBody.properties[0].propertyId,
    paymentMethod: "paypal",
    guest: {
      firstName: "Ana",
      lastName: "Mora",
      email: "ana@example.com",
      phone: "+50688888888",
      country: "CR",
      message: "Arriving around 4pm",
    },
    portalPassword: "correct horse battery staple",
    termsAccepted: true,
    marketingConsent: false,
  };

  const response = await handler(makeHoldEvent(holdRequest));

  expect(response.statusCode).toBe(200);
  expect(getByQuoteIdSpy).toHaveBeenCalledWith(searchBody.quoteId);
  const body = JSON.parse(response.body);
  expect(body).toMatchObject({
    booking: {
      bookingSessionId: searchBody.bookingSessionId,
      status: "hold_active",
      language: "en",
      arrivalDate: "2099-06-10",
      departureDate: "2099-06-14",
      guests: 2,
      property: {
        slug: "SunsetVilla",
        listingUrl: "/SunsetVilla",
        name: "Sunset Villa",
      },
      price: {
        currency: "USD",
        totalAmountCents: 51000,
        nightlyAverageCents: 12750,
        nights: 4,
        rateSource: "smoobu",
      },
      hold: {
        status: "active",
        expiresAt: "2026-04-15T19:00:00.000Z",
      },
      payment: {
        method: "paypal",
        status: "pending",
      },
    },
    nextAction: "create_paypal_order",
  });
  expect(body.booking.reservationPublicId).toMatch(/^KWL-[A-Z2-9]{8}$/);
  expect(JSON.stringify(body)).not.toContain("987654");
  expect(JSON.stringify(body)).not.toContain("smoobuReservationId");

  expect(fetchFn).toHaveBeenCalledTimes(3);
  const [, holdAvailabilityInit] = fetchFn.mock.calls[1];
  expect(JSON.parse(holdAvailabilityInit?.body as string)).toEqual({
    arrivalDate: "2099-06-10",
    departureDate: "2099-06-14",
    apartments: [100001],
    customerId: 9,
    guests: 2,
  });

  const [reservationUrl, reservationInit] = fetchFn.mock.calls[2];
  expect(new URL(reservationUrl.toString()).pathname).toBe("/api/reservations");
  const reservationPayload = JSON.parse(reservationInit?.body as string);
  expect(reservationPayload).toMatchObject({
    arrivalDate: "2099-06-10",
    departureDate: "2099-06-14",
    channelId: 11,
    apartmentId: 100001,
    firstName: "Ana",
    lastName: "Mora",
    email: "ana@example.com",
    phone: "+50688888888",
    country: "CR",
    adults: 2,
    children: 0,
    price: 510,
    priceStatus: 0,
    prepayment: 0,
    prepaymentStatus: 0,
    deposit: 0,
    depositStatus: 0,
    language: "en",
  });
  expect(reservationPayload.notice).toContain(`${SITE_NAME} PayPal provisional hold`);
  expect(reservationPayload.notice).toContain("Not confirmed until PayPal payment is verified");

  const storedSession = await bookingSessions.getById(searchBody.bookingSessionId);
  const storedHold = await holds.getByBookingSessionId(searchBody.bookingSessionId);
  expect(storedSession).toMatchObject({
    status: "hold_active",
    paymentMethod: "paypal",
    totalAmountCents: 51000,
    expiresAt: "2026-04-15T19:00:00.000Z",
  });
  expect(storedSession?.portalPasswordHash).toMatch(/^scryptN16384r8p1/);
  expect(storedSession?.portalPasswordHash).not.toContain("correct horse battery staple");
  expect(storedHold).toMatchObject({
    status: "active",
    smoobuReservationId: 987654,
    smoobuChannelId: 11,
  });
});

test("POST /api/holds replays successful responses for the same idempotency key without another Smoobu reservation", async () => {
  global.fetch = jest.fn(async (url: string | URL) => {
    const pathname = new URL(url.toString()).pathname;
    if (pathname === "/booking/checkApartmentAvailability") {
      return jsonResponse({
        availableApartments: [100001],
        prices: {
          "100001": { price: 510, currency: "USD" },
        },
        errorMessages: {},
      });
    }
    return jsonResponse({ id: 987654 });
  }) as typeof fetch;
  const handler = createBookingApiHandler(config);
  const searchResponse = await handler(makeSearchEvent());
  const searchBody = JSON.parse(searchResponse.body);
  const holdRequest = {
    quoteId: searchBody.quoteId,
    bookingSessionId: searchBody.bookingSessionId,
    propertyId: searchBody.properties[0].propertyId,
    paymentMethod: "paypal",
    guest: {
      firstName: "Ana",
      lastName: "Mora",
      email: "ana@example.com",
    },
    portalPassword: "correct horse battery staple",
    termsAccepted: true,
  };

  const first = await handler(makeHoldEvent(holdRequest, "idem-hold-duplicate-1"));
  const second = await handler(makeHoldEvent(holdRequest, "idem-hold-duplicate-1"));

  expect(first.statusCode).toBe(200);
  expect(second.statusCode).toBe(200);
  expect(JSON.parse(second.body)).toEqual(JSON.parse(first.body));
  expect((global.fetch as jest.Mock).mock.calls.filter(([url]) => new URL(url.toString()).pathname === "/api/reservations")).toHaveLength(1);
});

test("POST /api/holds rejects when the just-in-time Smoobu availability recheck fails", async () => {
  let availabilityCall = 0;
  global.fetch = jest.fn(async (url: string | URL) => {
    const pathname = new URL(url.toString()).pathname;
    if (pathname === "/booking/checkApartmentAvailability") {
      availabilityCall += 1;
      if (availabilityCall === 1) {
        return jsonResponse({
          availableApartments: [100001],
          prices: {
            "100001": { price: 510, currency: "USD" },
          },
          errorMessages: {},
        });
      }
      return jsonResponse({
        availableApartments: [],
        prices: {},
        errorMessages: {
          "100001": {
            errorCode: 401,
            message: "The duration of the booking is too short.",
          },
        },
      });
    }
    return jsonResponse({ id: 987654 });
  }) as typeof fetch;
  const handler = createBookingApiHandler(config);
  const searchResponse = await handler(makeSearchEvent());
  const searchBody = JSON.parse(searchResponse.body);

  const response = await handler(
    makeHoldEvent({
      quoteId: searchBody.quoteId,
      bookingSessionId: searchBody.bookingSessionId,
      propertyId: searchBody.properties[0].propertyId,
      paymentMethod: "paypal",
      guest: {
        firstName: "Ana",
        lastName: "Mora",
        email: "ana@example.com",
      },
      portalPassword: "correct horse battery staple",
      termsAccepted: true,
    })
  );

  expect(response.statusCode).toBe(409);
  expect(JSON.parse(response.body).error).toMatchObject({
    code: "property_no_longer_available",
    retryable: false,
  });
  expect((global.fetch as jest.Mock).mock.calls.filter(([url]) => new URL(url.toString()).pathname === "/api/reservations")).toHaveLength(0);
  await expect(holds.getByBookingSessionId(searchBody.bookingSessionId)).resolves.toBeUndefined();
});

test("POST /api/holds rejects with 404 when bookingSessionId and quoteId do not match", async () => {
  const fetchFn = jest.fn();
  global.fetch = fetchFn as typeof fetch;
  const handler = createBookingApiHandler(config);

  const response = await handler(
    makeHoldEvent({
      quoteId: "qt_XXXXXXXXXXXXXXXX",
      bookingSessionId: "a1b2c3d4-e5f6-4a7b-8c9d-e0f1a2b3c4d5",
      propertyId: "b2c3d4e5-f6a7-4b8c-9d0e-f1a2b3c4d5e6",
      paymentMethod: "paypal",
      guest: { firstName: "Ana", lastName: "Mora", email: "ana@example.com" },
      portalPassword: "correct horse battery staple",
      termsAccepted: true,
    })
  );

  expect(response.statusCode).toBe(404);
  expect(JSON.parse(response.body).error.code).toBe("not_found");
  expect(fetchFn).not.toHaveBeenCalled();
});

test("POST /api/holds rejects with 409 when the quote has expired", async () => {
  global.fetch = jest.fn(async (url: string | URL) => {
    const pathname = new URL(url.toString()).pathname;
    if (pathname === "/booking/checkApartmentAvailability") {
      return jsonResponse({ availableApartments: [100001], prices: { "100001": { price: 510, currency: "USD" } }, errorMessages: {} });
    }
    return jsonResponse({ id: 987654 });
  }) as typeof fetch;
  const handler = createBookingApiHandler(config);
  const searchResponse = await handler(makeSearchEvent());
  const searchBody = JSON.parse(searchResponse.body);

  jest.advanceTimersByTime(11 * 60 * 1000);

  const response = await handler(
    makeHoldEvent({
      quoteId: searchBody.quoteId,
      bookingSessionId: searchBody.bookingSessionId,
      propertyId: searchBody.properties[0].propertyId,
      paymentMethod: "paypal",
      guest: { firstName: "Ana", lastName: "Mora", email: "ana@example.com" },
      portalPassword: "correct horse battery staple",
      termsAccepted: true,
    })
  );

  expect(response.statusCode).toBe(409);
  expect(JSON.parse(response.body).error.code).toBe("quote_expired");
  expect((global.fetch as jest.Mock).mock.calls.filter(([url]) => new URL(url.toString()).pathname === "/api/reservations")).toHaveLength(0);
});

test("POST /api/holds rejects with 409 when the quoted price changed before hold creation", async () => {
  let availabilityCall = 0;
  global.fetch = jest.fn(async (url: string | URL) => {
    const pathname = new URL(url.toString()).pathname;
    if (pathname === "/booking/checkApartmentAvailability") {
      availabilityCall += 1;
      const price = availabilityCall === 1 ? 510 : 600;
      return jsonResponse({ availableApartments: [100001], prices: { "100001": { price, currency: "USD" } }, errorMessages: {} });
    }
    return jsonResponse({ id: 987654 });
  }) as typeof fetch;
  const handler = createBookingApiHandler(config);
  const searchResponse = await handler(makeSearchEvent());
  const searchBody = JSON.parse(searchResponse.body);

  const response = await handler(
    makeHoldEvent({
      quoteId: searchBody.quoteId,
      bookingSessionId: searchBody.bookingSessionId,
      propertyId: searchBody.properties[0].propertyId,
      paymentMethod: "paypal",
      guest: { firstName: "Ana", lastName: "Mora", email: "ana@example.com" },
      portalPassword: "correct horse battery staple",
      termsAccepted: true,
    })
  );

  expect(response.statusCode).toBe(409);
  expect(JSON.parse(response.body).error).toMatchObject({
    code: "property_no_longer_available",
    fieldErrors: { quoteId: ["quote_changed"] },
  });
  expect((global.fetch as jest.Mock).mock.calls.filter(([url]) => new URL(url.toString()).pathname === "/api/reservations")).toHaveLength(0);
});

test("POST /api/holds rejects with 409 when the same idempotency key is reused with a different request body", async () => {
  global.fetch = jest.fn(async (url: string | URL) => {
    const pathname = new URL(url.toString()).pathname;
    if (pathname === "/booking/checkApartmentAvailability") {
      return jsonResponse({ availableApartments: [100001], prices: { "100001": { price: 510, currency: "USD" } }, errorMessages: {} });
    }
    return jsonResponse({ id: 987654 });
  }) as typeof fetch;
  const handler = createBookingApiHandler(config);
  const searchResponse = await handler(makeSearchEvent());
  const searchBody = JSON.parse(searchResponse.body);

  const baseRequest = {
    quoteId: searchBody.quoteId,
    bookingSessionId: searchBody.bookingSessionId,
    propertyId: searchBody.properties[0].propertyId,
    paymentMethod: "paypal",
    guest: { firstName: "Ana", lastName: "Mora", email: "ana@example.com" },
    portalPassword: "correct horse battery staple",
    termsAccepted: true,
  };
  const differentRequest = { ...baseRequest, guest: { ...baseRequest.guest, email: "different@example.com" } };

  await handler(makeHoldEvent(baseRequest, "idem-conflict-key-1"));
  const conflict = await handler(makeHoldEvent(differentRequest, "idem-conflict-key-1"));

  expect(conflict.statusCode).toBe(409);
  expect(JSON.parse(conflict.body).error.code).toBe("idempotency_conflict");
});

test("POST /api/holds rejects with 409 when the booking session already has an active hold", async () => {
  global.fetch = jest.fn(async (url: string | URL) => {
    const pathname = new URL(url.toString()).pathname;
    if (pathname === "/booking/checkApartmentAvailability") {
      return jsonResponse({ availableApartments: [100001], prices: { "100001": { price: 510, currency: "USD" } }, errorMessages: {} });
    }
    return jsonResponse({ id: 987654 });
  }) as typeof fetch;
  const handler = createBookingApiHandler(config);
  const searchResponse = await handler(makeSearchEvent());
  const searchBody = JSON.parse(searchResponse.body);

  const holdRequest = {
    quoteId: searchBody.quoteId,
    bookingSessionId: searchBody.bookingSessionId,
    propertyId: searchBody.properties[0].propertyId,
    paymentMethod: "paypal",
    guest: { firstName: "Ana", lastName: "Mora", email: "ana@example.com" },
    portalPassword: "correct horse battery staple",
    termsAccepted: true,
  };

  const first = await handler(makeHoldEvent(holdRequest, "idem-dup-session-1"));
  // Second attempt with a fresh idempotency key: state machine blocks it because the
  // session has already transitioned to hold_active, before createCreatingHold is reached.
  const second = await handler(makeHoldEvent(holdRequest, "idem-dup-session-2"));

  expect(first.statusCode).toBe(200);
  expect(second.statusCode).toBe(409);
  expect(JSON.parse(second.body).error.code).toBe("invalid_booking_state");
});

test("POST /api/holds rolls back to failed state when Smoobu reservation creation fails", async () => {
  let availabilityCall = 0;
  global.fetch = jest.fn(async (url: string | URL) => {
    const pathname = new URL(url.toString()).pathname;
    if (pathname === "/booking/checkApartmentAvailability") {
      availabilityCall += 1;
      return jsonResponse({ availableApartments: [100001], prices: { "100001": { price: 510, currency: "USD" } }, errorMessages: {} });
    }
    if (pathname === "/api/reservations") {
      return jsonResponse({ error: "internal_server_error" }, { status: 500 });
    }
    return jsonResponse({}, { status: 500 });
  }) as typeof fetch;
  const handler = createBookingApiHandler(config);
  const searchResponse = await handler(makeSearchEvent());
  const searchBody = JSON.parse(searchResponse.body);

  const response = await handler(
    makeHoldEvent({
      quoteId: searchBody.quoteId,
      bookingSessionId: searchBody.bookingSessionId,
      propertyId: searchBody.properties[0].propertyId,
      paymentMethod: "paypal",
      guest: { firstName: "Ana", lastName: "Mora", email: "ana@example.com" },
      portalPassword: "correct horse battery staple",
      termsAccepted: true,
    })
  );

  expect(response.statusCode).toBe(503);

  const storedHold = await holds.getByBookingSessionId(searchBody.bookingSessionId);
  const storedSession = await bookingSessions.getById(searchBody.bookingSessionId);
  expect(storedHold?.status).toBe("failed");
  expect(storedSession?.status).toBe("failed");
  expect(storedHold?.smoobuReservationId).toBeUndefined();
});

test("POST /api/holds rejects with 409 when a different user races for the same property and overlapping dates", async () => {
  global.fetch = jest.fn(async (url: string | URL) => {
    const pathname = new URL(url.toString()).pathname;
    if (pathname === "/booking/checkApartmentAvailability") {
      return jsonResponse({
        availableApartments: [100001],
        prices: { "100001": { price: 510, currency: "USD" } },
        errorMessages: {},
      });
    }
    return jsonResponse({ id: 987654 });
  }) as typeof fetch;
  const handler = createBookingApiHandler(config);

  // User A searches and gets a quote
  const searchA = await handler(makeSearchEvent());
  const bodyA = JSON.parse(searchA.body);

  // User B searches independently and gets their own quote
  const searchB = await handler(makeSearchEvent());
  const bodyB = JSON.parse(searchB.body);

  const holdRequestA = {
    quoteId: bodyA.quoteId,
    bookingSessionId: bodyA.bookingSessionId,
    propertyId: bodyA.properties[0].propertyId,
    paymentMethod: "paypal",
    guest: { firstName: "Ana", lastName: "Mora", email: "ana@example.com" },
    portalPassword: "correct horse battery staple",
    termsAccepted: true,
  };
  const holdRequestB = {
    quoteId: bodyB.quoteId,
    bookingSessionId: bodyB.bookingSessionId,
    propertyId: bodyB.properties[0].propertyId,
    paymentMethod: "paypal",
    guest: { firstName: "Bob", lastName: "Smith", email: "bob@example.com" },
    portalPassword: "another secure passphrase",
    termsAccepted: true,
  };

  // User A creates a hold first — should succeed
  const responseA = await handler(makeHoldEvent(holdRequestA, "idem-user-a-00000001"));
  expect(responseA.statusCode).toBe(200);

  // User B tries the same property + overlapping dates — should be rejected
  const responseB = await handler(makeHoldEvent(holdRequestB, "idem-user-b-00000001"));
  expect(responseB.statusCode).toBe(409);
  expect(JSON.parse(responseB.body).error.code).toBe("property_no_longer_available");

  // Only one Smoobu reservation should have been created
  const reservationCalls = (global.fetch as jest.Mock).mock.calls.filter(
    ([url]) => new URL(url.toString()).pathname === "/api/reservations"
  );
  expect(reservationCalls).toHaveLength(1);
});

test("POST /api/holds records a pet on the booking and on the Smoobu notice", async () => {
  const fetchFn = jest.fn(async (url: string | URL, _init?: RequestInit) => {
    const pathname = new URL(url.toString()).pathname;
    if (pathname === "/booking/checkApartmentAvailability") {
      return jsonResponse({
        availableApartments: [100001],
        prices: { "100001": { price: 510, currency: "USD" } },
        errorMessages: {},
      });
    }
    return jsonResponse({ id: 987654 });
  });
  global.fetch = fetchFn as typeof fetch;
  const handler = createBookingApiHandler(config);

  const searchBody = JSON.parse((await handler(makeSearchEvent())).body);
  const response = await handler(
    makeHoldEvent({
      quoteId: searchBody.quoteId,
      bookingSessionId: searchBody.bookingSessionId,
      // Sunset Villa — one of the four pet-friendly homes.
      propertyId: searchBody.properties[0].propertyId,
      paymentMethod: "paypal",
      guest: { firstName: "Ana", lastName: "Mora", email: "ana@example.com", message: "Arriving late" },
      portalPassword: "correct horse battery staple",
      termsAccepted: true,
      withPet: true,
    })
  );

  expect(response.statusCode).toBe(200);

  const [, reservationInit] = fetchFn.mock.calls[2];
  const notice = JSON.parse(reservationInit?.body as string).notice as string;
  expect(notice).toContain("Guest is travelling with a pet.");
  // Ahead of the guest's own note, which staff would otherwise have to read past.
  expect(notice.indexOf("travelling with a pet")).toBeLessThan(notice.indexOf("Arriving late"));

  const storedSession = await bookingSessions.getById(searchBody.bookingSessionId);
  expect(storedSession).toMatchObject({ status: "hold_active", hasPet: true });
});

test("POST /api/holds applies the non-refundable discount via #norefundallowed and records it on the reservation (#307)", async () => {
  const fetchFn = jest.fn(async (url: string | URL, init?: RequestInit) => {
    const pathname = new URL(url.toString()).pathname;
    if (pathname === "/booking/checkApartmentAvailability") {
      // The #norefundallowed code is what actually discounts the rate; Smoobu
      // returns 10% off (510 -> 459) only when it is present on the re-quote.
      const reqBody = init?.body ? JSON.parse(init.body as string) : {};
      const price = reqBody.discountCode === "#norefundallowed" ? 459 : 510;
      return jsonResponse({
        availableApartments: [100001],
        prices: { "100001": { price, currency: "USD" } },
        errorMessages: {},
      });
    }
    if (pathname === "/api/reservations") {
      return jsonResponse({ id: 987654 });
    }
    return jsonResponse({ detail: "unexpected" }, { status: 500 });
  });
  global.fetch = fetchFn as typeof fetch;
  const handler = createBookingApiHandler(config);

  const searchBody = JSON.parse((await handler(makeSearchEvent())).body);
  const response = await handler(
    makeHoldEvent({
      quoteId: searchBody.quoteId,
      bookingSessionId: searchBody.bookingSessionId,
      propertyId: searchBody.properties[0].propertyId,
      paymentMethod: "paypal",
      guest: { firstName: "Ana", lastName: "Mora", email: "ana@example.com" },
      portalPassword: "correct horse battery staple",
      termsAccepted: true,
      nonRefundable: true,
    })
  );

  expect(response.statusCode).toBe(200);

  // The hold re-quote carried the discount code...
  const [, recheckInit] = fetchFn.mock.calls[1];
  expect(JSON.parse(recheckInit?.body as string).discountCode).toBe("#norefundallowed");

  // ...the reservation Smoobu records the discounted price and says why.
  const [, reservationInit] = fetchFn.mock.calls[2];
  const reservationPayload = JSON.parse(reservationInit?.body as string);
  expect(reservationPayload.price).toBe(459);
  expect(reservationPayload.notice).toContain("Non-refundable rate (#norefundallowed)");

  // ...and the charged total on the booking is the discounted one.
  expect(JSON.parse(response.body).booking.price.totalAmountCents).toBe(45900);
});

test("POST /api/holds rejects a pet on a home that does not accept pets", async () => {
  const fetchFn = jest.fn(async (url: string | URL) => {
    const pathname = new URL(url.toString()).pathname;
    if (pathname === "/booking/checkApartmentAvailability") {
      return jsonResponse({
        // Jungle Loft — available, but not pet friendly.
        availableApartments: [100004],
        prices: { "100004": { price: 510, currency: "USD" } },
        errorMessages: {},
      });
    }
    return jsonResponse({ id: 987654 });
  });
  global.fetch = fetchFn as typeof fetch;
  const handler = createBookingApiHandler(config);

  const searchBody = JSON.parse((await handler(makeSearchEvent())).body);
  const response = await handler(
    makeHoldEvent({
      quoteId: searchBody.quoteId,
      bookingSessionId: searchBody.bookingSessionId,
      propertyId: searchBody.properties[0].propertyId,
      paymentMethod: "paypal",
      guest: { firstName: "Ana", lastName: "Mora", email: "ana@example.com" },
      portalPassword: "correct horse battery staple",
      termsAccepted: true,
      withPet: true,
    })
  );

  expect(response.statusCode).toBe(409);
  expect(JSON.parse(response.body).error.code).toBe("property_not_pet_friendly");

  // Rejected before anything was reserved: only the search hit Smoobu.
  expect(fetchFn).toHaveBeenCalledTimes(1);
  const storedSession = await bookingSessions.getById(searchBody.bookingSessionId);
  expect(storedSession?.status).toBe("quoted");
});

test("POST /api/holds keeps hasPet false when the guest declares no pet", async () => {
  global.fetch = jest.fn(async (url: string | URL) => {
    const pathname = new URL(url.toString()).pathname;
    if (pathname === "/booking/checkApartmentAvailability") {
      return jsonResponse({
        availableApartments: [100001],
        prices: { "100001": { price: 510, currency: "USD" } },
        errorMessages: {},
      });
    }
    return jsonResponse({ id: 987654 });
  }) as typeof fetch;
  const handler = createBookingApiHandler(config);

  const searchBody = JSON.parse((await handler(makeSearchEvent())).body);
  const response = await handler(
    makeHoldEvent({
      quoteId: searchBody.quoteId,
      bookingSessionId: searchBody.bookingSessionId,
      propertyId: searchBody.properties[0].propertyId,
      paymentMethod: "paypal",
      guest: { firstName: "Ana", lastName: "Mora", email: "ana@example.com" },
      portalPassword: "correct horse battery staple",
      termsAccepted: true,
    })
  );

  expect(response.statusCode).toBe(200);
  const storedSession = await bookingSessions.getById(searchBody.bookingSessionId);
  expect(storedSession?.hasPet).toBe(false);
});
