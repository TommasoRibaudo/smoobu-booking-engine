import React from 'react';
import * as PostHog from '../../services/PostHog.service';
import {
  BookingLanguage,
  CalendarDay,
  CalendarDot,
  CalendarMonthResponse,
} from '../../services/BookingApi.service';
import { CookieConsentService } from '../../services/CookieConsent.service';
import { useCalendarMonth } from '../../hooks/useCalendarMonth';
import { addDays, getCostaRicaToday } from '../../utils/dates';
import { formatBookingMoney } from '../../utils/money';
import './CalendarWithPriceDots.style.scss';

interface CalendarWithPriceDotsProps {
  /**
   * Property whose nightly rates drive the dots and the availability rules.
   * Omitted on the homepage hero, which is not scoped to a single home — the
   * grid then renders as a plain date picker with no dots and no network call.
   */
  apartmentSlug?: string;
  language: BookingLanguage;
  /** Earliest selectable night. Defaults to today in Costa Rica. */
  minDate?: string;
  /** Currently picked check-in / check-out, for range highlighting. */
  selectionStart?: string | null;
  selectionEnd?: string | null;
  onSelectDate?: (date: string, day: CalendarDay | undefined, dot: CalendarDot) => void;
  /** Wires up the "Clear dates" control. Omitted, the control is not rendered. */
  onClearSelection?: () => void;
  /** The search widget supplies its own heading, so it opts out of this one. */
  showHeading?: boolean;
}

type CalendarAnalyticsEvent =
  | 'calendar_month_loaded'
  | 'calendar_month_changed'
  | 'calendar_date_selected';

const dotColors: CalendarDot[] = ['green', 'yellow', 'red', 'grey'];
const lowPriceThreshold = 0.85;
const highPriceThreshold = 1.15;
const maxLookaheadDays = 400;

const calendarStrings = {
  en: {
    title: 'Nightly prices',
    subtitle: 'Dots compare each available night with this month.',
    previousMonth: 'Previous month',
    nextMonth: 'Next month',
    loading: 'Loading prices',
    unavailable: 'Unavailable',
    past: 'No longer available',
    notCheckOut: 'Not available as a check-out date',
    noPrice: 'Price not available',
    lowPrice: 'low price',
    averagePrice: 'average price',
    highPrice: 'high price',
    minStay: (nights: number) => `${nights}-night minimum`,
    legendLow: 'Low',
    legendAverage: 'Average',
    legendHigh: 'High',
    legendUnavailable: 'Unavailable',
    unableToLoad: 'Calendar prices are temporarily unavailable.',
    pickCheckOut: 'Now pick your check-out date, or tap an earlier date to start over.',
    clearDates: 'Clear dates',
  },
  es: {
    title: 'Precios por noche',
    subtitle: 'Los puntos comparan cada noche disponible con este mes.',
    previousMonth: 'Mes anterior',
    nextMonth: 'Mes siguiente',
    loading: 'Cargando precios',
    unavailable: 'No disponible',
    past: 'Ya no disponible',
    notCheckOut: 'No disponible como fecha de salida',
    noPrice: 'Precio no disponible',
    lowPrice: 'precio bajo',
    averagePrice: 'precio promedio',
    highPrice: 'precio alto',
    minStay: (nights: number) => `Mínimo ${nights} ${nights === 1 ? 'noche' : 'noches'}`,
    legendLow: 'Bajo',
    legendAverage: 'Promedio',
    legendHigh: 'Alto',
    legendUnavailable: 'No disponible',
    unableToLoad: 'Los precios del calendario no están disponibles temporalmente.',
    pickCheckOut: 'Ahora elige tu fecha de salida, o toca una fecha anterior para empezar de nuevo.',
    clearDates: 'Borrar fechas',
  },
};

