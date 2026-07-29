/**
 * Portal authentication handler — POST /api/portal/login
 *
 * Verifies the guest's reservation ID + password, then issues a signed
 * portal session token (see portalSessions.ts).
 *
 * Password verification uses the scrypt hash stored on the booking_session
 * record (set during hold creation in holds.ts).
 *
 * Security properties:
 * - Timing-safe password comparison (scrypt verify + timingSafeEqual on derived keys)
 * - Constant-time response on unknown reservation IDs (dummy hash comparison)
 * - Rate limiting enforced at the route level (portalLogin policy: 10/5min per IP)
 * - Security events recorded for failed and successful logins
 */

import { randomUUID, scrypt as scryptCallback, ScryptOptions, timingSafeEqual } from "crypto";
import { BookingSessionRepository } from "./bookingSessions";
import { ApiError } from "./http/errors";
import { getHeader } from "./http/request";
import { jsonResponse } from "./http/response";
import { issuePortalSessionToken, PORTAL_SESSION_TTL_SECONDS } from "./portalSessions";
import { ApiResponse, BookingApiConfig, RouteRequest } from "./types";

// Must match the parameters used in holds.ts hashPortalPassword()
const SCRYPT_PARAMS: ScryptOptions = { N: 16384, r: 8, p: 1 };
const SCRYPT_VERSION_TAG = "scryptN16384r8p1";
const SCRYPT_SALT_HEX_LENGTH = 32; // 16 bytes → 32 hex chars (UUID without dashes)
const SCRYPT_KEY_LENGTH = 64;

/**
 * A dummy hash used when the reservation is not found, to prevent timing-based
 * enumeration of valid reservation IDs.
 */
const DUMMY_HASH = `${SCRYPT_VERSION_TAG}${"0".repeat(SCRYPT_SALT_HEX_LENGTH)}${Buffer.alloc(SCRYPT_KEY_LENGTH).toString("base64")}`;

export async function handlePortalLogin(
  body: { reservationPublicId: string; password: string; language: "en" | "es" },
  request: RouteRequest,
  config: BookingApiConfig
): Promise<ApiResponse> {
  const bookingSessions = requireBookingSessionRepository(config);
  const { portalSessionSecret } = await config.secrets.getSecrets();

  // Look up by reservationPublicId — search all sessions
  const session = await findSessionByPublicId(bookingSessions, body.reservationPublicId);

  // Always run the hash comparison (even for unknown IDs) to prevent timing attacks
  const storedHash = session?.portalPasswordHash ?? DUMMY_HASH;
  const passwordMatches = await verifyPortalPassword(body.password, storedHash);

  if (!session || !passwordMatches) {
    request.observability.recordSecurityEvent({
      name: "portal_login_failed",
      severity: "warn",
      route: "/api/portal/login",
      errorCode: !session ? "reservation_not_found" : "password_mismatch",
      bookingSessionId: session?.id,
    });

    // Uniform error — do not reveal whether the reservation ID exists
    throw new ApiError(401, "invalid_credentials", "Reservation ID or password is incorrect.");
  }

  // Only confirmed bookings can access the portal
  if (session.status !== "booking_confirmed") {
    request.observability.recordSecurityEvent({
      name: "portal_login_rejected_status",
      severity: "info",
      route: "/api/portal/login",
      bookingSessionId: session.id,
    });

    throw new ApiError(403, "booking_not_confirmed", "This reservation is not yet confirmed.");
  }

  const issuedAtSeconds = Math.floor(Date.now() / 1000);
  const token = issuePortalSessionToken(session.reservationPublicId, portalSessionSecret, issuedAtSeconds);
  const issuedAt = new Date(issuedAtSeconds * 1000).toISOString();
  const expiresAt = new Date((issuedAtSeconds + PORTAL_SESSION_TTL_SECONDS) * 1000).toISOString();

  if (config.portalSessions) {
    await config.portalSessions.createSession({
      bookingSessionId: session.id,
      reservationPublicId: session.reservationPublicId,
      token,
      issuedAt,
      expiresAt,
      requestIp: request.clientIp,
      userAgent: request.userAgent,
    });
  } else if (portalSessionPersistenceRequired(config)) {
    throw new ApiError(503, "database_unavailable", "Portal session storage is not configured.", {
      retryable: true,
    });
  }

  request.observability.recordStateTransition({
    entityType: "portal_session",
    toState: "active",
    action: "portal.login",
    success: true,
    bookingSessionId: session.id,
    reservationPublicId: session.reservationPublicId,
  });

  request.observability.recordSecurityEvent({
    name: "portal_login_success",
    severity: "info",
    route: "/api/portal/login",
    bookingSessionId: session.id,
  });

  return jsonResponse(
    200,
    {
      token,
      reservationPublicId: session.reservationPublicId,
      expiresIn: PORTAL_SESSION_TTL_SECONDS,
    },
    request.responseHeaders
  );
}

// ── helpers ──────────────────────────────────────────────────────────────────

function requireBookingSessionRepository(config: BookingApiConfig): BookingSessionRepository {
  if (!config.bookingSessions) {
    throw new ApiError(503, "database_unavailable", "Booking session storage is not configured.", {
      retryable: true,
    });
  }
  return config.bookingSessions;
}

function portalSessionPersistenceRequired(config: BookingApiConfig): boolean {
  const environment = config.observability.environment.trim().toLowerCase();
  return environment === "prod" || environment === "production";
}

async function findSessionByPublicId(
  repo: BookingSessionRepository,
  reservationPublicId: string
) {
  return repo.getByReservationPublicId(reservationPublicId);
}

async function verifyPortalPassword(password: string, storedHash: string): Promise<boolean> {
  if (!storedHash.startsWith(SCRYPT_VERSION_TAG)) {
    return false;
  }

  const rest = storedHash.slice(SCRYPT_VERSION_TAG.length);
  const salt = rest.slice(0, SCRYPT_SALT_HEX_LENGTH);
  const expectedBase64 = rest.slice(SCRYPT_SALT_HEX_LENGTH);

  if (!salt || !expectedBase64) {
    return false;
  }

  let derived: Buffer;
  try {
    derived = await scryptDeriveKey(password, salt, SCRYPT_KEY_LENGTH, SCRYPT_PARAMS);
  } catch {
    return false;
  }

  const expected = Buffer.from(expectedBase64, "base64");
  if (derived.length !== expected.length) {
    return false;
  }

  return timingSafeEqual(derived, expected);
}

function scryptDeriveKey(
  password: string,
  salt: string,
  keylen: number,
  options: ScryptOptions
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, keylen, options, (err, key) => {
      if (err) reject(err);
      else resolve(key);
    });
  });
}
