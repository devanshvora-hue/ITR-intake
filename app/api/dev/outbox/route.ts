// GET /api/dev/outbox: the developer outbox (development only). Simulated
// e-mails with their one-time links, shown only on this computer. In
// production this route answers 404 and the table stays empty.

import { getConfig } from "@/lib/server/config";
import { getDb } from "@/lib/server/db";
import { jsonError } from "@/lib/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function escape(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

export async function GET(request: Request): Promise<Response> {
  const host = (request.headers.get("host") ?? "").replace(/:\d+$/, "");
  if (getConfig().environment !== "development" || !["localhost", "127.0.0.1", "[::1]"].includes(host)) {
    return jsonError(404, "not_found");
  }
  const db = getDb();
  await db.query("DELETE FROM dev_mailbox WHERE expires_at <= now()");
  const messages = await db.query<{ recipient: string; subject: string; body_text: string; link: string | null; created_at: Date }>(
    "SELECT recipient, subject, body_text, link, created_at FROM dev_mailbox ORDER BY created_at DESC LIMIT 50");
  const items = messages.map((m) =>
    `<li><p><strong>To:</strong> ${escape(m.recipient)}<br><strong>Subject:</strong> ${escape(m.subject)}<br>`
    + `<small>${escape(m.created_at.toISOString())}</small></p><pre>${escape(m.body_text)}</pre>`
    + (m.link ? `<p><a href="${escape(m.link)}">Open the link in this message</a></p>` : "") + "</li>").join("")
    || "<li>No simulated emails yet.</li>";
  const page = "<!doctype html><html lang='en'><head><meta charset='utf-8'><title>Developer outbox</title>"
    + "<meta name='robots' content='noindex'><style>body{font-family:system-ui,sans-serif;max-width:46rem;margin:2rem auto;"
    + "padding:0 1rem;background:#faf7f1;color:#1d1b18}.warn{background:#f7ecd6;color:#8a5a10;padding:.75rem 1rem;"
    + "border-radius:.5rem}li{background:#fff;border:1px solid #e4ddd0;border-radius:.75rem;padding:1rem;margin:1rem 0;"
    + "list-style:none}ul{padding:0}pre{white-space:pre-wrap}</style></head><body><h1>Developer outbox</h1>"
    + "<p class='warn'><strong>Development simulation.</strong> No email was sent. Messages are deleted when their link "
    + "expires. This page exists only in local development.</p>"
    + `<ul>${items}</ul></body></html>`;
  return new Response(page, { headers: {
    "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'", "Referrer-Policy": "no-referrer",
  } });
}
