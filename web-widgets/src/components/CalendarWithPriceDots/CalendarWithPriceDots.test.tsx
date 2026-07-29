import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import * as PostHogService from '../../services/PostHog.service';
import { CookieConsentService } from '../../services/CookieConsent.service';
import { resetCalendarMonthCache } from '../../services/calendarMonthCache';
import CalendarWithPriceDots from './CalendarWithPriceDots.component';

// posthog-js is loaded lazily behind PostHog.service, so the component's
// captures reach the wrapper, never the library. Mock the wrapper.
jest.mock('../../services/PostHog.service', () => ({
  __esModule: true,
  capture: jest.fn(),
  loadPostHog: jest.fn(() => Promise.resolve(null)),
  initPostHogIfConsented: jest.fn(),
  optIn: jest.fn(),
  optOut: jest.fn(),
}));

const posthog = { capture: PostHogService.capture as jest.Mock };

const juneResponse = {
  property: {
    propertyId: 'property-sunsetvilla',
    slug: 'SunsetVilla',
    name: 'Sunset Villa',
  },
  month: '2026-06',
  currency: 'USD',
  days: [
    {
      date: '2026-06-01',
      available: true,
      priceCents: 9000,
      minStay: 2,
      dot: 'green',
      ariaLabelKey: 'calendar.priceLow',
    },
    {
      date: '2026-06-02',
      available: true,
      priceCents: 10000,
      minStay: 2,
      dot: 'yellow',
      ariaLabelKey: 'calendar.priceAverage',
    },
    {
      date: '2026-06-03',
      available: true,
      priceCents: 12500,
      minStay: 3,
      dot: 'red',
      ariaLabelKey: 'calendar.priceHigh',
    },
    {
      date: '2026-06-04',
      available: false,
      priceCents: null,
      minStay: null,
      dot: 'grey',
      ariaLabelKey: 'calendar.unavailable',
    },
  ],
  stats: {
    availableNightCount: 3,
    minPriceCents: 9000,
    maxPriceCents: 12500,
    averagePriceCents: 10500,
  },
  cache: {
    status: 'hit',
    ttlSeconds: 300,
    generatedAt: '2026-06-01T00:00:00Z',
  },
};

const julyResponse = {
  ...juneResponse,
  month: '2026-07',
  days: [
    {
      date: '2026-07-01',
      available: true,
      priceCents: 15000,
      minStay: 2,
      dot: 'yellow',
      ariaLabelKey: 'calendar.priceAverage',
    },
  ],
  stats: {
    availableNightCount: 1,
    minPriceCents: 15000,
    maxPriceCents: 15000,
    averagePriceCents: 15000,
  },
  cache: {
    status: 'miss',
    ttlSeconds: 300,
    generatedAt: '2026-07-01T00:00:00Z',
  },
};

const fallbackShapeResponse = {
  apartment: 'SunsetVilla',
  month: '2026-06',
  dates: {
    '2026-06-01': { available: true, price: 80, minStay: 2 },
    '2026-06-02': { available: true, price: 100, minStay: 2 },
    '2026-06-03': { available: true, price: 120, minStay: 2 },
    '2026-06-04': { available: false, price: null, minStay: null },
  },
  stats: {
    avg: 100,
    min: 80,
    max: 120,
  },
};

