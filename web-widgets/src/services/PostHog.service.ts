/**
 * Lazy PostHog loader.
 *
 * posthog-js used to be a static import in src/index.tsx with `posthog.init()`
 * running at module scope — so every visitor downloaded, parsed and executed
 * the library before React mounted, on the critical path. It is configured
 * `opt_out_capturing_by_default`, so for anyone who has not accepted analytics
 * cookies that work produced nothing at all. It also cost a Best-Practices
 * point: the library fetches its remote config, which sets third-party
 * cookies, and Lighthouse flags that on every page.
 *
 * Here the module is fetched only when analytics consent actually exists, and
 * even then off the critical path. Every call site in the app already gates on
 * consent before firing an event (BookingAnalytics `canTrack()`,
 * CalendarWithPriceDots, Router's PostHogPageView), so behaviour is unchanged
 * for consenting visitors — events fire a beat later, and any raised before
 * the chunk lands are queued rather than dropped.
 *
 * `import type` is erased at compile time, so it does not pull the runtime
 * module into the main bundle.
 */
import { CookieConsentService } from './CookieConsent.service';

type PostHogClient = typeof import('posthog-js')['default'];

/**
 * Mirrors posthog-js's own `Properties` type. Not Record<string, unknown>:
 * the call sites pass typed interfaces (BookingSearchProps and friends), and
 * an interface without an index signature is not assignable to that, so the
 * stricter type would reject every existing caller.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type EventProperties = Record<string, any>;

interface QueuedEvent {
  event: string;
  props?: EventProperties;
}

let client: PostHogClient | null = null;
let loadPromise: Promise<PostHogClient | null> | null = null;

/**
 * Events raised before the chunk resolves. Bounded: if the network never
 * delivers posthog-js this must not grow without limit, and analytics is
 * never worth leaking memory over.
 */
const queue: QueuedEvent[] = [];
const MAX_QUEUE = 50;

function isConfigured(): boolean {
  return Boolean(process.env.REACT_APP_PUBLIC_POSTHOG_KEY);
}

function hasAnalyticsConsent(): boolean {
  try {
    return CookieConsentService.hasConsent('analytics');
  } catch {
    return false;
  }
}

/** Run after the browser is idle, so loading never competes with hydration. */
function whenIdle(fn: () => void): void {
  if (typeof window === 'undefined') return;
  const ric = (window as unknown as {
    requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
  }).requestIdleCallback;
  if (typeof ric === 'function') {
    ric(fn, { timeout: 2000 });
  } else {
    window.setTimeout(fn, 200);
  }
}

function flushQueue(instance: PostHogClient): void {
  while (queue.length) {
    const next = queue.shift();
    if (next) instance.capture(next.event, next.props);
  }
}

/**
 * Fetch and initialise posthog-js. Resolves to null when PostHog is not
 * configured, when the chunk fails to load, or when called during
 * pre-rendering. Safe to call repeatedly — the work happens once.
 */
export function loadPostHog(): Promise<PostHogClient | null> {
  if (client) return Promise.resolve(client);
  if (loadPromise) return loadPromise;
  if (typeof window === 'undefined' || !isConfigured()) return Promise.resolve(null);

  loadPromise = import(/* webpackChunkName: "posthog" */ 'posthog-js')
    .then(({ default: posthog }) => {
      posthog.init(process.env.REACT_APP_PUBLIC_POSTHOG_KEY as string, {
        api_host: process.env.REACT_APP_PUBLIC_POSTHOG_HOST,
        person_profiles: 'identified_only',
        opt_out_capturing_by_default: true,
      });
      if (hasAnalyticsConsent()) posthog.opt_in_capturing();
      client = posthog;
      flushQueue(posthog);
      return posthog;
    })
    .catch(() => {
      // A blocked or failed analytics chunk must never break the page.
      loadPromise = null;
      return null;
    });

  return loadPromise;
}

/**
 * Load PostHog only if the visitor has already consented, and only once the
 * browser is idle. This is what src/index.tsx calls on startup: a visitor who
 * has not accepted analytics never downloads the library at all.
 */
export function initPostHogIfConsented(): void {
  if (!hasAnalyticsConsent()) return;
  whenIdle(() => { void loadPostHog(); });
}

/**
 * Record an event. Call sites are expected to have checked consent already;
 * the guard here is a backstop so a missed check cannot start tracking an
 * unconsented visitor.
 */
export function capture(event: string, props?: EventProperties): void {
  if (!hasAnalyticsConsent()) return;
  if (client) {
    client.capture(event, props);
    return;
  }
  if (queue.length < MAX_QUEUE) queue.push({ event, props });
  void loadPostHog();
}

/** Consent granted: load if needed, then start capturing. */
export function optIn(): void {
  void loadPostHog().then((instance) => instance?.opt_in_capturing());
}

/**
 * Consent withdrawn. If the library was never loaded there is nothing to opt
 * out of — importing it just to disable it would defeat the point.
 */
export function optOut(): void {
  client?.opt_out_capturing();
}
