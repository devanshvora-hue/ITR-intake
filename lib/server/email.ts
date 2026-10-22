// E-mail: templates, the outbox record and delivery (ported from
// email_service.py and smtp_sender.py).
//
// Flow: inside the request's transaction a row is written to `email_outbox`
// (earlier undelivered links of the same kind for the same recipient are
// superseded). After the response has been sent, the message is delivered:
//   development -> the developer outbox (`dev_mailbox`), recorded 'simulated'
//   production  -> SMTP (nodemailer, TLS with certificate checks), 'sent'
// Delivery runs after the response so the answer's timing never reveals
// whether a message was sent. A failed send is recorded with a fixed code;
// one-time-link bodies are cleared once delivered, dead or expired. Links,
// bodies and credentials are never logged.

import { after } from "next/server";
import nodemailer, { type Transporter } from "nodemailer";
import { emailDelivery, getConfig, type Config, type SmtpConfig } from "./config";
import type { Db } from "./db";
import { guarded } from "./errors";

export const TEMPLATE_VERIFY_EMAIL = "ca_verify_email";
export const TEMPLATE_PASSWORD_RESET = "ca_password_reset";
export const TEMPLATE_CLIENT_SIGN_IN = "client_sign_in";
export type Template = typeof TEMPLATE_VERIFY_EMAIL | typeof TEMPLATE_PASSWORD_RESET | typeof TEMPLATE_CLIENT_SIGN_IN;

// Seconds to wait after the 1st-4th failed attempt (used if a retry job is added).
const RETRY_DELAYS = [60, 5 * 60, 30 * 60, 2 * 60 * 60];
const LINK = /https?:\/\/\S+/;

export function maskEmail(address: string): string {
  const at = address.indexOf("@");
  return at > 0 ? `${address[0]}***${address.slice(at)}` : "***";
}

// --- templates -----------------------------------------------------------------------------------

export function renderEmail(template: Template, link: string, ttlSeconds: number): { subject: string; body: string } {
  if (template === TEMPLATE_VERIFY_EMAIL) {
    return {
      subject: "Verify your ITR Intake email address",
      body: "Please confirm your email address for ITR Intake by opening this link:\n\n"
        + `${link}\n\n`
        + `The link works once and expires in ${Math.floor(ttlSeconds / 3600)} hours. Confirming your email does not `
        + "approve your account; an administrator must approve it before you can sign in.\n\n"
        + "If you did not register, ignore this message.",
    };
  }
  if (template === TEMPLATE_PASSWORD_RESET) {
    return {
      subject: "Reset your ITR Intake password",
      body: "Someone asked to reset the password for this ITR Intake account. To choose a new password, open:\n\n"
        + `${link}\n\n`
        + `The link works once and expires in ${Math.floor(ttlSeconds / 60)} minutes. Resetting your password signs `
        + "you out everywhere.\n\n"
        + "If you did not ask for this, ignore this message; your password has not changed.",
    };
  }
  return {
    subject: "Continue your ITR Intake",
    body: "Someone used your email address to start an income tax intake with a CA firm on ITR Intake. "
      + "To continue, open this link:\n\n"
      + `${link}\n\n`
      + `The link works once and expires in ${Math.floor(ttlSeconds / 60)} minutes.\n\n`
      + "If this was not you, ignore this message; nothing has been shared.",
  };
}

// --- queueing ---------------------------------------------------------------------------------------

/**
 * Record a one-time-link e-mail (call inside the request's transaction).
 * `token` is "<challenge id>.<secret>"; only the challenge id enters the
 * idempotency key. Returns the outbox id to deliver once committed.
 */
