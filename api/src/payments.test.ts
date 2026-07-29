import { RdsPaymentRepository } from "./payments";

const BASE_PAYMENT_ROW = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  booking_session_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  status: "order_created",
  amount_cents: 51000,
  currency: "USD",
  paypal_order_id: "PAY-ORDER-123",
  paypal_capture_id: null,
  paypal_order_request_id: "order-request-id",
  paypal_capture_request_id: "capture-request-id",
  paid_at: null,
  created_at: "2026-04-15T18:00:00.000Z",
  updated_at: "2026-04-15T18:00:00.000Z",
};

function createPool(query: jest.Mock) {
  return { query } as unknown as ConstructorParameters<typeof RdsPaymentRepository>[0];
}

test("RdsPaymentRepository.createOrderPayment inserts and maps a PayPal order payment", async () => {
  const query = jest.fn(async (_sql: string, values: unknown[]) => ({
    rows: [
      {
        ...BASE_PAYMENT_ROW,
        booking_session_id: values[0],
        amount_cents: values[1],
        currency: values[2],
        paypal_order_id: values[3],
        paypal_order_request_id: values[4],
        paypal_capture_request_id: values[5],
      },
    ],
  }));
  const repo = new RdsPaymentRepository(createPool(query));

  const record = await repo.createOrderPayment({
    bookingSessionId: BASE_PAYMENT_ROW.booking_session_id,
    paypalOrderId: "PAY-ORDER-123",
    paypalRequestIdOrder: "order-request-id",
    paypalRequestIdCapture: "capture-request-id",
    currency: "usd",
    totalAmountCents: 51000,
  });

  expect(query).toHaveBeenCalledWith(expect.stringContaining("insert into payments"), [
    BASE_PAYMENT_ROW.booking_session_id,
    51000,
    "USD",
    "PAY-ORDER-123",
    "order-request-id",
    "capture-request-id",
  ]);
  expect(record).toMatchObject({
    bookingSessionId: BASE_PAYMENT_ROW.booking_session_id,
    paypalOrderId: "PAY-ORDER-123",
    paypalRequestIdOrder: "order-request-id",
    paypalRequestIdCapture: "capture-request-id",
    status: "order_created",
    currency: "USD",
    totalAmountCents: 51000,
  });
});

test("RdsPaymentRepository.createOrderPayment maps unique violations to payment_already_exists", async () => {
  const query = jest.fn(async () => {
    throw { code: "23505", constraint: "payments_booking_session_id_key" };
  });
  const repo = new RdsPaymentRepository(createPool(query));

  await expect(
    repo.createOrderPayment({
      bookingSessionId: BASE_PAYMENT_ROW.booking_session_id,
      paypalOrderId: "PAY-ORDER-123",
      paypalRequestIdOrder: "order-request-id",
      paypalRequestIdCapture: "capture-request-id",
      currency: "USD",
      totalAmountCents: 51000,
    })
  ).rejects.toMatchObject({
    statusCode: 409,
    code: "payment_already_exists",
  });
});

test("RdsPaymentRepository.markCaptured guards on order_created status", async () => {
  const query = jest.fn(async (_sql: string, values: unknown[]) => ({
    rows: [
      {
        ...BASE_PAYMENT_ROW,
        status: "captured",
        paypal_capture_id: values[1],
        paid_at: values[2],
        updated_at: "2026-04-15T18:01:00.000Z",
      },
    ],
  }));
  const repo = new RdsPaymentRepository(createPool(query));

  const record = await repo.markCaptured({
    bookingSessionId: BASE_PAYMENT_ROW.booking_session_id,
    paypalCaptureId: "CAPTURE-123",
    capturedAt: "2026-04-15T18:01:00.000Z",
  });

  expect(record).toMatchObject({
    status: "captured",
    paypalCaptureId: "CAPTURE-123",
    capturedAt: "2026-04-15T18:01:00.000Z",
  });
  expect(query).toHaveBeenCalledWith(expect.stringContaining("and status = 'order_created'"), [
    BASE_PAYMENT_ROW.booking_session_id,
    "CAPTURE-123",
    "2026-04-15T18:01:00.000Z",
  ]);
});

test("RdsPaymentRepository.markCaptured is idempotent for an already-stored capture id", async () => {
  const capturedRow = {
    ...BASE_PAYMENT_ROW,
    status: "captured",
    paypal_capture_id: "CAPTURE-123",
    paid_at: "2026-04-15T18:01:00.000Z",
  };
  const query = jest
    .fn()
    .mockResolvedValueOnce({ rows: [] })
    .mockResolvedValueOnce({ rows: [capturedRow] });
  const repo = new RdsPaymentRepository(createPool(query));

  const record = await repo.markCaptured({
    bookingSessionId: BASE_PAYMENT_ROW.booking_session_id,
    paypalCaptureId: "CAPTURE-123",
    capturedAt: "2026-04-15T18:01:00.000Z",
  });

  expect(record.status).toBe("captured");
  expect(record.paypalCaptureId).toBe("CAPTURE-123");
});

