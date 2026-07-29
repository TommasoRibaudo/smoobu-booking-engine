/**
 * Portal session tokens — stateless HMAC-SHA256 signed tokens.
 *
 * Format (base64url-encoded JSON envelope):
 *   header.payload.signature
 *
 * Where:
 *   header    = base64url({ alg: "HS256", typ: "KWL-portal" })
 *   payload   = base64url({ sub: reservationPublicId, iat: epochSeconds, exp: epochSeconds })
 *   signature = HMAC-SHA256(header + "." + payload, secret)
 *
 * The secret is the `portalSessionSecret` from Secrets Manager.
 * Tokens are valid for PORTAL_SESSION_TTL_SECONDS (24 hours by default).
 */

import { createHash, createHmac, randomUUID, timingSafeEqual } from "crypto";
import { ApiError } from "./http/errors";

export const PORTAL_SESSION_TTL_SECONDS = 24 * 60 * 60; // 24 hours

const HEADER_B64 = b64url(JSON.stringify({ alg: "HS256", typ: "KWL-portal" }));

export interface PortalSessionPayload {
  sub: string; // reservationPublicId
  iat: number; // issued-at (epoch seconds)
  exp: number; // expires-at (epoch seconds)
}

export type PortalSessionStatus = "active" | "expired" | "revoked";

export interface PortalSessionRecord {
  id: string;
  bookingSessionId: string;
  reservationPublicId: string;
  tokenHash: string;
  status: PortalSessionStatus;
  issuedAt: string;
  expiresAt: string;
  revokedAt?: string;
  lastSeenAt?: string;
  requestIp?: string;
  userAgentHash?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreatePortalSessionInput {
  bookingSessionId: string;
  reservationPublicId: string;
  token: string;
  issuedAt: string;
  expiresAt: string;
  requestIp?: string;
  userAgent?: string;
}

export interface PortalSessionRepository {
  createSession(input: CreatePortalSessionInput): Promise<PortalSessionRecord>;
  getActiveSessionByToken(input: {
    token: string;
    reservationPublicId: string;
    now: string;
  }): Promise<PortalSessionRecord | undefined>;
  touchActiveSession(input: {
    token: string;
    reservationPublicId: string;
    seenAt: string;
  }): Promise<PortalSessionRecord | undefined>;
  revokeSession(input: { token: string; revokedAt: string }): Promise<PortalSessionRecord | undefined>;
}

interface Queryable {
  query<Row extends object = Record<string, unknown>>(text: string, values?: unknown[]): Promise<{ rows: Row[] }>;
}

interface PortalSessionRow {
  id: string;
  booking_session_id: string;
  reservation_public_id: string;
  token_hash: string;
  status: string;
  issued_at: string | Date;
  expires_at: string | Date;
  revoked_at: string | Date | null;
  last_seen_at: string | Date | null;
  request_ip: string | null;
  user_agent_hash: string | null;
  created_at: string | Date;
  updated_at: string | Date;
}

const PORTAL_SESSION_COLUMNS = `
  id,
  booking_session_id,
  reservation_public_id,
  token_hash,
  status,
  issued_at,
  expires_at,
  revoked_at,
  last_seen_at,
  request_ip,
  user_agent_hash,
  created_at,
  updated_at
`;

const PORTAL_SESSION_SELECT = `select ${PORTAL_SESSION_COLUMNS} from portal_sessions`;

export class RdsPortalSessionRepository implements PortalSessionRepository {
  constructor(private readonly pool: Queryable) {}

  async createSession(input: CreatePortalSessionInput): Promise<PortalSessionRecord> {
    const result = await this.pool.query<PortalSessionRow>(
      `
        insert into portal_sessions (
          booking_session_id,
          reservation_public_id,
          token_hash,
          status,
          issued_at,
          expires_at,
          request_ip,
          user_agent_hash
        )
        values ($1, $2, $3, 'active', $4, $5, $6::inet, $7)
        returning ${PORTAL_SESSION_COLUMNS}
      `,
      [
        input.bookingSessionId,
        input.reservationPublicId,
        hashToken(input.token),
        input.issuedAt,
        input.expiresAt,
        normalizeOptionalString(input.requestIp),
        input.userAgent ? hashUserAgent(input.userAgent) : null,
      ]
    );

    return mapRequiredPortalSessionRow(result.rows[0], input.reservationPublicId);
  }

  async getActiveSessionByToken(input: {
    token: string;
    reservationPublicId: string;
    now: string;
  }): Promise<PortalSessionRecord | undefined> {
    const result = await this.pool.query<PortalSessionRow>(
      `
        ${PORTAL_SESSION_SELECT}
        where token_hash = $1
          and reservation_public_id = $2
          and status = 'active'
          and expires_at > $3
        limit 1
      `,
      [hashToken(input.token), input.reservationPublicId, input.now]
    );

    return mapOptionalPortalSessionRow(result.rows[0]);
  }

