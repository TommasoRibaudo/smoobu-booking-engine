import { randomUUID } from "crypto";
import { ApiError } from "./http/errors";

export type PaymentStatus =
  | "pending"
  | "order_created"
  | "captured"
  | "paid"
  | "failed"
  | "cancelled"
  | "refund_flagged";

export interface PaymentRecord {
  id: string;
  bookingSessionId: string;
  paypalOrderId: string;
  paypalCaptureId?: string;
  /** PayPal-Request-Id sent when creating the PayPal order. Stable for idempotent retries. */
  paypalRequestIdOrder: string;
  /** PayPal-Request-Id to use when capturing. Pre-assigned at payment record creation time. */
  paypalRequestIdCapture: string;
  status: PaymentStatus;
  currency: string;
  totalAmountCents: number;
  capturedAt?: string;
  /** Set when a guest cancellation handed this payment to staff for a manual refund. */
  refundFlaggedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface PaymentRepository {
  /** Create a payment record for a newly-created PayPal order. Throws 409 if one already exists. */
  createOrderPayment(input: {
    bookingSessionId: string;
    paypalOrderId: string;
    paypalRequestIdOrder: string;
    paypalRequestIdCapture: string;
    currency: string;
    totalAmountCents: number;
  }): Promise<PaymentRecord>;

  getByBookingSessionId(bookingSessionId: string): Promise<PaymentRecord | undefined>;

  markCaptured(input: {
    bookingSessionId: string;
    paypalCaptureId: string;
    capturedAt: string;
  }): Promise<PaymentRecord>;

  markFailed(bookingSessionId: string): Promise<PaymentRecord>;

  /**
   * Flag a captured payment for a manual PayPal refund by staff. Guest
   * cancellations do not move money — this records the hand-off so the capture
   * ID can be reconciled against the refund actually issued in PayPal.
   * Idempotent: re-flagging keeps the original timestamp.
   */
  markRefundFlagged(input: { bookingSessionId: string; flaggedAt: string }): Promise<PaymentRecord>;

  /** List all payments with the given status. Used by the reconciliation job. */
  listByStatus(status: PaymentStatus, limit?: number): Promise<PaymentRecord[]>;
}

interface Queryable {
  query<Row extends object = Record<string, unknown>>(text: string, values?: unknown[]): Promise<{ rows: Row[] }>;
}

interface PaymentRow {
  id: string;
  booking_session_id: string;
  status: string;
  amount_cents: number;
  currency: string;
  paypal_order_id: string | null;
  paypal_capture_id: string | null;
  paypal_order_request_id: string | null;
  paypal_capture_request_id: string | null;
  paid_at: string | Date | null;
  refund_flagged_at: string | Date | null;
  created_at: string | Date;
  updated_at: string | Date;
}

const PAYMENT_COLUMNS = `
  id,
  booking_session_id,
  status,
  amount_cents,
  currency,
  paypal_order_id,
  paypal_capture_id,
  paypal_order_request_id,
  paypal_capture_request_id,
  paid_at,
  refund_flagged_at,
  created_at,
  updated_at
`;

const PAYMENT_SELECT = `select ${PAYMENT_COLUMNS} from payments`;

export class RdsPaymentRepository implements PaymentRepository {
  constructor(private readonly pool: Queryable) {}

  async createOrderPayment(input: {
    bookingSessionId: string;
    paypalOrderId: string;
    paypalRequestIdOrder: string;
    paypalRequestIdCapture: string;
    currency: string;
    totalAmountCents: number;
  }): Promise<PaymentRecord> {
    try {
      const result = await this.pool.query<PaymentRow>(
        `
          insert into payments (
            booking_session_id,
            provider,
            method,
            status,
            amount_cents,
            currency,
            paypal_order_id,
            paypal_order_request_id,
            paypal_capture_request_id
          )
          values ($1, 'paypal', 'paypal', 'order_created', $2, $3, $4, $5, $6)
          returning ${PAYMENT_COLUMNS}
        `,
        [
          input.bookingSessionId,
          input.totalAmountCents,
          input.currency.trim().toUpperCase(),
          input.paypalOrderId,
          input.paypalRequestIdOrder,
          input.paypalRequestIdCapture,
        ]
      );

      return mapRequiredPaymentRow(result.rows[0], input.bookingSessionId);
    } catch (error) {
      throw mapPaymentInsertError(error);
    }
  }

