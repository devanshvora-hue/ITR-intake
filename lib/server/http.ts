// Shared HTTP behaviour for every API route (ported from the FastAPI
// middleware and helpers in backend/itr_intake_server/app.py):
//
// - State-changing requests (anything but GET/HEAD/OPTIONS) must come from an
//   allowed Origin and carry `X-ITR-Request: 1`; otherwise 403 before the
//   handler runs (CSRF protection).
// - Every API response is `no-store`, `nosniff`, `DENY` framing and
//   `no-referrer`.
// - Errors are `{error, message?, ...}` with fixed codes; unexpected failures
//   become a generic 500 and never echo data, SQL or file paths.
// - JSON bodies are size-limited and validated with strict zod schemas
//   (unknown fields are refused, like the Pydantic `extra="forbid"` models).

import { z } from "zod";
import { getConfig, type Config } from "./config";
import { sha256Hex } from "./ids";

export const CSRF_HEADER = "x-itr-request";
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const MAX_JSON_BYTES = 64 * 1024;

const API_HEADERS: Record<string, string> = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
};

export function withApiHeaders(response: Response): Response {
  for (const [name, value] of Object.entries(API_HEADERS)) response.headers.set(name, value);
  return response;
}

export function json(body: unknown, status = 200, headers?: HeadersInit): Response {
  return withApiHeaders(Response.json(body, { status, headers }));
}

export function jsonError(status: number, error: string, message?: string, extra: Record<string, unknown> = {}): Response {
  return json({ error, ...(message ? { message } : {}), ...extra }, status);
}

/** Thrown inside handlers to stop with a specific error response. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly error: string,
    readonly userMessage?: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(error);
    this.name = "HttpError";
  }
}

export function originAllowed(request: Request, config: Config = getConfig()): boolean {
  if (SAFE_METHODS.has(request.method)) return true;
  const origin = request.headers.get("origin");
  return origin !== null && config.allowedOrigins.includes(origin) && request.headers.get(CSRF_HEADER) === "1";
}

/**
 * The caller's address for abuse limits. On Vercel the platform sets
 * `x-real-ip` itself (a client can not choose it). Elsewhere, client-supplied
 * forwarding headers are never trusted, so every caller shares one bucket.
 */
export function clientAddress(request: Request): string {
  if (process.env.VERCEL === "1") {
    const ip = request.headers.get("x-real-ip");
    if (ip && /^[0-9a-fA-F:.]{2,45}$/.test(ip)) return ip;
  }
  return "shared";
}

/** A hash of the caller's address for audit rows (never the address itself). */
export function addressHash(request: Request): string {
  return sha256Hex(`addr:${clientAddress(request)}`);
}

/** Parse a strict JSON body; 413 when too large, 422 with field names when invalid. */
export async function readJson<S extends z.ZodType>(request: Request, schema: S): Promise<z.infer<S>> {
  const declared = request.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_JSON_BYTES)) {
    throw new HttpError(413, "too_large", "The request is too large.");
  }
  const text = await request.text();
  if (new TextEncoder().encode(text).length > MAX_JSON_BYTES) {
    throw new HttpError(413, "too_large", "The request is too large.");
  }
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    throw new HttpError(422, "invalid_request", "Some fields are missing or invalid.", { fields: ["body"] });
  }
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.flatMap((issue) => {
      if (issue.code === "unrecognized_keys") return issue.keys;
      return [issue.path.join(".") || "body"];
    }))].sort();
    throw new HttpError(422, "invalid_request", "Some fields are missing or invalid.", { fields });
  }
  return parsed.data;
}

type Handler<C> = (request: Request, context: C) => Promise<Response>;

/**
 * Wrap a route handler with the origin/CSRF check, safe error handling and
 * API headers. Usage: `export const POST = apiRoute(async (request) => ...)`.
 */
export function apiRoute<C = unknown>(handler: Handler<C>): Handler<C> {
  return async (request, context) => {
    if (!originAllowed(request)) return jsonError(403, "forbidden", "Request not allowed.");
    try {
      return withApiHeaders(await handler(request, context));
    } catch (error) {
      if (error instanceof HttpError) return jsonError(error.status, error.error, error.userMessage, error.extra);
      console.error("api error", error instanceof Error ? error.name : typeof error);
      return jsonError(500, "internal_error", "Something went wrong.");
    }
  };
}