  async touchActiveSession(input: {
    token: string;
    reservationPublicId: string;
    seenAt: string;
  }): Promise<PortalSessionRecord | undefined> {
    const result = await this.pool.query<PortalSessionRow>(
      `
        update portal_sessions
        set
          last_seen_at = $3,
          updated_at = now()
        where token_hash = $1
          and reservation_public_id = $2
          and status = 'active'
          and expires_at > $3
        returning ${PORTAL_SESSION_COLUMNS}
      `,
      [hashToken(input.token), input.reservationPublicId, input.seenAt]
    );

    return mapOptionalPortalSessionRow(result.rows[0]);
  }

  async revokeSession(input: { token: string; revokedAt: string }): Promise<PortalSessionRecord | undefined> {
    const result = await this.pool.query<PortalSessionRow>(
      `
        update portal_sessions
        set
          status = 'revoked',
          revoked_at = $2,
          updated_at = now()
        where token_hash = $1
          and status = 'active'
        returning ${PORTAL_SESSION_COLUMNS}
      `,
      [hashToken(input.token), input.revokedAt]
    );

    return mapOptionalPortalSessionRow(result.rows[0]);
  }
}

export class InMemoryPortalSessionRepository implements PortalSessionRepository {
  private readonly recordsByTokenHash = new Map<string, PortalSessionRecord>();

  async createSession(input: CreatePortalSessionInput): Promise<PortalSessionRecord> {
    const now = new Date().toISOString();
    const record: PortalSessionRecord = {
      id: randomUUID(),
      bookingSessionId: input.bookingSessionId,
      reservationPublicId: input.reservationPublicId,
      tokenHash: hashToken(input.token),
      status: "active",
      issuedAt: input.issuedAt,
      expiresAt: input.expiresAt,
      ...(input.requestIp ? { requestIp: input.requestIp } : {}),
      ...(input.userAgent ? { userAgentHash: hashUserAgent(input.userAgent) } : {}),
      createdAt: now,
      updatedAt: now,
    };

    this.recordsByTokenHash.set(record.tokenHash, record);
    return record;
  }

  async getActiveSessionByToken(input: {
    token: string;
    reservationPublicId: string;
    now: string;
  }): Promise<PortalSessionRecord | undefined> {
    const record = this.recordsByTokenHash.get(hashToken(input.token));
    if (
      !record ||
      record.reservationPublicId !== input.reservationPublicId ||
      record.status !== "active" ||
      Date.parse(record.expiresAt) <= Date.parse(input.now)
    ) {
      return undefined;
    }

    return record;
  }

  async touchActiveSession(input: {
    token: string;
    reservationPublicId: string;
    seenAt: string;
  }): Promise<PortalSessionRecord | undefined> {
    const existing = await this.getActiveSessionByToken({
      token: input.token,
      reservationPublicId: input.reservationPublicId,
      now: input.seenAt,
    });
    if (!existing) {
      return undefined;
    }

    const updated: PortalSessionRecord = {
      ...existing,
      lastSeenAt: input.seenAt,
      updatedAt: new Date().toISOString(),
    };
    this.recordsByTokenHash.set(updated.tokenHash, updated);
    return updated;
  }

  async revokeSession(input: { token: string; revokedAt: string }): Promise<PortalSessionRecord | undefined> {
    const existing = this.recordsByTokenHash.get(hashToken(input.token));
    if (!existing || existing.status !== "active") {
      return undefined;
    }

    const updated: PortalSessionRecord = {
      ...existing,
      status: "revoked",
      revokedAt: input.revokedAt,
      updatedAt: new Date().toISOString(),
    };
    this.recordsByTokenHash.set(updated.tokenHash, updated);
    return updated;
  }
}

/**
 * Issue a signed portal session token for the given reservation.
 */
export function issuePortalSessionToken(
  reservationPublicId: string,
  secret: string,
  nowSeconds: number = Math.floor(Date.now() / 1000)
): string {
  const payload: PortalSessionPayload = {
    sub: reservationPublicId,
    iat: nowSeconds,
    exp: nowSeconds + PORTAL_SESSION_TTL_SECONDS,
  };

  const payloadB64 = b64url(JSON.stringify(payload));
  const signingInput = `${HEADER_B64}.${payloadB64}`;
  const sig = hmacSha256(signingInput, secret);

  return `${signingInput}.${sig}`;
}

/**
 * Verify a portal session token and return the payload.
 * Throws ApiError 401 if the token is invalid, expired, or tampered.
 */
export function verifyPortalSessionToken(
  token: string,
  secret: string,
  nowSeconds: number = Math.floor(Date.now() / 1000)
): PortalSessionPayload {
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw invalidToken();
  }

