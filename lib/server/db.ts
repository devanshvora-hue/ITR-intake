// Database access. All application code talks to the small `Db` interface:
// parameterised SQL text ($1, $2, ...) and transactions. Production uses
// postgres.js over Supabase's connection pooler; tests use an in-memory
// Postgres (PGlite) through the same interface.
//
// Value conventions (identical in both adapters):
//   numeric     -> string (exact money, e.g. "1250.00")
//   date        -> "YYYY-MM-DD" string (never shifted by time zones)
//   timestamptz -> Date
//   jsonb       -> parsed value

import postgres from "postgres";
import { getConfig } from "./config";

export type Row = Record<string, unknown>;

/** The schema version supabase/schema.sql records in schema_migrations. */
export const SCHEMA_VERSION = 1;

export interface Db {
  query<T extends Row = Row>(text: string, params?: unknown[]): Promise<T[]>;
  /** Run `fn` in a transaction (a savepoint when already inside one). */
  transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T>;
}

/** A database error with the Postgres SQLSTATE code and constraint name, never the query or values. */
export class DbError extends Error {
  constructor(
    readonly code: string,
    readonly constraint: string | null,
  ) {
    super(`database error ${code}${constraint ? ` (${constraint})` : ""}`);
    this.name = "DbError";
  }
  get isUniqueViolation(): boolean {
    return this.code === "23505";
  }
  get isForeignKeyViolation(): boolean {
    return this.code === "23503";
  }
  get isCheckViolation(): boolean {
    return this.code === "23514";
  }
}

export function toDbError(error: unknown): unknown {
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string"
      && /^[0-9A-Z]{5}$/.test(error.code)) {
    const constraint = "constraint_name" in error ? error.constraint_name : "constraint" in error ? error.constraint : null;
    return new DbError(error.code, typeof constraint === "string" ? constraint : null);
  }
  return error;
}

// --- postgres.js (production) -------------------------------------------------------------------

type Sql = postgres.Sql | postgres.TransactionSql;

function wrapPostgres(sql: Sql, inTransaction: boolean): Db {
  return {
    async query<T extends Row>(text: string, params: unknown[] = []) {
      try {
        return (await sql.unsafe(text, params as postgres.ParameterOrJSON<never>[])) as unknown as T[];
      } catch (error) {
        throw toDbError(error);
      }
    },
    async transaction<T>(fn: (tx: Db) => Promise<T>) {
      try {
        if (inTransaction) {
          return (await (sql as postgres.TransactionSql).savepoint((sp) => fn(wrapPostgres(sp, true)))) as T;
        }
        return (await (sql as postgres.Sql).begin((tx) => fn(wrapPostgres(tx, true)))) as T;
      } catch (error) {
        throw toDbError(error);
      }
    },
  };
}

export function createPostgresDb(url: string): { db: Db; end: () => Promise<void> } {
  const sql = postgres(url, {
    // Supabase's transaction pooler (port 6543) does not support prepared statements.
    prepare: false,
    max: 5,
    idle_timeout: 20,
    connect_timeout: 10,
    types: {
      // Keep calendar dates as plain text.
      date: { to: 1082, from: [1082], serialize: (x: string) => x, parse: (x: string) => x },
    },
  });
  return { db: wrapPostgres(sql, false), end: () => sql.end({ timeout: 5 }) };
}

let shared: Db | null = null;

/** The process-wide database (created on first use from DATABASE_URL). */
export function getDb(): Db {
  shared ??= createPostgresDb(getConfig().databaseUrl).db;
  return shared;
}

/** For tests: use another database (e.g. PGlite) or reset to the default. */
export function setDbForTests(db: Db | null): void {
  shared = db;
}
