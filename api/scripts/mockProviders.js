#!/usr/bin/env node
/**
 * Local stand-ins for Smoobu and PayPal.
 *
 * Smoobu has no sandbox — every call hits live inventory and a createReservation
 * really blocks dates on real properties. So local development points
 * SMOOBU_BASE_URL here instead. PayPal does have a sandbox; this mock exists so
 * the flow is runnable offline and deterministic, but you can point
 * PAYPAL_BASE_URL at api-m.sandbox.paypal.com whenever you want the real thing.
 *
 * Both providers are served from one process because their paths don't overlap:
 *   Smoobu  /booking/*, /api/rates, /api/reservations, /api/apartments
 *   PayPal  /v1/oauth2/token, /v2/checkout/orders
 *
 * State is in-memory: restarting resets every reservation and order.
 */

const http = require("http");

const PORT = Number(process.env.MOCK_PROVIDERS_PORT || 4010);

// Smoobu apartment IDs, mirroring src/propertyCatalog.ts. Keep both in sync —
// an ID that isn't in the catalog is dropped from search results by the API.
const APARTMENTS = [
  { id: 100001, name: "Sunset Villa" },
  { id: 100002, name: "Palm Cottage" },
  { id: 100003, name: "Ocean Breeze House" },
  { id: 100004, name: "Jungle Loft" },
];

const NIGHTLY_PRICE_BY_APARTMENT = new Map(APARTMENTS.map((apartment, index) => [apartment.id, 120 + index * 15]));

const state = {
  reservations: new Map(),
  orders: new Map(),
  /** Dates deliberately marked unavailable, as `${apartmentId}:${YYYY-MM-DD}`. */
  blockedDates: new Set(),
};

// Identifier counters live outside `state` because /mock/reset must NOT rewind
// them, and they are seeded from the clock so a process restart doesn't either.
// Real Smoobu reservation IDs and PayPal order IDs are never reused, and the
// database enforces that with unique constraints on holds.smoobu_reservation_id
// and payments.paypal_order_id. Since Postgres outlives the mock, a counter that
// restarted at a fixed value would collide with rows from an earlier session.
const RUN_SEED = Math.floor(Date.now() / 1000);
const counters = {
  nextReservationId: RUN_SEED,
  nextOrderNumber: 1,
};

