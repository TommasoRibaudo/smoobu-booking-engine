import { createEmailClient } from "./email";
import { ApiError } from "./http/errors";
import { jsonResponse } from "./http/response";
import { BookingProperty, BOOKING_PROPERTIES_BY_ID, listingUrlForLanguage } from "./propertyCatalog";
import { ApiResponse, BookingApiConfig, DepositBankAccountConfig, HeadersMap, RouteObservability } from "./types";

export interface DepositHandoffQuery {
  language: "en" | "es";
  quoteId?: string;
  propertyId?: string;
}

export interface DepositHandoffEventRequest {
  quoteId: string;
  propertyId: string;
  language: "en" | "es";
  contactMethod: string;
  analyticsConsent: boolean;
}

const DEFAULT_WHATSAPP_URL = "https://wa.me/contact";
const DEFAULT_CONTACT_EMAIL = "reservations@example.com";

interface ContactMethod {
  type: string;
  label: string;
  url: string;
}

function buildContactMethods(config: BookingApiConfig): ContactMethod[] {
  const whatsappUrl = config.email.contactWhatsAppUrl ?? DEFAULT_WHATSAPP_URL;
  const contactEmail = config.email.contactEmail ?? DEFAULT_CONTACT_EMAIL;
  return [
    { type: "whatsapp", label: whatsappUrl, url: whatsappUrl },
    { type: "email", label: contactEmail, url: `mailto:${contactEmail}` },
  ];
}

// ---------------------------------------------------------------------------
// Bank transfer / SINPE payment details
// ---------------------------------------------------------------------------

export interface DepositBankInfo {
  sinpePhone?: string;
  sinpeName?: string;
  bankAccount: {
    accountHolder: string;
    primaryAccountLabel: string;
    primaryAccount: string;
    secondaryAccountLabel?: string;
    secondaryAccount?: string;
  };
}

/**
 * Bank/SINPE details are entirely deployment-specific — see the
 * `DEPOSIT_BANK_*` and `DEPOSIT_SINPE_*` env vars in config.ts, plus the
 * optional per-property `DEPOSIT_BANK_ACCOUNTS_BY_SLUG_JSON` override for
 * portfolios that settle different properties into different accounts.
 *
 * With nothing configured this falls back to a visible placeholder instead of
 * failing closed, since the manual-deposit flow is optional and a deployment
 * may not use it at all.
 */
const UNCONFIGURED_BANK_ACCOUNT: DepositBankAccountConfig = {
  accountHolder: "Set DEPOSIT_BANK_ACCOUNT_HOLDER",
  primaryAccountLabel: "Bank account",
  primaryAccount: "Set DEPOSIT_BANK_PRIMARY_ACCOUNT",
};

function bankAccountForProperty(config: BookingApiConfig, property: BookingProperty | undefined): DepositBankAccountConfig {
  const bySlug = property ? config.deposit?.bankByPropertySlug?.[property.slug] : undefined;
  return bySlug ?? config.deposit?.bank ?? UNCONFIGURED_BANK_ACCOUNT;
}

export function buildBankInfo(config: BookingApiConfig, property: BookingProperty | undefined): DepositBankInfo {
  const account = bankAccountForProperty(config, property);
  return {
    sinpePhone: account.sinpePhone,
    sinpeName: account.sinpeName,
    bankAccount: {
      accountHolder: account.accountHolder,
      primaryAccountLabel: account.primaryAccountLabel,
      primaryAccount: account.primaryAccount,
      secondaryAccountLabel: account.secondaryAccountLabel,
      secondaryAccount: account.secondaryAccount,
    },
  };
}

export async function handleManualDepositHandoff(
  query: DepositHandoffQuery,
  config: BookingApiConfig,
  responseHeaders: HeadersMap,
  observability: RouteObservability
): Promise<ApiResponse> {
  const bookingContext = await buildBookingContext(query, config);
  const property = query.propertyId ? BOOKING_PROPERTIES_BY_ID.get(query.propertyId) : undefined;
  const bankInfo = buildBankInfo(config, property);
  const contactMethods = buildContactMethods(config);

  observability.logger.info("manual_deposit_handoff_instructions_served", {
    language: query.language,
    quoteId: query.quoteId,
    propertyId: query.propertyId,
    hasBookingContext: Boolean(bookingContext),
    bankAccountHolder: bankInfo.bankAccount.accountHolder,
  });

  return jsonResponse(
    200,
    {
      language: query.language,
      status: "manual_deposit_handoff",
      isBookingConfirmed: false,
      doesCreateHold: false,
      messageKey: "deposit.handoffIntro",
      instructions: {
        titleKey: "deposit.title",
        bodyKeys: [
          "deposit.bankTransferInstructions",
          "deposit.uploadReceiptNote",
          "deposit.staffWillConfirm",
          "deposit.contactUs",
        ],
        contactMethods,
      },
      bankInfo,
      ...(bookingContext ? { bookingContext } : {}),
    },
    responseHeaders
  );
}

