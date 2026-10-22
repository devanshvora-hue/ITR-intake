// Turn the request's session cookie into a signed-in CA or client (or a 401).

import { authenticateCa, type CaPrincipal } from "./ca-auth";
import { authenticateClient, type ClientPrincipal } from "./client-auth";
import { clearSessionCookie, readSessionToken } from "./cookies";
import type { Db } from "./db";
import { jsonError } from "./http";

export async function caPrincipal(request: Request, db: Db): Promise<CaPrincipal | null> {
  const token = readSessionToken(request, "ca");
  return token ? authenticateCa(db, token) : null;
}

export async function clientPrincipal(request: Request, db: Db): Promise<ClientPrincipal | null> {
  const token = readSessionToken(request, "client");
  return token ? authenticateClient(db, token) : null;
}

export function caUnauthenticated(): Response {
  return clearSessionCookie(jsonError(401, "unauthenticated", "Please sign in."), "ca");
}

export function clientUnauthenticated(): Response {
  return clearSessionCookie(jsonError(401, "unauthenticated", "Please start again from the client page."), "client");
}