const CalendarWithPriceDots: React.FC<CalendarWithPriceDotsProps> = ({
  apartmentSlug,
  language,
  minDate,
  selectionStart = null,
  selectionEnd = null,
  onSelectDate,
  onClearSelection,
  showHeading = true,
}) => {
  const strings = calendarStrings[language];
  const today = React.useMemo(() => getCostaRicaToday(), []);
  const earliestDate = minDate ?? today;
  const earliestMonth = earliestDate.slice(0, 7);
  const [visibleMonth, setVisibleMonth] = React.useState(earliestMonth);

  // Once a check-in exists we are choosing a check-out, and the run of nights
  // that must all be free can cross a month boundary — so the check-in's month
  // and the one after it are loaded alongside whatever month is on screen.
  const isPickingCheckOut = Boolean(selectionStart) && !selectionEnd;
  const anchorMonth = selectionStart ? selectionStart.slice(0, 7) : visibleMonth;
  const visible = useCalendarMonth(apartmentSlug, visibleMonth, language);
  const anchor = useCalendarMonth(apartmentSlug, anchorMonth, language);
  const anchorNext = useCalendarMonth(apartmentSlug, addMonths(anchorMonth, 1), language, isPickingCheckOut);
  const data = visible.data;

  const nightsByDate = React.useMemo(() => {
    const nights = new Map<string, CalendarDay>();
    for (const source of [visible.data, anchor.data, anchorNext.data]) {
      for (const day of source?.days ?? []) {
        nights.set(day.date, day);
      }
    }
    return nights;
  }, [visible.data, anchor.data, anchorNext.data]);

  // Fire the analytics event once per month payload, not once per render.
  const reportedMonthsRef = React.useRef<Set<string>>(new Set());
  React.useEffect(() => {
    if (!data || !apartmentSlug) {
      return;
    }

    const reportKey = `${apartmentSlug}:${language}:${data.month}`;
    if (reportedMonthsRef.current.has(reportKey)) {
      return;
    }

    reportedMonthsRef.current.add(reportKey);
    captureCalendarEvent('calendar_month_loaded', {
      apartment_slug: apartmentSlug,
      month: data.month,
      available_count: data.stats.availableNightCount,
      avg_price: data.stats.averagePriceCents,
      source: data.cache?.status || 'api',
    });
  }, [data, apartmentSlug, language]);

  const goToMonth = (offset: number) => {
    setVisibleMonth((month) => {
      const nextMonth = addMonths(month, offset);
      captureCalendarEvent('calendar_month_changed', {
        apartment_slug: apartmentSlug,
        from_month: month,
        to_month: nextMonth,
      });
      return nextMonth;
    });
  };

  const handleDateSelect = (date: string, day: CalendarDay | undefined, dotColor: CalendarDot) => {
    captureCalendarEvent('calendar_date_selected', {
      apartment_slug: apartmentSlug,
      date,
      price: day?.priceCents ?? null,
      dot_color: dotColor,
      available: day?.available === true,
    });
    onSelectDate?.(date, day, dotColor);
  };

  // The last date a guest may check out on: the first booked night after
  // check-in is still a legal departure day, because that night is not slept.
  const checkOutLimit = React.useMemo(
    () => (isPickingCheckOut && selectionStart ? findCheckOutLimit(selectionStart, nightsByDate) : null),
    [isPickingCheckOut, selectionStart, nightsByDate]
  );
  const earliestCheckOut = React.useMemo(() => {
    if (!isPickingCheckOut || !selectionStart) {
      return null;
    }
    const minStay = nightsByDate.get(selectionStart)?.minStay;
    return addDays(selectionStart, minStay && minStay > 0 ? minStay : 1);
  }, [isPickingCheckOut, selectionStart, nightsByDate]);

  const isSelectable = (date: string): boolean => {
    if (date < earliestDate) {
      return false;
    }

    // Only the nights *after* the check-in are judged against the stay rules.
    // A tap on or before the check-in is not a broken check-out — it is a guest
    // fixing a misclicked arrival, so it falls through to the check-in rules
    // below and the parent restarts the range from there.
    if (isPickingCheckOut && selectionStart && date > selectionStart) {
      if (earliestCheckOut && date < earliestCheckOut) return false;
      if (checkOutLimit && date > checkOutLimit) return false;
      return true;
    }

    // Picking a check-in: the night itself has to be free. Nights we have not
    // loaded yet stay open — the server revalidates the range on search.
    const night = nightsByDate.get(date);
    return !night || night.available;
  };

  const canGoPrevious = visibleMonth > earliestMonth;
  const calendarDays = getCalendarDays(visibleMonth);

  return (
    <section
      className="calendar-with-price-dots"
      aria-labelledby={showHeading ? `calendar-title-${apartmentSlug ?? 'portfolio'}` : undefined}
      aria-label={showHeading ? undefined : strings.title}
    >
      <div className="calendar-with-price-dots__header">
        {showHeading && (
          <div>
            <h2 id={`calendar-title-${apartmentSlug ?? 'portfolio'}`}>{strings.title}</h2>
            <p>{strings.subtitle}</p>
          </div>
        )}
        <div className="calendar-with-price-dots__nav">
          <button
            type="button"
            onClick={() => goToMonth(-1)}
            disabled={!canGoPrevious}
            aria-label={strings.previousMonth}
          >
            {'‹'}
          </button>
          <span>{formatMonthLabel(visibleMonth, language)}</span>
          <button type="button" onClick={() => goToMonth(1)} aria-label={strings.nextMonth}>
            {'›'}
          </button>
        </div>
      </div>

      <div className="calendar-with-price-dots__weekdays" aria-hidden="true">
        {getWeekdayLabels(language).map((weekday, index) => (
          <span key={`${weekday}-${index}`}>{weekday}</span>
        ))}
      </div>

      <div className="calendar-with-price-dots__grid">
        {calendarDays.map((calendarDay, index) => {
          if (!calendarDay) {
            return (
              <span
                className="calendar-date-cell calendar-date-cell--empty"
                aria-hidden="true"
                key={`empty-${visibleMonth}-${index}`}
              />
            );
          }

          const dayData = nightsByDate.get(calendarDay.date);
          const dotColor = getDotColor(dayData, data);
          const isPast = calendarDay.date < earliestDate;
          const selectable = isSelectable(calendarDay.date);
          // Earlier dates are now restart taps, so they keep their ordinary
          // price label instead of being announced as bad check-outs.
          const blockedAsCheckOut =
            isPickingCheckOut &&
            !selectable &&
            !isPast &&
            Boolean(selectionStart) &&
            calendarDay.date > (selectionStart as string);
          const dateLabel = getDateAriaLabel({
            date: calendarDay.date,
            day: dayData,
            dotColor,
            currency: data?.currency ?? 'USD',
            language,
            isPast,
            hasRates: Boolean(apartmentSlug),
            blockedAsCheckOut,
          });
          const isStart = Boolean(selectionStart) && calendarDay.date === selectionStart;
          const isEnd = Boolean(selectionEnd) && calendarDay.date === selectionEnd;
          const isInRange =
            Boolean(selectionStart && selectionEnd) &&
            calendarDay.date > (selectionStart as string) &&
            calendarDay.date < (selectionEnd as string);

          return (
            <button
              className={[
                'calendar-date-cell',
                // The picked dates are never struck through, even though the
                // check-in is not a legal check-out for itself.
                selectable || isStart || isEnd ? '' : 'calendar-date-cell--blocked',
                isPast ? 'calendar-date-cell--past' : '',
                isStart ? 'calendar-date-cell--range-start' : '',
                isEnd ? 'calendar-date-cell--range-end' : '',
                isInRange ? 'calendar-date-cell--in-range' : '',
              ]
                .filter(Boolean)
                .join(' ')}
              key={calendarDay.date}
              type="button"
              disabled={!selectable && !isStart}
              aria-pressed={isStart || isEnd || undefined}
              onClick={() => handleDateSelect(calendarDay.date, dayData, dotColor)}
              aria-label={dateLabel}
            >
              <span className="calendar-date-cell__number">{calendarDay.day}</span>
              {/* No property, no rates — a grey dot would imply "unavailable". */}
              {apartmentSlug && (
                <span className={`price-dot price-dot--${dotColor}`} role="img" aria-label={dateLabel} />
              )}
            </button>
          );
        })}
      </div>

      {isPickingCheckOut && (
        <p className="calendar-with-price-dots__status" aria-live="polite">
          {strings.pickCheckOut}
        </p>
      )}
      {visible.isLoading && (
        <p className="calendar-with-price-dots__status" aria-live="polite">
          {strings.loading}
        </p>
      )}
      {visible.hasError && (
        <p className="calendar-with-price-dots__status calendar-with-price-dots__status--error" aria-live="polite">
          {strings.unableToLoad}
        </p>
      )}

      {/* Lives inside the calendar rather than beside it: the hero popover has
          no other way out of a half-finished range. */}
      {onClearSelection && selectionStart && (
        <div className="calendar-with-price-dots__actions">
          <button type="button" className="calendar-with-price-dots__clear" onClick={onClearSelection}>
            {strings.clearDates}
          </button>
        </div>
      )}

      {apartmentSlug && (
        <ul className="calendar-with-price-dots__legend" aria-label={strings.title}>
          <li>
            <span className="price-dot price-dot--green" aria-hidden="true" /> {strings.legendLow}
          </li>
          <li>
            <span className="price-dot price-dot--yellow" aria-hidden="true" /> {strings.legendAverage}
          </li>
          <li>
            <span className="price-dot price-dot--red" aria-hidden="true" /> {strings.legendHigh}
          </li>
          <li>
            <span className="price-dot price-dot--grey" aria-hidden="true" /> {strings.legendUnavailable}
          </li>
        </ul>
      )}
    </section>
  );
};