test("RdsPaymentRepository.markCaptured rejects invalid state transitions", async () => {
  const query = jest
    .fn()
    .mockResolvedValueOnce({ rows: [] })
    .mockResolvedValueOnce({ rows: [{ ...BASE_PAYMENT_ROW, status: "failed" }] });
  const repo = new RdsPaymentRepository(createPool(query));

  await expect(
    repo.markCaptured({
      bookingSessionId: BASE_PAYMENT_ROW.booking_session_id,
      paypalCaptureId: "CAPTURE-123",
      capturedAt: "2026-04-15T18:01:00.000Z",
    })
  ).rejects.toThrow(
    `Cannot transition payment for booking session ${BASE_PAYMENT_ROW.booking_session_id} to captured: expected order_created, got failed.`
  );
});

test("RdsPaymentRepository.markFailed leaves captured and already-failed payments unchanged", async () => {
  const capturedRow = {
    ...BASE_PAYMENT_ROW,
    status: "captured",
    paypal_capture_id: "CAPTURE-123",
    paid_at: "2026-04-15T18:01:00.000Z",
  };
  const query = jest
    .fn()
    .mockResolvedValueOnce({ rows: [] })
    .mockResolvedValueOnce({ rows: [capturedRow] });
  const repo = new RdsPaymentRepository(createPool(query));

  const record = await repo.markFailed(BASE_PAYMENT_ROW.booking_session_id);

  expect(record.status).toBe("captured");
  expect(record.paypalCaptureId).toBe("CAPTURE-123");
  expect(query).toHaveBeenNthCalledWith(1, expect.stringContaining("status not in ('captured', 'failed')"), [
    BASE_PAYMENT_ROW.booking_session_id,
  ]);
});

test("RdsPaymentRepository.markRefundFlagged hands a captured payment to staff for a manual refund", async () => {
  const query = jest.fn(async (_sql: string, values: unknown[]) => ({
    rows: [
      {
        ...BASE_PAYMENT_ROW,
        status: "refund_flagged",
        paypal_capture_id: "CAPTURE-123",
        paid_at: "2026-04-15T18:01:00.000Z",
        refund_flagged_at: values[1],
      },
    ],
  }));
  const repo = new RdsPaymentRepository(createPool(query));

  const record = await repo.markRefundFlagged({
    bookingSessionId: BASE_PAYMENT_ROW.booking_session_id,
    flaggedAt: "2026-04-20T09:00:00.000Z",
  });

  expect(record.status).toBe("refund_flagged");
  expect(record.refundFlaggedAt).toBe("2026-04-20T09:00:00.000Z");
  // The capture id is what staff needs to issue the refund in PayPal.
  expect(record.paypalCaptureId).toBe("CAPTURE-123");

  const [sql] = query.mock.calls[0];
  expect(sql).toContain("status in ('captured', 'paid', 'refund_flagged')");
  expect(sql).toContain("refund_flagged_at = coalesce(refund_flagged_at, $2)");
});

test("RdsPaymentRepository.markRefundFlagged leaves an unflaggable payment untouched", async () => {
  // A cancellation must never fail because the payment never reached 'captured'.
  const failedRow = { ...BASE_PAYMENT_ROW, status: "failed" };
  const query = jest
    .fn()
    .mockResolvedValueOnce({ rows: [] })
    .mockResolvedValueOnce({ rows: [failedRow] });
  const repo = new RdsPaymentRepository(createPool(query));

  const record = await repo.markRefundFlagged({
    bookingSessionId: BASE_PAYMENT_ROW.booking_session_id,
    flaggedAt: "2026-04-20T09:00:00.000Z",
  });

  expect(record.status).toBe("failed");
  expect(record.refundFlaggedAt).toBeUndefined();
});

test("RdsPaymentRepository.listByStatus returns matching PayPal payments", async () => {
  const rows = [
    BASE_PAYMENT_ROW,
    { ...BASE_PAYMENT_ROW, id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", booking_session_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" },
  ];
  const query = jest.fn(async () => ({ rows }));
  const repo = new RdsPaymentRepository(createPool(query));

  const records = await repo.listByStatus("order_created");

  expect(records).toHaveLength(2);
  expect(records[0].bookingSessionId).toBe(BASE_PAYMENT_ROW.booking_session_id);
  expect(query).toHaveBeenCalledWith(
    expect.stringContaining("where provider = 'paypal' and status = $1"),
    ["order_created", 500]
  );
});