  async getByBookingSessionId(bookingSessionId: string): Promise<PaymentRecord | undefined> {
    const result = await this.pool.query<PaymentRow>(
      `${PAYMENT_SELECT} where booking_session_id = $1 limit 1`,
      [bookingSessionId]
    );
    return mapOptionalPaymentRow(result.rows[0]);
  }

  async markCaptured(input: {
    bookingSessionId: string;
    paypalCaptureId: string;
    capturedAt: string;
  }): Promise<PaymentRecord> {
    const result = await this.pool.query<PaymentRow>(
      `
        update payments
        set
          status = 'captured',
          paypal_capture_id = $2,
          paypal_capture_status = 'COMPLETED',
          paid_at = $3,
          updated_at = now()
        where booking_session_id = $1
          and status = 'order_created'
        returning ${PAYMENT_COLUMNS}
      `,
      [input.bookingSessionId, input.paypalCaptureId, input.capturedAt]
    );

    if (result.rows[0]) {
      return mapPaymentRow(result.rows[0]);
    }

    const existing = await this.getByBookingSessionId(input.bookingSessionId);
    if (!existing) {
      throw paymentMissing();
    }
    if (existing.status === "captured" && existing.paypalCaptureId === input.paypalCaptureId) {
      return existing;
    }

    throw new Error(
      `Cannot transition payment for booking session ${input.bookingSessionId} to captured: expected order_created, got ${existing.status}.`
    );
  }

  async markFailed(bookingSessionId: string): Promise<PaymentRecord> {
    const result = await this.pool.query<PaymentRow>(
      `
        update payments
        set
          status = 'failed',
          failed_at = coalesce(failed_at, now()),
          updated_at = now()
        where booking_session_id = $1
          and status not in ('captured', 'failed')
        returning ${PAYMENT_COLUMNS}
      `,
      [bookingSessionId]
    );

    if (result.rows[0]) {
      return mapPaymentRow(result.rows[0]);
    }

    const existing = await this.getByBookingSessionId(bookingSessionId);
    if (existing) {
      return existing;
    }

    throw paymentMissing();
  }

  async markRefundFlagged(input: { bookingSessionId: string; flaggedAt: string }): Promise<PaymentRecord> {
    const result = await this.pool.query<PaymentRow>(
      `
        update payments
        set
          status = 'refund_flagged',
          refund_flagged_at = coalesce(refund_flagged_at, $2),
          updated_at = now()
        where booking_session_id = $1
          and status in ('captured', 'paid', 'refund_flagged')
        returning ${PAYMENT_COLUMNS}
      `,
      [input.bookingSessionId, input.flaggedAt]
    );

    if (result.rows[0]) {
      return mapPaymentRow(result.rows[0]);
    }

    // Nothing to flag (never captured, already failed) — return the row as-is so a
    // cancellation is never blocked by the state of its payment.
    const existing = await this.getByBookingSessionId(input.bookingSessionId);
    if (existing) {
      return existing;
    }

    throw paymentMissing();
  }

  async listByStatus(status: PaymentStatus, limit = 500): Promise<PaymentRecord[]> {
    const result = await this.pool.query<PaymentRow>(
      `${PAYMENT_SELECT} where provider = 'paypal' and status = $1 order by created_at asc limit $2`,
      [status, limit]
    );
    return result.rows.map(mapPaymentRow);
  }
}

export class InMemoryPaymentRepository implements PaymentRepository {
  private readonly records = new Map<string, PaymentRecord>();

  async createOrderPayment(input: {
    bookingSessionId: string;
    paypalOrderId: string;
    paypalRequestIdOrder: string;
    paypalRequestIdCapture: string;
    currency: string;
    totalAmountCents: number;
  }): Promise<PaymentRecord> {
    if (this.records.has(input.bookingSessionId)) {
      throw new ApiError(409, "payment_already_exists", "A payment record already exists for this booking session.");
    }

    const now = new Date().toISOString();
    const record: PaymentRecord = {
      id: randomUUID(),
      bookingSessionId: input.bookingSessionId,
      paypalOrderId: input.paypalOrderId,
      paypalRequestIdOrder: input.paypalRequestIdOrder,
      paypalRequestIdCapture: input.paypalRequestIdCapture,
      status: "order_created",
      currency: input.currency,
      totalAmountCents: input.totalAmountCents,
      createdAt: now,
      updatedAt: now,
    };

    this.records.set(input.bookingSessionId, record);
    return record;
  }

  async getByBookingSessionId(bookingSessionId: string): Promise<PaymentRecord | undefined> {
    return this.records.get(bookingSessionId);
  }

