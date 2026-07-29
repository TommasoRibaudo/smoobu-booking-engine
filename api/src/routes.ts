import { getHeader } from "./http/request";
import { jsonResponse } from "./http/response";
import { ApiError } from "./http/errors";
import { Router } from "./http/router";
import { handleCalendarRequest } from "./calendar";
import { handleExchangeRateRequest } from "./exchangeRate";
import { handlePortalLogin } from "./portalAuth";
import { handlePortalReservation, handlePortalHelpRequest, handlePortalCancellationRequest, handlePortalCancelBooking, handlePortalGuestUpdate } from "./portalPages";
import { handleManualDepositHandoff, handleManualDepositHandoffEvent } from "./depositHandoff";
import { handleDepositReceiptUploadUrl, handleDepositReceiptConfirm } from "./depositReceipt";
import { handleCreatePayPalHold } from "./holds";
import { handleCreateDepositHold } from "./depositHolds";
import { handleStaffDepositReviewPage, handleStaffDepositReviewSubmit } from "./depositConfirm";
import { handleCreatePayPalOrder, handleCapturePayPalOrder } from "./paypalOrders";
import { handlePayPalWebhook } from "./paypalWebhooks";
import { handleAvailabilitySearch } from "./search";
import { handleSmoobuWebhook } from "./smoobuWebhooks";
import { BookingApiConfig, RouteRequest } from "./types";
import {
  assertJsonObject,
  validateBookingSessionPathParams,
  validateBookingSessionRequest,
  validateCalendarRequest,
  validateDepositHoldRequest,
  validateStaffReviewToken,
  validateStaffReviewSubmit,
  validateCancellationRequest,
  validateDepositHandoffEvent,
  validateDepositHandoffQuery,
  validateDepositReceiptUploadUrlRequest,
  validateDepositReceiptConfirmRequest,
  validateGuestUpdateRequest,
  validateHoldRequest,
  validatePayPalCaptureRequest,
  validatePayPalCapturePathRequest,
  validatePortalLogin,
  validatePortalMessage,
  validateReservationPublicId,
  validateSearchRequest,
} from "./validation";

