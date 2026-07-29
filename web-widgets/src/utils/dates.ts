/**
 * Date helpers shared by the booking engine.
 *
 * Every value is a `YYYY-MM-DD` string anchored to Costa Rica (UTC-6, no DST),
 * so the search widget, the calendar and the booking wizard can never disagree
 * about what "today" is. Arithmetic runs in UTC on purpose: parsing a date in
 * the visitor's local zone shifts the result by a day for anyone east of
 * UTC+12, which silently broke the check-out minimum for those guests.
 */

export function getCostaRicaToday(): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Costa_Rica',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const byType = parts.reduce<Record<string, string>>((accumulator, part) => {
    accumulator[part.type] = part.value;
    return accumulator;
  }, {});
  return `${byType.year}-${byType.month}-${byType.day}`;
}

export function addDays(dateString: string, days: number): string {
  const date = new Date(`${dateString}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** Nights between two `YYYY-MM-DD` dates; 0 when the range is empty or inverted. */
export function nightsBetween(startDate: string, endDate: string): number {
  const startMs = Date.parse(`${startDate}T00:00:00Z`);
  const endMs = Date.parse(`${endDate}T00:00:00Z`);

  if (Number.isNaN(startMs) || Number.isNaN(endMs)) {
    return 0;
  }

  return Math.max(0, Math.round((endMs - startMs) / 86_400_000));
}
