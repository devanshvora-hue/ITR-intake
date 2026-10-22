// Drive the real route handlers in-process with a cookie jar, against the
// in-memory Postgres. E-mail deliveries are collected and run by `flush()`.

import { afterEach, beforeEach } from "vitest";
import { readConfig, setConfigForTests, type Config } from "@/lib/server/config";
import { setDbForTests, type Db } from "@/lib/server/db";
import { setDeliverySchedulerForTests, setMailTransportForTests } from "@/lib/server/email";
import { passwordSettings } from "@/lib/server/passwords";
import { createTestDb } from "./pglite";

export const DEV_ORIGIN = "http://localhost:3000";
export const PROD_ORIGIN = "https://itr.example.test";
export const PASSWORD = "synthetic-pass-4471-x";
export const DEV_CONFIG = readConfig({ APP_ENV: "development", DATABASE_URL: "postgresql://u:p@localhost/db" });
export const PROD_CONFIG = readConfig({
  APP_ENV: "production", DATABASE_URL: "postgresql://u:p@localhost/db", APP_BASE_URL: PROD_ORIGIN,
  SUPABASE_URL: "https://project.supabase.example.test", SUPABASE_SERVICE_ROLE_KEY: "synthetic-key",
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Handler = (request: Request, context: { params: Promise<any> }) => Promise<Response>;

export class Client {
  cookies = new Map<string, string>();
  constructor(private readonly origin = DEV_ORIGIN) {}

  async call(handler: Handler, options: { method?: string; path?: string; body?: unknown; params?: Record<string, string>;
    headers?: Record<string, string>; csrf?: boolean } = {}): Promise<Response> {
    const method = options.method ?? (options.body === undefined ? "GET" : "POST");
    const headers: Record<string, string> = { ...(options.body !== undefined ? { "content-type": "application/json" } : {}) };
    if (method !== "GET" && options.csrf !== false) Object.assign(headers, { origin: this.origin, "x-itr-request": "1" });
    if (this.cookies.size) headers.cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
    Object.assign(headers, options.headers ?? {});
    const request = new Request(`${this.origin}${options.path ?? "/api/x"}`, {
      method, headers, body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    const response = await handler(request, { params: Promise.resolve(options.params ?? {}) });
    for (const cookie of response.headers.getSetCookie()) {
      const [pair] = cookie.split(";");
      const [name, ...value] = pair.split("=");
      if (/Max-Age=0/.test(cookie)) this.cookies.delete(name);
      else this.cookies.set(name, value.join("="));
    }
    return response;
  }

  post(handler: Handler, body: unknown = {}, extra: Parameters<Client["call"]>[1] = {}) {
    return this.call(handler, { ...extra, method: "POST", body });
  }

  get(handler: Handler, extra: Parameters<Client["call"]>[1] = {}) {
    return this.call(handler, { ...extra, method: "GET" });
  }
}

export const env: { db: Db; deliveries: (() => Promise<unknown>)[] } = { db: null as unknown as Db, deliveries: [] };

/** Run every delivery scheduled "after the response". */
export async function flush(): Promise<void> {
  while (env.deliveries.length) await env.deliveries.shift()!();
}

/** Standard per-test setup: fresh database, development config, fast password hashing. */
export function setupTestServer(config: Config = DEV_CONFIG): void {
  beforeEach(async () => {
    env.db = (await createTestDb()).db;
    env.deliveries = [];
    setDbForTests(env.db);
    setConfigForTests(config);
    setDeliverySchedulerForTests((task) => { env.deliveries.push(task); });
    passwordSettings.N = 2 ** 10;
  });
  afterEach(() => {
    setDbForTests(null);
    setConfigForTests(null);
    setDeliverySchedulerForTests(null);
    setMailTransportForTests(null);
  });
}

export async function rows<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  return env.db.query(sql, params) as Promise<T[]>;
}

/** The one-time token from the newest developer-outbox message to `email`. */
export async function mailedToken(email: string): Promise<string> {
  await flush();
  const [message] = await rows<{ link: string }>(
    "SELECT link FROM dev_mailbox WHERE recipient = $1 ORDER BY created_at DESC LIMIT 1", [email]);
  if (!message) throw new Error(`no mail for ${email}`);
  return message.link.split("#token=")[1];
}
