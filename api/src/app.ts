import { loadConfig } from "./config";
import { AbuseGuard } from "./abuseProtection";
import { RdsBookingSessionRepository } from "./bookingSessions";
import { getPool } from "./db";
import { RdsHoldRepository } from "./holds";
import { RdsPaymentRepository } from "./payments";
import { RdsWebhookEventRepository } from "./paypalWebhooks";
import { RdsPortalSessionRepository } from "./portalSessions";
import { assertRouteHardening } from "./http/router";
import { createObservability } from "./observability";
import {
  getClientIp,
  getCorrelationId,
  getHeader,
  getMethod,
  getPath,
  getQuery,
  getRawBody,
  getUserAgent,
  normalizeHeaders,
  parseJsonBody,
} from "./http/request";
import { buildHeaders, errorResponse, optionsResponse } from "./http/response";
import { createRouter } from "./routes";
import { ApiResponse, BookingApiConfig, HttpMethod, LambdaHttpRequest, RouteRequest } from "./types";

// Holds the in-flight or resolved repository initialisation promise so that
// concurrent requests that arrive before the first pool connection completes
// all await the same Promise rather than each spawning a separate getPool() call.
const repositoryInitializationByConfig = new WeakMap<BookingApiConfig, Promise<void>>();

export function createBookingApiHandler(config: BookingApiConfig = loadConfig()) {
  const runtimeConfig: BookingApiConfig = { ...config };
  const router = createRouter(runtimeConfig);
  const abuseGuard = new AbuseGuard(runtimeConfig.abuseProtection, Date.now, runtimeConfig.secrets);
  const observability = createObservability(runtimeConfig.observability);

  return async function bookingApiHandler(event: LambdaHttpRequest): Promise<ApiResponse> {
    const startedAtMs = Date.now();
    const headers = normalizeHeaders(event.headers);
    const correlationId = getCorrelationId(headers);
    const responseHeaders = buildHeaders(runtimeConfig, correlationId, getHeader(headers, "origin"));
    let method: HttpMethod = "GET";
    let path = "/";
    let routePattern: string | undefined;
    let abusePolicy: string | undefined;
    let response: ApiResponse | undefined;
    let errorForLog: unknown;

    try {
      method = getMethod(event);
      if (method === "OPTIONS") {
        response = optionsResponse(responseHeaders);
        return response;
      }

      path = getPath(event);
      const query = getQuery(event);
      const { route, pathParams } = router.match({ method, path });
      routePattern = route.pattern;
      abusePolicy = route.options.abuseProtection;
      const rawBody = getRawBody(event, runtimeConfig.maxBodyBytes);
      const body = parseJsonBody(
        rawBody,
        headers,
        route.options.requireJsonBody ?? false,
        route.options.allowFormEncodedBody ?? false
      );

      const request: RouteRequest = {
        method,
        path,
        headers,
        responseHeaders,
        query,
        pathParams,
        body,
        rawBody,
        correlationId,
        clientIp: getClientIp(event),
        userAgent: getUserAgent(event, headers),
        awsRequestId: event.requestContext?.requestId,
        observability: observability.createRouteObservability({
          correlationId,
          awsRequestId: event.requestContext?.requestId,
          method,
          path,
          route: route.pattern,
        }),
      };

      assertRouteHardening(request, route.options);
      await abuseGuard.assertAllowed(request, route.options.abuseProtection);
      await ensurePersistenceRepositories(runtimeConfig, route.pattern, body);

      response = await route.handler(request);
      return response;
    } catch (error) {
      errorForLog = error;
      response = errorResponse(error, responseHeaders, correlationId);
      return response;
    } finally {
      observability.recordHttpRequest({
        correlationId,
        method,
        path,
        routePattern,
        abusePolicy,
        statusCode: response?.statusCode ?? 500,
        durationMs: Date.now() - startedAtMs,
        clientIp: getClientIp(event),
        userAgent: getUserAgent(event, headers),
        awsRequestId: event.requestContext?.requestId,
        error: errorForLog,
      });
    }
  };
}

function persistenceRepositoriesRequired(routePattern: string, body: unknown): boolean {
  if (routePattern === "/api/webhooks/smoobu") {
    return !isSmoobuRatesOnlyWebhook(body);
  }

  return (
    routePattern === "/api/search" ||
    routePattern === "/api/holds" ||
    routePattern === "/api/deposit-holds" ||
    isStaffDepositReviewRoute(routePattern) ||
    isPayPalOrderRoute(routePattern) ||
    isPayPalCaptureRoute(routePattern) ||
    routePattern === "/api/deposit-handoff" ||
    routePattern === "/api/deposit-handoff/events" ||
    routePattern === "/api/deposit-receipt/upload-url" ||
    routePattern === "/api/deposit-receipt/confirm" ||
    routePattern === "/api/webhooks/paypal" ||
    routePattern === "/api/portal/login" ||
    routePattern === "/api/portal/reservation/:reservationPublicId" ||
    routePattern === "/api/portal/reservation/:reservationPublicId/help-request" ||
    routePattern === "/api/portal/reservation/:reservationPublicId/cancellation-request" ||
    routePattern === "/api/portal/reservation/:reservationPublicId/cancel" ||
    routePattern === "/api/portal/reservation/:reservationPublicId/guests"
  );
}

