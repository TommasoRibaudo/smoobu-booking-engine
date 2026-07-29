/**
 * Currency formatting shared by the booking engine.
 *
 * Everything is quoted and charged in USD. Left to its defaults, `es-CR`
 * disambiguates a non-local currency as "USD 74,00" — jarring next to the
 * "$74.00" the English pages show for the very same night — so the narrow
 * symbol is requested explicitly. Costa Rica's own colón keeps its own ₡, so
 * there is no ambiguity to reintroduce.
 */

type BookingLocale = 'en' | 'es';

/**
 * Colón amounts are rounded to the nearest 100 before display.
 *
 * The conversion is an estimate off a daily reference rate, so quoting
 * "₡378.941" implies a precision that does not exist and invites a guest to
 * transfer exactly that and wonder why it did not match. ₡378.900 reads as the
 * approximation it is.
 */
const COLONES_DISPLAY_ROUNDING = 100;

export function formatBookingMoney(
  amountCents: number,
  currency: string,
  language: BookingLocale,
  options: { hideZeroCents?: boolean } = {}
): string {
  const locale = language === 'es' ? 'es-CR' : 'en-US';
  const fractionDigits = options.hideZeroCents && amountCents % 100 === 0 ? 0 : 2;
  const base: Intl.NumberFormatOptions = {
    style: 'currency',
    currency,
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  };

  try {
    // `currencyDisplay: 'narrowSymbol'` is ES2020; older engines throw RangeError.
    return new Intl.NumberFormat(locale, { ...base, currencyDisplay: 'narrowSymbol' }).format(
      amountCents / 100
    );
  } catch {
    return new Intl.NumberFormat(locale, base).format(amountCents / 100);
  }
}

/** Colones for a USD amount, rounded to the precision an estimate deserves. */
export function convertUsdCentsToColones(amountUsdCents: number, colonesPerDollar: number): number {
  const colones = (amountUsdCents / 100) * colonesPerDollar;
  return Math.round(colones / COLONES_DISPLAY_ROUNDING) * COLONES_DISPLAY_ROUNDING;
}

/**
 * A USD amount rendered in colones — "₡378.900".
 *
 * Decimals are dropped outright: a hundred-colón rounding step makes céntimos
 * meaningless, and nothing in Costa Rica is priced in them anyway.
 */
export function formatColones(
  amountUsdCents: number,
  colonesPerDollar: number,
  language: BookingLocale
): string {
  return formatColonesAmount(convertUsdCentsToColones(amountUsdCents, colonesPerDollar), language, 0);
}

/** The rate itself — "₡512,35" — for the line explaining where the estimate came from. */
export function formatExchangeRate(colonesPerDollar: number, language: BookingLocale): string {
  return formatColonesAmount(colonesPerDollar, language, 2);
}

function formatColonesAmount(colones: number, language: BookingLocale, fractionDigits: number): string {
  const locale = language === 'es' ? 'es-CR' : 'en-US';
  const base: Intl.NumberFormatOptions = {
    style: 'currency',
    currency: 'CRC',
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  };

  try {
    return new Intl.NumberFormat(locale, { ...base, currencyDisplay: 'narrowSymbol' }).format(colones);
  } catch {
    return new Intl.NumberFormat(locale, base).format(colones);
  }
}
