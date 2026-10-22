// Server-only: call this site's own API routes from server components,
// forwarding the visitor's cookies. The API lives in the same Next.js app.
// In production the base address comes from configuration (APP_BASE_URL, or a
// preview deployment's own address), never from request headers; only local
// development uses the request's host.
import { headers } from "next/headers";

function configuredBase(): string | null {
  if (process.env.VERCEL_ENV === "preview" && process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  if (process.env.NODE_ENV === "production" && process.env.APP_BASE_URL) {
    try {
      return new URL(process.env.APP_BASE_URL).origin;
    } catch {
      return null;
    }
  }
  return null;
}

export async function apiGet(path: string): Promise<Response> {
  const h = await headers();
  const host = h.get("host") ?? "localhost:3000";
  const base = configuredBase() ?? `http://${host}`;
  return fetch(`${base}${path}`, { headers: { cookie: h.get("cookie") ?? "" }, cache: "no-store" });
}
