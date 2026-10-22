// Session cookie policy (ported from ca_auth.CA_SESSION_COOKIE and the
// client cookie in app.py): HttpOnly, SameSite=Lax, Path=/, and in
// production Secure with the `__Host-` prefix. The cookie carries only the
// random session token; the database stores its SHA-256 hash.

import { getConfig, type Config } from "./config";

export type SessionKind = "ca" | "client";

export const SESSION_ABSOLUTE_SECONDS = 12 * 60 * 60;

export function cookieName(kind: SessionKind, config: Config = getConfig()): string {
  const base = kind === "ca" ? "itr_ca_session" : "itr_client_session";
  return config.environment === "production" ? `__Host-${base}` : base;
}

function attributes(maxAge: number, config: Config): string {
  return [
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAge}`,
    ...(config.environment === "production" ? ["Secure"] : []),
  ].join("; ");
}

export function setSessionCookie(response: Response, kind: SessionKind, token: string,
                                 config: Config = getConfig()): Response {
  response.headers.append("Set-Cookie", `${cookieName(kind, config)}=${token}; ${attributes(SESSION_ABSOLUTE_SECONDS, config)}`);
  return response;
}

export function clearSessionCookie(response: Response, kind: SessionKind, config: Config = getConfig()): Response {
  response.headers.append("Set-Cookie", `${cookieName(kind, config)}=; ${attributes(0, config)}`);
  return response;
}

/** The session token presented in the request's cookies, if any. */
export function readSessionToken(request: Request, kind: SessionKind, config: Config = getConfig()): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  const name = cookieName(kind, config);
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=") || null;
  }
  return null;
}
