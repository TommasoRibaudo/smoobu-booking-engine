import { createBookingApiHandler } from "./app";
import { InMemoryBookingSessionRepository } from "./bookingSessions";
import { BOOKING_PROPERTIES } from "./propertyCatalog";
import { MissingSecretProvider } from "./secrets";
import { BookingApiConfig, LambdaHttpRequest } from "./types";

function createConfig(bookingSessions = new InMemoryBookingSessionRepository()): BookingApiConfig {
  return {
    allowedOrigins: ["https://booking.test"],
    maxBodyBytes: 64 * 1024,
    secrets: new MissingSecretProvider(),
    smoobu: {
      baseUrl: "https://login.smoobu.com",
      timeoutMs: 8_000,
      maxRetries: 3,
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
    hold: {
      defaultTtlMinutes: 60,
      idempotencyTtlMinutes: 1440,
      staleIdempotencyLockSeconds: 120,
    },
    abuseProtection: {
      enabled: true,
      captchaChallengesEnabled: true,
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

function makeGetEvent(queryStringParameters: Record<string, string>): LambdaHttpRequest {
  return {
    version: "2.0",
    rawPath: "/api/deposit-handoff",
    queryStringParameters,
    headers: {
      "user-agent": "Jest Browser",
      "x-booking-device-id": "device-deposit-123",
    },
    requestContext: {
      http: {
        method: "GET",
        path: "/api/deposit-handoff",
        sourceIp: "203.0.113.20",
        userAgent: "Jest Browser",
      },
    },
  };
}

function makePostEvent(body: unknown, headers: Record<string, string> = {}): LambdaHttpRequest {
  return {
    version: "2.0",
    rawPath: "/api/deposit-handoff/events",
    headers: {
      "content-type": "application/json",
      "idempotency-key": "deposit-event-key-123",
      "user-agent": "Jest Browser",
      "x-booking-device-id": "device-deposit-123",
      ...headers,
    },
    body: JSON.stringify(body),
    requestContext: {
      http: {
        method: "POST",
        path: "/api/deposit-handoff/events",
        sourceIp: "203.0.113.20",
        userAgent: "Jest Browser",
      },
    },
  };
}

test("GET /api/deposit-handoff returns read-only manual deposit instructions", async () => {
  const handler = createBookingApiHandler(createConfig());

  const response = await handler(makeGetEvent({ language: "en" }));
  const body = JSON.parse(response.body);

  expect(response.statusCode).toBe(200);
  expect(body).toMatchObject({
    language: "en",
    status: "manual_deposit_handoff",
    isBookingConfirmed: false,
    doesCreateHold: false,
    messageKey: "deposit.handoffIntro",
  });
  expect(body.instructions.bodyKeys).toEqual([
    "deposit.bankTransferInstructions",
    "deposit.uploadReceiptNote",
    "deposit.staffWillConfirm",
    "deposit.contactUs",
  ]);
  expect(body.instructions.contactMethods).toEqual([
    {
      type: "whatsapp",
      label: "https://wa.me/contact",
      url: "https://wa.me/contact",
    },
    {
      type: "email",
      label: "reservations@example.com",
      url: "mailto:reservations@example.com",
    },
  ]);
  // No DEPOSIT_BANK_* env vars configured: falls back to the visible placeholder.
  expect(body.bankInfo).toEqual({
    bankAccount: {
      accountHolder: "Set DEPOSIT_BANK_ACCOUNT_HOLDER",
      primaryAccountLabel: "Bank account",
      primaryAccount: "Set DEPOSIT_BANK_PRIMARY_ACCOUNT",
    },
  });
});

test("GET /api/deposit-handoff echoes Spanish language without booking context", async () => {
  const handler = createBookingApiHandler(createConfig());

  const response = await handler(makeGetEvent({ language: "es" }));
  const body = JSON.parse(response.body);

  expect(response.statusCode).toBe(200);
  expect(body).toMatchObject({
    language: "es",
    status: "manual_deposit_handoff",
    isBookingConfirmed: false,
    doesCreateHold: false,
  });
  expect(body.bookingContext).toBeUndefined();
});

test("GET /api/deposit-handoff includes localized booking context when quote and property match", async () => {
  const bookingSessions = new InMemoryBookingSessionRepository();
  const property = BOOKING_PROPERTIES[0];
  const session = await bookingSessions.createQuotedSession({
    arrivalDate: "2099-06-10",
    departureDate: "2099-06-14",
    guests: 2,
    language: "es",
    quotedProperties: [
      {
        propertyId: property.propertyId,
        currency: "USD",
        totalAmountCents: 51000,
        nightlyAverageCents: 12750,
        nights: 4,
        includesTaxes: false,
        rateSource: "smoobu",
      },
    ],
  });
  const config = createConfig(bookingSessions);
  config.deposit = {
    holdTtlHours: 36,
    confirmTokenTtlHours: 168,
    staffConfirmBaseUrl: "",
    bank: {
      accountHolder: "Default Holding Co",
      primaryAccountLabel: "USD account",
      primaryAccount: "ACC-DEFAULT-0001",
    },
    bankByPropertySlug: {
      [property.slug]: {
        accountHolder: "Sunset Villa Ops LLC",
        primaryAccountLabel: "USD account",
        primaryAccount: "ACC-SUNSET-0001",
        sinpePhone: "8000 0001",
        sinpeName: "Sunset Villa Ops",
      },
    },
  };
  const handler = createBookingApiHandler(config);

  const response = await handler(
    makeGetEvent({
      language: "es",
      quoteId: session.quoteId,
      propertyId: property.propertyId,
    })
  );
  const body = JSON.parse(response.body);

  expect(response.statusCode).toBe(200);
  expect(body.bookingContext).toMatchObject({
    quoteId: session.quoteId,
    arrivalDate: "2099-06-10",
    departureDate: "2099-06-14",
    guests: 2,
    property: {
      propertyId: property.propertyId,
      slug: property.slug,
      listingUrl: `/${property.slug}ES`,
      name: property.name,
    },
  });
  // This property has a per-slug override in config.deposit.bankByPropertySlug.
  expect(body.bankInfo).toEqual({
    sinpePhone: "8000 0001",
    sinpeName: "Sunset Villa Ops",
    bankAccount: {
      accountHolder: "Sunset Villa Ops LLC",
      primaryAccountLabel: "USD account",
      primaryAccount: "ACC-SUNSET-0001",
    },
  });
});

test("GET /api/deposit-handoff includes quote dates when quoteId is provided without propertyId", async () => {
  const bookingSessions = new InMemoryBookingSessionRepository();
  const session = await bookingSessions.createQuotedSession({
    arrivalDate: "2099-06-10",
    departureDate: "2099-06-14",
    guests: 2,
    language: "en",
  });
  const handler = createBookingApiHandler(createConfig(bookingSessions));

  const response = await handler(
    makeGetEvent({
      language: "en",
      quoteId: session.quoteId,
    })
  );
  const body = JSON.parse(response.body);

  expect(response.statusCode).toBe(200);
  expect(body.bookingContext).toEqual({
    quoteId: session.quoteId,
    arrivalDate: "2099-06-10",
    departureDate: "2099-06-14",
    guests: 2,
  });
});

test("GET /api/deposit-handoff returns partial context when quoteId is unknown", async () => {
  const handler = createBookingApiHandler(createConfig());

  const response = await handler(
    makeGetEvent({
      language: "en",
      quoteId: "qt_UNKNOWN",
    })
  );
  const body = JSON.parse(response.body);

  expect(response.statusCode).toBe(200);
  expect(body.bookingContext).toEqual({
    quoteId: "qt_UNKNOWN",
  });
});

test("GET /api/deposit-handoff rejects a property that does not belong to the quote", async () => {
  const bookingSessions = new InMemoryBookingSessionRepository();
  const session = await bookingSessions.createQuotedSession({
    arrivalDate: "2099-06-10",
    departureDate: "2099-06-14",
    guests: 2,
    language: "en",
    quotedProperties: [
      {
        propertyId: BOOKING_PROPERTIES[0].propertyId,
        currency: "USD",
        totalAmountCents: 51000,
        nightlyAverageCents: 12750,
        nights: 4,
        includesTaxes: false,
        rateSource: "smoobu",
      },
    ],
  });
  const handler = createBookingApiHandler(createConfig(bookingSessions));

  const response = await handler(
    makeGetEvent({
      language: "en",
      quoteId: session.quoteId,
      propertyId: BOOKING_PROPERTIES[1].propertyId,
    })
  );
  const body = JSON.parse(response.body);

  expect(response.statusCode).toBe(404);
  expect(body.error.code).toBe("deposit_context_not_found");
});

test("POST /api/deposit-handoff/events records a read-only handoff click", async () => {
  const bookingSessions = new InMemoryBookingSessionRepository();
  const property = BOOKING_PROPERTIES[0];
  const session = await bookingSessions.createQuotedSession({
    arrivalDate: "2099-06-10",
    departureDate: "2099-06-14",
    guests: 2,
    language: "en",
    quotedProperties: [
      {
        propertyId: property.propertyId,
        currency: "USD",
        totalAmountCents: 51000,
        nightlyAverageCents: 12750,
        nights: 4,
        includesTaxes: false,
        rateSource: "smoobu",
      },
    ],
  });
  const handler = createBookingApiHandler(createConfig(bookingSessions));

  const response = await handler(
    makePostEvent({
      quoteId: session.quoteId,
      propertyId: property.propertyId,
      language: "en",
      contactMethod: "whatsapp",
      analyticsConsent: true,
    })
  );
  const body = JSON.parse(response.body);

  expect(response.statusCode).toBe(200);
  expect(body).toEqual({
    recorded: true,
    status: "manual_deposit_handoff",
    isBookingConfirmed: false,
    doesCreateHold: false,
    messageKey: "deposit.contactEventRecorded",
  });
});

test("POST /api/deposit-handoff/events requires an idempotency key", async () => {
  const property = BOOKING_PROPERTIES[0];
  const handler = createBookingApiHandler(createConfig());

  const response = await handler(
    makePostEvent(
      {
        quoteId: "qt_TEST",
        propertyId: property.propertyId,
        language: "en",
        contactMethod: "whatsapp",
        analyticsConsent: false,
      },
      { "idempotency-key": "" }
    )
  );
  const body = JSON.parse(response.body);

  expect(response.statusCode).toBe(400);
  expect(body.error.code).toBe("missing_idempotency_key");
});

test("POST /api/deposit-handoff/events rejects unsupported contact methods", async () => {
  const property = BOOKING_PROPERTIES[0];
  const handler = createBookingApiHandler(createConfig());

  const response = await handler(
    makePostEvent({
      quoteId: "qt_TEST",
      propertyId: property.propertyId,
      language: "en",
      contactMethod: "sms",
      analyticsConsent: false,
    })
  );
  const body = JSON.parse(response.body);

  expect(response.statusCode).toBe(400);
  expect(body.error.code).toBe("unsupported_contact_method");
});

test("POST /api/deposit-handoff/events rejects a property that does not belong to the quote", async () => {
  const bookingSessions = new InMemoryBookingSessionRepository();
  const session = await bookingSessions.createQuotedSession({
    arrivalDate: "2099-06-10",
    departureDate: "2099-06-14",
    guests: 2,
    language: "en",
    quotedProperties: [
      {
        propertyId: BOOKING_PROPERTIES[0].propertyId,
        currency: "USD",
        totalAmountCents: 51000,
        nightlyAverageCents: 12750,
        nights: 4,
        includesTaxes: false,
        rateSource: "smoobu",
      },
    ],
  });
  const handler = createBookingApiHandler(createConfig(bookingSessions));

  const response = await handler(
    makePostEvent({
      quoteId: session.quoteId,
      propertyId: BOOKING_PROPERTIES[1].propertyId,
      language: "en",
      contactMethod: "email",
      analyticsConsent: false,
    })
  );
  const body = JSON.parse(response.body);

  expect(response.statusCode).toBe(404);
  expect(body.error.code).toBe("deposit_context_not_found");
});