/**
 * Walks forward from check-in and returns the first booked night, which is the
 * last date a guest may depart on. Returns null once it runs past the nights we
 * have loaded — an unknown night is not evidence of a block, and the server
 * validates the range on search anyway.
 */
function findCheckOutLimit(checkIn: string, nights: Map<string, CalendarDay>): string | null {
  let cursor = checkIn;

  for (let step = 0; step < maxLookaheadDays; step += 1) {
    cursor = addDays(cursor, 1);
    const night = nights.get(cursor);

    if (!night) {
      return null;
    }

    if (!night.available) {
      return cursor;
    }
  }

  return null;
}

function captureCalendarEvent(eventName: CalendarAnalyticsEvent, properties: Record<string, unknown>): void {
  if (!CookieConsentService.hasConsent('analytics')) {
    return;
  }

  PostHog.capture(eventName, properties);

  if (typeof window !== 'undefined' && typeof window.gtag === 'function') {
    window.gtag('event', eventName, {
      event_category: 'calendar',
      ...properties,
    });
  }
}

function getDotColor(day: CalendarDay | undefined, monthData: CalendarMonthResponse | undefined): CalendarDot {
  if (!day || !day.available || typeof day.priceCents !== 'number') {
    return 'grey';
  }

  if (day.dot && dotColors.includes(day.dot)) {
    return day.dot;
  }

  const averagePrice = monthData?.stats.averagePriceCents;

  if (!averagePrice || averagePrice <= 0) {
    return 'yellow';
  }

  if (day.priceCents <= averagePrice * lowPriceThreshold) {
    return 'green';
  }

  if (day.priceCents > averagePrice * highPriceThreshold) {
    return 'red';
  }

  return 'yellow';
}

