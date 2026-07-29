/**
 * depositConfirm.ts — staff review of a manual deposit booking.
 *
 *   GET  /api/staff/deposit-review/:token   renders a review page
 *   POST /api/staff/deposit-review          performs the action
 *
 * The GET deliberately does not mutate. Email clients and security appliances
 * (Gmail's image proxy, Outlook Safe Links, corporate scanners) fetch links in
 * messages without a human involved, so putting the confirmation on the GET
 * would let a scanner confirm bookings and take payment out of staff's hands.
 * The page is a single screen with one button, so it is still one click.
 *
 * Access is by signed token alone — there is no staff login anywhere in this
 * system. The token is scoped to one booking session and one action, expires,
 * and its jti is recorded when spent.
 */

import { BookingSessionRecord } from "./bookingSessions";
import { SITE_NAME } from "./branding";
import { createEmailClient } from "./email";
import { reportServerConversion } from "./serverConversions";
import { ApiError } from "./http/errors";
import { htmlResponse } from "./http/response";
import { presignReceiptDownload } from "./depositReceipt";
import { BOOKING_PROPERTIES_BY_ID } from "./propertyCatalog";
import { createSmoobuClient, SmoobuProviderError } from "./smoobuClient";
import { verifySignedToken, type SignedTokenPayload } from "./signedTokens";
import { ApiResponse, BookingApiConfig, RouteRequest } from "./types";

export async function handleStaffDepositReviewPage(
  token: string,
  request: RouteRequest,
  config: BookingApiConfig
): Promise<ApiResponse> {
  const { payload, session } = await resolveToken(token, request, config);
  const property = BOOKING_PROPERTIES_BY_ID.get(session.propertyId ?? "");

  let receiptUrl: string | undefined;
  if (session.depositReceiptS3Key && config.s3Upload) {
    receiptUrl = await presignReceiptDownload(config.s3Upload, session.depositReceiptS3Key).catch(() => undefined);
  }

  if (session.status === "booking_confirmed") {
    return htmlResponse(
      200,
      renderPage({
        heading: "Already confirmed",
        body: `<p>Reservation <strong>${escapeHtml(session.reservationPublicId)}</strong> was confirmed on ${escapeHtml(
          session.confirmedAt ?? "an earlier date"
        )}. Nothing further to do.</p>`,
      }),
      request.responseHeaders
    );
  }

  if (session.status === "cancelled" || session.status === "hold_expired" || session.status === "failed") {
    return htmlResponse(
      200,
      renderPage({
        heading: "No longer actionable",
        body: `<p>Reservation <strong>${escapeHtml(session.reservationPublicId)}</strong> is <strong>${escapeHtml(
          session.status
        )}</strong>. The dates have already been released.</p>`,
      }),
      request.responseHeaders
    );
  }

  const isReject = payload.act === "deposit_reject";

  return htmlResponse(
    200,
    renderPage({
      heading: isReject ? "Reject deposit booking" : "Confirm deposit booking",
      body: `
${renderSummary(session, property?.name, receiptUrl)}
<form method="POST" action="/api/staff/deposit-review">
  <input type="hidden" name="token" value="${escapeHtml(token)}" />
  <button type="submit" class="${isReject ? "danger" : "primary"}">
    ${isReject ? "Reject and release the dates" : "Confirm — the money has arrived"}
  </button>
</form>
<p class="note">${
        isReject
          ? "This cancels the Smoobu reservation and puts the dates back on sale."
          : "This confirms the booking and emails the guest their portal access."
      }</p>`,
    }),
    request.responseHeaders
  );
}

