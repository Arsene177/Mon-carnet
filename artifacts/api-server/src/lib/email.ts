// Emails sent by the app: the link to confirm an email address and the link to reset a password.
// Sent through Brevo's HTTPS API (Render's free plan blocks the usual email ports).
//
//   BREVO_API_KEY        a Brevo API key (Brevo > SMTP & API > API Keys)
//   EMAIL_FROM           the sender address, verified in Brevo (Senders, Domains & Dedicated IPs)
//   EMAIL_FROM_NAME      sender name (default "Mon carnet")
//   APP_URL              the public address of the site, for the links (Render sets
//                        RENDER_EXTERNAL_URL, used when APP_URL is not set)
//   BREVO_API_URL        only for tests: where to send instead of Brevo
import { logger } from "./logger";

export type Language = "fr" | "en";

export function emailConfigured(): boolean {
  return Boolean(process.env.BREVO_API_KEY && process.env.EMAIL_FROM && appUrl());
}

export function appUrl(): string | null {
  const url = process.env.APP_URL ?? process.env.RENDER_EXTERNAL_URL;
  return url ? url.replace(/\/+$/, "") : null;
}

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function layout(heading: string, paragraphs: string[], button: { label: string; url: string }, footer: string): string {
  return `<!doctype html><html><body style="margin:0;background:#f4f7f6;font-family:Arial,Helvetica,sans-serif;color:#1d2b27">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" style="max-width:520px;background:#ffffff;border-radius:10px;padding:28px" cellpadding="0" cellspacing="0"><tr><td>
<p style="margin:0 0 18px;font-size:15px;color:#2b6b5c"><strong>Mon carnet</strong></p>
<h1 style="margin:0 0 14px;font-size:20px">${escapeHtml(heading)}</h1>
${paragraphs.map((text) => `<p style="margin:0 0 14px;font-size:15px;line-height:1.5">${escapeHtml(text)}</p>`).join("\n")}
<p style="margin:22px 0"><a href="${escapeHtml(button.url)}" style="background:#2b6b5c;color:#ffffff;text-decoration:none;padding:12px 20px;border-radius:8px;font-size:15px;display:inline-block">${escapeHtml(button.label)}</a></p>
<p style="margin:0 0 14px;font-size:13px;line-height:1.5;color:#55665f;word-break:break-all">${escapeHtml(button.url)}</p>
<p style="margin:18px 0 0;font-size:12px;line-height:1.5;color:#7a8a84">${escapeHtml(footer)}</p>
</td></tr></table></td></tr></table></body></html>`;
}

type Message = { subject: string; text: string; html: string };

export function verificationEmail(language: Language, name: string, url: string): Message {
  const t = language === "fr"
    ? {
      subject: "Confirmez votre adresse e-mail – Mon carnet",
      heading: "Confirmez votre adresse e-mail",
      lines: [`Bonjour ${name},`, "Pour terminer la création de votre compte Mon carnet, confirmez votre adresse e-mail. Le lien est valable 24 heures."],
      button: "Confirmer mon adresse",
      footer: "Si vous n’avez pas créé de compte Mon carnet, ignorez cet e-mail : aucun compte ne sera activé.",
    }
    : {
      subject: "Confirm your email address – Mon carnet",
      heading: "Confirm your email address",
      lines: [`Hello ${name},`, "To finish creating your Mon carnet account, confirm your email address. The link works for 24 hours."],
      button: "Confirm my address",
      footer: "If you did not create a Mon carnet account, ignore this email: no account will be activated.",
    };
  return { subject: t.subject, text: [...t.lines, `${t.button}: ${url}`, t.footer].join("\n\n"), html: layout(t.heading, t.lines, { label: t.button, url }, t.footer) };
}

export function passwordResetEmail(language: Language, name: string, url: string): Message {
  const t = language === "fr"
    ? {
      subject: "Réinitialiser votre mot de passe – Mon carnet",
      heading: "Choisissez un nouveau mot de passe",
      lines: [`Bonjour ${name},`, "Vous avez demandé à réinitialiser le mot de passe de votre compte Mon carnet. Le lien est valable 1 heure et ne fonctionne qu’une fois. Ensuite, vous serez déconnecté de tous vos appareils."],
      button: "Choisir un nouveau mot de passe",
      footer: "Si vous n’avez rien demandé, ignorez cet e-mail : votre mot de passe ne change pas. Si cela se répète, prévenez l’administrateur.",
    }
    : {
      subject: "Reset your password – Mon carnet",
      heading: "Choose a new password",
      lines: [`Hello ${name},`, "You asked to reset the password of your Mon carnet account. The link works for 1 hour and only once. Afterwards you will be signed out on every device."],
      button: "Choose a new password",
      footer: "If you did not ask for this, ignore this email: your password does not change. If it keeps happening, tell the administrator.",
    };
  return { subject: t.subject, text: [...t.lines, `${t.button}: ${url}`, t.footer].join("\n\n"), html: layout(t.heading, t.lines, { label: t.button, url }, t.footer) };
}

/** Sends one email. Returns false (and logs why, without the content) when it could not be sent. */
export async function sendEmail(to: { email: string; name: string }, message: Message): Promise<boolean> {
  if (!emailConfigured()) {
    logger.error("Email is not set up (BREVO_API_KEY, EMAIL_FROM, APP_URL): nothing was sent");
    return false;
  }
  try {
    const response = await fetch(process.env.BREVO_API_URL ?? "https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: { "api-key": process.env.BREVO_API_KEY!, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        sender: { email: process.env.EMAIL_FROM, name: process.env.EMAIL_FROM_NAME ?? "Mon carnet" },
        to: [{ email: to.email, name: to.name }],
        subject: message.subject,
        textContent: message.text,
        htmlContent: message.html,
        // No open or click tracking: the links carry single-use tokens.
        headers: { "X-Mailin-Track": "0", "X-Mailin-Track-Clicks": "0", "X-Mailin-Track-Opens": "0" },
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      logger.error({ status: response.status, reason: (await response.text()).slice(0, 300) }, "The email service refused the email");
      return false;
    }
    return true;
  } catch (err) {
    logger.error({ err }, "The email service could not be reached");
    return false;
  }
}
