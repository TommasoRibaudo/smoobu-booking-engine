import React, { useState, useMemo, useRef, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, Form, Spinner } from 'react-bootstrap';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faCalendarDays, faUser, faMagnifyingGlass } from '@fortawesome/free-solid-svg-icons';
import CalendarWithPriceDots from '../CalendarWithPriceDots';
import { MAX_PORTFOLIO_GUESTS } from '../../utils/constants';
import { getCostaRicaToday, nightsBetween } from '../../utils/dates';
import './BookingSearchWidget.style.scss';

interface BookingSearchWidgetProps {
  /** Whether the current page is Spanish */
  isSpanish: boolean;
  /** Optional: pre-select a number of guests (e.g. from property guestNumber) */
  defaultGuests?: number;
  /** Variant: 'sidebar' for listing pages, 'hero' for homepages */
  variant?: 'sidebar' | 'hero';
  /**
   * Property whose nightly rates colour the calendar dots. Listing pages pass
   * their own slug; the homepage hero leaves it unset because the search covers
   * the whole portfolio and there is no single home to price.
   */
  apartmentSlug?: string;
}

const strings = {
  en: {
    title: 'Check Availability',
    subtitle: 'Book directly for the best price, guaranteed',
    dates: 'Dates',
    guests: 'Guests',
    search: 'Search Availability',
    searching: 'Searching…',
    decreaseGuests: 'Decrease guests',
    increaseGuests: 'Increase guests',
    maxGuests: 'Our largest home sleeps {max}. Message us for bigger groups.',
    arrivalRequired: 'Please select a check-in date.',
    departureRequired: 'Please select a check-out date.',
    departureTooEarly: 'Check-out must be after check-in.',
    selectDates: 'Select your dates',
    selectCheckOut: 'select check-out',
    nights: (count: number) => `${count} ${count === 1 ? 'night' : 'nights'}`,
  },
  es: {
    title: 'Ver Disponibilidad',
    subtitle: 'Reserva directo y te garantizamos el mejor precio',
    dates: 'Fechas',
    guests: 'Huéspedes',
    search: 'Buscar Disponibilidad',
    searching: 'Buscando…',
    decreaseGuests: 'Menos huéspedes',
    increaseGuests: 'Más huéspedes',
    maxGuests: 'Nuestra casa más grande aloja a {max}. Escríbenos para grupos mayores.',
    arrivalRequired: 'Selecciona una fecha de llegada.',
    departureRequired: 'Selecciona una fecha de salida.',
    departureTooEarly: 'La salida debe ser después de la llegada.',
    selectDates: 'Elige tus fechas',
    selectCheckOut: 'elige la salida',
    nights: (count: number) => `${count} ${count === 1 ? 'noche' : 'noches'}`,
  },
};