function getDateAriaLabel({
  date,
  day,
  dotColor,
  currency,
  language,
  isPast,
  hasRates,
  blockedAsCheckOut,
}: {
  date: string;
  day: CalendarDay | undefined;
  dotColor: CalendarDot;
  currency: string;
  language: BookingLanguage;
  isPast: boolean;
  hasRates: boolean;
  blockedAsCheckOut: boolean;
}): string {
  const strings = calendarStrings[language];
  const formattedDate = formatDateLabel(date, language);

  if (isPast) {
    return `${formattedDate}, ${strings.past}`;
  }

  if (blockedAsCheckOut) {
    return `${formattedDate}, ${strings.notCheckOut}`;
  }

  // Without a property there are no rates to check, so the date makes no claim
  // about availability — the portfolio search does that after submission.
  if (!hasRates) {
    return formattedDate;
  }

  if (!day || !day.available) {
    return `${formattedDate}, ${strings.unavailable}`;
  }

  const priceText =
    typeof day.priceCents === 'number'
      ? formatBookingMoney(day.priceCents, currency, language)
      : strings.noPrice;
  const tierText = getTierText(dotColor, language);
  const minStayText = day.minStay ? `, ${strings.minStay(day.minStay)}` : '';

  return `${formattedDate}, ${priceText}, ${tierText}${minStayText}`;
}

