// An in-memory Postgres (PGlite) with the real Supabase schema applied, behind
// the same `Db` interface the app uses. Tests never touch a real database.

import { readdirSync, readFileSync } from "node:fs";
import { PGlite, types } from "@electric-sql/pglite";
import { toDbError, type Db, type Row } from "@/lib/server/db";

export const SCHEMA_SQL = readFileSync(new URL("../../supabase/schema.sql", import.meta.url), "utf8");
const MIGRATIONS_DIR = new URL("../../supabase/migrations/", import.meta.url);
/** supabase/migrations/*.sql in order, applied after schema.sql exactly as in production. */
export const MIGRATIONS_SQL = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort()
  .map((f) => readFileSync(new URL(f, MIGRATIONS_DIR), "utf8"));

type Queryable = Pick<PGlite, "query">;

function wrap(pg: Queryable, savepoints: { n: number } | null, root: PGlite): Db {
  return {
    async query<T extends Row>(text: string, params: unknown[] = []) {
      try {
        return (await pg.query<T>(text, params)).rows;
      } catch (error) {
        throw toDbError(error);
      }
    },
    async transaction<T>(fn: (tx: Db) => Promise<T>) {
      if (savepoints) {
        const name = `sp_${++savepoints.n}`;
        await pg.query(`SAVEPOINT ${name}`);
        try {
          const result = await fn(wrap(pg, savepoints, root));
          await pg.query(`RELEASE SAVEPOINT ${name}`);
          return result;
        } catch (error) {
          await pg.query(`ROLLBACK TO SAVEPOINT ${name}`);
          throw toDbError(error);
        }
      }
      try {
        return await root.transaction((tx) => fn(wrap(tx, { n: 0 }, root)));
      } catch (error) {
        throw toDbError(error);
      }
    },
  };
}

export async function createTestDb(): Promise<{ db: Db; pg: PGlite }> {
  const pg = new PGlite({
    // Same value conventions as production: dates stay "YYYY-MM-DD" text.
    parsers: { [types.DATE]: (value: string) => value },
  });
  await pg.exec(SCHEMA_SQL);
  for (const migration of MIGRATIONS_SQL) await pg.exec(migration);
  return { db: wrap(pg, null, pg), pg };
}
