/**
 * depositHolds.ts — POST /api/deposit-holds
 *
 * Manual-deposit guests (bank transfer / SINPE) now get a real booking, not a
 * contact handoff: guest details, a portal password, and a Smoobu blocked-channel
 * reservation that takes the dates off sale while the transfer clears.
 *
 * The booking stays `hold_active` until staff confirm the money arrived via the
 * signed link in their notification email. If nobody confirms, the existing
 * hold-expiry worker releases it — deposit holds deliberately reuse the PayPal
 * lifecycle so that worker needs no changes.
 */

import { BookingSessionRecord } from "./bookingSessions";
import { SITE_NAME } from "./branding";
import { buildBankInfo, DepositBankInfo } from "./depositHandoff";
import { createEmailClient } from "./email";
import { ApiError } from "./http/errors";
import { checkInInstantMs } from "./cancellationPolicy";
import { createSmoobuBackedHold } from "./holds";
import { BookingProperty } from "./propertyCatalog";
import { issueSignedToken } from "./signedTokens";
import { ApiResponse, BookingApiConfig, RouteRequest } from "./types";
import { HoldRequest } from "./validation";

const DEPOSIT_HOLD_IDEMPOTENCY_SCOPE = "booking.deposit_hold.create";

/** A deposit access token only needs to outlive the upload step. */
const DEPOSIT_ACCESS_TOKEN_TTL_SECONDS = 24 * 60 * 60;

export async function handleCreateDepositHold(
  holdRequest: HoldRequest,
  request: RouteRequest,
  config: BookingApiConfig
): Promise<ApiResponse> {
  const deposit = requireDepositConfig(config);

  return createSmoobuBackedHold(
    {
      paymentMethod: "manual_deposit",
      // Deposit bookings are always on the flexible rate. The non-refundable
      // discount is tied to immediate PayPal capture.
      ratePlan: "flexible",
      idempotencyScope: DEPOSIT_HOLD_IDEMPOTENCY_SCOPE,
      ttlMsFor: (session) => depositHoldTtlMs(deposit.holdTtlHours, session.arrivalDate),
      noticePrefix: `${SITE_NAME} manual deposit hold.`,
      noticeCaveat: "Awaiting bank transfer / SINPE. Not confirmed until staff verify the deposit.",
      allowNonRefundable: false,
      async finalize({ session, property, config: cfg, request: req }) {
        const { portalSessionSecret } = await cfg.secrets.getSecrets();

        // Scoped to this booking session, so the guest can attach a receipt
        // before the booking is confirmed and portal login becomes available.
        const depositAccessToken = issueSignedToken(
          {
            bookingSessionId: session.id,
            reservationPublicId: session.reservationPublicId,
            purpose: "deposit_access",
            ttlSeconds: DEPOSIT_ACCESS_TOKEN_TTL_SECONDS,
          },
          portalSessionSecret
        );

        const bankInfo = buildBankInfo(cfg, property);

        await sendDepositNotifications({
          session,
          property,
          bankInfo,
          config: cfg,
          request: req,
          portalSessionSecret,
        });

        return {
          payment: { method: "manual_deposit", status: "pending" },
          bankInfo,
          depositAccessToken,
          depositAccessTokenExpiresInSeconds: DEPOSIT_ACCESS_TOKEN_TTL_SECONDS,
          nextAction: "upload_deposit_receipt",
        };
      },
    },
    holdRequest,
    request,
    config
  );
}

/**
 * A deposit hold blocks the property on every channel, so a long TTL on a stay
 * that is imminent is a real cost. Never hold past half the time remaining until
 * check-in, and never longer than the configured maximum.
 */
export function depositHoldTtlMs(configuredHours: number, arrivalDate: string | undefined, nowMs = Date.now()): number {
  const configuredMs = configuredHours * 60 * 60 * 1000;
  if (!arrivalDate) {
    return configuredMs;
  }

  const msUntilCheckIn = checkInInstantMs(arrivalDate) - nowMs;
  if (!Number.isFinite(msUntilCheckIn) || msUntilCheckIn <= 0) {
    return configuredMs;
  }

  // Floor of one hour so a last-minute booking still has a usable window.
  return Math.max(60 * 60 * 1000, Math.min(configuredMs, Math.floor(msUntilCheckIn / 2)));
}

async function sendDepositNotifications(input: {
  session: BookingSessionRecord;
  property: BookingProperty;
  bankInfo: DepositBankInfo;
  config: BookingApiConfig;
  request: RouteRequest;
  portalSessionSecret: string;
}): Promise<void> {
  const { session, property, bankInfo, config, request, portalSessionSecret } = input;
  const deposit = requireDepositConfig(config);
  const emailClient = createEmailClient(config.email, request.observability.logger);

  // Non-fatal: the hold exists and the dates are blocked. A mail failure must
  // not roll that back, but staff need to know it happened.
  try {
    await emailClient.sendDepositInstructions(session, property.name, bankInfo);
  } catch (error) {
    request.observability.logger.error("deposit_instructions_email_failed", {
      bookingSessionId: session.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  try {
    const confirmUrl = buildStaffActionUrl(deposit.staffConfirmBaseUrl, "confirm", session, portalSessionSecret, deposit.confirmTokenTtlHours);
    const rejectUrl = buildStaffActionUrl(deposit.staffConfirmBaseUrl, "reject", session, portalSessionSecret, deposit.confirmTokenTtlHours);

    await emailClient.sendStaffDepositReview(session, property.name, {
      confirmUrl,
      rejectUrl,
      bankInfo,
    });
  } catch (error) {
    request.observability.logger.error("staff_deposit_review_email_failed", {
      bookingSessionId: session.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export function buildStaffActionUrl(
  baseUrl: string,
  action: "confirm" | "reject",
  session: BookingSessionRecord,
  portalSessionSecret: string,
  ttlHours: number
): string {
  const token = issueSignedToken(
    {
      bookingSessionId: session.id,
      reservationPublicId: session.reservationPublicId,
      purpose: action === "confirm" ? "deposit_confirm" : "deposit_reject",
      ttlSeconds: ttlHours * 60 * 60,
    },
    portalSessionSecret
  );

  // The token goes in a path segment, not a query string: base64url contains no
  // "/", the router decodes each segment, and it keeps the secret out of query
  // strings that other middleware deliberately rejects.
  return `${baseUrl.replace(/\/+$/, "")}/api/staff/deposit-review/${encodeURIComponent(token)}`;
}

function requireDepositConfig(config: BookingApiConfig) {
  if (!config.deposit) {
    throw new ApiError(503, "deposit_not_configured", "Manual deposit bookings are not configured.", {
      retryable: false,
    });
  }
  return config.deposit;
}
