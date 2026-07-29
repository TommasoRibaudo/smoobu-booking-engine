import React from 'react';
import {
  ExchangeRateSnapshot,
  getExchangeRateSnapshot,
  loadExchangeRate,
  subscribeToExchangeRate,
} from '../services/exchangeRateStore';

/**
 * Reads the shared USD → CRC display rate, kicking off the one fetch that fills
 * it if nobody has yet.
 *
 * `enabled` is what keeps English pages from requesting a rate they never show;
 * pass `language === 'es'`. Callers render nothing until `status` is `'ready'` —
 * a price with no estimate beside it is the correct fallback, so there is no
 * loading state to display.
 */
export function useExchangeRate(enabled: boolean): ExchangeRateSnapshot {
  const snapshot = React.useSyncExternalStore(
    subscribeToExchangeRate,
    getExchangeRateSnapshot,
    getExchangeRateSnapshot
  );

  React.useEffect(() => {
    if (enabled) {
      loadExchangeRate();
    }
  }, [enabled]);

  return snapshot;
}

export default useExchangeRate;
