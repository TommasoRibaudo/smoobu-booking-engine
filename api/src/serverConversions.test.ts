import { createHash } from "crypto";
import { BookingSessionRecord } from "./bookingSessions";
import {
  createServerConversionReporter,
  reportServerConversion,
  ServerConversionConfig,
} from "./serverConversions";
import { ObservabilityLogger } from "./types";

const CONFIG: ServerConversionConfig = {
  ga4MeasurementId: "G-TEST123",
  ga4ApiSecret: "ga4-secret",
  metaPixelId: "999999999999999",
  metaCapiAccessToken: "meta-token",
};

function createLogger(): ObservabilityLogger & { warnings: string[]; errors: string[] } {
  const warnings: string[] = [];
  const errors: string[] = [];
  return {
    warnings,
    errors,
    debug: () => undefined,
    info: () => undefined,
    warn: (message: string) => {
      warnings.push(message);
    },
    error: (message: string) => {
      errors.push(message);
    },
  };
}

function createSession(overrides: Partial<BookingSessionRecord> = {}): BookingSessionRecord {
  return {
    id: "11111111-2222-3333-4444-555555555555",
    reservationPublicId: "KWL-ABCD2345",
    quoteId: "qt_TEST",
    status: "booking_confirmed",
    language: "en",
    arrivalDate: "2099-06-10",
    departureDate: "2099-06-14",
    guests: 2,
    quoteExpiresAt: "2099-06-01T00:00:00.000Z",
    quotedProperties: [],
    propertyId: "prop-1",
    paymentMethod: "manual_deposit",
    currency: "USD",
    totalAmountCents: 51_000,
    guest: {
      firstName: "Ada",
      lastName: "Lovelace",
      email: "  ADA@Example.com ",
      phone: "+506 0000-0000",
      country: "CR",
    },
    marketingConsent: true,
    tracking: {
      gaClientId: "123.456",
      gaSessionId: "s-789",
      fbp: "fb.1.1.1",
      fbc: "fb.1.1.click",
    },
    createdAt: "2099-06-01T00:00:00.000Z",
    updatedAt: "2099-06-01T00:00:00.000Z",
    ...overrides,
  };
}

function okResponse(): Response {
  return { ok: true, status: 200 } as Response;
}

