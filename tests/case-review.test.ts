// CA case detail, review preparation and the internal workbook through the
// real routes, with in-memory storage. Synthetic statements only.

import ExcelJS from "exceljs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GET as caCases } from "@/app/api/ca/cases/route";
import { GET as detailRoute } from "@/app/api/ca/cases/[reference]/route";
import { POST as reviewRoute } from "@/app/api/ca/cases/[reference]/review/route";
import { GET as workbookRoute } from "@/app/api/ca/cases/[reference]/workbook/route";
import { POST as createCode } from "@/app/api/ca/firm-code/route";
import { POST as openCase } from "@/app/api/client/cases/route";
import { POST as saveProfile } from "@/app/api/client/cases/[reference]/profile/route";
import { POST as uploadRoute } from "@/app/api/client/cases/[reference]/statements/route";
import { POST as start } from "@/app/api/client/start/route";
import { financialYearOptions } from "@/lib/server/client-auth";
import { MemoryStore, setFileStoreForTests } from "@/lib/server/storage";
import { onboardCa } from "./helpers/ca";
import { Client, env, rows, setupTestServer } from "./helpers/http";
import { goodPdf } from "./helpers/synthetic-pdf";

setupTestServer();
let store: MemoryStore;
beforeEach(() => {
  store = new MemoryStore();
  setFileStoreForTests(store);
});
afterEach(() => setFileStoreForTests(null));

const FY = financialYearOptions().includes("2025-26") ? "2025-26" : financialYearOptions()[0];
const enc = (s: string) => new TextEncoder().encode(s);
const CSV_OK = enc("Date,Narration,Debit,Credit,Balance\n01/04/2025,UPI/1001/SYNTHETIC SHOP,250.00,,9750.00\n"
  + "02/04/2025,NEFT SALARY SYNTHETIC CO,,50000.00,59750.00\n");
const CSV_PARTLY_BAD = enc("Date,Narration,Debit,Credit,Balance\n01/04/2025,UPI SYNTHETIC SHOP,250.00,,9750.00\n"
  + "32/04/2025,SYNTHETIC BAD DATE,10.00,,9740.00\n03/04/2025,SYNTHETIC BAD AMOUNT,abc,,9730.00\n");
const CSV_FORMULA = enc('Date,Narration,Debit,Credit,Balance\n01/04/2025,"=HYPERLINK(""http://example.test"")",100.00,,900.00\n');

async function setup(tag = "a") {
  const ca = await onboardCa(tag);
  const code = (await (await ca.post(createCode)).json()).firm_code.code;
  const client = new Client();
  const email = `client-${tag}@example.test`;
  expect((await client.post(start, { firm_code: code, email })).status).toBe(200); // signs in directly
  const { reference } = (await (await client.post(openCase, { first_name: "Asha", financial_year: FY })).json()).case;
  await client.post(saveProfile, { full_name: "Asha Rao", bank_name: "Synthetic Bank Ltd", account_last4: "1234" }, { params: { reference } });
  return { ca, client, reference };
}

async function upload(client: Client, reference: string, data: Uint8Array, name = "s.csv", type = "text/csv"): Promise<string> {
  const response = await client.call(uploadRoute, { method: "POST", params: { reference }, rawBody: data,
    headers: { "content-type": type, "x-upload-filename": name } });
  return (await response.json()).statement.id;
}

const detail = (ca: Client, reference: string) => ca.get(detailRoute, { params: { reference } });
const prepare = (ca: Client, reference: string, statementId: string, extra = {}) =>
  ca.post(reviewRoute, { statement_id: statementId }, { params: { reference }, ...extra });

describe("case detail", () => {
  it("shows the case, profile and uploads before any review, to the owning firm only", async () => {
    const { ca, client, reference } = await setup();
    await upload(client, reference, CSV_OK);
    const body = await (await detail(ca, reference)).json();
    expect(body.case).toMatchObject({ reference, financial_year: FY, client_email: "client-a@example.test" });
    expect(body.profile).toMatchObject({ full_name: "Asha Rao", complete: true });
    expect(body.statements).toHaveLength(1);
    expect([body.review, body.document_requests]).toEqual([null, []]);
    const other = await onboardCa("b");
    expect((await detail(other, reference)).status).toBe(404);
    expect((await detail(client, reference)).status).toBe(401); // a client cookie is not a CA session
    expect((await detail(ca, "IT-NOPE-000000")).status).toBe(404);
  });
});