  async markCaptured(input: {
    bookingSessionId: string;
    paypalCaptureId: string;
    capturedAt: string;
  }): Promise<PaymentRecord> {
    const existing = this.getRequired(input.bookingSessionId);
    const updated: PaymentRecord = {
      ...existing,
      status: "captured",
      paypalCaptureId: input.paypalCaptureId,
      capturedAt: input.capturedAt,
      updatedAt: new Date().toISOString(),
    };
    this.records.set(input.bookingSessionId, updated);
    return updated;
  }

  async markFailed(bookingSessionId: string): Promise<PaymentRecord> {
    const existing = this.getRequired(bookingSessionId);
    const updated: PaymentRecord = {
      ...existing,
      status: "failed",
      updatedAt: new Date().toISOString(),
    };
    this.records.set(bookingSessionId, updated);
    return updated;
  }

  async markRefundFlagged(input: { bookingSessionId: string; flaggedAt: string }): Promise<PaymentRecord> {
    const existing = this.getRequired(input.bookingSessionId);
    if (existing.status !== "captured" && existing.status !== "paid" && existing.status !== "refund_flagged") {
      return existing;
    }

    const updated: PaymentRecord = {
      ...existing,
      status: "refund_flagged",
      refundFlaggedAt: existing.refundFlaggedAt ?? input.flaggedAt,
      updatedAt: new Date().toISOString(),
    };
    this.records.set(input.bookingSessionId, updated);
    return updated;
  }

  async listByStatus(status: PaymentStatus): Promise<PaymentRecord[]> {
    const results: PaymentRecord[] = [];
    for (const record of this.records.values()) {
      if (record.status === status) {
        results.push(record);
      }
    }
    return results;
  }

  private getRequired(bookingSessionId: string): PaymentRecord {
    const record = this.records.get(bookingSessionId);
    if (!record) {
      throw new ApiError(500, "payment_state_invalid", "Payment record is missing.");
    }
    return record;
  }
}

function mapOptionalPaymentRow(row: PaymentRow | undefined): PaymentRecord | undefined {
  return row ? mapPaymentRow(row) : undefined;
}

function mapRequiredPaymentRow(row: PaymentRow | undefined, bookingSessionId: string): PaymentRecord {
  if (!row) {
    throw new Error(`Payment for booking session ${bookingSessionId} was not found.`);
  }

  return mapPaymentRow(row);
}

function mapPaymentRow(row: PaymentRow): PaymentRecord {
  const paypalOrderId = row.paypal_order_id;
  const paypalRequestIdOrder = row.paypal_order_request_id;
  const paypalRequestIdCapture = row.paypal_capture_request_id;
  if (!paypalOrderId || !paypalRequestIdOrder || !paypalRequestIdCapture) {
    throw new Error(`Payment ${row.id} is missing PayPal identifiers.`);
  }

  return {
    id: row.id,
    bookingSessionId: row.booking_session_id,
    paypalOrderId,
    ...(row.paypal_capture_id ? { paypalCaptureId: row.paypal_capture_id } : {}),
    paypalRequestIdOrder,
    paypalRequestIdCapture,
    status: parsePaymentStatus(row.status),
    currency: row.currency.trim().toUpperCase(),
    totalAmountCents: row.amount_cents,
    ...(row.paid_at ? { capturedAt: toIsoString(row.paid_at) } : {}),
    ...(row.refund_flagged_at ? { refundFlaggedAt: toIsoString(row.refund_flagged_at) } : {}),
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
  };
}

function parsePaymentStatus(status: string): PaymentStatus {
  if (
    status === "pending" ||
    status === "order_created" ||
    status === "captured" ||
    status === "paid" ||
    status === "failed" ||
    status === "cancelled" ||
    status === "refund_flagged"
  ) {
    return status;
  }

  throw new Error(`Unsupported payment status from database: ${status}`);
}

function toIsoString(value: string | Date): string {
  if (value instanceof Date) {
    return value.toISOString();
  }

  const timestampMs = Date.parse(value);
  return Number.isNaN(timestampMs) ? value : new Date(timestampMs).toISOString();
}

function mapPaymentInsertError(error: unknown): unknown {
  const pgError = error as { code?: string };
  if (pgError.code === "23505") {
    return new ApiError(409, "payment_already_exists", "A payment record already exists for this booking session.");
  }

  return error;
}

function paymentMissing(): ApiError {
  return new ApiError(500, "payment_state_invalid", "Payment record is missing.");
}
