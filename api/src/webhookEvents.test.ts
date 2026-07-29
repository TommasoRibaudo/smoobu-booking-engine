import { RdsWebhookEventRepository } from "./paypalWebhooks";

const BASE_WEBHOOK_ROW = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  provider: "paypal" as const,
  external_event_id: "WH-EVT-123",
  dedupe_key: "WH-EVT-123",
  event_type: "PAYMENT.CAPTURE.COMPLETED",
  received_at: "2026-04-15T18:00:00.000Z",
  processed_at: null,
  processing_status: "pending",
  payload_hash: "payload-sha256",
};

function createPool(query: jest.Mock) {
  return { query } as unknown as ConstructorParameters<typeof RdsWebhookEventRepository>[0];
}

test("RdsWebhookEventRepository.insertIfNew inserts a pending event keyed by provider and external event id", async () => {
  const query = jest.fn(async (_sql: string, values: unknown[]) => ({
    rows: [
      {
        ...BASE_WEBHOOK_ROW,
        provider: values[0],
        external_event_id: values[1],
        dedupe_key: values[1],
        event_type: values[2],
        payload_hash: values[3],
      },
    ],
  }));
  const repo = new RdsWebhookEventRepository(createPool(query));

  const result = await repo.insertIfNew({
    provider: "paypal",
    externalEventId: "WH-EVT-123",
    eventType: "PAYMENT.CAPTURE.COMPLETED",
    payloadHash: "payload-sha256",
    payload: { id: "WH-EVT-123" },
  });

  expect(result.inserted).toBe(true);
  expect(result.record).toMatchObject({
    id: BASE_WEBHOOK_ROW.id,
    provider: "paypal",
    externalEventId: "WH-EVT-123",
    eventType: "PAYMENT.CAPTURE.COMPLETED",
    receivedAt: "2026-04-15T18:00:00.000Z",
    status: "pending",
    payloadHash: "payload-sha256",
  });
  expect(query).toHaveBeenCalledWith(expect.stringContaining("insert into webhook_events"), [
    "paypal",
    "WH-EVT-123",
    "PAYMENT.CAPTURE.COMPLETED",
    "payload-sha256",
    JSON.stringify({ id: "WH-EVT-123" }),
  ]);
  expect(query).toHaveBeenCalledWith(expect.stringContaining("on conflict do nothing"), expect.any(Array));
});

test("RdsWebhookEventRepository.insertIfNew returns the existing record when the unique constraint dedupes", async () => {
  const query = jest
    .fn()
    .mockResolvedValueOnce({ rows: [] })
    .mockResolvedValueOnce({
      rows: [
        {
          ...BASE_WEBHOOK_ROW,
          processing_status: "processed",
          processed_at: "2026-04-15T18:01:00.000Z",
        },
      ],
    });
  const repo = new RdsWebhookEventRepository(createPool(query));

  const result = await repo.insertIfNew({
    provider: "paypal",
    externalEventId: "WH-EVT-123",
    eventType: "PAYMENT.CAPTURE.COMPLETED",
    payloadHash: "payload-sha256",
  });

  expect(result.inserted).toBe(false);
  expect(result.record.status).toBe("processed");
  expect(result.record.processedAt).toBe("2026-04-15T18:01:00.000Z");
  expect(query).toHaveBeenNthCalledWith(2, expect.stringContaining("external_event_id = $2 or dedupe_key = $2"), [
    "paypal",
    "WH-EVT-123",
  ]);
});

test("RdsWebhookEventRepository.markProcessed is provider-scoped and updates processed_at", async () => {
  const query = jest.fn(async () => ({ rows: [] }));
  const repo = new RdsWebhookEventRepository(createPool(query));

  await repo.markProcessed("smoobu", "cancelReservation:987654:abc123", "processed");

  expect(query).toHaveBeenCalledWith(expect.stringContaining("processing_status = $3"), [
    "smoobu",
    "cancelReservation:987654:abc123",
    "processed",
  ]);
  expect(query).toHaveBeenCalledWith(expect.stringContaining("provider = $1"), expect.any(Array));
  expect(query).toHaveBeenCalledWith(expect.stringContaining("external_event_id = $2 or dedupe_key = $2"), expect.any(Array));
});

test("RdsWebhookEventRepository maps legacy received status to pending", async () => {
  const query = jest.fn(async () => ({
    rows: [{ ...BASE_WEBHOOK_ROW, processing_status: "received" }],
  }));
  const repo = new RdsWebhookEventRepository(createPool(query));

  const result = await repo.insertIfNew({
    provider: "paypal",
    externalEventId: "WH-EVT-123",
    eventType: "CHECKOUT.ORDER.APPROVED",
    payloadHash: "payload-sha256",
  });

  expect(result.record.status).toBe("pending");
});