// ── helpers ──────────────────────────────────────────────────────────────────

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve({});
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, statusCode, body) {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function eachNight(arrivalDate, departureDate) {
  const nights = [];
  const cursor = new Date(`${arrivalDate}T00:00:00Z`);
  const end = new Date(`${departureDate}T00:00:00Z`);

  while (cursor < end) {
    nights.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  return nights;
}

function isApartmentFree(apartmentId, arrivalDate, departureDate) {
  const nights = eachNight(arrivalDate, departureDate);
  if (nights.some((night) => state.blockedDates.has(`${apartmentId}:${night}`))) {
    return false;
  }

  for (const reservation of state.reservations.values()) {
    if (reservation.apartmentId !== apartmentId || reservation.cancelled) {
      continue;
    }
    const reservedNights = new Set(eachNight(reservation.arrivalDate, reservation.departureDate));
    if (nights.some((night) => reservedNights.has(night))) {
      return false;
    }
  }

  return true;
}

// ── Smoobu ───────────────────────────────────────────────────────────────────

function handleCheckAvailability(body, res) {
  const arrivalDate = body.arrivalDate;
  const departureDate = body.departureDate;
  const nightCount = eachNight(arrivalDate, departureDate).length;
  const requested = Array.isArray(body.apartments) && body.apartments.length > 0
    ? body.apartments.map(Number)
    : APARTMENTS.map((apartment) => apartment.id);

  const availableApartments = [];
  const prices = {};
  const errorMessages = {};

  for (const apartmentId of requested) {
    if (!NIGHTLY_PRICE_BY_APARTMENT.has(apartmentId)) {
      continue;
    }

    if (!isApartmentFree(apartmentId, arrivalDate, departureDate)) {
      errorMessages[String(apartmentId)] = { errorCode: 1, message: "Apartment is not available." };
      continue;
    }

    availableApartments.push(apartmentId);

    let nightly = NIGHTLY_PRICE_BY_APARTMENT.get(apartmentId);
    // Mirrors the real "#norefundallowed" behaviour: a 10% cheaper, stricter rate.
    if (typeof body.discountCode === "string" && body.discountCode === "#norefundallowed") {
      nightly = Math.round(nightly * 0.9 * 100) / 100;
    }

    prices[String(apartmentId)] = {
      price: Math.round(nightly * nightCount * 100) / 100,
      currency: "USD",
    };
  }

  sendJson(res, 200, { availableApartments, prices, errorMessages });
}

function handleRates(url, res) {
  const apartmentIds = url.searchParams.getAll("apartments[]").map(Number);
  const startDate = url.searchParams.get("start_date");
  const endDate = url.searchParams.get("end_date");

  const data = {};
  for (const apartmentId of apartmentIds) {
    const nightly = NIGHTLY_PRICE_BY_APARTMENT.get(apartmentId) ?? 130;
    const days = {};

    // `end_date` is inclusive for the rates endpoint, unlike a stay's departure date.
    const cursor = new Date(`${startDate}T00:00:00Z`);
    const end = new Date(`${endDate}T00:00:00Z`);
    while (cursor <= end) {
      const date = cursor.toISOString().slice(0, 10);
      const dayOfMonth = cursor.getUTCDate();
      // A little variation so the calendar's green/yellow/red dots are visible.
      const multiplier = 1 + ((dayOfMonth % 7) - 3) * 0.06;

      days[date] = {
        price: Math.round(nightly * multiplier * 100) / 100,
        available: isApartmentFree(apartmentId, date, addDays(date, 1)) ? 1 : 0,
        min_length_of_stay: 2,
      };

      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }

    data[String(apartmentId)] = days;
  }

  sendJson(res, 200, { data });
}

function addDays(date, days) {
  const next = new Date(`${date}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + days);
  return next.toISOString().slice(0, 10);
}

function handleCreateReservation(body, res) {
  const apartmentId = Number(body.apartmentId);
  const arrivalDate = body.arrivalDate;
  const departureDate = body.departureDate;

  if (!isApartmentFree(apartmentId, arrivalDate, departureDate)) {
    sendJson(res, 400, { title: "Bad Request", detail: "Apartment is not available for these dates." });
    return;
  }

  const id = counters.nextReservationId++;
  state.reservations.set(id, {
    id,
    apartmentId,
    arrivalDate,
    departureDate,
    channelId: body.channelId ?? null,
    notice: body.notice ?? null,
    cancelled: false,
  });

  console.log(`[smoobu] created reservation ${id} apartment=${apartmentId} ${arrivalDate}..${departureDate} channel=${body.channelId ?? "-"}`);
  sendJson(res, 200, { id });
}

function handleUpdateReservation(reservationId, body, res) {
  const reservation = state.reservations.get(reservationId);
  if (!reservation || reservation.cancelled) {
    sendJson(res, 404, { title: "Not Found", detail: "Reservation not found." });
    return;
  }

  Object.assign(reservation, {
    notice: body.notice ?? reservation.notice,
    adults: body.adults ?? reservation.adults,
  });

  console.log(`[smoobu] updated reservation ${reservationId}`);
  sendJson(res, 200, { id: reservationId });
}

function handleCancelReservation(reservationId, res) {
  const reservation = state.reservations.get(reservationId);
  if (!reservation || reservation.cancelled) {
    // Matches Smoobu: deleting an unknown reservation is a 404.
    sendJson(res, 404, { title: "Not Found", detail: "Reservation not found." });
    return;
  }

  reservation.cancelled = true;
  console.log(`[smoobu] cancelled reservation ${reservationId} (dates released)`);
  sendJson(res, 200, { id: reservationId });
}

// ── PayPal ───────────────────────────────────────────────────────────────────

function handlePayPalToken(res) {
  sendJson(res, 200, { access_token: "mock-paypal-access-token", expires_in: 3600, token_type: "Bearer" });
}

function handleCreateOrder(body, res) {
  const id = `MOCK-ORDER-${RUN_SEED}-${String(counters.nextOrderNumber++).padStart(4, "0")}`;
  const purchaseUnit = body.purchase_units?.[0] ?? {};
  const returnUrl = body.application_context?.return_url ?? "http://localhost:3000/book/return";

  state.orders.set(id, {
    id,
    status: "CREATED",
    currency: purchaseUnit.amount?.currency_code ?? "USD",
    value: purchaseUnit.amount?.value ?? "0.00",
    returnUrl,
  });

  // The approve link points at this mock's own approval page, which redirects
  // back to the booking site exactly as PayPal does.
  const approveUrl = `http://localhost:${PORT}/mock-paypal/approve?token=${encodeURIComponent(id)}`;

  console.log(`[paypal] created order ${id} for ${purchaseUnit.amount?.value} ${purchaseUnit.amount?.currency_code}`);
  sendJson(res, 201, {
    id,
    status: "CREATED",
    links: [
      { rel: "self", href: `http://localhost:${PORT}/v2/checkout/orders/${id}`, method: "GET" },
      { rel: "approve", href: approveUrl, method: "GET" },
    ],
  });
}

function handleApprovalPage(url, res) {
  const orderId = url.searchParams.get("token");
  const order = state.orders.get(orderId);

  if (!order) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Unknown order");
    return;
  }

  order.status = "APPROVED";
  const redirectTo = `${order.returnUrl}?token=${encodeURIComponent(orderId)}&PayerID=MOCKPAYER123`;

  console.log(`[paypal] buyer approved ${orderId}, redirecting to ${redirectTo}`);

  // A one-second interstitial makes the redirect visible while testing by hand.
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(`<!doctype html>
<html><head><meta charset="utf-8"><title>Mock PayPal</title>
<meta http-equiv="refresh" content="1;url=${redirectTo}"></head>
<body style="font-family:system-ui;padding:3rem;text-align:center">
<h1>Mock PayPal</h1>
<p>Approving order <strong>${orderId}</strong> for ${order.value} ${order.currency}.</p>
<p>Returning to the booking site…</p>
<p><a href="${redirectTo}">Continue now</a></p>
</body></html>`);
}

function handleCaptureOrder(orderId, res) {
  const order = state.orders.get(orderId);
  if (!order) {
    sendJson(res, 404, { name: "RESOURCE_NOT_FOUND", message: "Order not found." });
    return;
  }

  if (order.status !== "APPROVED" && order.status !== "COMPLETED") {
    sendJson(res, 422, {
      name: "UNPROCESSABLE_ENTITY",
      details: [{ issue: "ORDER_NOT_APPROVED", description: "Payer has not yet approved the order." }],
    });
    return;
  }

  order.status = "COMPLETED";
  const captureId = `MOCK-CAPTURE-${orderId.replace(/^MOCK-ORDER-/, "")}`;

  console.log(`[paypal] captured ${orderId} -> ${captureId}`);
  sendJson(res, 201, {
    id: orderId,
    status: "COMPLETED",
    purchase_units: [
      {
        payments: {
          captures: [
            {
              id: captureId,
              status: "COMPLETED",
              amount: { currency_code: order.currency, value: order.value },
            },
          ],
        },
      },
    ],
  });
}

function handleGetOrder(orderId, res) {
  const order = state.orders.get(orderId);
  if (!order) {
    sendJson(res, 404, { name: "RESOURCE_NOT_FOUND", message: "Order not found." });
    return;
  }

  sendJson(res, 200, {
    id: order.id,
    status: order.status,
    purchase_units: [
      {
        payments: {
          captures:
            order.status === "COMPLETED"
              ? [
                  {
                    id: `MOCK-CAPTURE-${order.id.replace(/^MOCK-ORDER-/, "")}`,
                    status: "COMPLETED",
                    amount: { currency_code: order.currency, value: order.value },
                  },
                ]
              : [],
        },
      },
    ],
  });
}

// ── routing ──────────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const { pathname } = url;
  const body = req.method === "POST" || req.method === "PUT" ? await readBody(req) : {};

  // Smoobu
  if (req.method === "POST" && pathname === "/booking/checkApartmentAvailability") {
    return handleCheckAvailability(body, res);
  }
  if (req.method === "GET" && pathname === "/api/rates") {
    return handleRates(url, res);
  }
  if (req.method === "POST" && pathname === "/api/reservations") {
    return handleCreateReservation(body, res);
  }
  if (pathname.startsWith("/api/reservations/")) {
    const reservationId = Number(pathname.slice("/api/reservations/".length));
    if (req.method === "PUT") {
      return handleUpdateReservation(reservationId, body, res);
    }
    if (req.method === "DELETE") {
      return handleCancelReservation(reservationId, res);
    }
  }
  if (req.method === "GET" && pathname === "/api/apartments") {
    return sendJson(res, 200, { apartments: APARTMENTS.map((apartment) => apartment.id) });
  }

  // PayPal
  if (req.method === "POST" && pathname === "/v1/oauth2/token") {
    return handlePayPalToken(res);
  }
  if (req.method === "POST" && pathname === "/v2/checkout/orders") {
    return handleCreateOrder(body, res);
  }
  if (req.method === "GET" && pathname === "/mock-paypal/approve") {
    return handleApprovalPage(url, res);
  }
  if (pathname.startsWith("/v2/checkout/orders/")) {
    const rest = pathname.slice("/v2/checkout/orders/".length);
    if (req.method === "POST" && rest.endsWith("/capture")) {
      return handleCaptureOrder(rest.slice(0, -"/capture".length), res);
    }
    if (req.method === "GET") {
      return handleGetOrder(rest, res);
    }
  }

  // Test affordance: POST /mock/reset clears all in-memory state.
  if (req.method === "POST" && pathname === "/mock/reset") {
    state.reservations.clear();
    state.orders.clear();
    state.blockedDates.clear();
    console.log("[mock] state reset");
    return sendJson(res, 200, { reset: true });
  }

  console.warn(`[mock] unhandled ${req.method} ${pathname}`);
  sendJson(res, 404, { error: "unhandled_mock_route", method: req.method, path: pathname });
});

server.listen(PORT, () => {
  console.log(`mock Smoobu + PayPal listening on http://localhost:${PORT}`);
  console.log(`  set SMOOBU_BASE_URL=http://localhost:${PORT}`);
  console.log(`  set PAYPAL_BASE_URL=http://localhost:${PORT}`);
});
