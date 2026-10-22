// Phase 1 foundation: configuration, IDs and tokens, the API route guard,
// rate limits, cookies, file storage and the health route.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { GET as health } from "@/app/api/health/route";
import { ConfigError, emailDelivery, readConfig, setConfigForTests, type Config } from "@/lib/server/config";
import { clearSessionCookie, cookieName, readSessionToken, setSessionCookie } from "@/lib/server/cookies";
import { setDbForTests, type Db } from "@/lib/server/db";
import { apiRoute, HttpError, json, readJson } from "@/lib/server/http";
import {
  formatFirmCode, isCaseReference, isToken, newCaseReference, newFirmCode, newId, newToken, normaliseEmail, parseId,
  referenceName, tokenHash, validateFinancialYear,
} from "@/lib/server/ids";
import { HOUR, limitReached, withinAll, withinLimit } from "@/lib/server/rate-limit";
import { MemoryStore, StorageError, storageKey } from "@/lib/server/storage";
import { createTestDb } from "./helpers/pglite";

const PASSWORD = "synthetic-smtp-password-123";
const BASE = { DATABASE_URL: "postgresql://u:p@db.example.test:6543/postgres" };
const PROD = {
  ...BASE, APP_ENV: "production", APP_BASE_URL: "https://itr.example.test",
  SUPABASE_URL: "https://project.supabase.example.test", SUPABASE_SERVICE_ROLE_KEY: "synthetic-key",
};
const DEV_CONFIG = readConfig({ ...BASE, APP_ENV: "development" });
const PROD_CONFIG = readConfig(PROD);

afterEach(() => {
  setConfigForTests(null);
  setDbForTests(null);
});

// === configuration ==================================================================================================

describe("config", () => {
  it("development allows the local origins and simulates e-mail", () => {
    expect(DEV_CONFIG.allowedOrigins).toEqual(expect.arrayContaining(["http://localhost:3000"]));
    expect(emailDelivery(DEV_CONFIG)).toBe("simulated");
  });

  it("production needs an https site address and Supabase", () => {
    expect(PROD_CONFIG.allowedOrigins).toEqual(["https://itr.example.test"]);
    expect(emailDelivery(PROD_CONFIG)).toBe("not_configured");
    expect(() => readConfig({ ...PROD, APP_BASE_URL: "http://itr.example.test" })).toThrow(/APP_BASE_URL/);
    expect(() => readConfig({ ...PROD, SUPABASE_URL: "", SUPABASE_SERVICE_ROLE_KEY: "" })).toThrow(/SUPABASE_URL/);
    expect(() => readConfig({ ...PROD, DATABASE_URL: "" })).toThrow(/DATABASE_URL/);
  });

  it("forgives quotes and a pasted name, and explains a wrong DATABASE_URL without echoing it", () => {
    expect(readConfig({ ...PROD, DATABASE_URL: `"${BASE.DATABASE_URL}"` }).databaseUrl).toBe(BASE.DATABASE_URL);
    expect(readConfig({ ...PROD, DATABASE_URL: `DATABASE_URL=${BASE.DATABASE_URL}` }).databaseUrl).toBe(BASE.DATABASE_URL);
    expect(() => readConfig({ ...PROD, DATABASE_URL: "https://secretproject.supabase.co" })).toThrow(/web address/);
    expect(() => readConfig({ ...PROD, DATABASE_URL: "psql -h host secret" })).toThrow(/psql command/);
    let message = "";
    try { readConfig({ ...PROD, DATABASE_URL: "https://secretproject.supabase.co" }); } catch (e) { message = String(e); }
    expect(message).not.toContain("secretproject");
  });

  it("allows a Vercel preview address automatically", () => {
    const config = readConfig({ ...PROD, VERCEL_ENV: "preview", VERCEL_URL: "itr-abc.vercel.app" });
    expect(config.allowedOrigins).toContain("https://itr-abc.vercel.app");
  });

  it("reads SMTP settings and never echoes the password in errors", () => {
    const smtp = { SMTP_HOST: "smtp.example.test", EMAIL_FROM: "no-reply@example.test", SMTP_USER: "u", SMTP_PASSWORD: PASSWORD };
    expect(emailDelivery(readConfig({ ...PROD, ...smtp }))).toBe("email");
    for (const broken of [{ EMAIL_FROM: "" }, { SMTP_PASSWORD: "" }, { SMTP_PORT: "x" }, { SMTP_TLS: "none" },
      { EMAIL_FROM: "a@example.test\r\nBcc: b@example.test" }]) {
      let error: unknown;
      try { readConfig({ ...PROD, ...smtp, ...broken }); } catch (e) { error = e; }
      expect(error).toBeInstanceOf(ConfigError);
      expect(String(error)).not.toContain(PASSWORD);
    }
  });
});

