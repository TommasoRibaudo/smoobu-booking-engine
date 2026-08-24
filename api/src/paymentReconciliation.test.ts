import { InMemoryBookingSessionRepository, BookingSessionRecord } from "./bookingSessions";
import { InMemoryPaymentRepository, PaymentRecord } from "./payments";
import { reconcilePendingPayments, ReconciliationDependencies, ReconciliationResult } from "./paymentReconciliation";
import { PayPalClient, PayPalProviderError, PayPalOrderDetails } from "./paypalClient";
import { ObservabilityLogger } from "./types";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function createSilentLogger(): ObservabilityLogger {
  return {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };
}

function createMockPayPalClient(
  overrides: Partial<PayPalClient> = {}
): PayPalClient {
  return {
    getOrderDetails: jest.fn().mockResolvedValue({
      orderId: "PAYPAL-ORDER-1",
      status: "CREATED",
      captureId: undefined,
      captureStatus: undefined,
    } satisfies PayPalOrderDetails),
    ...overrides,
  } as unknown as PayPalClient;
}

const NOW = "2026-04-15T12:00:00.000Z";
const RECENT = "2026-04-15T11:30:00.000Z"; // 30 min ago — within default 2h threshold
const STALE = "2026-04-15T09:00:00.000Z";  // 3h ago — beyond default 2h threshold

/**
 * Seeds a booking session in paypal_order_created state with a matching
 * payment record in order_created status.
 */
async function seedPendingPayment(
  sessions: InMemoryBookingSessionRepository,
  payments: InMemoryPaymentRepository,
  overrides: { createdAt?: string; paypalOrderId?: string } = {}
): Promise<{ session: BookingSessionRecord; payment: PaymentRecord }> {
  const session = await sessions.createQuotedSession({
    arrivalDate: "2026-05-01",
    departureDate: "2026-05-05",
    guests: 2,
    language: "en",
    quotedProperties: [
      {
        propertyId: "palmcottage",
        currency: "USD",
        totalAmountCents: 40000,
        nightlyAverageCents: 10000,
        nights: 4,
        includesTaxes: false,
        rateSource: "smoobu",
      },
    ],
  });

  // Advance session to hold_active → paypal_order_created
  await sessions.markHoldCreating({
    bookingSessionId: session.id,
    propertyId: "palmcottage",
    paymentMethod: "paypal",
    ratePlan: "flexible",
    price: session.quotedProperties[0],
    guest: { firstName: "Test", lastName: "Guest", email: "test@example.com" },
    portalPasswordHash: "hash",
    expiresAt: "2026-04-15T13:00:00.000Z",
  });
  await sessions.markHoldActive({
    bookingSessionId: session.id,
    expiresAt: "2026-04-15T13:00:00.000Z",
  });

  const paypalOrderId = overrides.paypalOrderId ?? "PAYPAL-ORDER-1";
  await sessions.markPaypalOrderCreated({
    bookingSessionId: session.id,
    paypalOrderId,
  });

  const payment = await payments.createOrderPayment({
    bookingSessionId: session.id,
    paypalOrderId,
    paypalRequestIdOrder: "req-order-1",
    paypalRequestIdCapture: "req-capture-1",
    currency: "USD",
    totalAmountCents: 40000,
  });

  // Backdate createdAt if needed for staleness tests
  if (overrides.createdAt) {
    (payment as any).createdAt = overrides.createdAt;
  }

  const updatedSession = await sessions.getById(session.id);
  return { session: updatedSession!, payment };
}