function getTierText(dotColor: CalendarDot, language: BookingLanguage): string {
  const strings = calendarStrings[language];

  if (dotColor === 'green') {
    return strings.lowPrice;
  }

  if (dotColor === 'red') {
    return strings.highPrice;
  }

  if (dotColor === 'grey') {
    return strings.unavailable;
  }

  return strings.averagePrice;
}

function getCalendarDays(month: string): Array<{ date: string; day: number } | null> {
  const [year, monthIndex] = month.split('-').map(Number);
  const firstDate = new Date(Date.UTC(year, monthIndex - 1, 1));
  const daysInMonth = new Date(Date.UTC(year, monthIndex, 0)).getUTCDate();
  const leadingEmptyCells = firstDate.getUTCDay();
  const days: Array<{ date: string; day: number } | null> = Array.from({ length: leadingEmptyCells }, () => null);

  for (let day = 1; day <= daysInMonth; day += 1) {
    days.push({
      date: `${month}-${String(day).padStart(2, '0')}`,
      day,
    });
  }

  return days;
}

function getWeekdayLabels(language: BookingLanguage): string[] {
  const formatter = new Intl.DateTimeFormat(language === 'es' ? 'es-CR' : 'en-US', {
    weekday: 'short',
    timeZone: 'UTC',
  });

  return Array.from({ length: 7 }, (_, index) => {
    const date = new Date(Date.UTC(2026, 1, 1 + index));
    // Two letters: the sidebar column is far too narrow for "WED"/"MIÉ", which
    // ran the headings into one another.
    return formatter.format(date).replace('.', '').slice(0, 2);
  });
}

function addMonths(month: string, months: number): string {
  const [year, monthIndex] = month.split('-').map(Number);
  const date = new Date(Date.UTC(year, monthIndex - 1 + months, 1));
  return date.toISOString().slice(0, 7);
}

function formatMonthLabel(month: string, language: BookingLanguage): string {
  const [year, monthIndex] = month.split('-').map(Number);
  const label = new Intl.DateTimeFormat(language === 'es' ? 'es-CR' : 'en-US', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(year, monthIndex - 1, 1)));

  // Spanish renders "julio de 2026"; CSS `capitalize` would title-case the
  // preposition too ("Julio De 2026"), so only the first letter is raised here.
  return label.charAt(0).toUpperCase() + label.slice(1);
}

function formatDateLabel(date: string, language: BookingLanguage): string {
  return new Intl.DateTimeFormat(language === 'es' ? 'es-CR' : 'en-US', {
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${date}T00:00:00Z`));
}

export default CalendarWithPriceDots;