export async function queueEmail(db: Db, input: {
  template: Template; recipient: string; token: string; link: string; ttlSeconds: number; firmId?: string | null;
}): Promise<string> {
  const { subject, body } = renderEmail(input.template, input.link, input.ttlSeconds);
  const challengeId = input.token.split(".", 1)[0];
  return guarded(() => db.transaction(async (tx) => {
    await tx.query(
      `UPDATE email_outbox SET status = 'superseded', next_attempt_at = NULL, updated_at = now(),
              body_text = CASE WHEN sensitive THEN NULL ELSE body_text END
       WHERE template = $1 AND recipient = $2 AND status IN ('pending', 'failed')`, [input.template, input.recipient]);
    const rows = await tx.query<{ id: string }>(
      `INSERT INTO email_outbox (idempotency_key, firm_id, template, recipient, subject, body_text, next_attempt_at,
                                 sensitive, body_expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, now(), true, now() + make_interval(secs => $7::double precision))
       ON CONFLICT (idempotency_key) DO UPDATE SET updated_at = email_outbox.updated_at
       RETURNING id`,
      [`${input.template}:${challengeId}`, input.firmId ?? null, input.template, input.recipient, subject, body,
        input.ttlSeconds]);
    console.info("email queued", input.template, maskEmail(input.recipient));
    return rows[0].id;
  }), "email");
}

// --- delivery ---------------------------------------------------------------------------------------

export class EmailSendError extends Error {
  constructor(readonly code: string, readonly retryable: boolean) {
    super(code);
    this.name = "EmailSendError";
  }
}

type OutboxRow = { id: string; template: string; recipient: string; subject: string; body_text: string | null;
  status: string; attempts: number; body_expires_at: Date | null };

let transportOverride: Pick<Transporter, "sendMail"> | null = null;

/** For tests: replace the SMTP transport. */
export function setMailTransportForTests(transport: Pick<Transporter, "sendMail"> | null): void {
  transportOverride = transport;
}

function transport(smtp: SmtpConfig): Pick<Transporter, "sendMail"> {
  return transportOverride ?? nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.tls === "implicit",
    requireTLS: smtp.tls === "starttls",
    auth: smtp.username ? { user: smtp.username, pass: smtp.password ?? "" } : undefined,
    tls: { rejectUnauthorized: true },
    connectionTimeout: 20_000,
    greetingTimeout: 20_000,
    socketTimeout: 20_000,
  });
}

/** Map a nodemailer failure to a fixed code; provider text is never kept. */
export function classifySendError(error: unknown): EmailSendError {
  const e = (error ?? {}) as { code?: string; responseCode?: number; command?: string };
  if (e.code === "EAUTH") return new EmailSendError("auth_failed", true);
  if (e.code === "EENVELOPE" || e.command === "RCPT TO") {
    return new EmailSendError("recipient_refused", !(e.responseCode && e.responseCode >= 500));
  }
  if (e.code === "ETLS" || /tls|certificate|ssl/i.test(String(e.code ?? ""))) return new EmailSendError("tls_failed", true);
  if (typeof e.responseCode === "number") {
    return e.responseCode >= 500 ? new EmailSendError("rejected", false) : new EmailSendError("temporary_failure", true);
  }
  return new EmailSendError("connection_failed", true);
}

async function sendSmtp(smtp: SmtpConfig, row: OutboxRow): Promise<string | null> {
  if (/[\r\n]/.test(row.recipient) || /[\r\n]/.test(row.subject)) throw new EmailSendError("invalid_message", false);
  try {
    const info = await transport(smtp).sendMail({
      from: smtp.from,
      to: row.recipient,
      subject: row.subject,
      text: row.body_text ?? "",
      headers: { "Auto-Submitted": "auto-generated" },
    });
    return typeof info?.messageId === "string" ? info.messageId : null;
  } catch (error) {
    throw classifySendError(error);
  }
}