export async function handleStaffDepositReviewSubmit(
  token: string,
  request: RouteRequest,
  config: BookingApiConfig
): Promise<ApiResponse> {
  const { payload, session } = await resolveToken(token, request, config);
  const property = BOOKING_PROPERTIES_BY_ID.get(session.propertyId ?? "");
  const propertyName = property?.name ?? session.propertyId ?? "";
  const sessions = requireRepository(config.bookingSessions, "Booking session storage");
  const holds = requireRepository(config.holds, "Hold storage");

  // Idempotent by status guard: a second click lands here and reports the
  // existing state rather than acting twice.
  if (session.status === "booking_confirmed") {
    return htmlResponse(
      200,
      renderPage({
        heading: "Already confirmed",
        body: `<p>Reservation <strong>${escapeHtml(session.reservationPublicId)}</strong> is already confirmed.</p>`,
      }),
      request.responseHeaders
    );
  }

  if (session.status !== "hold_active") {
    return htmlResponse(
      409,
      renderPage({
        heading: "No longer actionable",
        body: `<p>Reservation <strong>${escapeHtml(session.reservationPublicId)}</strong> is <strong>${escapeHtml(
          session.status
        )}</strong> and can no longer be actioned.</p>`,
      }),
      request.responseHeaders
    );
  }

  const hold = await holds.getByBookingSessionId(session.id);

  if (payload.act === "deposit_reject") {
    if (hold?.smoobuReservationId) {
      try {
        const smoobuClient = await createSmoobuClient(config);
        await smoobuClient.cancelReservation(hold.smoobuReservationId, request.observability);
      } catch (error) {
        if (!(error instanceof SmoobuProviderError && error.providerStatusCode === 404)) {
          throw new ApiError(502, "provider_error", "Could not release the reservation in Smoobu. Please try again.");
        }
      }
    }

    await sessions.markCancelled({
      bookingSessionId: session.id,
      reason: "deposit_not_received",
      cancelledBy: "staff",
      cancelledAt: new Date().toISOString(),
    });
    if (hold) {
      await holds.cancelHold(hold.id);
    }

    request.observability.recordStateTransition({
      entityType: "booking_session",
      fromState: "hold_active",
      toState: "cancelled",
      action: "staff.deposit_reject",
      success: true,
      bookingSessionId: session.id,
      reservationPublicId: session.reservationPublicId,
    });
    request.observability.recordSecurityEvent({
      name: "staff_deposit_rejected",
      severity: "info",
      route: "/api/staff/deposit-review",
      bookingSessionId: session.id,
    });

    return htmlResponse(
      200,
      renderPage({
        heading: "Rejected",
        body: `<p>Reservation <strong>${escapeHtml(
          session.reservationPublicId
        )}</strong> was rejected and the dates are back on sale.</p>`,
      }),
      request.responseHeaders
    );
  }

  const confirmedAt = new Date().toISOString();
  const confirmedSession = await sessions.markDepositConfirmed({
    bookingSessionId: session.id,
    confirmedAt,
    confirmedBy: "staff_link",
    tokenJti: payload.jti,
  });

  // The hold must leave the expiry worker's reach. listExpiredHolds sweeps
  // creating|active holds past expires_at, so a confirmed booking left `active`
  // would have its Smoobu reservation cancelled when the TTL elapsed.
  if (hold) {
    try {
      await holds.convertHold({
        holdId: hold.id,
        newSmoobuReservationId: hold.smoobuReservationId ?? 0,
        newSmoobuChannelId: hold.smoobuChannelId,
      });
    } catch (error) {
      request.observability.logger.error("deposit_confirm_hold_convert_failed", {
        bookingSessionId: session.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // Mark the Smoobu reservation as paid so the dashboard reflects reality.
  if (hold?.smoobuReservationId) {
    try {
      const smoobuClient = await createSmoobuClient(config);
      await smoobuClient.updateReservation(
        hold.smoobuReservationId,
        {
          notice: `${SITE_NAME} manual deposit CONFIRMED by staff on ${confirmedAt}. Reservation ${session.reservationPublicId}.`,
          priceStatus: 1,
          prepaymentStatus: 1,
        },
        request.observability
      );
    } catch (error) {
      request.observability.logger.warn("deposit_confirm_smoobu_update_failed", {
        bookingSessionId: session.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  request.observability.recordStateTransition({
    entityType: "booking_session",
    fromState: "hold_active",
    toState: "booking_confirmed",
    action: "staff.deposit_confirm",
    success: true,
    bookingSessionId: session.id,
    reservationPublicId: session.reservationPublicId,
  });
  request.observability.recordSecurityEvent({
    name: "staff_deposit_confirmed",
    severity: "info",
    route: "/api/staff/deposit-review",
    bookingSessionId: session.id,
  });

  // The only place a manual-deposit sale can ever be reported: the guest's
  // browser is long gone by the time staff confirm the transfer.
  await reportServerConversion(
    "purchase",
    confirmedSession,
    config.serverConversions,
    request.observability.logger
  );

  try {
    const emailClient = createEmailClient(config.email, request.observability.logger);
    await emailClient.sendDepositConfirmed(confirmedSession, propertyName);
  } catch (error) {
    request.observability.logger.error("deposit_confirmed_email_failed", {
      bookingSessionId: session.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return htmlResponse(
    200,
    renderPage({
      heading: "Confirmed",
      body: `<p>Reservation <strong>${escapeHtml(
        session.reservationPublicId
      )}</strong> is confirmed. The guest has been emailed their portal access.</p>`,
    }),
    request.responseHeaders
  );
}

async function resolveToken(
  token: string,
  request: RouteRequest,
  config: BookingApiConfig
): Promise<{ payload: SignedTokenPayload; session: BookingSessionRecord }> {
  const { portalSessionSecret } = await config.secrets.getSecrets();
  const payload = verifySignedToken(token, portalSessionSecret, ["deposit_confirm", "deposit_reject"]);

  const sessions = requireRepository(config.bookingSessions, "Booking session storage");
  const session = await sessions.getById(payload.sub);
  if (!session || session.reservationPublicId !== payload.rid) {
    throw new ApiError(404, "not_found", "That booking could not be found.");
  }

  request.observability.recordSecurityEvent({
    name: "staff_deposit_link_used",
    severity: "info",
    route: "/api/staff/deposit-review",
    bookingSessionId: session.id,
  });

  return { payload, session };
}

function requireRepository<T>(repository: T | undefined, label: string): T {
  if (!repository) {
    throw new ApiError(503, "database_unavailable", `${label} is not configured.`, { retryable: true });
  }
  return repository;
}

function renderSummary(session: BookingSessionRecord, propertyName: string | undefined, receiptUrl?: string): string {
  const rows: Array<[string, string]> = [
    ["Reservation", session.reservationPublicId],
    ["Property", propertyName ?? "—"],
    ["Arrival", session.arrivalDate],
    ["Departure", session.departureDate],
    ["Guests", String(session.guests)],
    ["Total", session.totalAmountCents !== undefined && session.currency ? `${session.currency} ${(session.totalAmountCents / 100).toFixed(2)}` : "—"],
    ["Guest", session.guest ? `${session.guest.firstName} ${session.guest.lastName} · ${session.guest.email}` : "—"],
    ["Hold expires", session.expiresAt ?? "—"],
  ];

  const rowsHtml = rows
    .map(([label, value]) => `<tr><th>${escapeHtml(label)}</th><td>${escapeHtml(value)}</td></tr>`)
    .join("\n");

  const receiptHtml = receiptUrl
    ? `<p><a href="${escapeHtml(receiptUrl)}" target="_blank" rel="noopener noreferrer">View uploaded receipt</a></p>`
    : `<p class="note">No receipt uploaded yet.</p>`;

  return `<table>${rowsHtml}</table>${receiptHtml}`;
}

function renderPage(input: { heading: string; body: string }): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${escapeHtml(input.heading)} · ${SITE_NAME}</title>
<style>
  body { margin:0; padding:32px 16px; background:#f5f5f5; font-family:system-ui,-apple-system,'Segoe UI',sans-serif; color:#171717; }
  main { max-width:640px; margin:0 auto; background:#fff; border-radius:12px; overflow:hidden; }
  header { background:#0B3028; color:#fff; padding:20px 28px; font-size:20px; font-weight:700; letter-spacing:1px; }
  section { padding:28px; }
  h1 { font-size:22px; margin:0 0 16px; color:#0B3028; }
  table { border-collapse:collapse; width:100%; margin:0 0 20px; }
  th { text-align:left; padding:6px 16px 6px 0; color:#555; font-weight:500; white-space:nowrap; vertical-align:top; }
  td { padding:6px 0; font-weight:600; }
  button { border:0; border-radius:8px; padding:14px 22px; font-size:16px; font-weight:700; color:#fff; cursor:pointer; }
  button.primary { background:#294F44; }
  button.danger { background:#b03a2e; }
  a { color:#294F44; }
  .note { color:#888; font-size:13px; }
</style>
</head>
<body>
<main>
  <header>${SITE_NAME}</header>
  <section>
    <h1>${escapeHtml(input.heading)}</h1>
    ${input.body}
  </section>
</main>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