  const [headerB64, payloadB64, providedSig] = parts;

  // Verify header
  if (headerB64 !== HEADER_B64) {
    throw invalidToken();
  }

  // Verify signature (timing-safe)
  const signingInput = `${headerB64}.${payloadB64}`;
  const expectedSig = hmacSha256(signingInput, secret);
  const expectedBuf = Buffer.from(expectedSig, "utf8");
  const providedBuf = Buffer.from(providedSig ?? "", "utf8");
  if (
    expectedBuf.length !== providedBuf.length ||
    !timingSafeEqual(expectedBuf, providedBuf)
  ) {
    throw invalidToken();
  }

  // Decode and validate payload
  let payload: unknown;
  try {
    payload = JSON.parse(b64urlDecode(payloadB64));
  } catch {
    throw invalidToken();
  }

  if (
    !payload ||
    typeof payload !== "object" ||
    typeof (payload as Record<string, unknown>).sub !== "string" ||
    typeof (payload as Record<string, unknown>).iat !== "number" ||
    typeof (payload as Record<string, unknown>).exp !== "number"
  ) {
    throw invalidToken();
  }

  const typed = payload as PortalSessionPayload;

  if (nowSeconds >= typed.exp) {
    throw new ApiError(401, "session_expired", "Your session has expired. Please log in again.");
  }

  return typed;
}

/**
 * Extract and verify the portal session token from the Authorization header.
 * Expects: Authorization: Bearer <token>
 */
export function requirePortalSession(
  authorizationHeader: string | undefined,
  secret: string
): PortalSessionPayload {
  return verifyPortalSessionToken(extractPortalSessionToken(authorizationHeader), secret);
}

export function extractPortalSessionToken(authorizationHeader: string | undefined): string {
  if (!authorizationHeader || !authorizationHeader.startsWith("Bearer ")) {
    throw new ApiError(401, "unauthorized", "Authorization header with Bearer token is required.");
  }

  const token = authorizationHeader.slice("Bearer ".length).trim();
  if (!token) {
    throw new ApiError(401, "unauthorized", "Authorization header with Bearer token is required.");
  }

  return token;
}

// ── helpers ──────────────────────────────────────────────────────────────────

function hmacSha256(input: string, secret: string): string {
  return createHmac("sha256", secret).update(input).digest("base64url");
}

function b64url(input: string): string {
  return Buffer.from(input, "utf8").toString("base64url");
}

function b64urlDecode(input: string): string {
  return Buffer.from(input, "base64url").toString("utf8");
}

function invalidToken(): ApiError {
  return new ApiError(401, "unauthorized", "Invalid or expired session token.");
}

function hashToken(token: string): string {
  return sha256(token);
}

function hashUserAgent(userAgent: string): string {
  return sha256(userAgent);
}

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function mapOptionalPortalSessionRow(row: PortalSessionRow | undefined): PortalSessionRecord | undefined {
  return row ? mapPortalSessionRow(row) : undefined;
}

function mapRequiredPortalSessionRow(
  row: PortalSessionRow | undefined,
  reservationPublicId: string
): PortalSessionRecord {
  if (!row) {
    throw new Error(`Portal session for reservation ${reservationPublicId} was not created.`);
  }

  return mapPortalSessionRow(row);
}

function mapPortalSessionRow(row: PortalSessionRow): PortalSessionRecord {
  return {
    id: row.id,
    bookingSessionId: row.booking_session_id,
    reservationPublicId: row.reservation_public_id,
    tokenHash: row.token_hash,
    status: parsePortalSessionStatus(row.status),
    issuedAt: toIsoString(row.issued_at),
    expiresAt: toIsoString(row.expires_at),
    ...(row.revoked_at ? { revokedAt: toIsoString(row.revoked_at) } : {}),
    ...(row.last_seen_at ? { lastSeenAt: toIsoString(row.last_seen_at) } : {}),
    ...(row.request_ip ? { requestIp: row.request_ip } : {}),
    ...(row.user_agent_hash ? { userAgentHash: row.user_agent_hash } : {}),
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
  };
}

function parsePortalSessionStatus(status: string): PortalSessionStatus {
  if (status === "active" || status === "expired" || status === "revoked") {
    return status;
  }

  throw new Error(`Unsupported portal session status from database: ${status}`);
}

function normalizeOptionalString(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function toIsoString(value: string | Date): string {
  if (value instanceof Date) {
    return value.toISOString();
  }

  const timestampMs = Date.parse(value);
  return Number.isNaN(timestampMs) ? value : new Date(timestampMs).toISOString();
}
