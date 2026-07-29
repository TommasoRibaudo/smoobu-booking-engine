/**
 * Process-wide cache for `GET /api/calendar/:slug`.
 *
 * The price line on a listing card and the date picker inside the search widget
 * both want the same month for the same property. Without a shared cache each
 * one fetches independently, so every listing page fired two identical requests
 * and double-counted the `calendar_month_loaded` analytics event. Requests are
 * deduplicated here by (slug, language, month) — both in flight and resolved —
 * so the components stay independent while the network sees a single call.
 */

import { BookingLanguage, CalendarMonthResponse, getCalendarMonth } from './BookingApi.service';

const resolvedMonths = new Map<string, CalendarMonthResponse>();
const inFlightMonths = new Map<string, Promise<CalendarMonthResponse>>();

export function calendarMonthKey(apartmentSlug: string, language: BookingLanguage, month: string): string {
  return `${apartmentSlug}:${language}:${month}`;
}

/** Synchronous read of an already-resolved month; `undefined` if not loaded yet. */
export function peekCalendarMonth(key: string): CalendarMonthResponse | undefined {
  return resolvedMonths.get(key);
}

export function loadCalendarMonth(
  apartmentSlug: string,
  month: string,
  language: BookingLanguage
): Promise<CalendarMonthResponse> {
  const key = calendarMonthKey(apartmentSlug, language, month);
  const resolved = resolvedMonths.get(key);

  if (resolved) {
    return Promise.resolve(resolved);
  }

  const inFlight = inFlightMonths.get(key);

  if (inFlight) {
    return inFlight;
  }

  const request = getCalendarMonth(apartmentSlug, month, language)
    .then((response) => {
      // Key off the month the server echoed back, not the one we asked for, so a
      // corrected/clamped month lands under the key the caller will look up.
      resolvedMonths.set(calendarMonthKey(apartmentSlug, language, response.month || month), response);
      return response;
    })
    .finally(() => {
      inFlightMonths.delete(key);
    });

  inFlightMonths.set(key, request);
  return request;
}

/** Test seam — clears both resolved and in-flight entries. */
export function resetCalendarMonthCache(): void {
  resolvedMonths.clear();
  inFlightMonths.clear();
}