export async function handleManualDepositHandoffEvent(
  event: DepositHandoffEventRequest,
  config: BookingApiConfig,
  responseHeaders: HeadersMap,
  observability: RouteObservability
): Promise<ApiResponse> {
  const contactMethods = buildContactMethods(config);
  const contactMethod = contactMethods.find((method) => method.type === event.contactMethod);
  if (!contactMethod) {
    throw new ApiError(400, "unsupported_contact_method", "Manual deposit contact method is not supported.", {
      fieldErrors: {
        contactMethod: ["unsupported_contact_method"],
      },
    });
  }

  const bookingContext = await buildBookingContext({ quoteId: event.quoteId, propertyId: event.propertyId, language: event.language }, config);
  const eventName = "manual_deposit_handoff_clicked";

  observability.logger.info(event.analyticsConsent ? eventName : "manual_deposit_handoff_clicked_no_analytics_consent", {
    eventName,
    analyticsConsent: event.analyticsConsent,
    language: event.language,
    quoteId: event.quoteId,
    propertyId: event.propertyId,
    contactMethod: contactMethod.type,
    staffNotificationChannel: "existing_contact_link",
    hasBookingContext: Boolean(bookingContext),
  });

  // Send deposit handoff email — non-fatal
  if (bookingContext) {
    try {
      const repository = config.bookingSessions;
  if (!repository) {
    throw new ApiError(503, "database_unavailable", "Booking storage is not configured.", { retryable: true });
  }
      const session = event.quoteId ? await repository.getByQuoteId(event.quoteId) : undefined;
      const guestEmail = session?.guest?.email;
      const guestFirstName = session?.guest?.firstName ?? "";
      if (guestEmail) {
        const property = event.propertyId ? BOOKING_PROPERTIES_BY_ID.get(event.propertyId) : undefined;
        const emailClient = createEmailClient(config.email, observability.logger);
        await emailClient.sendDepositHandoff(
          guestEmail,
          guestFirstName,
          event.language,
          property?.name ?? "",
          session?.arrivalDate ?? "",
          session?.departureDate ?? "",
          session?.guests ?? 0
        );
      }
    } catch (emailError) {
      observability.logger.error("deposit_handoff_email_failed", {
        error: emailError instanceof Error ? emailError.message : String(emailError),
        quoteId: event.quoteId,
      });
    }
  }

  return jsonResponse(
    200,
    {
      recorded: true,
      status: "manual_deposit_handoff",
      isBookingConfirmed: false,
      doesCreateHold: false,
      messageKey: "deposit.contactEventRecorded",
    },
    responseHeaders
  );
}

async function buildBookingContext(query: DepositHandoffQuery, config: BookingApiConfig) {
  const repository = config.bookingSessions;
  if (!repository) {
    throw new ApiError(503, "database_unavailable", "Booking storage is not configured.", { retryable: true });
  }
  const session = query.quoteId ? await repository.getByQuoteId(query.quoteId) : undefined;
  const property = query.propertyId ? BOOKING_PROPERTIES_BY_ID.get(query.propertyId) : undefined;

  if (query.propertyId && !property) {
    throw new ApiError(404, "deposit_context_not_found", "Manual deposit context was not found.");
  }

  if (session && property && !session.quotedProperties.some((quoted) => quoted.propertyId === property.propertyId)) {
    throw new ApiError(404, "deposit_context_not_found", "Manual deposit context was not found.");
  }

  if (!query.quoteId && !property) {
    return undefined;
  }

  return {
    ...(query.quoteId ? { quoteId: query.quoteId } : {}),
    ...(property
      ? {
          property: {
            propertyId: property.propertyId,
            slug: property.slug,
            listingUrl: listingUrlForLanguage(property.slug, query.language),
            name: property.name,
          },
        }
      : {}),
    ...(session
      ? {
          arrivalDate: session.arrivalDate,
          departureDate: session.departureDate,
          guests: session.guests,
        }
      : {}),
  };
}
