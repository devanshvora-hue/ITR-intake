// Turn a database connection failure into a fixed, safe explanation for the
// health check. Never includes the address, user name, password or error text.

export function diagnoseDbError(error: unknown): string {
  const e = (error ?? {}) as { code?: unknown; message?: unknown };
  const code = typeof e.code === "string" ? e.code : "";
  const message = typeof e.message === "string" ? e.message : "";
  if (code === "28P01" || code === "28000") {
    return "The database rejected the password in DATABASE_URL. Check it, and if it contains special characters "
      + "such as @ # / ? % : replace them with their URL-encoded form (or reset the password to letters and digits).";
  }
  if (/tenant or user not found/i.test(message) || code === "XX000") {
    return "The pooler did not recognise the user in DATABASE_URL. With the Transaction pooler the user name must be "
      + "postgres.<your-project-ref>, exactly as Supabase -> Connect shows it.";
  }
  if (code === "42P01") return "The database tables are missing. Run supabase/schema.sql in the Supabase SQL Editor.";
  if (code === "3D000") return "The database name at the end of DATABASE_URL is wrong; it should be /postgres.";
  if (["ENOTFOUND", "EAI_AGAIN"].includes(code)) return "The host name in DATABASE_URL could not be found. Copy the URI again.";
  if (["ECONNREFUSED", "ETIMEDOUT", "ENETUNREACH", "EHOSTUNREACH", "CONNECT_TIMEOUT", "ECONNRESET"].includes(code)) {
    return "The database could not be reached. On Vercel use the Transaction pooler URI (host *.pooler.supabase.com, "
      + "port 6543); the direct connection (db.<ref>.supabase.co:5432) is IPv6-only and is not reachable from Vercel.";
  }
  if (/ssl|tls|certificate/i.test(code + message)) return "The secure connection to the database failed.";
  return `The database could not be used (error code ${/^[A-Z0-9_]{1,20}$/.test(code) ? code : "unknown"}).`;
}
