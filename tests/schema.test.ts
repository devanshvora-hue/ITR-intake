// The Supabase schema enforces ownership and integrity on its own, so a bug in
// application code can not attach data to another firm's case.

import { beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { DbError, SCHEMA_VERSION, type Db } from "@/lib/server/db";
import { createTestDb, MIGRATIONS_SQL, SCHEMA_SQL } from "./helpers/pglite";

let db: Db;
let pg: PGlite;

const FIRM_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const FIRM_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CLIENT_A = "aaaaaaaa-0000-4000-8000-000000000001";
const CASE_A = "aaaaaaaa-0000-4000-8000-0000000000ca";
const CODE_B = "bbbbbbbb-0000-4000-8000-0000000000cd";

async function rejects(sql: string, params: unknown[] = []): Promise<DbError> {
  const error = await db.query(sql, params).then(() => null, (e) => e);
  expect(error).toBeInstanceOf(DbError);
  return error as DbError;
}

beforeEach(async () => {
  ({ db, pg } = await createTestDb());
  await db.query("INSERT INTO firms (id, name) VALUES ($1, 'Firm A (synthetic)'), ($2, 'Firm B (synthetic)')",
    [FIRM_A, FIRM_B]);
  await db.query("INSERT INTO client_identities (id, firm_id, email_norm) VALUES ($1, $2, 'client@example.test')",
    [CLIENT_A, FIRM_A]);
  await db.query(`INSERT INTO cases (id, firm_id, client_identity_id, reference, financial_year, client_first_name)
                  VALUES ($1, $2, $3, 'IT-ASHA-ABC123', '2025-26', 'Asha')`, [CASE_A, FIRM_A, CLIENT_A]);
  await db.query("INSERT INTO firm_codes (id, firm_id, code) VALUES ($1, $2, 'ABCD1234EFGH')", [CODE_B, FIRM_B]);
});

describe("schema", () => {
  it("records its version and refuses to run twice", async () => {
    expect(await db.query("SELECT version, name FROM schema_migrations ORDER BY version")).toEqual([
      { version: 1, name: "initial_schema" }, { version: 2, name: "document_checklist" },
      { version: 3, name: "client_resume_codes" }, { version: 4, name: "statement_row_source_page" },
      { version: 5, name: "classification_corrections" }, { version: 6, name: "tax_reports" }]);
    expect(SCHEMA_VERSION).toBe(6);
    await expect(pg.exec(SCHEMA_SQL)).rejects.toThrow(/already applied/);
    await pg.exec("ROLLBACK"); // the failed script leaves its transaction open, as in the SQL editor
    await expect(pg.exec(MIGRATIONS_SQL[0])).rejects.toThrow(/already applied/);
  });

  it("enables row level security on every table", async () => {
    const rows = await db.query<{ relname: string; relrowsecurity: boolean }>(
      `SELECT c.relname, c.relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind = 'r'`);
    expect(rows.length).toBe(22);
    expect(rows.filter((r) => !r.relrowsecurity)).toEqual([]);
  });

  it("refuses a case row that belongs to another firm", async () => {
    const error = await rejects(
      "INSERT INTO statement_rows (case_id, firm_id, row_number, is_valid) VALUES ($1, $2, 1, false)", [CASE_A, FIRM_B]);
    expect(error.isForeignKeyViolation).toBe(true);
  });

  it("refuses a case opened with another firm's code", async () => {
    await rejects("UPDATE cases SET created_via_firm_code_id = $1 WHERE id = $2", [CODE_B, CASE_A]);
  });

  it("keeps at most one active firm code per firm", async () => {
    const error = await rejects("INSERT INTO firm_codes (firm_id, code) VALUES ($1, 'ZZZZ9999YYYY')", [FIRM_B]);
    expect(error.isUniqueViolation).toBe(true);
  });

  it("refuses a client session tied to another firm's code", async () => {
    await rejects(
      `INSERT INTO sessions (token_hash, kind, firm_id, client_identity_id, firm_code_id, idle_expires_at, absolute_expires_at)
       VALUES (repeat('a', 64), 'client', $1, $2, $3, now(), now())`, [FIRM_A, CLIENT_A, CODE_B]);
  });

  it("confines storage keys to the firm's and case's folder", async () => {
    const insert = (key: string) => db.query(
      `INSERT INTO documents (case_id, firm_id, kind, storage_key, display_name, content_type, size_bytes, sha256, uploaded_by)
       VALUES ($1, $2, 'bank_statement', $3, 's.pdf', 'application/pdf', 10, repeat('b', 64), 'client')`,
      [CASE_A, FIRM_A, key]);
    await expect(insert(`${FIRM_B}/${CASE_A}/x.pdf`)).rejects.toBeInstanceOf(DbError);
    await expect(insert(`${FIRM_A}/${CASE_A}/../x.pdf`)).rejects.toBeInstanceOf(DbError);
    await expect(insert(`${FIRM_A}/${CASE_A}/sub/x.pdf`)).rejects.toBeInstanceOf(DbError);
    await insert(`${FIRM_A}/${CASE_A}/x.pdf`);
  });

  it("only lets a statement upload point at a bank statement of the same case", async () => {
    const [doc] = await db.query<{ id: string }>(
      `INSERT INTO documents (case_id, firm_id, kind, storage_key, display_name, content_type, size_bytes, sha256, uploaded_by)
       VALUES ($1, $2, 'supporting', $3, 'p.png', 'image/png', 10, repeat('c', 64), 'client') RETURNING id`,
      [CASE_A, FIRM_A, `${FIRM_A}/${CASE_A}/p.png`]);
    await expect(db.query(
      `INSERT INTO statement_uploads (case_id, firm_id, document_id, file_type, display_name, size_bytes, status, processed_at)
       VALUES ($1, $2, $3, 'pdf', 's.pdf', 10, 'extracted', now())`, [CASE_A, FIRM_A, doc.id])).rejects.toMatchObject({ code: "P0001" });  // trigger refusal
  });

  it("keeps audit events append-only", async () => {
    await db.query("INSERT INTO audit_events (firm_id, actor_kind, action) VALUES ($1, 'system', 'test.event')", [FIRM_A]);
    await expect(db.query("UPDATE audit_events SET action = 'changed'")).rejects.toMatchObject({ code: "P0001" });
    await expect(db.query("DELETE FROM audit_events")).rejects.toMatchObject({ code: "P0001" });
  });

  it("cascades a deleted case to its rows, requests and uploads", async () => {
    await db.query("INSERT INTO document_requests (case_id, firm_id, key, label, source) VALUES ($1, $2, 'pan', 'PAN', 'ca')",
      [CASE_A, FIRM_A]);
    await db.query("DELETE FROM cases WHERE id = $1", [CASE_A]);
    expect(await db.query("SELECT count(*)::int AS n FROM document_requests")).toEqual([{ n: 0 }]);
  });
});

describe("value conventions", () => {
  it("returns money as exact text, dates as plain text and timestamps as Date", async () => {
    const [row] = await db.query<{ m: string; d: string; t: Date; j: unknown }>(
      "SELECT 1250.5::numeric(18,2) AS m, '2025-04-01'::date AS d, now() AS t, '{\"a\":1}'::jsonb AS j");
    expect(row.m).toBe("1250.50");
    expect(row.d).toBe("2025-04-01");
    expect(row.t).toBeInstanceOf(Date);
    expect(row.j).toEqual({ a: 1 });
  });

  it("rolls back a failed transaction and keeps an inner savepoint's failure contained", async () => {
    await expect(db.transaction(async (tx) => {
      await tx.query("INSERT INTO firms (name) VALUES ('Rolled back')");
      throw new Error("stop");
    })).rejects.toThrow("stop");
    await db.transaction(async (tx) => {
      await tx.query("INSERT INTO firms (name) VALUES ('Kept')");
      await expect(tx.transaction(async (inner) => {
        await inner.query("INSERT INTO firms (name) VALUES ('Inner')");
        throw new Error("inner");
      })).rejects.toThrow("inner");
    });
    const names = (await db.query<{ name: string }>("SELECT name FROM firms ORDER BY name")).map((r) => r.name);
    expect(names).toEqual(["Firm A (synthetic)", "Firm B (synthetic)", "Kept"]);
  });
});
