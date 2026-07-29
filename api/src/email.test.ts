/**
 * email.test.ts
 *
 * Tests for email template rendering and EmailClient send helpers.
 * SES is never called — EmailClient is constructed with disabled: true.
 */

import {
  renderHoldCreatedEmail,
  renderPaymentPendingEmail,
  renderBookingConfirmedEmail,
  renderCancelledEmail,
  renderDepositHandoffEmail,
} from "./emailTemplates";
import { EmailClient } from "./email";
import type { BookingSessionRecord } from "./bookingSessions";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeSession(overrides: Partial<BookingSessionRecord> = {}): BookingSessionRecord {
  return {
    id: "sess-1",
    reservationPublicId: "KWL-ABCD1234",
    quoteId: "qt_QUOTE1",
    status: "hold_active",
    language: "en",
    arrivalDate: "2026-07-01",
    departureDate: "2026-07-05",
    guests: 2,
    quoteExpiresAt: "2026-06-01T00:00:00Z",
    quotedProperties: [],
    propertyId: "prop-1",
    paymentMethod: "paypal",
    currency: "USD",
    totalAmountCents: 55000,
    expiresAt: "2026-06-15T12:00:00Z",
    guest: {
      firstName: "Ana",
      lastName: "García",
      email: "ana@example.com",
      phone: "+506 8000 0000",
    },
    createdAt: "2026-06-01T00:00:00Z",
    updatedAt: "2026-06-01T00:00:00Z",
    ...overrides,
  };
}

let noopLogger: { debug: jest.Mock; info: jest.Mock; warn: jest.Mock; error: jest.Mock };

beforeEach(() => {
  noopLogger = {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };
});

// ─── Template rendering ───────────────────────────────────────────────────────

describe("renderHoldCreatedEmail", () => {
  it("EN: includes reservation ID and property name in subject and body", () => {
    const result = renderHoldCreatedEmail({
      language: "en",
      guestFirstName: "Ana",
      guestEmail: "ana@example.com",
      reservationPublicId: "KWL-ABCD1234",
      propertyName: "Sunset Villa",
      arrivalDate: "2026-07-01",
      departureDate: "2026-07-05",
      guests: 2,
      currency: "USD",
      totalAmountCents: 55000,
      holdExpiresAt: "2026-06-15T12:00:00Z",
    });

    expect(result.subject).toContain("KWL-ABCD1234");
    expect(result.html).toContain("Sunset Villa");
    expect(result.html).toContain("Hi Ana,");
    expect(result.html).toContain("USD 550.00");
    expect(result.text).toContain("KWL-ABCD1234");
    expect(result.text).toContain("Sunset Villa");
  });

  it("ES: uses Spanish strings", () => {
    const result = renderHoldCreatedEmail({
      language: "es",
      guestFirstName: "Ana",
      guestEmail: "ana@example.com",
      reservationPublicId: "KWL-ABCD1234",
      propertyName: "Sunset Villa",
      arrivalDate: "2026-07-01",
      departureDate: "2026-07-05",
      guests: 2,
    });

    expect(result.subject).toContain("KWL-ABCD1234");
    expect(result.html).toContain("Hola Ana,");
    expect(result.html).toContain("Tu reserva provisional está activa");
  });
});

describe("renderPaymentPendingEmail", () => {
  it("includes PayPal order ID", () => {
    const result = renderPaymentPendingEmail({
      language: "en",
      guestFirstName: "Bob",
      guestEmail: "bob@example.com",
      reservationPublicId: "KWL-XYZ9999",
      propertyName: "Palm Cottage",
      arrivalDate: "2026-08-10",
      departureDate: "2026-08-14",
      guests: 3,
      paypalOrderId: "PP-ORDER-123",
    });

    expect(result.subject).toContain("KWL-XYZ9999");
    expect(result.html).toContain("PP-ORDER-123");
    expect(result.text).toContain("PP-ORDER-123");
  });

  it("ES: uses Spanish strings", () => {
    const result = renderPaymentPendingEmail({
      language: "es",
      guestFirstName: "Carlos",
      guestEmail: "carlos@example.com",
      reservationPublicId: "KWL-ES0001",
      propertyName: "Ocean Breeze House",
      arrivalDate: "2026-09-01",
      departureDate: "2026-09-05",
      guests: 1,
    });

    expect(result.html).toContain("Hola Carlos,");
    expect(result.html).toContain("Regresa a la página de reserva");
  });
});

describe("renderBookingConfirmedEmail", () => {
  it("includes capture ID and confirmed date", () => {
    const result = renderBookingConfirmedEmail({
      language: "en",
      guestFirstName: "Dana",
      guestEmail: "dana@example.com",
      reservationPublicId: "KWL-CONF001",
      propertyName: "Sunset Villa",
      arrivalDate: "2026-10-01",
      departureDate: "2026-10-07",
      guests: 2,
      currency: "USD",
      totalAmountCents: 84000,
      paypalCaptureId: "PP-CAP-456",
      confirmedAt: "2026-06-01T10:00:00Z",
    });

    expect(result.subject).toContain("KWL-CONF001");
    expect(result.html).toContain("PP-CAP-456");
    expect(result.html).toContain("USD 840.00");
    expect(result.html).toContain("confirmed");
  });

  it("ES: uses Spanish strings", () => {
    const result = renderBookingConfirmedEmail({
      language: "es",
      guestFirstName: "Elena",
      guestEmail: "elena@example.com",
      reservationPublicId: "KWL-ES-CONF",
      propertyName: "Ocean Breeze House",
      arrivalDate: "2026-11-01",
      departureDate: "2026-11-05",
      guests: 2,
    });

    expect(result.html).toContain("confirmada");
    expect(result.html).toContain("Hola Elena,");
  });
});