describe("review preparation", () => {
  it("turns an extracted CSV into a verified, classified review", async () => {
    const { ca, client, reference } = await setup();
    const id = await upload(client, reference, CSV_OK);
    const response = await prepare(ca, reference, id);
    expect(response.status).toBe(200);
    const { review, case: c } = await response.json();
    expect(c.status).toBe("ca_review_required");
    expect([review.verified, review.unverified_reasons]).toEqual([true, []]);
    expect(review.totals).toMatchObject({ rows: 2, valid: 2, invalid: 0, credits: "50000.00", debits: "250.00" });
    expect(review.reconciliation.status).toBe("passed");
    expect(review.rows.map((r: { date: string; debit: string; credit: string; category: string }) => [r.date, r.debit, r.credit]))
      .toEqual([["2025-04-01", "250.00", "0.00"], ["2025-04-02", "0.00", "50000.00"]]);
    expect(review.rows[1].category).toBe("Salary / Pension");
    expect(await rows("SELECT action FROM audit_events WHERE action = 'case.review_prepared'")).toHaveLength(1);
    const cases = (await (await ca.get(caCases)).json()).cases;
    expect(cases[0].readiness.statement).toBe("verified");
  });

  it("never shows a manual-review statement as verified, and keeps rejected rows as codes only", async () => {
    const { ca, client, reference } = await setup();
    const { review } = await (await prepare(ca, reference, await upload(client, reference, CSV_PARTLY_BAD))).json();
    expect(review.verified).toBe(false);
    expect(new Set(review.unverified_reasons)).toEqual(new Set(["statement_needs_manual_review", "rows_invalid", "balance_check_not_passed"]));
    const invalid = review.rows.filter((r: { is_valid: boolean }) => !r.is_valid);
    expect(invalid.map((r: { row_number: number; issues: string[] }) => [r.row_number, r.issues]))
      .toEqual([[2, ["invalid_date"]], [3, ["debit_invalid_amount"]]]);
    expect(invalid.every((r: { narration: string | null; category: string | null }) => r.narration === null && r.category === null)).toBe(true);
  });

  it("reviews an extracted PDF and replaces earlier rows when prepared again", async () => {
    const { ca, client, reference } = await setup();
    const pdf = await upload(client, reference, goodPdf(), "s.pdf", "application/pdf");
    const first = (await (await prepare(ca, reference, pdf)).json()).review;
    expect([first.verified, first.totals.rows]).toEqual([true, 5]);
    const csv = await upload(client, reference, CSV_OK);
    await prepare(ca, reference, csv);
    expect(await rows("SELECT count(*)::int AS n FROM statement_rows")).toEqual([{ n: 2 }]);
  });

  it("refuses unusable statements, missing files and other cases", async () => {
    const { ca, client, reference } = await setup();
    const good = await upload(client, reference, CSV_OK); // moves the case to "statement_uploaded"
    const rejected = await upload(client, reference, enc("not,a,statement\n"), "s.csv");
    const refused = await prepare(ca, reference, rejected);
    expect([refused.status, (await refused.json()).error]).toEqual([409, "statement_not_usable"]);
    expect((await prepare(ca, reference, "00000000-0000-4000-8000-000000000000")).status).toBe(404);
    expect((await prepare(ca, reference, "not-a-uuid")).status).toBe(404);

    store.objects.clear();
    const missing = await prepare(ca, reference, good);
    expect([missing.status, (await missing.json()).error]).toEqual([409, "file_missing"]);

    const { ca: otherCa, client: otherClient, reference: otherRef } = await setup("b");
    await upload(otherClient, otherRef, CSV_OK); // the other case is ready for review too
    expect((await prepare(otherCa, otherRef, good)).status).toBe(404);   // upload of another firm's case
    expect((await prepare(otherCa, reference, good)).status).toBe(404);  // another firm's case
    expect((await prepare(ca, reference, good, { csrf: false })).status).toBe(403);
  });

  it("refuses a closed case", async () => {
    const { ca, client, reference } = await setup();
    const id = await upload(client, reference, CSV_OK);
    await env.db.query("UPDATE cases SET status = 'closed', closed_at = now()");
    const response = await prepare(ca, reference, id);
    expect([response.status, (await response.json()).error]).toEqual([409, "case_closed"]);
  });
});

describe("internal workbook", () => {
  it("needs a prepared review", async () => {
    const { ca, reference } = await setup();
    const response = await ca.get(workbookRoute, { params: { reference } });
    expect([response.status, (await response.json()).error]).toEqual([404, "no_review"]);
  });

  it("downloads an xlsx with the expected sheets, a verification line and literal narrations", async () => {
    const { ca, client, reference } = await setup();
    await prepare(ca, reference, await upload(client, reference, CSV_FORMULA));
    const response = await ca.get(workbookRoute, { params: { reference } });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toBe(`attachment; filename="${reference}-internal-workbook.xlsx"`);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(await response.arrayBuffer());
    expect(wb.worksheets.map((w) => w.name)).toEqual(["Summary", "All Transactions", "Others – Needs Review", "Needs Review", "Lists"]);
    expect(wb.getWorksheet("Lists")!.state).toBe("hidden");
    const summary = wb.getWorksheet("Summary")!;
    expect(String(summary.getCell("A2").value)).toContain("INTERNAL");
    expect(String(summary.getCell("A3").value)).toMatch(/^(Verified extraction|UNVERIFIED REVIEW)/);
    const narration = wb.getWorksheet("All Transactions")!.getCell("H2");
    expect(narration.type).toBe(ExcelJS.ValueType.String); // text, never a formula
    expect(narration.value).toBe('=HYPERLINK("http://example.test")');
    expect(summary.getCell("B8").value).toBe("XXXX1234"); // account number masked
    expect(await rows("SELECT action FROM audit_events WHERE action = 'case.workbook_downloaded'")).toHaveLength(1);
  });

  it("is only for the owning firm's CA", async () => {
    const { ca, client, reference } = await setup();
    await prepare(ca, reference, await upload(client, reference, CSV_OK));
    expect((await client.get(workbookRoute, { params: { reference } })).status).toBe(401);
    const other = await onboardCa("b");
    expect((await other.get(workbookRoute, { params: { reference } })).status).toBe(404);
  });
});
