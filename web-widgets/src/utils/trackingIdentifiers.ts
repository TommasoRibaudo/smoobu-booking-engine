/**
 * Marketing attribution identifiers, read from the browser and forwarded to the
 * booking API so conversions can be reported server-side.
 *
 * The API is the authoritative source for funnel events — see
 * booking-api/src/serverConversions.ts — but it cannot see the guest's cookies.
 * Without `gaClientId` the GA4 Measurement Protocol rejects the event outright;
 * without `gaSessionId` the sale is attributed to a fresh session and lands in
 * Direct/None, crediting no campaign.
 *
 * The consent gate lives here rather than at each call site, so no caller can
 * forget it: with marketing consent absent this returns undefined and the API
 * stores nothing, which in turn keeps the server silent.
 */

import { CookieConsentService } from '../services/CookieConsent.service';

/** Must stay in sync with the GA4 measurement ID configured in public/index.html. */
const GA4_MEASUREMENT_ID = process.env.REACT_APP_GA4_MEASUREMENT_ID || '';

export interface TrackingIdentifiers {
  gaClientId?: string;
  gaSessionId?: string;
  fbp?: string;
  fbc?: string;
  gclid?: string;
}

function readCookie(name: string): string | undefined {
  if (typeof document === 'undefined') return undefined;

  const match = document.cookie.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : undefined;
}

/**
 * `_ga` is `GA1.<depth>.<client_id>`, where the client ID is itself dotted
 * (`1234567890.1234567890`). Everything from the third segment on is the ID.
 */
function parseGaClientId(): string | undefined {
  const raw = readCookie('_ga');
  if (!raw) return undefined;

  const parts = raw.split('.');
  return parts.length >= 4 ? parts.slice(2).join('.') : undefined;
}

/**
 * `_ga_<container>` is `GS<version>.<depth>.s<session_id>$o<n>$g<n>$t<n>...`.
 * The session ID is the `s`-prefixed field of the third segment.
 */
function parseGaSessionId(): string | undefined {
  if (!GA4_MEASUREMENT_ID) return undefined;

  const container = GA4_MEASUREMENT_ID.replace(/^G-/, '');
  const raw = readCookie(`_ga_${container}`);
  if (!raw) return undefined;

  const sessionPart = raw.split('.')[2];
  if (!sessionPart) return undefined;

  const sessionId = sessionPart.split('$')[0].replace(/^s/, '');
  return /^\d+$/.test(sessionId) ? sessionId : undefined;
}

/**
 * Meta's click ID cookie is only set when the visitor arrived via an ad. When
 * absent but `fbclid` is on the URL, synthesise it in Meta's documented
 * `fb.<subdomain_index>.<timestamp>.<fbclid>` form so the click is still matched.
 */
function resolveFbc(): string | undefined {
  const cookie = readCookie('_fbc');
  if (cookie) return cookie;

  if (typeof window === 'undefined') return undefined;
  const fbclid = new URLSearchParams(window.location.search).get('fbclid');
  return fbclid ? `fb.1.${Date.now()}.${fbclid}` : undefined;
}

function readGclid(): string | undefined {
  if (typeof window === 'undefined') return undefined;
  return new URLSearchParams(window.location.search).get('gclid') ?? undefined;
}

/**
 * Collects whatever identifiers are available, or undefined when the guest has
 * not granted marketing consent.
 */
export function getTrackingIdentifiers(): TrackingIdentifiers | undefined {
  try {
    if (!CookieConsentService.hasConsent('marketing')) return undefined;

    const identifiers: TrackingIdentifiers = {};

    const gaClientId = parseGaClientId();
    if (gaClientId) identifiers.gaClientId = gaClientId;

    const gaSessionId = parseGaSessionId();
    if (gaSessionId) identifiers.gaSessionId = gaSessionId;

    const fbp = readCookie('_fbp');
    if (fbp) identifiers.fbp = fbp;

    const fbc = resolveFbc();
    if (fbc) identifiers.fbc = fbc;

    const gclid = readGclid();
    if (gclid) identifiers.gclid = gclid;

    return Object.keys(identifiers).length > 0 ? identifiers : undefined;
  } catch {
    // Attribution is never worth breaking a booking request over.
    return undefined;
  }
}

/** True when the guest has granted marketing consent. */
export function hasMarketingConsent(): boolean {
  try {
    return CookieConsentService.hasConsent('marketing');
  } catch {
    return false;
  }
}