const BookingSearchWidget: React.FC<BookingSearchWidgetProps> = ({
  isSpanish,
  defaultGuests = 2,
  variant = 'sidebar',
  apartmentSlug,
}) => {
  const navigate = useNavigate();
  const lang = isSpanish ? 'es' : 'en';
  const s = strings[lang];
  const today = useMemo(() => getCostaRicaToday(), []);

  const [arrivalDate, setArrivalDate] = useState('');
  const [departureDate, setDepartureDate] = useState('');
  const [guests, setGuests] = useState(() =>
    Math.min(Math.max(1, defaultGuests), MAX_PORTFOLIO_GUESTS)
  );
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [isSubmitting, setIsSubmitting] = useState(false);
  // The hero sits on a busy homepage, so its calendar hides behind a trigger.
  // The listing sidebar has the room to keep it open permanently.
  const [isCalendarOpen, setIsCalendarOpen] = useState(false);
  const datesFieldRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (variant !== 'hero' || !isCalendarOpen) {
      return;
    }

    const handlePointerDown = (event: MouseEvent | TouchEvent) => {
      if (!datesFieldRef.current?.contains(event.target as Node)) {
        setIsCalendarOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsCalendarOpen(false);
      }
    };

    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('touchstart', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('touchstart', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [variant, isCalendarOpen]);

  /**
   * One tap picks check-in, the next picks check-out. Tapping a night on or
   * before the current check-in restarts the range rather than producing an
   * inverted one, which is what guests expect from a two-tap picker.
   */
  const handleCalendarSelect = (date: string) => {
    setFieldErrors({});

    if (!arrivalDate || departureDate || date <= arrivalDate) {
      setArrivalDate(date);
      setDepartureDate('');
      return;
    }

    setDepartureDate(date);
    if (variant === 'hero') {
      setIsCalendarOpen(false);
    }
  };

  const clearDates = () => {
    setArrivalDate('');
    setDepartureDate('');
    setFieldErrors({});
  };

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    const errors: Record<string, string> = {};

    if (!arrivalDate) errors.arrivalDate = s.arrivalRequired;
    else if (!departureDate) errors.departureDate = s.departureRequired;
    else if (departureDate <= arrivalDate) errors.departureDate = s.departureTooEarly;

    if (Object.keys(errors).length > 0) {
      setFieldErrors(errors);
      if (variant === 'hero') {
        setIsCalendarOpen(true);
      }
      return;
    }

    setIsSubmitting(true);

    const bookPath = isSpanish ? '/bookES' : '/book';
    const params = new URLSearchParams({
      arrivalDate,
      departureDate,
      guests: String(guests),
      autoSearch: 'true',
      // The search itself runs on /book, so without this every search looks
      // like it started there and the funnel cannot tell which entry point —
      // homepage hero or listing sidebar — actually drives bookings.
      src: variant === 'hero' ? 'widget_hero' : 'widget_sidebar',
    });
    // Promotes this home to the top of the results. The search still returns the
    // whole portfolio — see the results page for how the two are laid out.
    if (apartmentSlug) {
      params.set('property', apartmentSlug);
    }

    try {
      navigate(`${bookPath}?${params.toString()}`);
    } catch {
      // Navigation blocked — release the button instead of spinning forever.
      setIsSubmitting(false);
    }
  };

  const rangeSummary = (() => {
    if (!arrivalDate) {
      return s.selectDates;
    }
    if (!departureDate) {
      return `${formatShortDate(arrivalDate, lang)} → ${s.selectCheckOut}`;
    }
    return `${formatShortDate(arrivalDate, lang)} → ${formatShortDate(departureDate, lang)} · ${s.nights(
      nightsBetween(arrivalDate, departureDate)
    )}`;
  })();

  const dateError = fieldErrors.arrivalDate || fieldErrors.departureDate;

  const calendar = (
    <CalendarWithPriceDots
      apartmentSlug={apartmentSlug}
      language={lang}
      minDate={today}
      selectionStart={arrivalDate || null}
      selectionEnd={departureDate || null}
      onSelectDate={handleCalendarSelect}
      onClearSelection={clearDates}
      showHeading={false}
    />
  );

  return (
    <div className={`booking-search-widget booking-search-widget--${variant}`}>
      {/* The hero already carries the headline, so the widget stays a bare
          search bar there. Listing sidebars still need the label. */}
      {variant !== 'hero' && (
        <div className="booking-search-widget__header">
          <FontAwesomeIcon icon={faCalendarDays} className="booking-search-widget__icon" />
          <div>
            <h2 className="booking-search-widget__title">{s.title}</h2>
            <p className="booking-search-widget__subtitle">{s.subtitle}</p>
          </div>
        </div>
      )}

      <Form className="booking-search-widget__form" onSubmit={handleSubmit} noValidate aria-label={s.title}>
        <div className="booking-search-widget__field booking-search-widget__dates" ref={datesFieldRef}>
          <span className="booking-search-widget__label">{s.dates}</span>

          {variant === 'hero' ? (
            <>
              <button
                type="button"
                className={`booking-search-widget__dates-trigger${
                  dateError ? ' booking-search-widget__dates-trigger--invalid' : ''
                }`}
                onClick={() => setIsCalendarOpen((open) => !open)}
                aria-expanded={isCalendarOpen}
                aria-haspopup="dialog"
              >
                <FontAwesomeIcon icon={faCalendarDays} />
                <span>{rangeSummary}</span>
              </button>
              {isCalendarOpen && (
                <div className="booking-search-widget__calendar-popover" role="dialog" aria-label={s.dates}>
                  {calendar}
                </div>
              )}
            </>
          ) : (
            <div className="booking-search-widget__calendar">{calendar}</div>
          )}

          {/* The hero shows the range on its trigger, so it does not repeat it.
              Clearing lives in the calendar itself, where both variants get it. */}
          {variant !== 'hero' && (
            <p className="booking-search-widget__range" aria-live="polite">
              {rangeSummary}
            </p>
          )}

          {dateError && (
            <p className="booking-search-widget__error" aria-live="polite">
              {dateError}
            </p>
          )}
        </div>

        <Form.Group controlId={`bsw-guests-${variant}`} className="booking-search-widget__field booking-search-widget__field--guests">
          <Form.Label>{s.guests}</Form.Label>
          <div className="booking-search-widget__guest-control">
            <Button
              type="button"
              variant="outline-secondary"
              size="sm"
              aria-label={s.decreaseGuests}
              onClick={() => setGuests((g) => Math.max(1, g - 1))}
              disabled={guests <= 1}
            >
              −
            </Button>
            <span className="booking-search-widget__guest-count">
              <FontAwesomeIcon icon={faUser} /> {guests}
            </span>
            <Button
              type="button"
              variant="outline-secondary"
              size="sm"
              aria-label={s.increaseGuests}
              onClick={() => setGuests((g) => Math.min(MAX_PORTFOLIO_GUESTS, g + 1))}
              disabled={guests >= MAX_PORTFOLIO_GUESTS}
            >
              +
            </Button>
          </div>
        </Form.Group>

        <Button
          className="booking-search-widget__submit"
          type="submit"
          disabled={isSubmitting}
        >
          {isSubmitting ? (
            <><Spinner animation="border" size="sm" /> {s.searching}</>
          ) : (
            <><FontAwesomeIcon icon={faMagnifyingGlass} /> {s.search}</>
          )}
        </Button>

        {/* Full-width row so it never disturbs the alignment of the fields above. */}
        {guests >= MAX_PORTFOLIO_GUESTS && (
          <p className="booking-search-widget__hint" aria-live="polite">
            {s.maxGuests.replace('{max}', String(MAX_PORTFOLIO_GUESTS))}
          </p>
        )}
      </Form>
    </div>
  );
};

function formatShortDate(date: string, language: 'en' | 'es'): string {
  return new Intl.DateTimeFormat(language === 'es' ? 'es-CR' : 'en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${date}T00:00:00Z`));
}

export default BookingSearchWidget;