/** Deliver one queued message now. Never throws; the outcome is recorded on the row. */
export async function deliverEmail(db: Db, outboxId: string, config: Config = getConfig()): Promise<string> {
  try {
    const [row] = await db.query<OutboxRow>(
      `SELECT id, template, recipient, subject, body_text, status, attempts, body_expires_at
       FROM email_outbox WHERE id = $1 AND status IN ('pending', 'failed')`, [outboxId]);
    if (!row) return "skipped";
    if (row.body_text === null || (row.body_expires_at && row.body_expires_at <= new Date())) {
      await db.query(`UPDATE email_outbox SET status = 'dead', last_error = 'body_missing', body_text = NULL,
                      next_attempt_at = NULL, attempts = attempts + 1, updated_at = now() WHERE id = $1`, [row.id]);
      return "dead";
    }
    const mode = emailDelivery(config);
    if (mode === "simulated") {
      const body = row.body_text;
      await db.transaction(async (tx) => {
        await tx.query(
          `INSERT INTO dev_mailbox (outbox_id, recipient, subject, body_text, link, expires_at)
           VALUES ($1, $2, $3, $4, $5, COALESCE($6::timestamptz, now() + interval '1 hour'))
           ON CONFLICT (outbox_id) DO NOTHING`,
          [row.id, row.recipient, row.subject, `DEVELOPMENT SIMULATION - this email was not sent.\n\n${body}`,
            LINK.exec(body)?.[0] ?? null, row.body_expires_at]);
        await tx.query(`UPDATE email_outbox SET status = 'simulated', sent_at = now(), attempts = attempts + 1,
                        body_text = NULL, next_attempt_at = NULL, updated_at = now() WHERE id = $1`, [row.id]);
      });
      return "simulated";
    }
    if (mode !== "email" || !config.smtp) return "not_configured";
    try {
      const messageId = await sendSmtp(config.smtp, row);
      await db.query(`UPDATE email_outbox SET status = 'sent', sent_at = now(), provider_message_id = $2,
                      attempts = attempts + 1, body_text = NULL, next_attempt_at = NULL, updated_at = now()
                      WHERE id = $1`, [row.id, messageId]);
      console.info("email sent", row.template, maskEmail(row.recipient));
      return "sent";
    } catch (error) {
      const failure = error instanceof EmailSendError ? error : new EmailSendError("unexpected_error", true);
      const delay = failure.retryable ? RETRY_DELAYS[row.attempts] : undefined;
      await db.query(
        `UPDATE email_outbox SET status = $2, attempts = attempts + 1, last_error = $3, updated_at = now(),
                next_attempt_at = CASE WHEN $4::int IS NULL THEN NULL ELSE now() + make_interval(secs => $4::int) END,
                body_text = CASE WHEN $4::int IS NULL THEN NULL ELSE body_text END
         WHERE id = $1`, [row.id, delay === undefined ? "dead" : "failed", failure.code, delay ?? null]);
      console.warn("email failed", row.template, maskEmail(row.recipient), failure.code);
      return failure.code;
    }
  } catch (error) {
    console.error("email delivery error", error instanceof Error ? error.name : typeof error);
    return "error";
  }
}

/** The answer for "we may have sent you a link" routes; the developer outbox link only in development. */
export function deliveryAnswer(status: string, config: Config = getConfig()): Record<string, string> {
  const delivery = emailDelivery(config);
  return { status, email_delivery: delivery,
    ...(delivery === "simulated" ? { dev_outbox_url: `${config.appBaseUrl}/api/dev/outbox` } : {}) };
}

export function canSendEmail(config: Config = getConfig()): boolean {
  return emailDelivery(config) !== "not_configured";
}

// --- scheduling -----------------------------------------------------------------------------------

type Scheduler = (task: () => Promise<unknown>) => void;

let scheduler: Scheduler = (task) => after(task);

/** For tests: run deliveries some other way (e.g. collect and await them). */
export function setDeliverySchedulerForTests(next: Scheduler | null): void {
  scheduler = next ?? ((task) => after(task));
}

/** Deliver after the response has been sent (Vercel keeps the function alive for it). */
export function deliverAfterResponse(db: Db, outboxIds: string[]): void {
  for (const id of outboxIds) scheduler(() => deliverEmail(db, id));
}