// === IDs and tokens =====================================================================================================

describe("ids", () => {
  it("accepts only canonical UUID4 identifiers", () => {
    const id = newId();
    expect(parseId(id)).toBe(id);
    for (const bad of [id.toUpperCase(), "not-a-uuid", "00000000-0000-1000-8000-000000000000", 7, null]) {
      expect(() => parseId(bad)).toThrow();
    }
  });

  it("makes 43-character tokens and stores only their hash", () => {
    const token = newToken();
    expect(isToken(token)).toBe(true);
    expect(tokenHash(token)).toMatch(/^[0-9a-f]{64}$/);
    expect(tokenHash(token)).not.toContain(token);
  });

  it("builds readable case references and firm codes", () => {
    expect(referenceName("Ásha Rao")).toBe("ASHARAO");
    expect(referenceName("123")).toBe("CLIENT");
    expect(isCaseReference(newCaseReference("Asha"))).toBe(true);
    const code = newFirmCode();
    expect(code).toMatch(/^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{12}$/);
    expect(formatFirmCode("7K4P92XMQR3T")).toBe("7K4P-92XM-QR3T");
  });

  it("normalises e-mails and financial years", () => {
    expect(normaliseEmail("  Asha@Example.TEST ")).toBe("asha@example.test");
    expect(() => normaliseEmail("nope")).toThrow();
    expect(validateFinancialYear("2025-26")).toBe("2025-26");
    expect(() => validateFinancialYear("2025-27")).toThrow();
  });
});

// === the API route guard =============================================================================================

describe("apiRoute", () => {
  const echo = apiRoute(async (request: Request) =>
    json(await readJson(request, z.strictObject({ label: z.string().min(2).max(10) }))));

  function post(headers: Record<string, string>, body: unknown = { label: "Form 16" }) {
    return new Request("http://localhost:3000/api/x", {
      method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body),
    });
  }

  beforeEach(() => setConfigForTests(DEV_CONFIG));

  it("requires an allowed origin and the CSRF header for state changes", async () => {
    const refused: Record<string, string>[] = [
      {}, { origin: "http://localhost:3000" }, { origin: "https://evil.example.test", "x-itr-request": "1" }];
    for (const headers of refused) {
      const response = await echo(post(headers), undefined);
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: "forbidden", message: "Request not allowed." });
    }
    const ok = await echo(post({ origin: "http://localhost:3000", "x-itr-request": "1" }), undefined);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("cache-control")).toBe("no-store");
    expect(ok.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("refuses unknown and invalid fields with their names only", async () => {
    const headers = { origin: "http://localhost:3000", "x-itr-request": "1" };
    const response = await echo(post(headers, { label: "x", key: "pan" }), undefined);
    expect(response.status).toBe(422);
    expect((await response.json()).fields).toEqual(["key", "label"]);
  });

  it("turns unexpected failures into a generic 500 and HttpError into its own answer", async () => {
    const boom = apiRoute(async () => { throw new Error("secret detail /var/data.db"); });
    const response = await boom(new Request("http://localhost:3000/api/x"), undefined);
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("secret detail");
    const known = apiRoute(async () => { throw new HttpError(404, "not_found", "Not found."); });
    expect(await (await known(new Request("http://localhost:3000/api/x"), undefined)).json())
      .toEqual({ error: "not_found", message: "Not found." });
  });
});

// === rate limits ======================================================================================================

