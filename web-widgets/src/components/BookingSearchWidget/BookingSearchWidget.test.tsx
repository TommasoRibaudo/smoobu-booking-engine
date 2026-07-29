/**
 * Two-tap date picking in the search widget.
 *
 * A guest who misclicks the arrival must be able to correct it by tapping an
 * earlier date. The widget has always restarted the range on such a tap; the
 * calendar used to disable those cells, so the tap never arrived. These tests
 * cover the seam between the two, plus the clear control that is the guest's
 * other way out of a half-finished range.
 */

import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import BookingSearchWidget from './BookingSearchWidget.component';

jest.mock('posthog-js', () => ({ __esModule: true, default: { capture: jest.fn() }, capture: jest.fn() }));

// No apartmentSlug: the portfolio-wide picker draws plain dates and makes no
// calendar request, which keeps these tests about selection behaviour alone.
function renderWidget() {
  return render(
    <MemoryRouter>
      <BookingSearchWidget isSpanish={false} />
    </MemoryRouter>
  );
}

describe('BookingSearchWidget date selection', () => {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-06-01T12:00:00Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('a tap before the check-in moves the check-in instead of doing nothing', () => {
    renderWidget();

    fireEvent.click(screen.getByRole('button', { name: 'June 20' }));
    expect(screen.getByText('Jun 20 → select check-out')).toBeInTheDocument();

    // The misclick correction: June 12 is earlier than the current arrival.
    const earlier = screen.getByRole('button', { name: 'June 12' });
    expect(earlier).toBeEnabled();
    fireEvent.click(earlier);
    expect(screen.getByText('Jun 12 → select check-out')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'June 15' }));
    expect(screen.getByText('Jun 12 → Jun 15 · 3 nights')).toBeInTheDocument();
  });

  test('clearing the dates empties the range', () => {
    renderWidget();

    fireEvent.click(screen.getByRole('button', { name: 'June 20' }));
    fireEvent.click(screen.getByRole('button', { name: 'Clear dates' }));

    expect(screen.getByText('Select your dates')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Clear dates' })).not.toBeInTheDocument();
  });
});
