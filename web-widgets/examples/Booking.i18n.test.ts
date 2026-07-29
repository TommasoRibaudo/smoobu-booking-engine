import { bookingStrings } from './Booking.i18n';

const bookingFlowKeys = [
  'bookNow',
  'checkoutTitle',
  'guestDetails',
  'portalPassword',
  'portalPasswordHelp',
  'termsAccepted',
  'paypalTitle',
  'paypalDescription',
  'paypalReturnTitle',
  'paypalReturnProcessing',
  'paypalReturnProcessingBody',
  'paypalReturnSuccessBody',
  'paypalReturnMissing',
  'paypalCaptureError',
  'continueToPayment',
  'creatingHold',
  'creatingPayPalOrder',
  'holdExpiring',
  'holdActiveTitle',
  'holdActiveBody',
  'holdExpiresAt',
  'checkoutSummary',
  'confirmationTitle',
  'confirmationSubtitle',
  'confirmationMissing',
  'reservationId',
  'manageBooking',
  'stayDates',
  'paymentConfirmed',
  'notAvailable',
  'validationRequired',
  'validationEmail',
  'validationPortalPassword',
  'validationTerms',
  'propertyNoLongerAvailable',
  'paymentNotReady',
  'checkoutUnavailable',
] as const;

test('Booking.i18n exposes the same booking-flow keys in English and Spanish', () => {
  expect(Object.keys(bookingStrings.es).sort()).toEqual(Object.keys(bookingStrings.en).sort());
});

test('Booking.i18n has non-empty EN/ES copy for checkout, hold, PayPal return, and confirmation UI', () => {
  for (const key of bookingFlowKeys) {
    expect(bookingStrings.en[key]).toBeDefined();
    expect(bookingStrings.es[key]).toBeDefined();

    if (typeof bookingStrings.en[key] === 'string') {
      expect(bookingStrings.en[key]).toEqual(expect.stringMatching(/\S/));
    }

    if (typeof bookingStrings.es[key] === 'string') {
      expect(bookingStrings.es[key]).toEqual(expect.stringMatching(/\S/));
    }
  }
});