describe("rate limits", () => {
  let db: Db;
  beforeEach(async () => ({ db } = await createTestDb()));

  it("counts hits per window and stores only hashed keys", async () => {
    const now = new Date("2026-10-22T10:15:00Z");
    expect(await withinLimit(db, "login", "a@example.test", 2, HOUR, now)).toBe(true);
    expect(await withinLimit(db, "login", "a@example.test", 2, HOUR, now)).toBe(true);
    expect(await limitReached(db, "login", "a@example.test", 2, HOUR, now)).toBe(true);
    expect(await withinLimit(db, "login", "a@example.test", 2, HOUR, now)).toBe(false);
    expect(await withinLimit(db, "login", "a@example.test", 2, HOUR, new Date("2026-10-22T11:00:00Z"))).toBe(true);
    const buckets = (await db.query<{ bucket: string }>("SELECT bucket FROM rate_limits")).map((r) => r.bucket);
    expect(buckets.some((b) => b.includes("example.test"))).toBe(false);
  });

  it("advances every counter even when one is over its limit", async () => {
    const now = new Date("2026-10-22T10:15:00Z");
    expect(await withinAll(db, [["a", "k", 0, HOUR], ["b", "k", 5, HOUR]], now)).toBe(false);
    expect(await db.query("SELECT count FROM rate_limits ORDER BY bucket")).toEqual([{ count: 1 }, { count: 1 }]);
  });
});

// === cookies =========================================================================================================

describe("session cookies", () => {
  it("are HttpOnly and Lax, and Secure with the __Host- prefix in production", () => {
    const dev = setSessionCookie(new Response(), "ca", "tok", DEV_CONFIG).headers.get("set-cookie")!;
    expect(dev).toMatch(/^itr_ca_session=tok; Path=\/; HttpOnly; SameSite=Lax; Max-Age=43200$/);
    const prod = setSessionCookie(new Response(), "client", "tok", PROD_CONFIG).headers.get("set-cookie")!;
    expect(prod).toMatch(/^__Host-itr_client_session=tok; .*Secure$/);
    expect(clearSessionCookie(new Response(), "ca", PROD_CONFIG).headers.get("set-cookie")).toContain("Max-Age=0");
    const request = new Request("http://x", { headers: { cookie: `a=1; ${cookieName("ca", DEV_CONFIG)}=abc` } });
    expect(readSessionToken(request, "ca", DEV_CONFIG)).toBe("abc");
    expect(readSessionToken(request, "client", DEV_CONFIG)).toBeNull();
  });
});

// === storage ==========================================================================================================

describe("file storage", () => {
  const firm = newId(), kase = newId(), doc = newId();

  it("only accepts server-generated keys and never overwrites", async () => {
    const store = new MemoryStore();
    const key = storageKey(firm, kase, doc, "pdf");
    await store.put(key, new Uint8Array([1, 2, 3]), "application/pdf");
    expect([...await store.get(key)]).toEqual([1, 2, 3]);
    await expect(store.put(key, new Uint8Array([9]), "application/pdf")).rejects.toThrow(StorageError);
    for (const bad of [`${firm}/${kase}/../x.pdf`, `${firm}/x.pdf`, `${firm}/${kase}/${doc}.PDF`]) {
      await expect(store.get(bad)).rejects.toMatchObject({ code: "invalid_key" });
    }
  });
});

// === health route =====================================================================================================

describe("GET /api/health", () => {
  it("reports ok when the schema is in place", async () => {
    setConfigForTests(DEV_CONFIG);
    setDbForTests((await createTestDb()).db);
    const response = await health(new Request("http://localhost:3000/api/health"), undefined);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
  });

  it("reports a missing schema without details", async () => {
    setConfigForTests(DEV_CONFIG);
    const broken: Db = { query: async () => { throw new Error("connection refused at 10.0.0.1"); }, transaction: async () => { throw new Error(); } };
    setDbForTests(broken);
    const response = await health(new Request("http://localhost:3000/api/health"), undefined);
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("10.0.0.1");
  });
});

export type { Config };

// postgres.js serialises a parameter by the type Postgres reports for it; a
// "$n::jsonb" parameter would be JSON-encoded a second time (a JSON string, not
// an object). JSON text must be sent as text and cast in SQL: "$n::text::jsonb".
describe("SQL parameters", () => {
  it("never declare a parameter as jsonb directly", async () => {
    const { readdirSync, readFileSync, statSync } = await import("node:fs");
    const { join } = await import("node:path");
    const files: string[] = [];
    const walk = (dir: string) => readdirSync(dir).forEach((f) => {
      const p = join(dir, f);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith(".ts")) files.push(p);
    });
    walk("lib");
    walk("app");
    expect(files.filter((f) => /\$\d+::jsonb/.test(readFileSync(f, "utf8")))).toEqual([]);
  });
});
