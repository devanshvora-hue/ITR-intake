// GET /api/health: is the API configured and can it reach the database with
// the expected schema? Reports only fixed codes, never configuration values.

import { ConfigError, getConfig } from "@/lib/server/config";
import { getDb, SCHEMA_VERSION } from "@/lib/server/db";
import { diagnoseDbError } from "@/lib/server/db-diagnosis";
import { apiRoute, json, jsonError } from "@/lib/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = apiRoute(async () => {
  try {
    getConfig();
  } catch (error) {
    // The message names the variable that is missing or malformed, never its value.
    if (error instanceof ConfigError) {
      return jsonError(503, "not_configured", "The server is not configured yet.", { detail: error.message });
    }
    throw error;
  }
  let version: number | null = null;
  try {
    const rows = await getDb().query<{ version: number }>("SELECT max(version) AS version FROM schema_migrations");
    version = rows[0]?.version ?? null;
  } catch (error) {
    return jsonError(503, "database_unavailable", "The database is not reachable or the schema is missing.",
      { detail: diagnoseDbError(error) });
  }
  if (version !== SCHEMA_VERSION) {
    return jsonError(503, "schema_mismatch", "The database schema is not the expected version.");
  }
  return json({ status: "ok" });
});