function createDeps(
  overrides: Partial<ReconciliationDependencies> = {}
): ReconciliationDependencies {
  return {
    payments: new InMemoryPaymentRepository(),
    bookingSessions: new InMemoryBookingSessionRepository(),
    paypalClient: createMockPayPalClient(),
    logger: createSilentLogger(),
    now: () => NOW,
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("reconcilePendingPayments", () => {
  it("returns empty result when no payments are pending", async () => {
    const deps = createDeps();
    const result = await reconcilePendingPayments(deps);

    expect(result.processed).toBe(0);
    expect(result.confirmed).toBe(0);
    expect(result.markedFailed).toBe(0);
    expect(result.stillPending).toBe(0);
    expect(result.errors).toHaveLength(0);
  });

  it("confirms a booking when PayPal reports COMPLETED with a capture", async () => {
    const sessions = new InMemoryBookingSessionRepository();
    const payments = new InMemoryPaymentRepository();
    const { session } = await seedPendingPayment(sessions, payments, { createdAt: RECENT });

    const paypalClient = createMockPayPalClient({
      getOrderDetails: jest.fn().mockResolvedValue({
        orderId: "PAYPAL-ORDER-1",
        status: "COMPLETED",
        captureId: "CAPTURE-123",
        captureStatus: "COMPLETED",
      } satisfies PayPalOrderDetails),
    });

    const deps = createDeps({ payments, bookingSessions: sessions, paypalClient });
    const result = await reconcilePendingPayments(deps);

    expect(result.processed).toBe(1);
    expect(result.confirmed).toBe(1);
    expect(result.markedFailed).toBe(0);
    expect(result.stillPending).toBe(0);

    // Verify payment was marked captured
    const updatedPayment = await payments.getByBookingSessionId(session.id);
    expect(updatedPayment?.status).toBe("captured");
    expect(updatedPayment?.paypalCaptureId).toBe("CAPTURE-123");

    // Verify session was confirmed
    const updatedSession = await sessions.getById(session.id);
    expect(updatedSession?.status).toBe("booking_confirmed");
  });

  it("uses injected now for confirmedAt timestamp", async () => {
    const sessions = new InMemoryBookingSessionRepository();
    const payments = new InMemoryPaymentRepository();
    const { session } = await seedPendingPayment(sessions, payments, { createdAt: RECENT });

    const paypalClient = createMockPayPalClient({
      getOrderDetails: jest.fn().mockResolvedValue({
        orderId: "PAYPAL-ORDER-1",
        status: "COMPLETED",
        captureId: "CAPTURE-456",
        captureStatus: "COMPLETED",
      } satisfies PayPalOrderDetails),
    });

    const deps = createDeps({ payments, bookingSessions: sessions, paypalClient });
    await reconcilePendingPayments(deps);

    const updatedPayment = await payments.getByBookingSessionId(session.id);
    expect(updatedPayment?.capturedAt).toBe(NOW);

    const updatedSession = await sessions.getById(session.id);
    expect(updatedSession?.confirmedAt).toBe(NOW);
  });

  it("warns about missed webhooks when confirming via reconciliation", async () => {
    const sessions = new InMemoryBookingSessionRepository();
    const payments = new InMemoryPaymentRepository();
    await seedPendingPayment(sessions, payments, { createdAt: RECENT });
    const logger = createSilentLogger();

    const paypalClient = createMockPayPalClient({
      getOrderDetails: jest.fn().mockResolvedValue({
        orderId: "PAYPAL-ORDER-1",
        status: "COMPLETED",
        captureId: "CAPTURE-789",
        captureStatus: "COMPLETED",
      } satisfies PayPalOrderDetails),
    });

    const deps = createDeps({ payments, bookingSessions: sessions, paypalClient, logger });
    await reconcilePendingPayments(deps);

    expect(logger.warn).toHaveBeenCalledWith(
      "payment_reconciliation_missed_webhooks",
      expect.objectContaining({ confirmedCount: 1 })
    );
  });

  it("marks payment as failed when PayPal reports VOIDED", async () => {
    const sessions = new InMemoryBookingSessionRepository();
    const payments = new InMemoryPaymentRepository();
    const { session } = await seedPendingPayment(sessions, payments, { createdAt: RECENT });

    const paypalClient = createMockPayPalClient({
      getOrderDetails: jest.fn().mockResolvedValue({
        orderId: "PAYPAL-ORDER-1",
        status: "VOIDED",
      } satisfies PayPalOrderDetails),
    });

    const deps = createDeps({ payments, bookingSessions: sessions, paypalClient });
    const result = await reconcilePendingPayments(deps);

    expect(result.markedFailed).toBe(1);
    expect(result.confirmed).toBe(0);

    const updatedPayment = await payments.getByBookingSessionId(session.id);
    expect(updatedPayment?.status).toBe("failed");

    const updatedSession = await sessions.getById(session.id);
    expect(updatedSession?.status).toBe("failed");
    expect(updatedSession?.failureReason).toBe("paypal_status_voided");
  });

  it("marks payment as failed when PayPal reports EXPIRED", async () => {
    const sessions = new InMemoryBookingSessionRepository();
    const payments = new InMemoryPaymentRepository();
    const { session } = await seedPendingPayment(sessions, payments, { createdAt: RECENT });

    const paypalClient = createMockPayPalClient({
      getOrderDetails: jest.fn().mockResolvedValue({
        orderId: "PAYPAL-ORDER-1",
        status: "EXPIRED",
      } satisfies PayPalOrderDetails),
    });

    const deps = createDeps({ payments, bookingSessions: sessions, paypalClient });
    const result = await reconcilePendingPayments(deps);

    expect(result.markedFailed).toBe(1);

    const updatedSession = await sessions.getById(session.id);
    expect(updatedSession?.status).toBe("failed");
    expect(updatedSession?.failureReason).toBe("paypal_status_expired");
  });

  it("marks payment as failed when capture status is DECLINED", async () => {
    const sessions = new InMemoryBookingSessionRepository();
    const payments = new InMemoryPaymentRepository();
    const { session } = await seedPendingPayment(sessions, payments, { createdAt: RECENT });

    const paypalClient = createMockPayPalClient({
      getOrderDetails: jest.fn().mockResolvedValue({
        orderId: "PAYPAL-ORDER-1",
        status: "COMPLETED",
        captureId: "CAPTURE-X",
        captureStatus: "DECLINED",
      } satisfies PayPalOrderDetails),
    });

    const deps = createDeps({ payments, bookingSessions: sessions, paypalClient });
    const result = await reconcilePendingPayments(deps);

    expect(result.markedFailed).toBe(1);

    const updatedPayment = await payments.getByBookingSessionId(session.id);
    expect(updatedPayment?.status).toBe("failed");
  });

  it("marks payment as failed when capture status is REVERSED", async () => {
    const sessions = new InMemoryBookingSessionRepository();
    const payments = new InMemoryPaymentRepository();
    await seedPendingPayment(sessions, payments, { createdAt: RECENT });

    const paypalClient = createMockPayPalClient({
      getOrderDetails: jest.fn().mockResolvedValue({
        orderId: "PAYPAL-ORDER-1",
        status: "COMPLETED",
        captureId: "CAPTURE-X",
        captureStatus: "REVERSED",
      } satisfies PayPalOrderDetails),
    });

    const deps = createDeps({ payments, bookingSessions: sessions, paypalClient });
    const result = await reconcilePendingPayments(deps);

    expect(result.markedFailed).toBe(1);
  });

  it("leaves a recent CREATED order as stillPending", async () => {
    const sessions = new InMemoryBookingSessionRepository();
    const payments = new InMemoryPaymentRepository();
    const { session } = await seedPendingPayment(sessions, payments, { createdAt: RECENT });

    const paypalClient = createMockPayPalClient({
      getOrderDetails: jest.fn().mockResolvedValue({
        orderId: "PAYPAL-ORDER-1",
        status: "CREATED",
      } satisfies PayPalOrderDetails),
    });

    const deps = createDeps({ payments, bookingSessions: sessions, paypalClient });
    const result = await reconcilePendingPayments(deps);

    expect(result.stillPending).toBe(1);
    expect(result.confirmed).toBe(0);
    expect(result.markedFailed).toBe(0);

    // Session should remain unchanged
    const updatedSession = await sessions.getById(session.id);
    expect(updatedSession?.status).toBe("paypal_order_created");
  });

  it("leaves a recent PAYER_ACTION_REQUIRED order as stillPending", async () => {
    const sessions = new InMemoryBookingSessionRepository();
    const payments = new InMemoryPaymentRepository();
    await seedPendingPayment(sessions, payments, { createdAt: RECENT });

    const paypalClient = createMockPayPalClient({
      getOrderDetails: jest.fn().mockResolvedValue({
        orderId: "PAYPAL-ORDER-1",
        status: "PAYER_ACTION_REQUIRED",
      } satisfies PayPalOrderDetails),
    });

    const deps = createDeps({ payments, bookingSessions: sessions, paypalClient });
    const result = await reconcilePendingPayments(deps);

    expect(result.stillPending).toBe(1);
    expect(result.markedFailed).toBe(0);
  });

  it("marks a stale APPROVED order as failed", async () => {
    const sessions = new InMemoryBookingSessionRepository();
    const payments = new InMemoryPaymentRepository();
    const { session } = await seedPendingPayment(sessions, payments, { createdAt: STALE });

    const paypalClient = createMockPayPalClient({
      getOrderDetails: jest.fn().mockResolvedValue({
        orderId: "PAYPAL-ORDER-1",
        status: "APPROVED",
      } satisfies PayPalOrderDetails),
    });

    const deps = createDeps({ payments, bookingSessions: sessions, paypalClient });
    const result = await reconcilePendingPayments(deps);

    expect(result.markedFailed).toBe(1);
    expect(result.stillPending).toBe(0);

    const updatedSession = await sessions.getById(session.id);
    expect(updatedSession?.status).toBe("failed");
    expect(updatedSession?.failureReason).toBe("stale_pending_payment");
  });

  it("logs staleness warning before failing a stale payment", async () => {
    const sessions = new InMemoryBookingSessionRepository();
    const payments = new InMemoryPaymentRepository();
    await seedPendingPayment(sessions, payments, { createdAt: STALE });
    const logger = createSilentLogger();

    const paypalClient = createMockPayPalClient({
      getOrderDetails: jest.fn().mockResolvedValue({
        orderId: "PAYPAL-ORDER-1",
        status: "APPROVED",
      } satisfies PayPalOrderDetails),
    });

    const deps = createDeps({ payments, bookingSessions: sessions, paypalClient, logger });
    await reconcilePendingPayments(deps);

    expect(logger.warn).toHaveBeenCalledWith(
      "payment_reconciliation_stale",
      expect.objectContaining({ paypalStatus: "APPROVED" })
    );
  });

  it("skips a payment when PayPal API returns an error and continues others", async () => {
    const sessions = new InMemoryBookingSessionRepository();
    const payments = new InMemoryPaymentRepository();
    const { session: s1 } = await seedPendingPayment(sessions, payments, {
      createdAt: RECENT,
      paypalOrderId: "ORDER-FAIL",
    });

    // Seed a second payment — need a fresh session
    const session2 = await sessions.createQuotedSession({
      arrivalDate: "2026-06-01",
      departureDate: "2026-06-05",
      guests: 2,
      language: "es",
      quotedProperties: [
        {
          propertyId: "sunsetvilla",
          currency: "USD",
          totalAmountCents: 50000,
          nightlyAverageCents: 12500,
          nights: 4,
          includesTaxes: false,
          rateSource: "smoobu",
        },
      ],
    });
    await sessions.markHoldCreating({
      bookingSessionId: session2.id,
      propertyId: "sunsetvilla",
      paymentMethod: "paypal",
      ratePlan: "flexible",
      price: session2.quotedProperties[0],
      guest: { firstName: "Test", lastName: "Two", email: "test2@example.com" },
      portalPasswordHash: "hash2",
      expiresAt: "2026-04-15T13:00:00.000Z",
    });
    await sessions.markHoldActive({ bookingSessionId: session2.id, expiresAt: "2026-04-15T13:00:00.000Z" });
    await sessions.markPaypalOrderCreated({ bookingSessionId: session2.id, paypalOrderId: "ORDER-OK" });
    const p2 = await payments.createOrderPayment({
      bookingSessionId: session2.id,
      paypalOrderId: "ORDER-OK",
      paypalRequestIdOrder: "req-2",
      paypalRequestIdCapture: "req-cap-2",
      currency: "USD",
      totalAmountCents: 50000,
    });
    (p2 as any).createdAt = RECENT;

    const paypalClient = createMockPayPalClient({
      getOrderDetails: jest.fn().mockImplementation((orderId: string) => {
        if (orderId === "ORDER-FAIL") {
          throw new PayPalProviderError(503, "provider_unavailable", "PayPal is down.");
        }
        return Promise.resolve({
          orderId: "ORDER-OK",
          status: "COMPLETED",
          captureId: "CAPTURE-OK",
          captureStatus: "COMPLETED",
        } satisfies PayPalOrderDetails);
      }),
    });

    const deps = createDeps({ payments, bookingSessions: sessions, paypalClient });
    const result = await reconcilePendingPayments(deps);

    expect(result.processed).toBe(2);
    expect(result.providerErrors).toBe(1);
    expect(result.confirmed).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].phase).toBe("fetch_order");
    expect(result.errors[0].paypalOrderId).toBe("ORDER-FAIL");

    // The second session should be confirmed despite the first failing
    const updatedS2 = await sessions.getById(session2.id);
    expect(updatedS2?.status).toBe("booking_confirmed");
  });

  it("records error when DB update fails during confirmation", async () => {
    const sessions = new InMemoryBookingSessionRepository();
    const payments = new InMemoryPaymentRepository();
    await seedPendingPayment(sessions, payments, { createdAt: RECENT });

    // Sabotage markCaptured
    const originalMarkCaptured = payments.markCaptured.bind(payments);
    payments.markCaptured = jest.fn().mockRejectedValue(new Error("connection reset"));

    const paypalClient = createMockPayPalClient({
      getOrderDetails: jest.fn().mockResolvedValue({
        orderId: "PAYPAL-ORDER-1",
        status: "COMPLETED",
        captureId: "CAPTURE-DB-FAIL",
        captureStatus: "COMPLETED",
      } satisfies PayPalOrderDetails),
    });

    const logger = createSilentLogger();
    const deps = createDeps({ payments, bookingSessions: sessions, paypalClient, logger });
    const result = await reconcilePendingPayments(deps);

    expect(result.confirmed).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({
      phase: "confirm_session",
      errorCode: "db_update_failed",
    });

    expect(logger.error).toHaveBeenCalledWith(
      "payment_reconciliation_confirm_failed",
      expect.objectContaining({ error: "connection reset" })
    );
  });

  it("records error when DB update fails during failure marking", async () => {
    const sessions = new InMemoryBookingSessionRepository();
    const payments = new InMemoryPaymentRepository();
    await seedPendingPayment(sessions, payments, { createdAt: RECENT });

    // Sabotage markFailed on payments
    payments.markFailed = jest.fn().mockRejectedValue(new Error("disk full"));

    const paypalClient = createMockPayPalClient({
      getOrderDetails: jest.fn().mockResolvedValue({
        orderId: "PAYPAL-ORDER-1",
        status: "VOIDED",
      } satisfies PayPalOrderDetails),
    });

    const logger = createSilentLogger();
    const deps = createDeps({ payments, bookingSessions: sessions, paypalClient, logger });
    const result = await reconcilePendingPayments(deps);

    expect(result.markedFailed).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({
      phase: "fail_session",
      errorCode: "db_update_failed",
    });
  });

  it("respects custom staleThresholdMs", async () => {
    const sessions = new InMemoryBookingSessionRepository();
    const payments = new InMemoryPaymentRepository();
    // Payment created 30 min ago
    const { session } = await seedPendingPayment(sessions, payments, { createdAt: RECENT });

    const paypalClient = createMockPayPalClient({
      getOrderDetails: jest.fn().mockResolvedValue({
        orderId: "PAYPAL-ORDER-1",
        status: "APPROVED",
      } satisfies PayPalOrderDetails),
    });

    // Set stale threshold to 15 minutes — the 30-min-old payment should be stale
    const deps = createDeps({
      payments,
      bookingSessions: sessions,
      paypalClient,
      staleThresholdMs: 15 * 60 * 1000,
    });
    const result = await reconcilePendingPayments(deps);

    expect(result.markedFailed).toBe(1);
    expect(result.stillPending).toBe(0);

    const updatedSession = await sessions.getById(session.id);
    expect(updatedSession?.failureReason).toBe("stale_pending_payment");
  });

  it("does not confirm when order is COMPLETED but captureId is missing", async () => {
    const sessions = new InMemoryBookingSessionRepository();
    const payments = new InMemoryPaymentRepository();
    await seedPendingPayment(sessions, payments, { createdAt: RECENT });

    const paypalClient = createMockPayPalClient({
      getOrderDetails: jest.fn().mockResolvedValue({
        orderId: "PAYPAL-ORDER-1",
        status: "COMPLETED",
        captureId: undefined,
        captureStatus: "COMPLETED",
      } satisfies PayPalOrderDetails),
    });

    const deps = createDeps({ payments, bookingSessions: sessions, paypalClient });
    const result = await reconcilePendingPayments(deps);

    // Without a captureId, we can't confirm — should fall through to staleness
    expect(result.confirmed).toBe(0);
    expect(result.stillPending).toBe(1);
  });

  it("logs debug when sweep finds no pending payments", async () => {
    const logger = createSilentLogger();
    const deps = createDeps({ logger });
    await reconcilePendingPayments(deps);

    expect(logger.debug).toHaveBeenCalledWith(
      "payment_reconciliation_empty",
      expect.any(Object)
    );
  });
});

describe("reconcilePendingPayments — race-condition regression (R9)", () => {
  it("confirms a session left in paypal_order_created after its payment was captured", async () => {
    const sessions = new InMemoryBookingSessionRepository();
    const payments = new InMemoryPaymentRepository();

    const { session } = await seedPendingPayment(sessions, payments);
    // The payment captured but the session confirmation never landed — a crash
    // between markCaptured and markBookingConfirmed. The main scan filters on
    // payment status ('order_created') and can never re-pick this.
    await payments.markCaptured({
      bookingSessionId: session.id,
      paypalCaptureId: "CAP-R9",
      capturedAt: NOW,
    });

    const deps = createDeps({ payments, bookingSessions: sessions });
    const result = await reconcilePendingPayments(deps);

    expect(result.confirmed).toBe(1);
    const after = await sessions.getById(session.id);
    expect(after?.status).toBe("booking_confirmed");
  });
});