describe('CalendarWithPriceDots', () => {
  beforeEach(() => {
    // Pinned to the 1st so the fixture's June 1–4 nights are all still bookable;
    // the component now greys out anything before today in Costa Rica.
    jest.useFakeTimers().setSystemTime(new Date('2026-06-01T12:00:00Z'));
    localStorage.clear();
    resetCalendarMonthCache();
    (posthog.capture as jest.Mock).mockClear();
    (window as any).gtag = jest.fn();
  });

  afterEach(() => {
    jest.useRealTimers();
    resetCalendarMonthCache();
    delete (window as any).gtag;
    jest.restoreAllMocks();
  });

  test('fetches the visible month on mount and renders accessible price dots', async () => {
    mockFetchByMonth();

    render(<CalendarWithPriceDots apartmentSlug="SunsetVilla" language="en" />);

    await screen.findByRole('img', { name: /June 1, \$90\.00, low price, 2-night minimum/ });

    expect(global.fetch).toHaveBeenCalledWith(
      '/api/calendar/SunsetVilla?month=2026-06&language=en',
      expect.objectContaining({
        headers: expect.objectContaining({
          'Accept-Language': 'en',
        }),
      })
    );
    expect(screen.getByRole('img', { name: /June 1,/ })).toHaveClass('price-dot--green');
    expect(screen.getByRole('img', { name: /June 2,/ })).toHaveClass('price-dot--yellow');
    expect(screen.getByRole('img', { name: /June 3,/ })).toHaveClass('price-dot--red');
    expect(screen.getByRole('img', { name: /June 4, Unavailable/ })).toHaveClass('price-dot--grey');
  });

  test('lazy-loads a new month on navigation without refetching cached months', async () => {
    mockFetchByMonth();

    render(<CalendarWithPriceDots apartmentSlug="SunsetVilla" language="en" />);
    await screen.findByRole('img', { name: /June 1,/ });

    fireEvent.click(screen.getByRole('button', { name: 'Next month' }));
    await screen.findByRole('img', { name: /July 1, \$150\.00, average price/ });

    fireEvent.click(screen.getByRole('button', { name: 'Previous month' }));
    await screen.findByRole('img', { name: /June 1,/ });

    const fetchedUrls = (global.fetch as jest.Mock).mock.calls.map(([url]) => url);
    expect(fetchedUrls).toEqual([
      '/api/calendar/SunsetVilla?month=2026-06&language=en',
      '/api/calendar/SunsetVilla?month=2026-07&language=en',
    ]);
  });

  test('computes fallback dot colors from month average when backend dot values are omitted', async () => {
    mockFetch(fallbackShapeResponse);

    render(<CalendarWithPriceDots apartmentSlug="SunsetVilla" language="en" />);

    await screen.findByRole('img', { name: /June 1, \$80\.00, low price/ });

    expect(screen.getByRole('img', { name: /June 1,/ })).toHaveClass('price-dot--green');
    expect(screen.getByRole('img', { name: /June 2,/ })).toHaveClass('price-dot--yellow');
    expect(screen.getByRole('img', { name: /June 3,/ })).toHaveClass('price-dot--red');
    expect(screen.getByRole('img', { name: /June 4, Unavailable/ })).toHaveClass('price-dot--grey');
  });

  test('renders Spanish accessible labels', async () => {
    mockFetchByMonth();

    render(<CalendarWithPriceDots apartmentSlug="SunsetVilla" language="es" />);

    expect(await screen.findByRole('img', { name: /1 de junio.*precio bajo.*M\u00ednimo 2 noches/ })).toBeInTheDocument();
  });

  test('captures consent-gated calendar analytics events', async () => {
    CookieConsentService.saveConsent({
      analytics: true,
      marketing: false,
      functional: true,
    });
    mockFetchByMonth();

    render(<CalendarWithPriceDots apartmentSlug="SunsetVilla" language="en" />);

    await waitFor(() => {
      expect(posthog.capture).toHaveBeenCalledWith(
        'calendar_month_loaded',
        expect.objectContaining({
          apartment_slug: 'SunsetVilla',
          month: '2026-06',
          available_count: 3,
          avg_price: 10500,
          source: 'hit',
        })
      );
    });

    fireEvent.click(screen.getByRole('button', { name: 'Next month' }));
    expect(posthog.capture).toHaveBeenCalledWith(
      'calendar_month_changed',
      expect.objectContaining({
        apartment_slug: 'SunsetVilla',
        from_month: '2026-06',
        to_month: '2026-07',
      })
    );

    await screen.findByRole('img', { name: /July 1, \$150\.00, average price/ });
    fireEvent.click(screen.getByRole('button', { name: /July 1,/ }));

    expect(posthog.capture).toHaveBeenCalledWith(
      'calendar_date_selected',
      expect.objectContaining({
        apartment_slug: 'SunsetVilla',
        date: '2026-07-01',
        price: 15000,
        dot_color: 'yellow',
        available: true,
      })
    );
    expect(window.gtag).toHaveBeenCalledWith(
      'event',
      'calendar_date_selected',
      expect.objectContaining({
        event_category: 'calendar',
        apartment_slug: 'SunsetVilla',
      })
    );
  });

  test('disables nights before today and never reports them as bookable', async () => {
    jest.setSystemTime(new Date('2026-06-03T12:00:00Z'));
    mockFetchByMonth();

    const onSelectDate = jest.fn();
    render(<CalendarWithPriceDots apartmentSlug="SunsetVilla" language="en" onSelectDate={onSelectDate} />);

    // June 3 is today, so it stays selectable and keeps its price. Awaiting a
    // priced label also guarantees the month payload has landed.
    const todayCell = await screen.findByRole('button', { name: /June 3, \$125\.00, high price/ });
    expect(todayCell).toBeEnabled();

    // June 1 and 2 are behind us even though the fixture marks them available.
    const pastCell = screen.getByRole('button', { name: /June 1, No longer available/ });
    expect(pastCell).toBeDisabled();
    expect(screen.getByRole('button', { name: /June 2, No longer available/ })).toBeDisabled();

    fireEvent.click(pastCell);
    expect(onSelectDate).not.toHaveBeenCalled();

    fireEvent.click(todayCell);
    expect(onSelectDate).toHaveBeenCalledWith('2026-06-03', expect.objectContaining({ date: '2026-06-03' }), 'red');
  });

  test('marks the picked range and reports each click to the parent', async () => {
    mockFetchByMonth();

    const onSelectDate = jest.fn();
    const { rerender } = render(
      <CalendarWithPriceDots apartmentSlug="SunsetVilla" language="en" onSelectDate={onSelectDate} />
    );

    fireEvent.click(await screen.findByRole('button', { name: /June 1, \$90\.00/ }));
    expect(onSelectDate).toHaveBeenCalledWith(
      '2026-06-01',
      expect.objectContaining({ date: '2026-06-01' }),
      'green'
    );

    rerender(
      <CalendarWithPriceDots
        apartmentSlug="SunsetVilla"
        language="en"
        onSelectDate={onSelectDate}
        selectionStart="2026-06-01"
        selectionEnd="2026-06-03"
      />
    );

    expect(screen.getByRole('button', { name: /June 1,/ })).toHaveClass('calendar-date-cell--range-start');
    expect(screen.getByRole('button', { name: /June 2,/ })).toHaveClass('calendar-date-cell--in-range');
    expect(screen.getByRole('button', { name: /June 3,/ })).toHaveClass('calendar-date-cell--range-end');
  });

  test('two calendars on the same property and month share a single request', async () => {
    mockFetchByMonth();

    render(
      <>
        <CalendarWithPriceDots apartmentSlug="SunsetVilla" language="en" />
        <CalendarWithPriceDots apartmentSlug="SunsetVilla" language="en" />
      </>
    );

    await waitFor(() => {
      expect(screen.getAllByRole('img', { name: /June 1,/ })).toHaveLength(2);
    });

    expect((global.fetch as jest.Mock).mock.calls).toHaveLength(1);
  });

  test('blocks booked nights from starting a stay', async () => {
    mockFetchByMonth();

    render(<CalendarWithPriceDots apartmentSlug="SunsetVilla" language="en" />);

    await screen.findByRole('button', { name: /June 1, \$90\.00/ });

    // June 4 is booked in the fixture, so it cannot be a check-in.
    const booked = screen.getByRole('button', { name: /June 4, Unavailable/ });
    expect(booked).toBeDisabled();
    expect(booked).toHaveClass('calendar-date-cell--blocked');
    expect(screen.getByRole('button', { name: /June 1, \$90\.00/ })).toBeEnabled();
  });

  test('limits check-out to the min-stay and the first booked night', async () => {
    mockFetchByMonth();

    // Check-in June 1 carries a 2-night minimum, and June 4 is booked. That
    // leaves exactly June 3 and June 4 as legal departure dates: June 4 is
    // still fine because that night is never slept.
    render(
      <CalendarWithPriceDots apartmentSlug="SunsetVilla" language="en" selectionStart="2026-06-01" />
    );

    await screen.findByRole('button', { name: /June 3, \$125\.00/ });

    expect(screen.getByRole('button', { name: /June 2, .*Not available as a check-out date/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /June 3, \$125\.00/ })).toBeEnabled();
    expect(screen.getByRole('button', { name: /June 4, Unavailable/ })).toBeEnabled();
    expect(screen.getByRole('button', { name: /June 5, .*Not available as a check-out date/ })).toBeDisabled();

    // The chosen check-in stays highlighted rather than being struck through.
    const start = screen.getByRole('button', { name: /June 1,/ });
    expect(start).toHaveClass('calendar-date-cell--range-start');
    expect(start).not.toHaveClass('calendar-date-cell--blocked');

    expect(
      screen.getByText('Now pick your check-out date, or tap an earlier date to start over.')
    ).toBeInTheDocument();
  });

  test('lets a tap before the check-in restart the range instead of swallowing it', async () => {
    mockFetchByMonth();

    // A guest who meant June 1 but misclicked June 2 has to be able to correct
    // it by tapping June 1 — the two-tap picker used to disable everything
    // before the check-in, leaving the click nowhere to go.
    const onSelectDate = jest.fn();
    render(
      <CalendarWithPriceDots
        apartmentSlug="SunsetVilla"
        language="en"
        onSelectDate={onSelectDate}
        selectionStart="2026-06-02"
      />
    );

    const earlier = await screen.findByRole('button', { name: /June 1, \$90\.00, low price/ });
    expect(earlier).toBeEnabled();
    expect(earlier).not.toHaveClass('calendar-date-cell--blocked');

    fireEvent.click(earlier);
    expect(onSelectDate).toHaveBeenCalledWith(
      '2026-06-01',
      expect.objectContaining({ date: '2026-06-01' }),
      'green'
    );

    // Nights after the check-in still obey the stay rules: June 2 carries a
    // 2-night minimum and June 4 is booked, so June 3 remains closed.
    expect(screen.getByRole('button', { name: /June 3, .*Not available as a check-out date/ })).toBeDisabled();
  });

  test('offers the clear control only once a date is picked', async () => {
    mockFetchByMonth();

    const onClearSelection = jest.fn();
    const { rerender } = render(
      <CalendarWithPriceDots apartmentSlug="SunsetVilla" language="en" onClearSelection={onClearSelection} />
    );

    await screen.findByRole('button', { name: /June 1, \$90\.00/ });
    expect(screen.queryByRole('button', { name: 'Clear dates' })).not.toBeInTheDocument();

    rerender(
      <CalendarWithPriceDots
        apartmentSlug="SunsetVilla"
        language="en"
        onClearSelection={onClearSelection}
        selectionStart="2026-06-02"
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Clear dates' }));
    expect(onClearSelection).toHaveBeenCalledTimes(1);
  });

  test('renders the Spanish month label without title-casing the preposition', async () => {
    mockFetchByMonth();

    render(<CalendarWithPriceDots apartmentSlug="SunsetVilla" language="es" />);

    expect(await screen.findByText('Junio de 2026')).toBeInTheDocument();
  });

  test('omits dots and skips the request when no property is given', async () => {
    mockFetchByMonth();

    render(<CalendarWithPriceDots language="en" />);

    // The date alone — with no rates to consult, claiming "Unavailable" would be
    // a statement the component cannot back up.
    expect(await screen.findByRole('button', { name: 'June 1' })).toBeEnabled();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    // The colour legend is the only list here, and it explains dots we no longer draw.
    expect(screen.queryByRole('list')).not.toBeInTheDocument();
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

function mockFetchByMonth() {
  global.fetch = jest.fn((url: RequestInfo | URL) => {
    const urlString = String(url);
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve(urlString.includes('month=2026-07') ? julyResponse : juneResponse),
    } as Response);
  });
}

function mockFetch(responseBody: unknown) {
  global.fetch = jest.fn(() =>
    Promise.resolve({
      ok: true,
      json: () => Promise.resolve(responseBody),
    } as Response)
  );
}