export function createRouter(config: BookingApiConfig): Router {
  const router = new Router();

  router.get("/api/health", healthHandler);

  router.post(
    "/api/search",
    async (request) => {
      const searchRequest = validateSearchRequest(request.body);
      return handleAvailabilitySearch(searchRequest, config, request.responseHeaders, request.observability);
    },
    { requireJsonBody: true, abuseProtection: "availabilitySearch" }
  );

  // Display-only USD → CRC rate for the Spanish booking flow. No parameters:
  // one currency pair, one cached answer for every caller.
  router.get("/api/exchange-rate", async (request) => {
    return handleExchangeRateRequest(config, request.responseHeaders, request.observability);
  }, { abuseProtection: "publicRead" });

  router.get("/api/calendar/:apartmentSlug", async (request) => {
    const calendarRequest = validateCalendarRequest(request.pathParams, request.query);
    return handleCalendarRequest(calendarRequest, config, request.responseHeaders, request.observability);
  }, { abuseProtection: "publicRead" });

  router.post(
    "/api/holds",
    async (request) => {
      const holdRequest = validateHoldRequest(request.body);
      return handleCreatePayPalHold(holdRequest, request, config);
    },
    { requireJsonBody: true, requireIdempotencyKey: true, abuseProtection: "holdCreate" }
  );

  router.post(
    "/api/paypal/order",
    async (request) => {
      const body = validateBookingSessionRequest(request.body);
      return handleCreatePayPalOrder(body, request, config);
    },
    { requireJsonBody: true, requireIdempotencyKey: true, abuseProtection: "paymentCreate" }
  );

  router.post(
    "/api/bookings/:bookingSessionId/paypal/create-order",
    async (request) => {
      const body = validateBookingSessionPathParams(request.pathParams);
      return handleCreatePayPalOrder(body, request, config);
    },
    { requireIdempotencyKey: true, abuseProtection: "paymentCreate" }
  );

  router.post(
    "/api/paypal/capture",
    async (request) => {
      const body = validatePayPalCaptureRequest(request.body);
      return handleCapturePayPalOrder(body, request, config);
    },
    { requireJsonBody: true, requireIdempotencyKey: true, abuseProtection: "paymentCapture" }
  );

  router.post(
    "/api/bookings/:bookingSessionId/paypal/capture",
    async (request) => {
      const body = validatePayPalCapturePathRequest(request.pathParams, request.body);
      return handleCapturePayPalOrder(body, request, config);
    },
    { requireJsonBody: true, requireIdempotencyKey: true, abuseProtection: "paymentCapture" }
  );

  router.post(
    "/api/deposit-holds",
    async (request) => {
      const holdRequest = validateDepositHoldRequest(request.body);
      return handleCreateDepositHold(holdRequest, request, config);
    },
    { requireJsonBody: true, requireIdempotencyKey: true, abuseProtection: "holdCreate" }
  );

  // Staff deposit review. GET renders a one-screen summary with a single button;
  // the POST performs the action. Splitting them keeps email scanners and
  // link-preview bots from confirming bookings by merely fetching the URL.
  router.get("/api/staff/deposit-review/:token", async (request) => {
    const token = validateStaffReviewToken(request.pathParams);
    return handleStaffDepositReviewPage(token, request, config);
  }, { abuseProtection: "portalRead" });

  router.post(
    "/api/staff/deposit-review",
    async (request) => {
      const token = validateStaffReviewSubmit(request.rawBody, request.body);
      return handleStaffDepositReviewSubmit(token, request, config);
    },
    { allowFormEncodedBody: true, preserveRawBody: true, abuseProtection: "portalWrite" }
  );

  router.get("/api/deposit-handoff", async (request) => {
    const query = validateDepositHandoffQuery(request.query);
    return handleManualDepositHandoff(query, config, request.responseHeaders, request.observability);
  }, { abuseProtection: "publicRead" });

  router.post(
    "/api/deposit-handoff/events",
    async (request) => {
      const event = validateDepositHandoffEvent(request.body);
      return handleManualDepositHandoffEvent(event, config, request.responseHeaders, request.observability);
    },
    { requireJsonBody: true, requireIdempotencyKey: true, abuseProtection: "depositEvent" }
  );

  router.post(
    "/api/deposit-receipt/upload-url",
    async (request) => {
      const body = validateDepositReceiptUploadUrlRequest(request.body);
      return handleDepositReceiptUploadUrl(
        body,
        config,
        request.responseHeaders,
        request.observability,
        getHeader(request.headers, "authorization")
      );
    },
    { requireJsonBody: true, abuseProtection: "depositEvent" }
  );

  router.post(
    "/api/deposit-receipt/confirm",
    async (request) => {
      const body = validateDepositReceiptConfirmRequest(request.body);
      return handleDepositReceiptConfirm(
        body,
        config,
        request.responseHeaders,
        request.observability,
        getHeader(request.headers, "authorization")
      );
    },
    { requireJsonBody: true, requireIdempotencyKey: true, abuseProtection: "depositEvent" }
  );

  router.post(
    "/api/webhooks/paypal",
    async (request) => {
      assertJsonObject(request.body);
      assertPayPalWebhookHeaders(request);
      return handlePayPalWebhook(request, config);
    },
    { requireJsonBody: true, preserveRawBody: true, abuseProtection: "webhook" }
  );

  router.post(
    "/api/webhooks/smoobu",
    async (request) => {
      const body = assertJsonObject(request.body);
      return handleSmoobuWebhook(request, config, body);
    },
    { requireJsonBody: true, preserveRawBody: true, rejectQuerySecrets: true, abuseProtection: "webhook" }
  );

  router.post(
    "/api/portal/login",
    async (request) => {
      const body = validatePortalLogin(request.body);
      return handlePortalLogin(body, request, config);
    },
    { requireJsonBody: true, abuseProtection: "portalLogin" }
  );

  router.get("/api/portal/reservation/:reservationPublicId", async (request) => {
    const reservationPublicId = validateReservationPublicId(request.pathParams);
    return handlePortalReservation(reservationPublicId, request, config);
  }, { abuseProtection: "portalRead" });

  router.post(
    "/api/portal/reservation/:reservationPublicId/help-request",
    async (request) => {
      const reservationPublicId = validateReservationPublicId(request.pathParams);
      const body = validatePortalMessage(request.body);
      return handlePortalHelpRequest(reservationPublicId, body, request, config);
    },
    { requireJsonBody: true, requireIdempotencyKey: true, abuseProtection: "portalWrite" }
  );

  router.post(
    "/api/portal/reservation/:reservationPublicId/cancellation-request",
    async (request) => {
      const reservationPublicId = validateReservationPublicId(request.pathParams);
      const body = validateCancellationRequest(request.body);
      return handlePortalCancellationRequest(reservationPublicId, body, request, config);
    },
    { requireJsonBody: true, requireIdempotencyKey: true, abuseProtection: "portalWrite" }
  );

  router.post(
    "/api/portal/reservation/:reservationPublicId/cancel",
    async (request) => {
      const reservationPublicId = validateReservationPublicId(request.pathParams);
      const body = validateCancellationRequest(request.body);
      return handlePortalCancelBooking(reservationPublicId, body, request, config);
    },
    { requireJsonBody: true, requireIdempotencyKey: true, abuseProtection: "portalWrite" }
  );

  router.put(
    "/api/portal/reservation/:reservationPublicId/guests",
    async (request) => {
      const reservationPublicId = validateReservationPublicId(request.pathParams);
      const body = validateGuestUpdateRequest(request.body);
      return handlePortalGuestUpdate(reservationPublicId, body, request, config);
    },
    { requireJsonBody: true, abuseProtection: "portalWrite" }
  );

  return router;
}

function healthHandler(request: RouteRequest) {
  return jsonResponse(
    200,
    {
      status: "ok",
      service: "booking-api",
      correlationId: request.correlationId,
    },
    request.responseHeaders
  );
}

function assertPayPalWebhookHeaders(request: RouteRequest): void {
  const certUrl = getHeader(request.headers, "paypal-cert-url");
  const requiredHeaders = [
    "paypal-auth-algo",
    "paypal-cert-url",
    "paypal-transmission-id",
    "paypal-transmission-sig",
    "paypal-transmission-time",
  ];

  const missing = requiredHeaders.filter((header) => !getHeader(request.headers, header));
  if (missing.length > 0) {
    throw new ApiError(400, "invalid_webhook_headers", "PayPal webhook verification headers are required.", {
      fieldErrors: {
        headers: missing.map((header) => `${header}_required`),
      },
    });
  }

  if (!certUrl) {
    return;
  }

  let parsed: URL;
  try {
    parsed = new URL(certUrl);
  } catch {
    throw new ApiError(400, "invalid_webhook_headers", "PayPal cert URL is invalid.");
  }

  const hostname = parsed.hostname.toLowerCase();
  if (parsed.protocol !== "https:" || (hostname !== "paypal.com" && !hostname.endsWith(".paypal.com"))) {
    throw new ApiError(400, "invalid_webhook_headers", "PayPal cert URL host is not allowed.");
  }
}

