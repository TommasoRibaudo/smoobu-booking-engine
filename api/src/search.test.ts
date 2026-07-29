import { createBookingApiHandler } from "./app";
import { InMemoryBookingSessionRepository } from "./bookingSessions";
import { clearStayRatesCache } from "./search";
import { BOOKING_PROPERTIES } from "./propertyCatalog";
import { StaticSecretProvider } from "./secrets";
import { BookingApiConfig, LambdaHttpRequest } from "./types";

const config: BookingApiConfig = {
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
  bookingSessions: new InMemoryBookingSessionRepository(),
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

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
  jest.restoreAllMocks();
});

function makeSearchEvent(body: unknown): LambdaHttpRequest {
  return {
    version: "2.0",
    rawPath: "/api/search",
    headers: {
      "content-type": "application/json",
      origin: "https://booking.test",
      "user-agent": "Jest Browser",
      "x-booking-device-id": "device-search-123",
    },
    body: JSON.stringify(body),
    requestContext: {
      http: {
        method: "POST",
        path: "/api/search",
        sourceIp: "203.0.113.20",
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

test("POST /api/search calls Smoobu availability and returns safe property summaries", async () => {
  const fetchFn = jest.fn(async (_url: string | URL, _init?: RequestInit) =>
    jsonResponse({
      availableApartments: [100001, 100003],
      prices: {
        "100001": { price: 510, currency: "USD" },
        "100003": { price: 820, currency: "USD" },
      },
      errorMessages: {},
    })
  );
  global.fetch = fetchFn as typeof fetch;
  const handler = createBookingApiHandler(config);

  const response = await handler(
    makeSearchEvent({
      arrivalDate: "2099-06-10",
      departureDate: "2099-06-14",
      guests: 2,
      language: "es",
      discountCode: " 5OFF ",
      source: "booking_page",
    })
  );

  expect(response.statusCode).toBe(200);
  const body = JSON.parse(response.body);
  expect(body.bookingSessionId).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
  );
  expect(body.quoteId).toMatch(/^qt_/);
  expect(body.resultsCount).toBe(2);
  expect(body.properties[0]).toMatchObject({
    slug: "SunsetVilla",
    listingUrl: "/SunsetVillaES",
    name: "Sunset Villa",
    guestCapacity: 6,
    amenities: [
      { code: "bath", label: "Ba\u00f1o privado equipado" },
      { code: "kitchen", label: "Cocina privada equipada" },
      { code: "ac", label: "A/C" },
      { code: "parking", label: "Parqueo privado cercado" },
      { code: "wifi", label: "WiFi 100Mbps" },
      { code: "pet", label: "Acepta mascotas" },
    ],
    price: {
      currency: "USD",
      totalAmountCents: 51000,
      nightlyAverageCents: 12750,
      nights: 4,
      includesTaxes: false,
      rateSource: "smoobu",
    },
    actions: {
      viewListingUrl: "/SunsetVillaES",
      canCreatePayPalHold: true,
      canUseManualDepositHandoff: true,
    },
  });
  expect(JSON.stringify(body.properties)).not.toContain("smoobuApartmentId");

  const [, init] = fetchFn.mock.calls[0];
  expect(new URL(fetchFn.mock.calls[0][0].toString()).pathname).toBe("/booking/checkApartmentAvailability");
  expect((init?.headers as Record<string, string>)["X-API-Key"]).toBe("smoobu-secret-value");
  expect(JSON.parse(init?.body as string)).toEqual({
    arrivalDate: "2099-06-10",
    departureDate: "2099-06-14",
    apartments: BOOKING_PROPERTIES.map((p) => p.smoobuApartmentId),
    customerId: 9,
    guests: 2,
    discountCode: "5OFF",
  });
});

test("POST /api/search persists quoted booking session language for server-side communications", async () => {
  const bookingSessions = new InMemoryBookingSessionRepository();
  global.fetch = jest.fn(async () =>
    jsonResponse({
      availableApartments: [100001],
      prices: {
        "100001": { price: 510, currency: "USD" },
      },
      errorMessages: {},
    })
  ) as typeof fetch;
  const handler = createBookingApiHandler({ ...config, bookingSessions });

  const response = await handler(
    makeSearchEvent({
      arrivalDate: "2099-06-10",
      departureDate: "2099-06-14",
      guests: 3,
      language: "es",
      source: "booking_page",
    })
  );

  expect(response.statusCode).toBe(200);
  const body = JSON.parse(response.body);
  const session = await bookingSessions.getById(body.bookingSessionId);
  expect(session).toMatchObject({
    id: body.bookingSessionId,
    quoteId: body.quoteId,
    status: "quoted",
    language: "es",
    arrivalDate: "2099-06-10",
    departureDate: "2099-06-14",
    guests: 3,
    source: "booking_page",
  });
  expect(body.language).toBe("es");
});

test("POST /api/search returns structured 200 response when no houses are available", async () => {
  const bookingSessions = new InMemoryBookingSessionRepository();
  global.fetch = jest.fn(async () =>
    jsonResponse({
      availableApartments: [],
      prices: {},
      errorMessages: {},
    })
  ) as typeof fetch;
  const handler = createBookingApiHandler({ ...config, bookingSessions });

  const response = await handler(
    makeSearchEvent({
      arrivalDate: "2099-07-01",
      departureDate: "2099-07-03",
      guests: 2,
      language: "en",
    })
  );

  expect(response.statusCode).toBe(200);
  const body = JSON.parse(response.body);
  expect(body.resultsCount).toBe(0);
  expect(body.properties).toEqual([]);
  const session = await bookingSessions.getById(body.bookingSessionId);
  expect(session).toMatchObject({
    id: body.bookingSessionId,
    quoteId: body.quoteId,
    status: "no_availability",
    language: "en",
    arrivalDate: "2099-07-01",
    departureDate: "2099-07-03",
    guests: 2,
    quotedProperties: [],
  });
  expect(body.availabilityWarnings).toEqual([
    {
      code: "no_properties_available",
      messageKey: "booking.noAvailability",
    },
  ]);
});

test("POST /api/search maps Smoobu restriction details to safe warning codes", async () => {
  global.fetch = jest.fn(async () =>
    jsonResponse({
      availableApartments: [100002],
      prices: {
        "100002": { price: 300, currency: "USD" },
      },
      errorMessages: {
        "100002": {
          errorCode: 401,
          message: "The duration of the booking is too short.",
          minimumLengthOfStay: 5,
        },
      },
    })
  ) as typeof fetch;
  const handler = createBookingApiHandler(config);

  const response = await handler(
    makeSearchEvent({
      arrivalDate: "2099-08-01",
      departureDate: "2099-08-02",
      guests: 2,
      language: "en",
    })
  );

  expect(response.statusCode).toBe(200);
  const body = JSON.parse(response.body);
  expect(body.resultsCount).toBe(0);
  expect(body.availabilityWarnings).toEqual([
    {
      code: "minimum_stay_not_met",
      messageKey: "booking.availability.minimum_stay_not_met",
      propertyId: "11111111-0000-4000-8000-000000000002",
    },
  ]);
  expect(JSON.stringify(body)).not.toContain("The duration of the booking is too short.");
});

test("POST /api/search fails closed when Smoobu customer ID is missing", async () => {
  const handler = createBookingApiHandler({
    ...config,
    smoobu: {
      ...config.smoobu,
      customerId: undefined,
    },
  });

  const response = await handler(
    makeSearchEvent({
      arrivalDate: "2099-08-01",
      departureDate: "2099-08-02",
      guests: 2,
      language: "en",
    })
  );

  expect(response.statusCode).toBe(503);
  expect(JSON.parse(response.body).error).toMatchObject({
    code: "provider_config_missing",
    retryable: false,
  });
});

test("POST /api/search surfaces upstream Smoobu failures as provider errors", async () => {
  global.fetch = jest.fn(async () => jsonResponse({ detail: "temporary" }, { status: 503 })) as typeof fetch;
  const handler = createBookingApiHandler(config);

  const response = await handler(
    makeSearchEvent({
      arrivalDate: "2099-08-01",
      departureDate: "2099-08-02",
      guests: 2,
      language: "en",
    })
  );

  expect(response.statusCode).toBe(503);
  expect(JSON.parse(response.body).error).toMatchObject({
    code: "provider_unavailable",
    retryable: true,
  });
});

test("POST /api/search uses English listing URLs and drops unknown or unpriced Smoobu apartments", async () => {
  global.fetch = jest.fn(async () =>
    jsonResponse({
      availableApartments: [100001, 999, 100003],
      prices: {
        "100001": { price: 510, currency: "USD" },
        "999": { price: 250, currency: "USD" },
      },
      errorMessages: {},
    })
  ) as typeof fetch;  const handler = createBookingApiHandler(config);

  const response = await handler(
    makeSearchEvent({
      arrivalDate: "2099-09-10",
      departureDate: "2099-09-14",
      guests: 2,
      language: "en",
    })
  );

  expect(response.statusCode).toBe(200);
  const body = JSON.parse(response.body);
  expect(body.resultsCount).toBe(1);
  expect(body.properties).toHaveLength(1);
  expect(body.properties[0]).toMatchObject({
    slug: "SunsetVilla",
    listingUrl: "/SunsetVilla",
    actions: {
      viewListingUrl: "/SunsetVilla",
      canCreatePayPalHold: true,
    },
  });
  expect(JSON.stringify(body.properties)).not.toContain("999");
  expect(JSON.stringify(body.properties)).not.toContain("OceanBreeze");
});

// ── Long-stay discounts ──────────────────────────────────────────────────────
//
// Smoobu applies them silently: the availability total simply arrives lower than
// the rack rate, with no breakdown. The baseline is rebuilt from /api/rates,
// which prices nights individually and so knows nothing about stay length.

beforeEach(async () => {
  await clearStayRatesCache();
});

/** Builds a Smoobu rates payload with one flat nightly price per apartment. */
function ratesFor(apartmentId: number, dates: string[], nightlyPrice: number) {
  return {
    data: {
      [String(apartmentId)]: Object.fromEntries(
        dates.map((date) => [date, { price: nightlyPrice, min_length_of_stay: 1, available: 1 }])
      ),
    },
  };
}

const SEVEN_NIGHTS = [
  "2099-06-10",
  "2099-06-11",
  "2099-06-12",
  "2099-06-13",
  "2099-06-14",
  "2099-06-15",
  "2099-06-16",
];

function mockAvailabilityAndRates(availabilityBody: unknown, ratesBody: unknown) {
  const fetchFn = jest.fn(async (url: string | URL) => {
    const pathname = new URL(url.toString()).pathname;
    if (pathname === "/api/rates") {
      return jsonResponse(ratesBody);
    }
    return jsonResponse(availabilityBody);
  });
  global.fetch = fetchFn as typeof fetch;
  return fetchFn;
}

test("POST /api/search reports the long-stay discount Smoobu applied silently", async () => {
  // Rack rate 7 x $150 = $1050; Smoobu quotes $892.50 for the same nights.
  const fetchFn = mockAvailabilityAndRates(
    {
      availableApartments: [100001],
      prices: { "100001": { price: 892.5, currency: "USD" } },
      errorMessages: {},
    },
    ratesFor(100001, SEVEN_NIGHTS, 150)
  );
  const handler = createBookingApiHandler(config);

  const response = await handler(
    makeSearchEvent({
      arrivalDate: "2099-06-10",
      departureDate: "2099-06-17",
      guests: 2,
      language: "en",
    })
  );

  expect(response.statusCode).toBe(200);
  const price = JSON.parse(response.body).properties[0].price;
  expect(price).toMatchObject({
    totalAmountCents: 89250,
    nights: 7,
    discount: {
      source: "long_stay",
      baseTotalCents: 105000,
      baseNightlyAverageCents: 15000,
      amountCents: 15750,
      percentage: 15,
    },
  });

  // Rates are asked for the nights slept in — the departure date is not one.
  const ratesCall = fetchFn.mock.calls.find(([url]) => new URL(url.toString()).pathname === "/api/rates");
  const ratesUrl = new URL(ratesCall![0].toString());
  expect(ratesUrl.searchParams.get("start_date")).toBe("2099-06-10");
  expect(ratesUrl.searchParams.get("end_date")).toBe("2099-06-16");
});

test("POST /api/search attributes the gap to the code when the search carried one", async () => {
  mockAvailabilityAndRates(
    {
      availableApartments: [100001],
      prices: { "100001": { price: 892.5, currency: "USD" } },
      errorMessages: {},
    },
    ratesFor(100001, SEVEN_NIGHTS, 150)
  );
  const handler = createBookingApiHandler(config);

  const response = await handler(
    makeSearchEvent({
      arrivalDate: "2099-06-10",
      departureDate: "2099-06-17",
      guests: 2,
      language: "en",
      discountCode: "5OFF",
    })
  );

  expect(JSON.parse(response.body).properties[0].price.discount.source).toBe("discount_code");
});

test("POST /api/search spends no rates call on a stay too short to qualify", async () => {
  const fetchFn = mockAvailabilityAndRates(
    {
      availableApartments: [100001],
      prices: { "100001": { price: 510, currency: "USD" } },
      errorMessages: {},
    },
    ratesFor(100001, ["2099-06-10"], 150)
  );
  const handler = createBookingApiHandler(config);

  const response = await handler(
    makeSearchEvent({
      arrivalDate: "2099-06-10",
      departureDate: "2099-06-14",
      guests: 2,
      language: "en",
    })
  );

  expect(JSON.parse(response.body).properties[0].price).not.toHaveProperty("discount");
  expect(fetchFn.mock.calls.some(([url]) => new URL(url.toString()).pathname === "/api/rates")).toBe(false);
});

test("POST /api/search shows no discount when the quote is above the rack rate", async () => {
  // Extra-guest pricing puts the quote above the sum of nightly rates. That is a
  // surcharge, not a negative saving, and must not be advertised either way.
  mockAvailabilityAndRates(
    {
      availableApartments: [100001],
      prices: { "100001": { price: 1200, currency: "USD" } },
      errorMessages: {},
    },
    ratesFor(100001, SEVEN_NIGHTS, 150)
  );
  const handler = createBookingApiHandler(config);

  const response = await handler(
    makeSearchEvent({
      arrivalDate: "2099-06-10",
      departureDate: "2099-06-17",
      guests: 2,
      language: "en",
    })
  );

  expect(JSON.parse(response.body).properties[0].price).not.toHaveProperty("discount");
});

test("POST /api/search still returns prices when the rack-rate lookup fails", async () => {
  global.fetch = jest.fn(async (url: string | URL) => {
    const pathname = new URL(url.toString()).pathname;
    if (pathname === "/api/rates") {
      return jsonResponse({ detail: "rate limited" }, { status: 429 });
    }
    return jsonResponse({
      availableApartments: [100001],
      prices: { "100001": { price: 892.5, currency: "USD" } },
      errorMessages: {},
    });
  }) as typeof fetch;
  const handler = createBookingApiHandler(config);

  const response = await handler(
    makeSearchEvent({
      arrivalDate: "2099-06-10",
      departureDate: "2099-06-17",
      guests: 2,
      language: "en",
    })
  );

  expect(response.statusCode).toBe(200);
  const price = JSON.parse(response.body).properties[0].price;
  expect(price.totalAmountCents).toBe(89250);
  expect(price).not.toHaveProperty("discount");
});

test("POST /api/search ignores a partial rate table rather than inventing a discount", async () => {
  // One night missing from the rate table would understate the rack rate.
  mockAvailabilityAndRates(
    {
      availableApartments: [100001],
      prices: { "100001": { price: 892.5, currency: "USD" } },
      errorMessages: {},
    },
    ratesFor(100001, SEVEN_NIGHTS.slice(0, 6), 150)
  );
  const handler = createBookingApiHandler(config);

  const response = await handler(
    makeSearchEvent({
      arrivalDate: "2099-06-10",
      departureDate: "2099-06-17",
      guests: 2,
      language: "en",
    })
  );

  expect(JSON.parse(response.body).properties[0].price).not.toHaveProperty("discount");
});
