/**
 * emailTemplates.ts
 *
 * Bilingual (EN/ES) email templates for each booking state transition.
 * Each template returns { subject, html, text } ready for SES SendEmail.
 *
 * Templates are intentionally plain HTML — no external dependencies.
 */

import type { BookingLanguage } from "./bookingSessions";
import { SITE_NAME } from "./branding";

export interface EmailTemplateInput {
  language: BookingLanguage;
  guestFirstName: string;
  guestEmail: string;
  reservationPublicId: string;
  propertyName: string;
  arrivalDate: string;
  departureDate: string;
  guests: number;
  currency?: string;
  totalAmountCents?: number;
  holdExpiresAt?: string;
  paypalOrderId?: string;
  paypalCaptureId?: string;
  confirmedAt?: string;
  cancellationReason?: string;
  /**
   * Whether a refund is owed for a cancellation. Defaults to true when a capture
   * id is present; set false for cancellations inside the no-refund window.
   */
  refundExpected?: boolean;
  /** Manual deposit flow — SINPE and bank account details shown to the guest. */
  bankInfo?: {
    sinpePhone?: string;
    sinpeName?: string;
    bankAccount: {
      accountHolder: string;
      primaryAccountLabel: string;
      primaryAccount: string;
      secondaryAccountLabel?: string;
      secondaryAccount?: string;
    };
  };
  /** Where the guest uploads their transfer receipt. */
  depositUploadUrl?: string;
  /** Presigned link to an uploaded receipt, for the staff review email. */
  depositReceiptUrl?: string;
  /** Signed one-click staff links. */
  depositConfirmUrl?: string;
  depositRejectUrl?: string;
  /** Override default WhatsApp contact URL (falls back to config/env default) */
  contactWhatsApp?: string;
  /** Override default contact email address (falls back to config/env default) */
  contactEmail?: string;
  /** Free-text guest message — portal help/cancellation requests. HTML-escaped by the renderer, not the caller. */
  guestMessage?: string;
  /** Optional category the guest picked for a help request (e.g. "general", "maintenance"). */
  helpRequestType?: string;
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

// ─── String maps ──────────────────────────────────────────────────────────────

const strings = {
  en: {
    greeting: (name: string) => `Hi ${name},`,
    footer: `${SITE_NAME} · manage your reservation online`,
    reservationId: "Reservation ID",
    property: "Property",
    arrival: "Arrival",
    departure: "Departure",
    guests: "Guests",
    totalAmount: "Total",
    holdExpires: "Hold expires",
    paypalOrderId: "PayPal Order",
    paypalCaptureId: "PayPal Capture",
    confirmedAt: "Confirmed at",

    holdCreated: {
      subject: (id: string) => `Your hold is active: ${id}`,
      intro: "Your hold is active, so the dates are yours for now.",
      cta: "Complete your PayPal payment before the hold expires and the booking is confirmed.",
      warning: "If the hold expires, the dates go back on sale and you will have to start a new search.",
    },
    paymentPending: {
      subject: (id: string) => `Complete your payment: ${id}`,
      intro: "We created your PayPal order. Approve the payment and your booking is confirmed.",
      cta: "Return to the booking page to approve your PayPal payment.",
      warning: "The hold expires if you do not complete the payment in time.",
    },
    confirmed: {
      subject: (id: string) => `Booking confirmed: ${id}`,
      intro: "Your booking is confirmed. We look forward to welcoming you to Puerto Viejo!",
      cta: "You can view your reservation with your reservation ID and the password you set at checkout.",
      note: "If you have any questions, please contact us at reservations@example.com or via WhatsApp.",
    },
    cancelled: {
      subject: (id: string) => `Reservation cancelled: ${id}`,
      intro: "Your reservation hold has expired or been cancelled.",
      cta: "You are welcome to search for new dates on our website.",
      note: "If you believe this is an error, please contact us.",
    },
    depositHandoff: {
      subject: `Manual deposit instructions from ${SITE_NAME}`,
      intro: `Thanks for your interest in booking with ${SITE_NAME}. Three steps complete your reservation by manual deposit.`,
      step1: "Contact us via WhatsApp or email to confirm availability and receive bank transfer details.",
      step2: "Transfer the deposit amount and send us proof of payment.",
      step3: "Our team will confirm your booking directly in our system.",
      warning: "Your booking is NOT confirmed until our team verifies your deposit and confirms it manually.",
      contactLabel: "Contact us",
    },
    cancellationReason: "Reason",
    bankTransfer: "Bank transfer",
    sinpe: "SINPE Móvil",
    accountHolder: "Account holder",
    alternateAccount: "Alternate account",
    depositInstructions: {
      subject: (id: string) => `Complete your bank transfer: ${id}`,
      intro:
        "We are holding your dates while you complete the transfer. Send the amount below by bank transfer or SINPE Móvil, then upload your receipt so our team can verify it.",
      warning:
        "Your dates are held only until the time shown above. If we have not confirmed the transfer by then, the hold is released and the property goes back on sale.",
      uploadCta: "Upload your receipt",
      note: "Once our team confirms the payment we will email you the confirmation and your portal access.",
    },
    depositConfirmed: {
      subject: (id: string) => `Booking confirmed: ${id}`,
      intro: "We have verified your deposit and your booking is confirmed. We look forward to welcoming you!",
      portalCta:
        "You can now manage your booking online using your reservation ID and the password you chose during checkout.",
      note: "If anything about your stay changes, contact us and we will help.",
    },
    staffDepositReview: {
      subject: (id: string) => `[ACTION] Deposit booking awaiting confirmation: ${id}`,
      intro:
        "A guest booked by bank transfer / SINPE. The dates are held in Smoobu on the blocked channel until you confirm or reject.",
      action: "Confirm once the money has landed. Rejecting releases the hold and frees the dates immediately.",
      receiptLabel: "Uploaded receipt",
      noReceipt: "No receipt uploaded yet.",
      guestContact: "Guest contact",
      confirmLabel: "Review and confirm",
      rejectLabel: "Reject and release the dates",
    },
    guestCancelled: {
      subject: (id: string) => `Your booking is cancelled: ${id}`,
      intro: "We cancelled your booking as you asked. The dates are back on sale and we will not charge you again.",
      refundPending:
        "Our team issues refunds by hand, back to the PayPal account you paid with. It can take a few business days to appear.",
      noRefund: "This booking was cancelled within 24 hours of check-in, so no refund applies.",
      note: "If you did not request this cancellation, please contact us straight away.",
    },
    staffCancelled: {
      subject: (id: string) => `[ACTION] Guest cancelled ${id}: refund required`,
      intro: "A guest cancelled their booking through the guest portal. The Smoobu reservation has already been cancelled and the dates released.",
      action: "Issue the refund in PayPal for the capture below. The payment is flagged as refund_flagged until you do.",
      noRefundAction: "No refund is due. The guest cancelled inside the 24-hour window.",
      guestContact: "Guest contact",
    },
    staffHelpRequest: {
      subject: (id: string) => `Help request: ${id}`,
      intro: "A guest sent a message through their booking portal.",
      typeLabel: "Type",
      messageLabel: "Message",
      guestContact: "Guest contact",
    },
    staffCancellationRequest: {
      subject: (id: string) => `[ACTION] Cancellation request: ${id}`,
      intro: "A guest asked to cancel their confirmed booking through the portal. This is a request, not a self-service cancellation — the booking is still active and Smoobu has not been touched.",
      reasonLabel: "Reason",
      messageLabel: "Message",
      guestContact: "Guest contact",
      action: "Follow up with the guest and process the cancellation by hand if appropriate.",
    },
  },
  es: {
    greeting: (name: string) => `Hola ${name},`,
    footer: `${SITE_NAME} · gestiona tu reserva en línea`,
    reservationId: "ID de reserva",
    property: "Propiedad",
    arrival: "Llegada",
    departure: "Salida",
    guests: "Huéspedes",
    totalAmount: "Total",
    holdExpires: "La reserva expira",
    paypalOrderId: "Orden PayPal",
    paypalCaptureId: "Captura PayPal",
    confirmedAt: "Confirmado el",

    holdCreated: {
      subject: (id: string) => `Tu reserva está activa: ${id}`,
      intro: "Tu reserva provisional está activa, así que las fechas son tuyas por ahora.",
      cta: "Completa el pago con PayPal antes de que expire la reserva y tu estadía queda confirmada.",
      warning: "Si la reserva expira, las fechas vuelven a estar disponibles y tendrás que empezar una nueva búsqueda.",
    },
    paymentPending: {
      subject: (id: string) => `Completa tu pago: ${id}`,
      intro: "Creamos tu orden de PayPal. Aprueba el pago y tu reserva queda confirmada.",
      cta: "Regresa a la página de reserva para aprobar tu pago con PayPal.",
      warning: "La reserva expira si no completas el pago a tiempo.",
    },
    confirmed: {
      subject: (id: string) => `Reserva confirmada: ${id}`,
      intro: "¡Tu reserva está confirmada! Esperamos darte la bienvenida en Puerto Viejo.",
      cta: "Puedes ver tu reserva con tu ID de reserva y la contraseña que creaste al reservar.",
      note: "Si tienes alguna pregunta, contáctanos en reservations@example.com o por WhatsApp.",
    },
    cancelled: {
      subject: (id: string) => `Reserva cancelada: ${id}`,
      intro: "Tu reserva provisional ha expirado o ha sido cancelada.",
      cta: "Puedes buscar nuevas fechas en nuestro sitio web.",
      note: "Si crees que esto es un error, por favor contáctanos.",
    },
    depositHandoff: {
      subject: `Instrucciones de depósito manual de ${SITE_NAME}`,
      intro: `Gracias por tu interés en reservar con ${SITE_NAME}. Tres pasos completan tu reserva por depósito manual.`,
      step1: "Contáctanos por WhatsApp o correo electrónico para confirmar disponibilidad y recibir los datos bancarios.",
      step2: "Realiza la transferencia del depósito y envíanos el comprobante de pago.",
      step3: "Nuestro equipo confirmará tu reserva directamente en nuestro sistema.",
      warning: "Tu reserva NO está confirmada hasta que nuestro equipo verifique tu depósito y lo confirme manualmente.",
      contactLabel: "Contáctanos",
    },
    cancellationReason: "Motivo",
    bankTransfer: "Transferencia bancaria",
    sinpe: "SINPE Móvil",
    accountHolder: "Titular de la cuenta",
    alternateAccount: "Cuenta alterna",
    depositInstructions: {
      subject: (id: string) => `Completa tu transferencia: ${id}`,
      intro:
        "Estamos reservando tus fechas mientras completas la transferencia. Envía el monto indicado por transferencia bancaria o SINPE Móvil y luego sube tu comprobante para que nuestro equipo lo verifique.",
      warning:
        "Tus fechas quedan reservadas solo hasta la hora indicada arriba. Si no confirmamos la transferencia antes, la reserva se libera y la propiedad vuelve a estar disponible.",
      uploadCta: "Sube tu comprobante",
      note: "Cuando nuestro equipo confirme el pago te enviaremos la confirmación y el acceso a tu portal.",
    },
    depositConfirmed: {
      subject: (id: string) => `Reserva confirmada: ${id}`,
      intro: "Hemos verificado tu depósito y tu reserva está confirmada. ¡Te esperamos!",
      portalCta:
        "Ya puedes gestionar tu reserva en línea con tu ID de reserva y la contraseña que elegiste durante el proceso de pago.",
      note: "Si algo cambia en tu estadía, contáctanos y te ayudamos.",
    },
    staffDepositReview: {
      subject: (id: string) => `[ACCIÓN] Reserva por depósito pendiente de confirmar: ${id}`,
      intro:
        "Un huésped reservó por transferencia / SINPE. Las fechas están bloqueadas en Smoobu en el canal Blocked hasta que confirmes o rechaces.",
      action: "Confirma cuando el dinero haya ingresado. Rechazar libera la reserva y las fechas de inmediato.",
      receiptLabel: "Comprobante subido",
      noReceipt: "Aún no se ha subido comprobante.",
      guestContact: "Contacto del huésped",
      confirmLabel: "Revisar y confirmar",
      rejectLabel: "Rechazar y liberar las fechas",
    },
    guestCancelled: {
      subject: (id: string) => `Cancelamos tu reserva: ${id}`,
      intro: "Cancelamos tu reserva como lo pediste. Las fechas quedaron liberadas y no te volveremos a cobrar.",
      refundPending:
        "Nuestro equipo procesa los reembolsos a mano y lo devolverá a la cuenta de PayPal con la que pagaste. Puede tardar algunos días hábiles en reflejarse.",
      noRefund: "Esta reserva se canceló dentro de las 24 horas previas al check-in, así que no corresponde reembolso.",
      note: "Si no solicitaste esta cancelación, contáctanos de inmediato.",
    },
    staffCancelled: {
      subject: (id: string) => `[ACCIÓN] Huésped canceló ${id}: reembolso requerido`,
      intro: "Un huésped canceló su reserva desde el portal. La reserva en Smoobu ya fue cancelada y las fechas quedaron liberadas.",
      action: "Emite el reembolso en PayPal para la captura indicada abajo. El pago queda marcado como refund_flagged hasta que lo hagas.",
      noRefundAction: "No corresponde reembolso. El huésped canceló dentro de la ventana de 24 horas.",
      guestContact: "Contacto del huésped",
    },
    staffHelpRequest: {
      subject: (id: string) => `Solicitud de ayuda: ${id}`,
      intro: "Un huésped envió un mensaje desde el portal de su reserva.",
      typeLabel: "Tipo",
      messageLabel: "Mensaje",
      guestContact: "Contacto del huésped",
    },
    staffCancellationRequest: {
      subject: (id: string) => `[ACCIÓN] Solicitud de cancelación: ${id}`,
      intro: "Un huésped solicitó cancelar su reserva confirmada desde el portal. Esto es una solicitud, no una cancelación automática — la reserva sigue activa y no se ha tocado Smoobu.",
      reasonLabel: "Motivo",
      messageLabel: "Mensaje",
      guestContact: "Contacto del huésped",
      action: "Da seguimiento al huésped y procesa la cancelación manualmente si corresponde.",
    },
  },
} as const;

// ─── Shared layout ────────────────────────────────────────────────────────────

/**
 * Escapes free-text guest input before it goes into an HTML email body.
 * Every other field these templates interpolate is bounded/structured (IDs,
 * dates, amounts); the portal help/cancellation message is arbitrary text a
 * guest typed, so it's the one field here that genuinely needs this.
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatAmount(cents: number, currency: string): string {
  return `${currency} ${(cents / 100).toFixed(2)}`;
}

function formatDate(isoDate: string): string {
  // isoDate may be YYYY-MM-DD or full ISO timestamp
  return isoDate.slice(0, 10);
}

function detailsTable(rows: Array<[string, string]>): string {
  const rowsHtml = rows
    .map(([label, value]) => `<tr><td style="padding:4px 12px 4px 0;color:#555;white-space:nowrap">${label}</td><td style="padding:4px 0;color:#171717;font-weight:600">${value}</td></tr>`)
    .join("\n");
  return `<table style="border-collapse:collapse;margin:16px 0">${rowsHtml}</table>`;
}

function detailsText(rows: Array<[string, string]>): string {
  return rows.map(([label, value]) => `${label}: ${value}`).join("\n");
}

function layout(body: string, footer: string, language: string): string {
  return `<!DOCTYPE html>
<html lang="${language}">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:'Urbanist',Arial,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;padding:32px 0">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px;overflow:hidden;max-width:600px;width:100%">
  <tr><td style="background:#0B3028;padding:24px 32px">
    <span style="color:#ffffff;font-size:22px;font-weight:700;letter-spacing:1px">${SITE_NAME}</span>
  </td></tr>
  <tr><td style="padding:32px;color:#171717;font-size:15px;line-height:1.6">
    ${body}
  </td></tr>
  <tr><td style="background:#f0f0f0;padding:16px 32px;color:#888;font-size:12px;text-align:center">
    ${footer}
  </td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}

// ─── Template: hold_created ───────────────────────────────────────────────────

export function renderHoldCreatedEmail(input: EmailTemplateInput): RenderedEmail {
  const s = strings[input.language];
  const t = s.holdCreated;

  const rows: Array<[string, string]> = [
    [s.reservationId, input.reservationPublicId],
    [s.property, input.propertyName],
    [s.arrival, formatDate(input.arrivalDate)],
    [s.departure, formatDate(input.departureDate)],
    [s.guests, String(input.guests)],
    ...(input.totalAmountCents !== undefined && input.currency
      ? [[s.totalAmount, formatAmount(input.totalAmountCents, input.currency)] as [string, string]]
      : []),
    ...(input.holdExpiresAt
      ? [[s.holdExpires, formatDate(input.holdExpiresAt)] as [string, string]]
      : []),
  ];

  const html = layout(
    `<p>${s.greeting(input.guestFirstName)}</p>
<p>${t.intro}</p>
${detailsTable(rows)}
<p style="color:#294F44;font-weight:600">${t.cta}</p>
<p style="color:#888;font-size:13px">${t.warning}</p>`,
    s.footer,
    input.language
  );

  const text = [
    s.greeting(input.guestFirstName),
    "",
    t.intro,
    "",
    detailsText(rows),
    "",
    t.cta,
    "",
    t.warning,
    "",
    s.footer,
  ].join("\n");

  return { subject: t.subject(input.reservationPublicId), html, text };
}

// ─── Template: payment_pending ────────────────────────────────────────────────

export function renderPaymentPendingEmail(input: EmailTemplateInput): RenderedEmail {
  const s = strings[input.language];
  const t = s.paymentPending;

  const rows: Array<[string, string]> = [
    [s.reservationId, input.reservationPublicId],
    [s.property, input.propertyName],
    [s.arrival, formatDate(input.arrivalDate)],
    [s.departure, formatDate(input.departureDate)],
    [s.guests, String(input.guests)],
    ...(input.totalAmountCents !== undefined && input.currency
      ? [[s.totalAmount, formatAmount(input.totalAmountCents, input.currency)] as [string, string]]
      : []),
    ...(input.paypalOrderId
      ? [[s.paypalOrderId, input.paypalOrderId] as [string, string]]
      : []),
    ...(input.holdExpiresAt
      ? [[s.holdExpires, formatDate(input.holdExpiresAt)] as [string, string]]
      : []),
  ];

  const html = layout(
    `<p>${s.greeting(input.guestFirstName)}</p>
<p>${t.intro}</p>
${detailsTable(rows)}
<p style="color:#294F44;font-weight:600">${t.cta}</p>
<p style="color:#888;font-size:13px">${t.warning}</p>`,
    s.footer,
    input.language
  );

  const text = [
    s.greeting(input.guestFirstName),
    "",
    t.intro,
    "",
    detailsText(rows),
    "",
    t.cta,
    "",
    t.warning,
    "",
    s.footer,
  ].join("\n");

  return { subject: t.subject(input.reservationPublicId), html, text };
}

// ─── Template: booking_confirmed ─────────────────────────────────────────────

export function renderBookingConfirmedEmail(input: EmailTemplateInput): RenderedEmail {
  const s = strings[input.language];
  const t = s.confirmed;

  const rows: Array<[string, string]> = [
    [s.reservationId, input.reservationPublicId],
    [s.property, input.propertyName],
    [s.arrival, formatDate(input.arrivalDate)],
    [s.departure, formatDate(input.departureDate)],
    [s.guests, String(input.guests)],
    ...(input.totalAmountCents !== undefined && input.currency
      ? [[s.totalAmount, formatAmount(input.totalAmountCents, input.currency)] as [string, string]]
      : []),
    ...(input.paypalCaptureId
      ? [[s.paypalCaptureId, input.paypalCaptureId] as [string, string]]
      : []),
    ...(input.confirmedAt
      ? [[s.confirmedAt, formatDate(input.confirmedAt)] as [string, string]]
      : []),
  ];

  const html = layout(
    `<p>${s.greeting(input.guestFirstName)}</p>
<p>${t.intro}</p>
${detailsTable(rows)}
<p style="color:#294F44;font-weight:600">${t.cta}</p>
<p style="color:#888;font-size:13px">${t.note}</p>`,
    s.footer,
    input.language
  );

  const text = [
    s.greeting(input.guestFirstName),
    "",
    t.intro,
    "",
    detailsText(rows),
    "",
    t.cta,
    "",
    t.note,
    "",
    s.footer,
  ].join("\n");

  return { subject: t.subject(input.reservationPublicId), html, text };
}

// ─── Template: cancelled / hold_expired ──────────────────────────────────────

export function renderCancelledEmail(input: EmailTemplateInput): RenderedEmail {
  const s = strings[input.language];
  const t = s.cancelled;

  const rows: Array<[string, string]> = [
    [s.reservationId, input.reservationPublicId],
    [s.property, input.propertyName],
    [s.arrival, formatDate(input.arrivalDate)],
    [s.departure, formatDate(input.departureDate)],
  ];

  const html = layout(
    `<p>${s.greeting(input.guestFirstName)}</p>
<p>${t.intro}</p>
${detailsTable(rows)}
<p style="color:#294F44;font-weight:600">${t.cta}</p>
<p style="color:#888;font-size:13px">${t.note}</p>`,
    s.footer,
    input.language
  );

  const text = [
    s.greeting(input.guestFirstName),
    "",
    t.intro,
    "",
    detailsText(rows),
    "",
    t.cta,
    "",
    t.note,
    "",
    s.footer,
  ].join("\n");

  return { subject: t.subject(input.reservationPublicId), html, text };
}

// ─── Template: deposit_instructions ──────────────────────────────────────────

/**
 * Guest-facing, sent when a deposit hold is created.
 *
 * Replaces renderDepositHandoffEmail for the new flow — that one told the guest
 * to contact us to check availability, which is no longer true now that the
 * dates are actually held.
 */
export function renderDepositInstructionsEmail(input: EmailTemplateInput): RenderedEmail {
  const s = strings[input.language];
  const t = s.depositInstructions;
  const bank = input.bankInfo;

  const rows: Array<[string, string]> = [
    [s.reservationId, input.reservationPublicId],
    [s.property, input.propertyName],
    [s.arrival, formatDate(input.arrivalDate)],
    [s.departure, formatDate(input.departureDate)],
    [s.guests, String(input.guests)],
    ...(input.totalAmountCents !== undefined && input.currency
      ? ([[s.totalAmount, formatAmount(input.totalAmountCents, input.currency)]] as Array<[string, string]>)
      : []),
    ...(input.holdExpiresAt ? ([[s.holdExpires, input.holdExpiresAt]] as Array<[string, string]>) : []),
  ];

  const bankRows: Array<[string, string]> = bank
    ? [
        ...(bank.sinpePhone
          ? ([[s.sinpe, bank.sinpeName ? `${bank.sinpePhone} · ${bank.sinpeName}` : bank.sinpePhone]] as Array<[string, string]>)
          : []),
        [s.accountHolder, bank.bankAccount.accountHolder],
        [bank.bankAccount.primaryAccountLabel, bank.bankAccount.primaryAccount],
        ...(bank.bankAccount.secondaryAccount
          ? ([[bank.bankAccount.secondaryAccountLabel ?? s.alternateAccount, bank.bankAccount.secondaryAccount]] as Array<
              [string, string]
            >)
          : []),
      ]
    : [];

  const uploadLink = input.depositUploadUrl
    ? `<p><a href="${input.depositUploadUrl}" style="color:#294F44;font-weight:700">${t.uploadCta}</a></p>`
    : "";

  const html = layout(
    `<p>${s.greeting(input.guestFirstName)}</p>
<p>${t.intro}</p>
${detailsTable(rows)}
${bankRows.length > 0 ? detailsTable(bankRows) : ""}
<p style="color:#b03a2e;font-weight:600">${t.warning}</p>
${uploadLink}
<p style="color:#888;font-size:13px">${t.note}</p>`,
    s.footer,
    input.language
  );

  const text = [
    s.greeting(input.guestFirstName),
    "",
    t.intro,
    "",
    detailsText(rows),
    "",
    ...(bankRows.length > 0 ? [detailsText(bankRows), ""] : []),
    t.warning,
    "",
    ...(input.depositUploadUrl ? [`${t.uploadCta}: ${input.depositUploadUrl}`, ""] : []),
    t.note,
    "",
    s.footer,
  ].join("\n");

  return { subject: t.subject(input.reservationPublicId), html, text };
}

// ─── Template: deposit_confirmed ─────────────────────────────────────────────

export function renderDepositConfirmedEmail(input: EmailTemplateInput): RenderedEmail {
  const s = strings[input.language];
  const t = s.depositConfirmed;

  const rows: Array<[string, string]> = [
    [s.reservationId, input.reservationPublicId],
    [s.property, input.propertyName],
    [s.arrival, formatDate(input.arrivalDate)],
    [s.departure, formatDate(input.departureDate)],
    [s.guests, String(input.guests)],
    ...(input.totalAmountCents !== undefined && input.currency
      ? ([[s.totalAmount, formatAmount(input.totalAmountCents, input.currency)]] as Array<[string, string]>)
      : []),
  ];

  const html = layout(
    `<p>${s.greeting(input.guestFirstName)}</p>
<p>${t.intro}</p>
${detailsTable(rows)}
<p style="color:#294F44;font-weight:600">${t.portalCta}</p>
<p style="color:#888;font-size:13px">${t.note}</p>`,
    s.footer,
    input.language
  );

  const text = [s.greeting(input.guestFirstName), "", t.intro, "", detailsText(rows), "", t.portalCta, "", t.note, "", s.footer].join("\n");

  return { subject: t.subject(input.reservationPublicId), html, text };
}

// ─── Template: staff_deposit_review ──────────────────────────────────────────

/** Staff-facing. Carries the signed confirm and reject links. */
export function renderStaffDepositReviewEmail(input: EmailTemplateInput): RenderedEmail {
  const s = strings[input.language];
  const t = s.staffDepositReview;

  const rows: Array<[string, string]> = [
    [s.reservationId, input.reservationPublicId],
    [s.property, input.propertyName],
    [s.arrival, formatDate(input.arrivalDate)],
    [s.departure, formatDate(input.departureDate)],
    [s.guests, String(input.guests)],
    ...(input.totalAmountCents !== undefined && input.currency
      ? ([[s.totalAmount, formatAmount(input.totalAmountCents, input.currency)]] as Array<[string, string]>)
      : []),
    ...(input.holdExpiresAt ? ([[s.holdExpires, input.holdExpiresAt]] as Array<[string, string]>) : []),
    [t.guestContact, `${input.guestFirstName} · ${input.guestEmail}`],
    [t.receiptLabel, input.depositReceiptUrl ? input.depositReceiptUrl : t.noReceipt],
  ];

  const actions = [
    input.depositConfirmUrl
      ? `<p><a href="${input.depositConfirmUrl}" style="color:#294F44;font-weight:700">${t.confirmLabel}</a></p>`
      : "",
    input.depositRejectUrl
      ? `<p><a href="${input.depositRejectUrl}" style="color:#b03a2e;font-weight:700">${t.rejectLabel}</a></p>`
      : "",
  ].join("\n");

  const html = layout(
    `<p>${t.intro}</p>
${detailsTable(rows)}
<p style="font-weight:600">${t.action}</p>
${actions}`,
    s.footer,
    input.language
  );

  const text = [
    t.intro,
    "",
    detailsText(rows),
    "",
    t.action,
    "",
    ...(input.depositConfirmUrl ? [`${t.confirmLabel}: ${input.depositConfirmUrl}`] : []),
    ...(input.depositRejectUrl ? [`${t.rejectLabel}: ${input.depositRejectUrl}`] : []),
    "",
    s.footer,
  ].join("\n");

  return { subject: t.subject(input.reservationPublicId), html, text };
}

// ─── Template: guest_cancellation ────────────────────────────────────────────

/**
 * Sent to the guest after a self-service cancellation.
 *
 * Distinct from renderCancelledEmail, which is worded for a hold that lapsed
 * before payment ("your hold has expired") and is used by the hold-expiry worker.
 * This one is for a paid booking the guest deliberately cancelled, so it has to
 * say what happens to their money.
 */
export function renderGuestCancellationEmail(input: EmailTemplateInput): RenderedEmail {
  const s = strings[input.language];
  const t = s.guestCancelled;
  const refundExpected = Boolean(input.paypalCaptureId) && input.refundExpected !== false;

  const rows: Array<[string, string]> = [
    [s.reservationId, input.reservationPublicId],
    [s.property, input.propertyName],
    [s.arrival, formatDate(input.arrivalDate)],
    [s.departure, formatDate(input.departureDate)],
    ...(input.totalAmountCents !== undefined && input.currency
      ? ([[s.totalAmount, formatAmount(input.totalAmountCents, input.currency)]] as Array<[string, string]>)
      : []),
    ...(input.cancellationReason
      ? ([[s.cancellationReason, input.cancellationReason]] as Array<[string, string]>)
      : []),
  ];

  const refundCopy = refundExpected ? t.refundPending : t.noRefund;

  const html = layout(
    `<p>${s.greeting(input.guestFirstName)}</p>
<p>${t.intro}</p>
${detailsTable(rows)}
<p style="color:#294F44;font-weight:600">${refundCopy}</p>
<p style="color:#888;font-size:13px">${t.note}</p>`,
    s.footer,
    input.language
  );

  const text = [
    s.greeting(input.guestFirstName),
    "",
    t.intro,
    "",
    detailsText(rows),
    "",
    refundCopy,
    "",
    t.note,
    "",
    s.footer,
  ].join("\n");

  return { subject: t.subject(input.reservationPublicId), html, text };
}

// ─── Template: staff_cancellation_alert ──────────────────────────────────────

/**
 * Sent to STAFF_NOTIFICATION_EMAIL, not the guest. Refunds are issued by hand,
 * so this carries the PayPal capture ID and the guest's contact details.
 */
export function renderStaffCancellationEmail(input: EmailTemplateInput): RenderedEmail {
  const s = strings[input.language];
  const t = s.staffCancelled;
  const refundExpected = Boolean(input.paypalCaptureId) && input.refundExpected !== false;

  const rows: Array<[string, string]> = [
    [s.reservationId, input.reservationPublicId],
    [s.property, input.propertyName],
    [s.arrival, formatDate(input.arrivalDate)],
    [s.departure, formatDate(input.departureDate)],
    [s.guests, String(input.guests)],
    ...(input.totalAmountCents !== undefined && input.currency
      ? ([[s.totalAmount, formatAmount(input.totalAmountCents, input.currency)]] as Array<[string, string]>)
      : []),
    ...(input.paypalCaptureId ? ([[s.paypalCaptureId, input.paypalCaptureId]] as Array<[string, string]>) : []),
    ...(input.cancellationReason
      ? ([[s.cancellationReason, input.cancellationReason]] as Array<[string, string]>)
      : []),
    [t.guestContact, `${input.guestFirstName} · ${input.guestEmail}`],
  ];

  const actionCopy = refundExpected ? t.action : t.noRefundAction;

  const html = layout(
    `<p>${t.intro}</p>
${detailsTable(rows)}
<p style="color:#294F44;font-weight:600">${actionCopy}</p>`,
    s.footer,
    input.language
  );

  const text = [t.intro, "", detailsText(rows), "", actionCopy, "", s.footer].join("\n");

  return { subject: t.subject(input.reservationPublicId), html, text };
}

// ─── Template: staff_help_request ────────────────────────────────────────────

/**
 * Sent to STAFF_NOTIFICATION_EMAIL — forwards a guest's portal help-request
 * message. `guestMessage` is free text a guest typed, unlike every other
 * field in this template, so it's the one HTML-escaped before interpolation.
 */
export function renderStaffHelpRequestEmail(input: EmailTemplateInput): RenderedEmail {
  const s = strings[input.language];
  const t = s.staffHelpRequest;

  const rows: Array<[string, string]> = [
    [s.reservationId, input.reservationPublicId],
    [s.property, input.propertyName],
    [s.arrival, formatDate(input.arrivalDate)],
    [s.departure, formatDate(input.departureDate)],
    ...(input.helpRequestType ? ([[t.typeLabel, input.helpRequestType]] as Array<[string, string]>) : []),
    [t.guestContact, `${escapeHtml(input.guestFirstName)} · ${escapeHtml(input.guestEmail)}`],
  ];

  const message = input.guestMessage ?? "";

  const html = layout(
    `<p>${t.intro}</p>
${detailsTable(rows)}
<p style="color:#555;margin-bottom:4px">${t.messageLabel}</p>
<p style="white-space:pre-wrap;background:#f5f5f5;border-radius:6px;padding:12px 16px;margin:0">${escapeHtml(message)}</p>`,
    s.footer,
    input.language
  );

  const text = [t.intro, "", detailsText(rows), "", `${t.messageLabel}:`, message, "", s.footer].join("\n");

  return { subject: t.subject(input.reservationPublicId), html, text };
}

// ─── Template: staff_cancellation_request ────────────────────────────────────

/**
 * Sent to STAFF_NOTIFICATION_EMAIL when a guest asks (via the portal) to
 * cancel a confirmed booking. This is the *request* — nothing is cancelled
 * automatically; staff follow up and, if appropriate, process it by hand
 * (see renderStaffCancellationEmail for the actual-cancellation alert).
 */
export function renderStaffCancellationRequestEmail(input: EmailTemplateInput): RenderedEmail {
  const s = strings[input.language];
  const t = s.staffCancellationRequest;

  const rows: Array<[string, string]> = [
    [s.reservationId, input.reservationPublicId],
    [s.property, input.propertyName],
    [s.arrival, formatDate(input.arrivalDate)],
    [s.departure, formatDate(input.departureDate)],
    ...(input.cancellationReason ? ([[t.reasonLabel, input.cancellationReason]] as Array<[string, string]>) : []),
    [t.guestContact, `${escapeHtml(input.guestFirstName)} · ${escapeHtml(input.guestEmail)}`],
  ];

  const message = input.guestMessage ?? "";

  const html = layout(
    `<p>${t.intro}</p>
${detailsTable(rows)}
${
  message
    ? `<p style="color:#555;margin-bottom:4px">${t.messageLabel}</p>
<p style="white-space:pre-wrap;background:#f5f5f5;border-radius:6px;padding:12px 16px;margin:0 0 16px">${escapeHtml(message)}</p>`
    : ""
}
<p style="color:#294F44;font-weight:600">${t.action}</p>`,
    s.footer,
    input.language
  );

  const text = [
    t.intro,
    "",
    detailsText(rows),
    ...(message ? ["", `${t.messageLabel}:`, message] : []),
    "",
    t.action,
    "",
    s.footer,
  ].join("\n");

  return { subject: t.subject(input.reservationPublicId), html, text };
}

// ─── Template: manual_deposit_handoff ────────────────────────────────────────

export function renderDepositHandoffEmail(input: EmailTemplateInput): RenderedEmail {
  const s = strings[input.language];
  const t = s.depositHandoff;

  // Callers (EmailClient) are responsible for resolving config/env fallbacks
  // before calling this template. The template itself must not read process.env.
  const contactWhatsApp = input.contactWhatsApp ?? "https://wa.me/contact";
  const contactEmail = input.contactEmail ?? "reservations@example.com";

  const contextRows: Array<[string, string]> = [
    ...(input.propertyName ? [[s.property, input.propertyName] as [string, string]] : []),
    ...(input.arrivalDate ? [[s.arrival, formatDate(input.arrivalDate)] as [string, string]] : []),
    ...(input.departureDate ? [[s.departure, formatDate(input.departureDate)] as [string, string]] : []),
    ...(input.guests ? [[s.guests, String(input.guests)] as [string, string]] : []),
  ];

  const html = layout(
    `<p>${s.greeting(input.guestFirstName)}</p>
<p>${t.intro}</p>
${contextRows.length > 0 ? detailsTable(contextRows) : ""}
<ol style="padding-left:20px;line-height:1.8">
  <li>${t.step1}</li>
  <li>${t.step2}</li>
  <li>${t.step3}</li>
</ol>
<p style="background:#fff3cd;border-left:4px solid #FFC107;padding:12px 16px;border-radius:4px;font-size:13px">${t.warning}</p>
<p><strong>${t.contactLabel}:</strong><br>
  WhatsApp: <a href="${contactWhatsApp}" style="color:#294F44">${contactWhatsApp}</a><br>
  Email: <a href="mailto:${contactEmail}" style="color:#294F44">${contactEmail}</a>
</p>`,
    s.footer,
    input.language
  );

  const text = [
    s.greeting(input.guestFirstName),
    "",
    t.intro,
    "",
    ...(contextRows.length > 0 ? [detailsText(contextRows), ""] : []),
    `1. ${t.step1}`,
    `2. ${t.step2}`,
    `3. ${t.step3}`,
    "",
    t.warning,
    "",
    `${t.contactLabel}:`,
    `WhatsApp: ${contactWhatsApp}`,
    `Email: ${contactEmail}`,
    "",
    s.footer,
  ].join("\n");

  return { subject: t.subject, html, text };
}
