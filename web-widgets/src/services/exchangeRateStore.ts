/**
 * Process-wide store for the USD → CRC display rate.
 *
 * Every price on a Spanish booking page wants the same number, and they render
 * from several places at once — each result card, the checkout summary, the
 * deposit panel. A module-level store keeps that to a single request per page
 * load without threading the rate through four levels of props, and lets a
 * price block that mounts later (checkout, after a search) render the already
 * loaded rate on its first tick instead of flashing the USD-only layout.
 *
 * A failed load is not retried within the session. The estimate is a courtesy;
 * repeatedly polling a source that is down to render a nice-to-have is not.
 */

import { ExchangeRateResponse, getExchangeRate } from './BookingApi.service';

export type ExchangeRateStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface ExchangeRateSnapshot {
  status: ExchangeRateStatus;
  data: ExchangeRateResponse | null;
}

const IDLE_SNAPSHOT: ExchangeRateSnapshot = { status: 'idle', data: null };

let snapshot: ExchangeRateSnapshot = IDLE_SNAPSHOT;
const listeners = new Set<() => void>();

export function subscribeToExchangeRate(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Must return a stable reference between changes — `useSyncExternalStore` loops
 * forever on a snapshot rebuilt per call.
 */
export function getExchangeRateSnapshot(): ExchangeRateSnapshot {
  return snapshot;
}

export function loadExchangeRate(): void {
  if (snapshot.status !== 'idle') {
    return;
  }

  if (typeof fetch !== 'function') {
    publish({ status: 'error', data: null });
    return;
  }

  publish({ status: 'loading', data: null });

  getExchangeRate()
    .then((data) => {
      // A 200 that is not a rate — a proxy interstitial, a repointed endpoint —
      // would otherwise reach the formatter and render "₡NaN" next to a price.
      publish(isUsableRate(data) ? { status: 'ready', data } : { status: 'error', data: null });
    })
    .catch(() => {
      publish({ status: 'error', data: null });
    });
}

function isUsableRate(data: ExchangeRateResponse | null): boolean {
  return Boolean(
    data && typeof data.base === 'string' && typeof data.rate === 'number' && Number.isFinite(data.rate) && data.rate > 0
  );
}

/** Test seam — module state would otherwise leak between cases. */
export function resetExchangeRateStore(): void {
  snapshot = IDLE_SNAPSHOT;
  listeners.clear();
}

function publish(next: ExchangeRateSnapshot): void {
  snapshot = next;
  listeners.forEach((listener) => listener());
}
