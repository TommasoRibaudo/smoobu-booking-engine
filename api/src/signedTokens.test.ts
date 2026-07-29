import { issueSignedToken, verifySignedToken, extractBearerToken, deriveSigningKey } from "./signedTokens";
import { issuePortalSessionToken } from "./portalSessions";
import { ApiError } from "./http/errors";

const SECRET = "portal-session-secret-for-signed-token-tests";
const BOOKING_SESSION_ID = "11111111-1111-4111-8111-111111111111";
const RESERVATION_ID = "KWL-ABCD1234";
const NOW = 1_800_000_000;

function issue(purpose: "deposit_access" | "deposit_confirm" | "deposit_reject", ttlSeconds = 3600): string {
  return issueSignedToken(
    { bookingSessionId: BOOKING_SESSION_ID, reservationPublicId: RESERVATION_ID, purpose, ttlSeconds },
    SECRET,
    NOW
  );
}

function expectApiError(fn: () => unknown, status: number, code: string): void {
  try {
    fn();
    throw new Error("expected the call to throw");
  } catch (error) {
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).statusCode).toBe(status);
    expect((error as ApiError).code).toBe(code);
  }
}

test("a freshly issued token round-trips with its payload intact", () => {
  const payload = verifySignedToken(issue("deposit_access"), SECRET, ["deposit_access"], NOW);

  expect(payload.sub).toBe(BOOKING_SESSION_ID);
  expect(payload.rid).toBe(RESERVATION_ID);
  expect(payload.act).toBe("deposit_access");
  expect(payload.jti).toHaveLength(36);
  expect(payload.exp).toBe(NOW + 3600);
});

test("each token gets its own jti so a spent confirm link is identifiable", () => {
  const first = verifySignedToken(issue("deposit_confirm"), SECRET, ["deposit_confirm"], NOW);
  const second = verifySignedToken(issue("deposit_confirm"), SECRET, ["deposit_confirm"], NOW);

  expect(first.jti).not.toBe(second.jti);
});

test("a tampered payload is rejected", () => {
  const [header, , signature] = issue("deposit_access").split(".");
  const forged = Buffer.from(
    JSON.stringify({
      sub: "22222222-2222-4222-8222-222222222222",
      rid: RESERVATION_ID,
      act: "deposit_access",
      jti: "forged",
      iat: NOW,
      exp: NOW + 3600,
    }),
    "utf8"
  ).toString("base64url");

  expectApiError(() => verifySignedToken(`${header}.${forged}.${signature}`, SECRET, ["deposit_access"], NOW), 401, "invalid_token");
});

test("a token signed with a different secret is rejected", () => {
  const token = issue("deposit_access");
  expectApiError(() => verifySignedToken(token, "some-other-secret", ["deposit_access"], NOW), 401, "invalid_token");
});

test("an expired token reports expiry rather than invalidity", () => {
  const token = issue("deposit_access", 60);
  expectApiError(() => verifySignedToken(token, SECRET, ["deposit_access"], NOW + 61), 401, "token_expired");
});

test("a token is refused for a purpose it was not issued for", () => {
  // A guest's upload token must never confirm the booking.
  const token = issue("deposit_access");
  expectApiError(() => verifySignedToken(token, SECRET, ["deposit_confirm"], NOW), 401, "invalid_token");
});

test("a portal session token cannot be replayed against a signed-token route", () => {
  // The two families use different `typ` headers, which is compared before the
  // signature is even considered.
  const portalToken = issuePortalSessionToken(RESERVATION_ID, SECRET, NOW);
  expectApiError(() => verifySignedToken(portalToken, SECRET, ["deposit_access"], NOW), 401, "invalid_token");
});

test("the signing key is derived from, and differs from, the portal session secret", () => {
  const derived = deriveSigningKey(SECRET);
  expect(derived).not.toBe(SECRET);
  expect(deriveSigningKey(SECRET)).toBe(derived);
  expect(deriveSigningKey("different-secret")).not.toBe(derived);
});

test("malformed tokens are rejected without throwing anything unexpected", () => {
  for (const bad of ["", "not-a-token", "a.b", "a.b.c.d", "a.b.c"]) {
    expectApiError(() => verifySignedToken(bad, SECRET, ["deposit_access"], NOW), 401, "invalid_token");
  }
});

test("extractBearerToken handles the shapes an Authorization header arrives in", () => {
  expect(extractBearerToken("Bearer abc123")).toBe("abc123");
  expect(extractBearerToken("bearer abc123")).toBe("abc123");
  expect(extractBearerToken("  Bearer   abc123  ")).toBe("abc123");
  expect(extractBearerToken("Basic abc123")).toBeUndefined();
  expect(extractBearerToken("Bearer")).toBeUndefined();
  expect(extractBearerToken(undefined)).toBeUndefined();
});