describe("renderCancelledEmail", () => {
  it("EN: includes reservation ID", () => {
    const result = renderCancelledEmail({
      language: "en",
      guestFirstName: "Frank",
      guestEmail: "frank@example.com",
      reservationPublicId: "KWL-CANC001",
      propertyName: "PalmCottage",
      arrivalDate: "2026-12-01",
      departureDate: "2026-12-05",
      guests: 1,
    });

    expect(result.subject).toContain("KWL-CANC001");
    expect(result.html).toContain("cancelled");
    expect(result.html).toContain("PalmCottage");
  });

  it("ES: uses Spanish strings", () => {
    const result = renderCancelledEmail({
      language: "es",
      guestFirstName: "Gabi",
      guestEmail: "gabi@example.com",
      reservationPublicId: "KWL-ES-CANC",
      propertyName: "JungleLoft",
      arrivalDate: "2026-12-10",
      departureDate: "2026-12-14",
      guests: 2,
    });

    expect(result.html).toContain("cancelada");
  });
});

describe("renderDepositHandoffEmail", () => {
  it("EN: includes all three steps and warning", () => {
    const result = renderDepositHandoffEmail({
      language: "en",
      guestFirstName: "Hana",
      guestEmail: "hana@example.com",
      reservationPublicId: "",
      propertyName: "SunsetVilla",
      arrivalDate: "2027-01-10",
      departureDate: "2027-01-15",
      guests: 4,
    });

    expect(result.subject).toContain("Manual deposit");
    expect(result.html).toContain("NOT confirmed");
    expect(result.html).toContain("wa.me");
    expect(result.text).toContain("1.");
    expect(result.text).toContain("2.");
    expect(result.text).toContain("3.");
  });

  it("ES: uses Spanish strings", () => {
    const result = renderDepositHandoffEmail({
      language: "es",
      guestFirstName: "Iván",
      guestEmail: "ivan@example.com",
      reservationPublicId: "",
      propertyName: "JungleLoft",
      arrivalDate: "2027-02-01",
      departureDate: "2027-02-05",
      guests: 5,
    });

    expect(result.subject).toContain("depósito manual");
    expect(result.html).toContain("NO está confirmada");
  });
});

// ─── EmailClient (disabled mode) ──────────────────────────────────────────────

describe("EmailClient (disabled)", () => {
  let client: EmailClient;

  beforeEach(() => {
    client = new EmailClient(
      { fromAddress: "test@example.com", region: "us-east-1", disabled: true },
      noopLogger
    );
  });

  it("sendHoldCreated: logs skip and does not throw", async () => {
    const session = makeSession();
    await expect(client.sendHoldCreated(session, "Sunset Villa")).resolves.toBeUndefined();
    expect(noopLogger.info).toHaveBeenCalledWith(
      "email_send_skipped_disabled",
      expect.objectContaining({ template: "hold_created" })
    );
  });

  it("sendPaymentPending: logs skip and does not throw", async () => {
    const session = makeSession();
    await expect(client.sendPaymentPending(session, "Sunset Villa", "PP-ORDER-1")).resolves.toBeUndefined();
    expect(noopLogger.info).toHaveBeenCalledWith(
      "email_send_skipped_disabled",
      expect.objectContaining({ template: "payment_pending" })
    );
  });

  it("sendBookingConfirmed: logs skip and does not throw", async () => {
    const session = makeSession({ status: "booking_confirmed", confirmedAt: "2026-06-01T10:00:00Z" });
    await expect(client.sendBookingConfirmed(session, "Sunset Villa", "PP-CAP-1")).resolves.toBeUndefined();
    expect(noopLogger.info).toHaveBeenCalledWith(
      "email_send_skipped_disabled",
      expect.objectContaining({ template: "booking_confirmed" })
    );
  });

  it("sendCancelled: logs skip and does not throw", async () => {
    const session = makeSession({ status: "hold_expired" });
    await expect(client.sendCancelled(session, "Sunset Villa")).resolves.toBeUndefined();
    expect(noopLogger.info).toHaveBeenCalledWith(
      "email_send_skipped_disabled",
      expect.objectContaining({ template: "cancelled" })
    );
  });

  it("sendDepositHandoff: logs skip and does not throw", async () => {
    await expect(
      client.sendDepositHandoff("guest@example.com", "Ana", "en", "Sunset Villa", "2026-07-01", "2026-07-05", 2)
    ).resolves.toBeUndefined();
    expect(noopLogger.info).toHaveBeenCalledWith(
      "email_send_skipped_disabled",
      expect.objectContaining({ template: "deposit_handoff" })
    );
  });

  it("skips send when guest email is missing", async () => {
    const session = makeSession({ guest: undefined });
    await expect(client.sendHoldCreated(session, "Sunset Villa")).resolves.toBeUndefined();
    // No SES call attempted — no error thrown
  });
});