describe("createServerConversionReporter", () => {
  it("posts a GA4 purchase with client_id, session_id and transaction_id", async () => {
    const calls: Array<{ url: string; body: any }> = [];
    const fetchFn = jest.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(init.body as string) });
      return okResponse();
    });

    await createServerConversionReporter(CONFIG, createLogger(), fetchFn).reportPurchase(createSession());

    const ga4 = calls.find((call) => call.url.includes("google-analytics.com"));
    expect(ga4).toBeDefined();
    expect(ga4!.url).toContain("measurement_id=G-TEST123");
    expect(ga4!.url).toContain("api_secret=ga4-secret");
    expect(ga4!.body.client_id).toBe("123.456");
    expect(ga4!.body.events[0].name).toBe("purchase");
    expect(ga4!.body.events[0].params.session_id).toBe("s-789");
    // GA4 dedupes purchase on transaction_id, which is what makes it safe to
    // report from the capture path, the webhook and the reconciliation sweep.
    expect(ga4!.body.events[0].params.transaction_id).toBe("KWL-ABCD2345");
    expect(ga4!.body.events[0].params.value).toBe(510);
    expect(ga4!.body.events[0].params.currency).toBe("USD");
  });

  it("posts a Meta Purchase whose event_id matches the browser's dedup key", async () => {
    const calls: Array<{ url: string; body: any }> = [];
    const fetchFn = jest.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(init.body as string) });
      return okResponse();
    });

    await createServerConversionReporter(CONFIG, createLogger(), fetchFn).reportPurchase(createSession());

    const meta = calls.find((call) => call.url.includes("graph.facebook.com"));
    expect(meta).toBeDefined();
    const event = meta!.body.data[0];
    expect(event.event_name).toBe("Purchase");
    // BookingAnalytics.service.ts sends eventID: reservationPublicId. If these
    // ever diverge, Meta counts every booking twice.
    expect(event.event_id).toBe("KWL-ABCD2345");
    expect(event.custom_data.value).toBe(510);
    expect(event.custom_data.order_id).toBe("KWL-ABCD2345");
  });

  it("uses the browser's dedup keys for the upper funnel too", async () => {
    const seen: Record<string, string> = {};
    const fetchFn = jest.fn(async (url: string, init: RequestInit) => {
      if (url.includes("graph.facebook.com")) {
        const event = JSON.parse(init.body as string).data[0];
        seen[event.event_name] = event.event_id;
      }
      return okResponse();
    });

    const reporter = createServerConversionReporter(CONFIG, createLogger(), fetchFn);
    const session = createSession({ paymentMethod: "paypal" });
    await reporter.reportBeginCheckout(session);
    await reporter.reportAddPaymentInfo(session);

    expect(seen.InitiateCheckout).toBe("qt_TEST");
    expect(seen.AddPaymentInfo).toBe("qt_TEST-paypal");
  });

  it("hashes email and phone and never sends them in clear", async () => {
    let metaBody: any;
    const fetchFn = jest.fn(async (url: string, init: RequestInit) => {
      if (url.includes("graph.facebook.com")) {
        metaBody = JSON.parse(init.body as string);
      }
      return okResponse();
    });

    await createServerConversionReporter(CONFIG, createLogger(), fetchFn).reportPurchase(createSession());

    const userData = metaBody.data[0].user_data;
    // Normalised (trimmed + lowercased) before hashing, or the hash misses.
    expect(userData.em).toEqual([
      createHash("sha256").update("ada@example.com", "utf8").digest("hex"),
    ]);
    // Digits only — punctuation must be stripped from the phone first.
    expect(userData.ph).toEqual([createHash("sha256").update("50600000000", "utf8").digest("hex")]);

    const serialised = JSON.stringify(metaBody);
    expect(serialised).not.toContain("ADA@Example.com");
    expect(serialised).not.toContain("ada@example.com");
    expect(serialised).not.toContain("8463");
  });

  it("sends nothing when the guest did not grant marketing consent", async () => {
    const fetchFn = jest.fn(async () => okResponse());

    await createServerConversionReporter(CONFIG, createLogger(), fetchFn).reportPurchase(
      createSession({ marketingConsent: false })
    );

    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("fails closed when consent is absent rather than explicitly false", async () => {
    const fetchFn = jest.fn(async () => okResponse());
    const session = createSession();
    delete session.marketingConsent;

    await createServerConversionReporter(CONFIG, createLogger(), fetchFn).reportPurchase(session);

    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("sends nothing when no attribution identifiers were captured", async () => {
    const fetchFn = jest.fn(async () => okResponse());

    await createServerConversionReporter(CONFIG, createLogger(), fetchFn).reportPurchase(
      createSession({ tracking: undefined })
    );

    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("no-ops when neither provider is configured", async () => {
    const fetchFn = jest.fn(async () => okResponse());

    await createServerConversionReporter({}, createLogger(), fetchFn).reportPurchase(createSession());

    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("reports to Meta alone when GA4 is unconfigured", async () => {
    const urls: string[] = [];
    const fetchFn = jest.fn(async (url: string) => {
      urls.push(url);
      return okResponse();
    });

    await createServerConversionReporter(
      { metaPixelId: "123", metaCapiAccessToken: "token" },
      createLogger(),
      fetchFn
    ).reportPurchase(createSession());

    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain("graph.facebook.com");
  });

  it("never throws when the provider call fails", async () => {
    const logger = createLogger();
    const fetchFn = jest.fn(async () => {
      throw new Error("network down");
    });

    await expect(
      createServerConversionReporter(CONFIG, logger, fetchFn).reportPurchase(createSession())
    ).resolves.toBeUndefined();

    expect(logger.warnings).toContain("server_conversion_failed");
  });

  it("logs but does not throw when a provider returns a non-2xx", async () => {
    const logger = createLogger();
    const fetchFn = jest.fn(async () => ({ ok: false, status: 400 }) as Response);

    await expect(
      createServerConversionReporter(CONFIG, logger, fetchFn).reportPurchase(createSession())
    ).resolves.toBeUndefined();

    expect(logger.warnings).toContain("server_conversion_rejected");
  });

  it("routes GA4 to the validation endpoint in debug mode", async () => {
    const urls: string[] = [];
    const fetchFn = jest.fn(async (url: string) => {
      urls.push(url);
      return okResponse();
    });

    await createServerConversionReporter({ ...CONFIG, debug: true }, createLogger(), fetchFn).reportPurchase(
      createSession()
    );

    expect(urls.some((url) => url.includes("/debug/mp/collect"))).toBe(true);
  });
});

describe("reportServerConversion", () => {
  it("is a no-op when conversion reporting is not configured at all", async () => {
    await expect(
      reportServerConversion("purchase", createSession(), undefined, createLogger())
    ).resolves.toBeUndefined();
  });
});
