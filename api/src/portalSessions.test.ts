import { createHash } from "crypto";
import { RdsPortalSessionRepository } from "./portalSessions";

const BASE_PORTAL_SESSION_ROW = {
  id: "11111111-1111-4111-8111-111111111111",
  booking_session_id: "22222222-2222-4222-8222-222222222222",
  reservation_public_id: "KWL-ABCD1234",
  token_hash: sha256("portal-token"),
  status: "active",
  issued_at: "2026-04-15T18:00:00.000Z",
  expires_at: "2026-04-16T18:00:00.000Z",
  revoked_at: null,
  last_seen_at: null,
  request_ip: "203.0.113.10",
  user_agent_hash: sha256("Mozilla/5.0"),
  created_at: "2026-04-15T18:00:00.000Z",
  updated_at: "2026-04-15T18:00:00.000Z",
};

function createPool(query: jest.Mock) {
  return { query } as unknown as ConstructorParameters<typeof RdsPortalSessionRepository>[0];
}

test("RdsPortalSessionRepository.createSession stores only hashed token and user-agent values", async () => {
  const query = jest.fn(async (_sql: string, values: unknown[]) => ({
    rows: [
      {
        ...BASE_PORTAL_SESSION_ROW,
        booking_session_id: values[0],
        reservation_public_id: values[1],
        token_hash: values[2],
        issued_at: values[3],
        expires_at: values[4],
        request_ip: values[5],
        user_agent_hash: values[6],
      },
    ],
  }));
  const repo = new RdsPortalSessionRepository(createPool(query));

  const result = await repo.createSession({
    bookingSessionId: BASE_PORTAL_SESSION_ROW.booking_session_id,
    reservationPublicId: "KWL-ABCD1234",
    token: "portal-token",
    issuedAt: "2026-04-15T18:00:00.000Z",
    expiresAt: "2026-04-16T18:00:00.000Z",
    requestIp: "203.0.113.10",
    userAgent: "Mozilla/5.0",
  });

  expect(result).toMatchObject({
    id: BASE_PORTAL_SESSION_ROW.id,
    bookingSessionId: BASE_PORTAL_SESSION_ROW.booking_session_id,
    reservationPublicId: "KWL-ABCD1234",
    tokenHash: sha256("portal-token"),
    status: "active",
    requestIp: "203.0.113.10",
    userAgentHash: sha256("Mozilla/5.0"),
  });
  expect(query).toHaveBeenCalledWith(expect.stringContaining("insert into portal_sessions"), [
    BASE_PORTAL_SESSION_ROW.booking_session_id,
    "KWL-ABCD1234",
    sha256("portal-token"),
    "2026-04-15T18:00:00.000Z",
    "2026-04-16T18:00:00.000Z",
    "203.0.113.10",
    sha256("Mozilla/5.0"),
  ]);
  expect(query.mock.calls[0][1]).not.toContain("portal-token");
  expect(query.mock.calls[0][1]).not.toContain("Mozilla/5.0");
});

test("RdsPortalSessionRepository.getActiveSessionByToken requires active, unexpired matching public id", async () => {
  const query = jest.fn(async () => ({ rows: [BASE_PORTAL_SESSION_ROW] }));
  const repo = new RdsPortalSessionRepository(createPool(query));

  const result = await repo.getActiveSessionByToken({
    token: "portal-token",
    reservationPublicId: "KWL-ABCD1234",
    now: "2026-04-15T19:00:00.000Z",
  });

  expect(result?.reservationPublicId).toBe("KWL-ABCD1234");
  expect(query).toHaveBeenCalledWith(expect.stringContaining("status = 'active'"), [
    sha256("portal-token"),
    "KWL-ABCD1234",
    "2026-04-15T19:00:00.000Z",
  ]);
  expect(query).toHaveBeenCalledWith(expect.stringContaining("expires_at > $3"), expect.any(Array));
});

test("RdsPortalSessionRepository.touchActiveSession updates last_seen_at for an active token", async () => {
  const query = jest.fn(async (_sql: string, values: unknown[]) => ({
    rows: [
      {
        ...BASE_PORTAL_SESSION_ROW,
        last_seen_at: values[2],
        updated_at: values[2],
      },
    ],
  }));
  const repo = new RdsPortalSessionRepository(createPool(query));

  const result = await repo.touchActiveSession({
    token: "portal-token",
    reservationPublicId: "KWL-ABCD1234",
    seenAt: "2026-04-15T19:30:00.000Z",
  });

  expect(result?.lastSeenAt).toBe("2026-04-15T19:30:00.000Z");
  expect(query).toHaveBeenCalledWith(expect.stringContaining("last_seen_at = $3"), [
    sha256("portal-token"),
    "KWL-ABCD1234",
    "2026-04-15T19:30:00.000Z",
  ]);
});

test("RdsPortalSessionRepository.revokeSession marks active tokens revoked", async () => {
  const query = jest.fn(async (_sql: string, values: unknown[]) => ({
    rows: [
      {
        ...BASE_PORTAL_SESSION_ROW,
        status: "revoked",
        revoked_at: values[1],
        updated_at: values[1],
      },
    ],
  }));
  const repo = new RdsPortalSessionRepository(createPool(query));

  const result = await repo.revokeSession({
    token: "portal-token",
    revokedAt: "2026-04-15T20:00:00.000Z",
  });

  expect(result?.status).toBe("revoked");
  expect(result?.revokedAt).toBe("2026-04-15T20:00:00.000Z");
  expect(query).toHaveBeenCalledWith(expect.stringContaining("status = 'revoked'"), [
    sha256("portal-token"),
    "2026-04-15T20:00:00.000Z",
  ]);
});

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}