async function ensurePersistenceRepositories(
  config: BookingApiConfig,
  routePattern: string,
  body: unknown
): Promise<void> {
  if (!persistenceRepositoriesRequired(routePattern, body)) {
    return;
  }

  const holdsRequired = holdRepositoryRequired(routePattern, body);
  const paymentsRequired = paymentRepositoryRequired(routePattern);
  const webhookEventsRequired = webhookEventRepositoryRequired(routePattern, body);
  if (
    config.bookingSessions &&
    (!holdsRequired || config.holds) &&
    (!paymentsRequired || config.payments) &&
    (!webhookEventsRequired || config.webhookEvents)
  ) {
    return;
  }

  // Reuse an existing in-flight initialisation promise so concurrent requests
  // that arrive before the pool is ready all await the same work rather than
  // each calling getPool() independently.
  let initPromise = repositoryInitializationByConfig.get(config);
  if (!initPromise) {
    initPromise = getPool({ secretProvider: config.secrets }).then((pool) => {
      if (!config.bookingSessions) {
        config.bookingSessions = new RdsBookingSessionRepository(pool);
      }
      if (!config.holds) {
        config.holds = new RdsHoldRepository(pool);
      }
      if (!config.payments) {
        config.payments = new RdsPaymentRepository(pool);
      }
      if (!config.webhookEvents) {
        config.webhookEvents = new RdsWebhookEventRepository(pool);
      }
      if (!config.portalSessions) {
        config.portalSessions = new RdsPortalSessionRepository(pool);
      }
    }).catch((err) => {
      // Remove the failed promise so the next request retries pool initialization.
      repositoryInitializationByConfig.delete(config);
      throw err;
    });
    repositoryInitializationByConfig.set(config, initPromise);
  }

  await initPromise;
}

function isStaffDepositReviewRoute(routePattern: string): boolean {
  return (
    routePattern === "/api/staff/deposit-review/:token" || routePattern === "/api/staff/deposit-review"
  );
}

function holdRepositoryRequired(routePattern: string, body: unknown): boolean {
  if (routePattern === "/api/webhooks/smoobu") {
    return !isSmoobuRatesOnlyWebhook(body);
  }

  return (
    routePattern === "/api/holds" ||
    routePattern === "/api/deposit-holds" ||
    isStaffDepositReviewRoute(routePattern) ||
    isPayPalOrderRoute(routePattern) ||
    isPayPalCaptureRoute(routePattern) ||
    routePattern === "/api/deposit-receipt/confirm" ||
    routePattern === "/api/webhooks/paypal" ||
    routePattern === "/api/portal/reservation/:reservationPublicId" ||
    routePattern === "/api/portal/reservation/:reservationPublicId/help-request" ||
    routePattern === "/api/portal/reservation/:reservationPublicId/cancellation-request" ||
    routePattern === "/api/portal/reservation/:reservationPublicId/cancel" ||
    routePattern === "/api/portal/reservation/:reservationPublicId/guests"
  );
}

function paymentRepositoryRequired(routePattern: string): boolean {
  return (
    isPayPalOrderRoute(routePattern) ||
    isPayPalCaptureRoute(routePattern) ||
    routePattern === "/api/webhooks/paypal" ||
    routePattern === "/api/portal/reservation/:reservationPublicId" ||
    routePattern === "/api/portal/reservation/:reservationPublicId/help-request" ||
    routePattern === "/api/portal/reservation/:reservationPublicId/cancellation-request" ||
    routePattern === "/api/portal/reservation/:reservationPublicId/cancel" ||
    routePattern === "/api/portal/reservation/:reservationPublicId/guests"
  );
}

function webhookEventRepositoryRequired(routePattern: string, body: unknown): boolean {
  if (routePattern === "/api/webhooks/smoobu") {
    return !isSmoobuRatesOnlyWebhook(body);
  }

  return routePattern === "/api/webhooks/paypal";
}

function isPayPalOrderRoute(routePattern: string): boolean {
  return (
    routePattern === "/api/paypal/order" ||
    routePattern === "/api/bookings/:bookingSessionId/paypal/create-order"
  );
}

function isPayPalCaptureRoute(routePattern: string): boolean {
  return (
    routePattern === "/api/paypal/capture" ||
    routePattern === "/api/bookings/:bookingSessionId/paypal/capture"
  );
}

function isSmoobuRatesOnlyWebhook(body: unknown): boolean {
  return Boolean(
    body &&
      typeof body === "object" &&
      !Array.isArray(body) &&
      (body as { action?: unknown }).action === "updateRates"
  );
}
