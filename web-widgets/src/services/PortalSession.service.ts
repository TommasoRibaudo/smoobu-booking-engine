const tokenKey = 'booking_portal_token';
const reservationKey = 'booking_portal_reservation_id';
const credentialCacheKey = 'booking_portal_credentials';

/** Maximum number of reservation credentials to keep in the cache. */
const MAX_CACHED_CREDENTIALS = 10;

// ---------------------------------------------------------------------------
// Session token helpers (sessionStorage — cleared on tab close)
// ---------------------------------------------------------------------------

export function readPortalToken(): string | null {
  try {
    return window.sessionStorage.getItem(tokenKey);
  } catch {
    return null;
  }
}

export function persistPortalSession(token: string, reservationPublicId: string): void {
  try {
    window.sessionStorage.setItem(tokenKey, token);
    window.sessionStorage.setItem(reservationKey, reservationPublicId);
  } catch {
    // Non-critical — the detail page handles missing token gracefully.
  }
}

export function clearPortalSession(): void {
  try {
    window.sessionStorage.removeItem(tokenKey);
    window.sessionStorage.removeItem(reservationKey);
  } catch {
    // Non-critical.
  }
}

// ---------------------------------------------------------------------------
// Credential cache (localStorage — survives browser close)
//
// Stores reservation ID + password pairs so the guest can quickly log back in
// to manage their reservation without re-typing credentials. When multiple
// reservations exist the most recently saved one is returned first.
// ---------------------------------------------------------------------------

interface CachedCredential {
  reservationPublicId: string;
  password: string;
  /** ISO-8601 timestamp of when this entry was saved / last updated. */
  savedAt: string;
}

/**
 * Save (or update) credentials for a reservation. If the reservation already
 * exists in the cache the password and timestamp are updated and it is moved
 * to the front. New entries are prepended so the most recent is always first.
 */
export function savePortalCredentials(reservationPublicId: string, password: string): void {
  try {
    const list = readCredentialList();
    const filtered = list.filter((c) => c.reservationPublicId !== reservationPublicId);
    filtered.unshift({ reservationPublicId, password, savedAt: new Date().toISOString() });
    // Keep the list bounded.
    const trimmed = filtered.slice(0, MAX_CACHED_CREDENTIALS);
    window.localStorage.setItem(credentialCacheKey, JSON.stringify(trimmed));
  } catch {
    // Non-critical — the portal login still works manually.
  }
}

/**
 * Return the most recently saved credential, or `null` if the cache is empty.
 */
export function readLatestPortalCredentials(): CachedCredential | null {
  const list = readCredentialList();
  return list.length > 0 ? list[0] : null;
}

/**
 * Look up cached credentials for a specific reservation.
 */
export function readPortalCredentials(reservationPublicId: string): CachedCredential | null {
  const list = readCredentialList();
  return list.find((c) => c.reservationPublicId === reservationPublicId) ?? null;
}

/**
 * Remove a single reservation from the credential cache (e.g. after a failed
 * login proves the password is stale).
 */
export function removePortalCredentials(reservationPublicId: string): void {
  try {
    const list = readCredentialList();
    const filtered = list.filter((c) => c.reservationPublicId !== reservationPublicId);
    if (filtered.length === 0) {
      window.localStorage.removeItem(credentialCacheKey);
    } else {
      window.localStorage.setItem(credentialCacheKey, JSON.stringify(filtered));
    }
  } catch {
    // Non-critical.
  }
}

/**
 * Wipe the entire credential cache.
 */
export function clearAllPortalCredentials(): void {
  try {
    window.localStorage.removeItem(credentialCacheKey);
  } catch {
    // Non-critical.
  }
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

function readCredentialList(): CachedCredential[] {
  try {
    const raw = window.localStorage.getItem(credentialCacheKey);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Validate each entry.
    return parsed.filter(
      (c: unknown): c is CachedCredential =>
        typeof c === 'object' &&
        c !== null &&
        typeof (c as CachedCredential).reservationPublicId === 'string' &&
        typeof (c as CachedCredential).password === 'string' &&
        typeof (c as CachedCredential).savedAt === 'string',
    );
  } catch {
    return [];
  }
}
