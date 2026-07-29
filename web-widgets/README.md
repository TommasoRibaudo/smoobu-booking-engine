# Booking Engine — Web Widgets

React components for the [Smoobu Booking Engine](../README.md). See
[../AGENTS.md](../AGENTS.md) for the full integration guide.

## What's portable vs. reference-only

- `src/components/CalendarWithPriceDots/` and
  `src/components/BookingSearchWidget/` are drop-in components with their own
  test suites. Copy the whole `src/` tree into your app (they depend on the
  sibling hooks/services/utils) and import them directly.
- `examples/Booking.page.tsx` is a full reference checkout page (search →
  hold → pay → confirm → guest portal) demonstrating how to wire the two
  components above together with `BookingApi.service.ts`. It is intentionally
  not polished into a zero-dependency drop-in — read it, then adapt it to
  your own site's routing, navigation, and i18n. It has no test suite of its
  own.

## Peer dependencies

`react`, `react-dom`, `react-router-dom`, plus `react-bootstrap`,
`@fortawesome/*`, `react-helmet`, `react-google-recaptcha-v3`, and
`posthog-js` (optional — see below).

## Analytics is optional

`BookingAnalytics.service.ts` and the PostHog calls inside
`CalendarWithPriceDots` are gated behind `CookieConsentService.hasConsent`.
If you don't use PostHog, delete the `PostHog.service.ts` import and its call
sites — nothing else depends on it.

## Development

```bash
npm install
npm run typecheck
npm test
```
