// Server configuration, read once from environment variables (Vercel project
// settings in production, `.env.local` for local development). Never import
// this from client components.
//
// Errors name the variable that is missing or invalid, never its value.

export type Environment = "development" | "production";

export type SmtpConfig = {
  host: string;
  port: number;
  tls: "starttls" | "implicit";
  username: string | null;
  password: string | null;
  from: string;
};

export type Config = {
  environment: Environment;
  /** The site's public origin, e.g. https://itr-intake.vercel.app (used in e-mail links). */
  appBaseUrl: string;
  /** Origins allowed to send state-changing requests (CSRF/origin check). */
  allowedOrigins: string[];
  databaseUrl: string;
  supabaseUrl: string | null;
  supabaseServiceRoleKey: string | null;
  storageBucket: string;
  smtp: SmtpConfig | null;
};

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

type Env = Record<string, string | undefined>;

const ADDRESS = /^[^@\s<>"]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
const HOST = /^[A-Za-z0-9.-]{1,253}$/;
const DEV_ORIGINS = ["http://localhost:3000", "http://127.0.0.1:3000"];

function value(env: Env, name: string): string {
  return (env[name] ?? "").trim();
}

function origin(url: string, name: string): string {
  try {
    return new URL(url).origin;
  } catch {
    throw new ConfigError(`${name} must be a full URL, e.g. https://example.com`);
  }
}

export function readSmtpConfig(env: Env): SmtpConfig | null {
  const names = ["SMTP_HOST", "SMTP_PORT", "SMTP_TLS", "SMTP_USER", "SMTP_PASSWORD", "EMAIL_FROM"];
  if (!names.some((n) => value(env, n))) return null;
  const host = value(env, "SMTP_HOST");
  const from = value(env, "EMAIL_FROM");
  if (!host || !from) throw new ConfigError("SMTP_HOST and EMAIL_FROM are both required to enable e-mail");
  if (!HOST.test(host)) throw new ConfigError("SMTP_HOST must be a host name");
  if (!ADDRESS.test(from)) throw new ConfigError("EMAIL_FROM must be a plain e-mail address");
  const tlsText = value(env, "SMTP_TLS") || "starttls";
  if (tlsText !== "starttls" && tlsText !== "implicit") {
    throw new ConfigError('SMTP_TLS must be "starttls" or "implicit"');
  }
  const portText = value(env, "SMTP_PORT") || (tlsText === "implicit" ? "465" : "587");
  const port = Number(portText);
  if (!/^\d+$/.test(portText) || port < 1 || port > 65535) throw new ConfigError("SMTP_PORT must be a port number");
  const username = value(env, "SMTP_USER") || null;
  const password = value(env, "SMTP_PASSWORD") || null;
  if (Boolean(username) !== Boolean(password)) {
    throw new ConfigError("SMTP_USER and SMTP_PASSWORD must be set together");
  }
  return { host, port, tls: tlsText, username, password, from };
}

/** Build the configuration from an environment map. Exported for tests. */
export function readConfig(env: Env): Config {
  const explicit = value(env, "APP_ENV");
  if (explicit && explicit !== "development" && explicit !== "production") {
    throw new ConfigError('APP_ENV must be "development" or "production"');
  }
  const environment: Environment =
    (explicit as Environment) || (env.NODE_ENV === "production" ? "production" : "development");

  const databaseUrl = value(env, "DATABASE_URL");
  if (!databaseUrl) throw new ConfigError("DATABASE_URL is required (Supabase connection string)");
  if (!/^postgres(ql)?:\/\//.test(databaseUrl)) throw new ConfigError("DATABASE_URL must be a postgres:// URL");

  const supabaseUrl = value(env, "SUPABASE_URL") || null;
  const supabaseServiceRoleKey = value(env, "SUPABASE_SERVICE_ROLE_KEY") || null;
  if (Boolean(supabaseUrl) !== Boolean(supabaseServiceRoleKey)) {
    throw new ConfigError("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set together");
  }
  if (supabaseUrl && !supabaseUrl.startsWith("https://")) throw new ConfigError("SUPABASE_URL must start with https://");

  let appBaseUrl = value(env, "APP_BASE_URL");
  const allowed = new Set<string>();
  if (environment === "production") {
    if (!appBaseUrl.startsWith("https://")) throw new ConfigError("APP_BASE_URL must be the site's https:// address");
    if (!supabaseUrl) throw new ConfigError("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required in production");
  } else {
    appBaseUrl ||= "http://localhost:3000";
    DEV_ORIGINS.forEach((o) => allowed.add(o));
  }
  appBaseUrl = origin(appBaseUrl, "APP_BASE_URL");
  allowed.add(appBaseUrl);
  for (const extra of value(env, "ALLOWED_ORIGINS").split(",").map((s) => s.trim()).filter(Boolean)) {
    const o = origin(extra, "ALLOWED_ORIGINS");
    if (environment === "production" && !o.startsWith("https://")) {
      throw new ConfigError("ALLOWED_ORIGINS must be https:// in production");
    }
    allowed.add(o);
  }
  // Vercel preview deployments get their own address; allow it automatically.
  for (const name of ["VERCEL_URL", "VERCEL_BRANCH_URL"]) {
    const host = value(env, name);
    if (host && env.VERCEL_ENV === "preview") allowed.add(`https://${host}`);
  }

  return {
    environment,
    appBaseUrl,
    allowedOrigins: [...allowed],
    databaseUrl,
    supabaseUrl,
    supabaseServiceRoleKey,
    storageBucket: value(env, "STORAGE_BUCKET") || "itr-private",
    smtp: readSmtpConfig(env),
  };
}

let cached: Config | null = null;

export function getConfig(): Config {
  cached ??= readConfig(process.env);
  return cached;
}

/** For tests: replace or clear the cached configuration. */
export function setConfigForTests(config: Config | null): void {
  cached = config;
}

export function isProduction(config: Config = getConfig()): boolean {
  return config.environment === "production";
}

/** "simulated" (development), "email" (SMTP configured) or "not_configured". */
export function emailDelivery(config: Config = getConfig()): "simulated" | "email" | "not_configured" {
  if (config.environment === "development") return "simulated";
  return config.smtp ? "email" : "not_configured";
}
