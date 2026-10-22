// AIS / TIS / Form 26AS: reading reports, refusing unsupported files, matching
// against the reviewed bank statement, duplicates across reports, CA verdicts,
// routes (isolation, CSRF, audit) and the workbook sheet. Synthetic data only.

import ExcelJS from "exceljs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GET as detailRoute } from "@/app/api/ca/cases/[reference]/route";
import { POST as reviewRoute } from "@/app/api/ca/cases/[reference]/review/route";
import { POST as uploadReport } from "@/app/api/ca/cases/[reference]/tax-reports/route";
import { POST as recordRoute } from "@/app/api/ca/cases/[reference]/tax-reports/records/[recordId]/route";
import { GET as fileRoute } from "@/app/api/ca/cases/[reference]/tax-reports/[reportId]/file/route";
import { POST as withdrawRoute } from "@/app/api/ca/cases/[reference]/tax-reports/[reportId]/withdraw/route";
import { GET as workbookRoute } from "@/app/api/ca/cases/[reference]/workbook/route";
import { POST as createCode } from "@/app/api/ca/firm-code/route";
import { POST as openCase } from "@/app/api/client/cases/route";
import { POST as saveProfile } from "@/app/api/client/cases/[reference]/profile/route";
import { POST as uploadStatement } from "@/app/api/client/cases/[reference]/statements/route";
import { POST as start } from "@/app/api/client/start/route";
import type { TaxReconRecord } from "@/lib/tax-reconciliation";
import { financialYearOptions } from "@/lib/server/client-auth";
import { MemoryStore, setFileStoreForTests } from "@/lib/server/storage";
import { reconcileTaxReports, type BankCredit, type ReconRecordInput } from "@/lib/statement/tax-reconcile";
import { classifyTaxRecord, parseTaxReport } from "@/lib/statement/tax-report";
import { onboardCa } from "./helpers/ca";
import { Client, env, rows, setupTestServer } from "./helpers/http";
import { goodPdf } from "./helpers/synthetic-pdf";

const enc = (s: string) => new TextEncoder().encode(s);
const AIS_CSV = [
  "Annual Information Statement (synthetic)",
  "Information Category,Information Source,Date of Payment/Credit,Amount Paid/Credited,TDS Deducted",
  "Salary (Section 192),DEMO SYSTEMS PVT LTD,01-04-2025,\"85,000.00\",\"5,000.00\"",
  "Interest from savings bank,SYNTHETIC BANK LTD,,312.40,",
  "Dividend (Section 194),SYNTH INDUSTRIES LTD,10-04-2025,\"1,200.00\",120.00",
  "Interest from deposit (194A),SYNTHETIC BANK LTD,12-04-2025,\"2,000.00\",200.00",
  "Rent received (194-I),SYNTH TENANT,15-04-2025,\"25,000.00\",\"2,500.00\"",
  "Salary (Section 192),DEMO SYSTEMS PVT LTD,01-05-2025,abc,",
  "Total,,,\"1,13,512.40\",",
].join("\n");

async function xlsx(rowsIn: (string | number)[][]): Promise<Uint8Array> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("AIS");
  rowsIn.forEach((r) => ws.addRow(r));
  return new Uint8Array(await wb.xlsx.writeBuffer());
}

describe("reading reports", () => {
  it("reads CSV with a preamble, Indian amounts, sections, TDS and row warnings", async () => {
    const parsed = await parseTaxReport(enc(AIS_CSV), "ais.csv");
    if (!parsed.ok) throw new Error(parsed.code);
    expect(parsed.records.map((r) => [r.sourceRow, r.category, r.date, r.amount, r.taxDeducted])).toEqual([
      [3, "salary", "2025-04-01", 8500000n, 500000n], [4, "interest_savings", null, 31240n, null],
      [5, "dividend", "2025-04-10", 120000n, 12000n], [6, "interest_deposit", "2025-04-12", 200000n, 20000n],
      [7, "rent", "2025-04-15", 2500000n, 250000n]]);
    expect(parsed.records[0].party).toBe("DEMO SYSTEMS PVT LTD");
    expect(parsed.records[0].raw[0]).toBe("Salary (Section 192)");
    expect(parsed.warnings).toEqual([{ row: 8, code: "invalid_amount" }]); // the total row is skipped, not counted
  });

  it("reads Excel and Form 26AS caret-separated text", async () => {
    const book = await xlsx([["Description", "Name of Deductor", "Transaction Date", "Amount", "TDS"],
      ["Interest other than securities", "SYNTHETIC BANK LTD", "12/04/2025", 2000, 200]]);
    const fromXlsx = await parseTaxReport(book, "ais.xlsx");
    expect(fromXlsx.ok && fromXlsx.records.map((r) => [r.category, r.amount, r.taxDeducted, r.date])).toEqual([
      ["interest_other", 200000n, 20000n, "2025-04-12"]]);
    const caret = await parseTaxReport(enc("Section^Name of Deductor^Date of Payment/Credit^Amount Paid/Credited^Tax Deducted\n"
      + "192^DEMO SYSTEMS PVT LTD^01-04-2025^85000.00^5000.00\n"), "26as.txt");
    expect(caret.ok && caret.records.map((r) => [r.category, r.amount])).toEqual([["salary", 8500000n]]);
  });

  it("refuses unsupported or unreadable files with a reason instead of accepting them", async () => {
    const cases: [Uint8Array, string, string][] = [
      [goodPdf(), "ais.pdf", "pdf_not_supported"], [enc('{"AIS": []}'), "ais.json", "json_not_supported"],
      [enc("\xD0\xCF\x11\xE0 old excel"), "ais.xls", "xls_not_supported"], [enc("a,b\n1,2\n"), "ais.csv", "missing_required_columns"],
      [new Uint8Array(0), "ais.csv", "empty_file"], [enc("Description,Amount\nSalary,abc\n"), "ais.csv", "no_records"],
      [enc("PK\x03\x04 not really a workbook"), "ais.xlsx", "unreadable_file"], [enc("Description,Amount\n"), "ais.docx", "unsupported_file_type"],
    ];
    for (const [data, name, code] of cases) expect([name, await parseTaxReport(data, name)]).toEqual([name, { ok: false, code }]);
  });

  it("maps descriptions to reporting categories", () => {
    expect(["Salary", "Interest from savings bank", "Interest on time deposit", "Dividend income", "Sale of securities and units",
      "Rent", "Income tax refund", "Cash deposits", "Purchase of immovable property"].map(classifyTaxRecord)).toEqual([
      "salary", "interest_savings", "interest_deposit", "dividend", "securities_sale", "rent", "tax_refund", "cash_deposit", "other"]);
  });
});

describe("matching against the bank statement", () => {
  let id = 0;
  const rec = (over: Partial<ReconRecordInput>): ReconRecordInput => ({ id: `r${++id}`, reportId: "A", reportKind: "ais",
    reportOrder: 0, sourceRow: id, category: "salary", description: "x", party: "PAYER", date: "2025-04-01", amount: 8500000n,
    taxDeducted: null, reviewStatus: null, reviewedMatch: null, ...over });
  const credit = (rowNumber: number, date: string, rupees: number, category: string): BankCredit =>
    ({ rowNumber, date, credit: BigInt(rupees * 100), category, narration: "SYNTH" });

  it("matches exactly, net of TDS, by annual total, and reports date and amount differences", () => {
    const bank = [credit(1, "2025-04-01", 85000, "Salary / Pension"), credit(2, "2025-04-11", 1080, "Dividend"),
      credit(3, "2025-03-31", 150, "Interest – Savings Bank"), credit(4, "2025-09-30", 162.4, "Interest – Savings Bank"),
      credit(5, "2025-05-20", 2000, "Interest – FD / RD / Others"), credit(6, "2025-04-16", 24000, "Rent Received")];
    const records = [
      rec({ category: "salary", amount: 8500000n }),
      rec({ category: "dividend", date: "2025-04-10", amount: 120000n, taxDeducted: 12000n }),
      rec({ category: "interest_savings", date: null, amount: 31240n }),
      rec({ category: "interest_deposit", date: "2025-04-12", amount: 200000n }),
      rec({ category: "rent", date: "2025-04-15", amount: 2500000n }),
      rec({ category: "salary", date: "2025-06-01", amount: 8500000n }),
      rec({ category: "other", date: null, amount: 100n }),
    ];
    const out = reconcileTaxReports(records, bank).results.map((r) => [r.status, r.bankRows, r.difference, r.review]);
    expect(out).toEqual([
      ["matched", [1], 0n, "auto"], ["matched_net_of_tax", [2], 0n, "auto"], ["aggregate_matched", [3, 4], 0n, "auto"],
      ["date_differs", [5], 0n, "open"], ["amount_differs", [6], -100000n, "open"], ["not_found", [], null, "open"],
      ["not_compared", [], null, "open"]]);
  });

  it("counts the same item in two reports once, uses each bank credit once, and lists income only in the bank", () => {
    const bank = [credit(1, "2025-04-01", 85000, "Salary / Pension"), credit(2, "2025-05-01", 85000, "Salary / Pension"),
      credit(3, "2025-04-20", 900, "Dividend")];
    const ais = rec({ reportId: "A", amount: 8500000n });
    const form26 = rec({ reportId: "B", reportKind: "form26as", reportOrder: 1, amount: 8500000n });
    const again = rec({ reportId: "A", date: "2025-04-02", amount: 8500000n });
    const result = reconcileTaxReports([ais, form26, again], bank);
    expect(result.results.map((r) => [r.id, r.status, r.bankRows, r.duplicateOf])).toEqual([
      [ais.id, "matched", [1], null], [again.id, "date_differs", [2], null], [form26.id, "duplicate", [], ais.id]]);
    expect(result.bankOnly.map((b) => b.rowNumber)).toEqual([3]);
    expect(result.summary.find((s) => s.category === "salary")).toMatchObject({ records: 2, reported: "170000.00", bank: "170000.00" });
  });

  it("applies a CA verdict only to the match the CA saw, and is complete only when nothing is open", () => {
    const bank = [credit(1, "2025-04-20", 24000, "Rent Received")];
    const first = reconcileTaxReports([rec({ id: "x", category: "rent", date: "2025-04-15", amount: 2500000n })], bank);
    expect([first.status, first.openCount]).toEqual(["open", 1]);
    const signature = first.results[0].signature;
    const confirmed = reconcileTaxReports([rec({ id: "x", category: "rent", date: "2025-04-15", amount: 2500000n,
      reviewStatus: "confirmed", reviewedMatch: signature })], bank);
    expect([confirmed.status, confirmed.results[0].review]).toEqual(["complete", "confirmed"]);
    const changed = reconcileTaxReports([rec({ id: "x", category: "rent", date: "2025-04-15", amount: 2500000n,
      reviewStatus: "confirmed", reviewedMatch: signature })], [credit(9, "2025-04-18", 23000, "Rent Received")]);
    expect([changed.status, changed.results[0].review, changed.results[0].staleReview]).toEqual(["open", "open", true]);
  });
});

// --- through the routes ------------------------------------------------------------------------------------------

setupTestServer();
let store: MemoryStore;
beforeEach(() => {
  store = new MemoryStore();
  setFileStoreForTests(store);
});
afterEach(() => setFileStoreForTests(null));

const FY = financialYearOptions().includes("2025-26") ? "2025-26" : financialYearOptions()[0];
const BANK = enc(["Date,Narration,Debit,Credit,Balance",
  "01/04/2025,NEFT SALARY/DEMO SYSTEMS PVT LTD,,80000.00,180000.00",
  "10/04/2025,ACH DIVIDEND SYNTH INDUSTRIES LTD,,1080.00,181080.00",
  "12/04/2025,INT ON FD SYNTHETIC BANK,,1800.00,182880.00",
  "20/04/2025,UPI/RAHUL-MART,640.00,,182240.00",
  "30/04/2025,CREDIT INTEREST,,312.40,182552.40",
].join("\n") + "\n");

async function prepared(tag = "a") {
  const ca = await onboardCa(tag);
  const code = (await (await ca.post(createCode)).json()).firm_code.code;
  const client = new Client();
  await client.post(start, { firm_code: code, email: `client-${tag}@example.test` });
  const { reference } = (await (await client.post(openCase, { first_name: "Asha", financial_year: FY })).json()).case;
  await client.post(saveProfile, { full_name: "Asha Rao", bank_name: "Synthetic Bank Ltd" }, { params: { reference } });
  const up = await client.call(uploadStatement, { method: "POST", params: { reference }, rawBody: BANK,
    headers: { "content-type": "text/csv", "x-upload-filename": "s.csv" } });
  await ca.post(reviewRoute, { statement_id: (await up.json()).statement.id }, { params: { reference } });
  return { ca, client, reference };
}
const upload = (c: Client, reference: string, data: Uint8Array, name: string, kind = "ais", extra = {}) =>
  c.call(uploadReport, { method: "POST", path: `/api/x?kind=${kind}`, params: { reference }, rawBody: data,
    headers: { "content-type": "text/csv", "x-upload-filename": name }, ...extra });
const recon = async (ca: Client, reference: string) => (await (await ca.get(detailRoute, { params: { reference } })).json());

describe("tax report routes", () => {
  it("uploads, reconciles, takes verdicts and is complete only when every difference is resolved", async () => {
    const { ca, reference } = await prepared();
    const response = await upload(ca, reference, enc(AIS_CSV), "ais.csv");
    expect(response.status).toBe(201);
    expect((await response.json()).report).toMatchObject({ records: 5, warnings: 1 });
    let view = (await recon(ca, reference)).tax_reconciliation;
    const status = (cat: string) => view.records.find((r: TaxReconRecord) => r.category === cat);
    expect(view.records.map((r: TaxReconRecord) => [r.category, r.status, r.review])).toEqual([
      ["salary", "matched_net_of_tax", "auto"], ["interest_savings", "aggregate_matched", "auto"],
      ["dividend", "matched_net_of_tax", "auto"], ["interest_deposit", "matched_net_of_tax", "auto"], ["rent", "not_found", "open"]]);
    expect([view.status, view.open_count]).toEqual(["open", 1]);
    const detail = await recon(ca, reference);
    expect(detail.review.itr.flags.map((f: { code: string }) => f.code)).toContain("tax_report_differences");
    expect(detail.review.itr.flags.map((f: { code: string }) => f.code)).not.toContain("tax_reports_not_provided");

    const rent = status("rent");
    const verdict = await ca.post(recordRoute, { status: "confirmed", note: "Rent received in another account", signature: rent.signature },
      { params: { reference, recordId: rent.id } });
    expect(verdict.status).toBe(200);
    view = (await verdict.json()).tax_reconciliation;
    expect([view.status, view.open_count, view.records.find((r: TaxReconRecord) => r.id === rent.id).review]).toEqual(["complete", 0, "confirmed"]);
    expect(await rows("SELECT action, details_json FROM audit_events WHERE action LIKE 'tax_report.%' ORDER BY created_at")).toEqual([
      { action: "tax_report.uploaded", details_json: { report_id: expect.any(String), kind: "ais", records: 5, warnings: 1 } },
      { action: "tax_report.record_reviewed", details_json: { record_id: rent.id, status: "confirmed" } }]);

    // The original file is kept and served through the server.
    const reportId = view.reports[0].id;
    const original = await ca.get(fileRoute, { params: { reference, reportId } });
    expect([original.status, new TextDecoder().decode(await original.arrayBuffer())]).toEqual([200, AIS_CSV]);
    // The workbook gets the reconciliation sheet.
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(await (await ca.get(workbookRoute, { params: { reference } })).arrayBuffer());
    const sheet = wb.getWorksheet("AIS - 26AS Reconciliation")!;
    expect(String(sheet.getCell("A2").value)).toBe("All report entries are matched or confirmed by the CA.");
  });

  it("refuses unsupported files without storing them, and refuses a repeat upload", async () => {
    const { ca, reference } = await prepared();
    const pdf = await upload(ca, reference, goodPdf(), "ais.pdf");
    expect([pdf.status, (await pdf.json()).error]).toEqual([422, "pdf_not_supported"]);
    expect((await upload(ca, reference, enc(AIS_CSV), "ais.csv", "bank")).status).toBe(422); // unknown report kind
    expect(store.objects.size).toBe(1); // only the bank statement
    expect(await rows("SELECT id FROM tax_reports")).toEqual([]);
    expect((await upload(ca, reference, enc(AIS_CSV), "ais.csv")).status).toBe(201);
    const again = await upload(ca, reference, enc(AIS_CSV), "copy.csv");
    expect([again.status, (await again.json()).error]).toEqual([409, "already_uploaded"]);
  });

  it("counts a 26AS entry already in the AIS once, and withdrawing a report takes it out", async () => {
    const { ca, reference } = await prepared();
    await upload(ca, reference, enc(AIS_CSV), "ais.csv");
    const form26 = enc("Section^Name of Deductor^Date of Payment/Credit^Amount Paid/Credited^Tax Deducted\n"
      + "Salary (Section 192)^DEMO SYSTEMS PVT LTD^01-04-2025^85000.00^5000.00\n");
    expect((await upload(ca, reference, form26, "26as.txt", "form26as")).status).toBe(201);
    let view = (await recon(ca, reference)).tax_reconciliation;
    const dup = view.records.find((r: TaxReconRecord) => r.report_kind === "form26as");
    expect([dup.status, dup.review]).toEqual(["duplicate", "auto"]);
    expect(view.summary.find((s: { category: string }) => s.category === "salary")).toMatchObject({ records: 1, reported: "85000.00" });
    const withdraw = await ca.post(withdrawRoute, {}, { params: { reference, reportId: view.reports[1].id } });
    expect(withdraw.status).toBe(200);
    view = (await recon(ca, reference)).tax_reconciliation;
    expect(view.reports.map((r: { kind: string }) => r.kind)).toEqual(["ais"]);
  });

  it("is only for the owning firm's CA, needs the CSRF header and refuses closed cases", async () => {
    const { ca, client, reference } = await prepared();
    await upload(ca, reference, enc(AIS_CSV), "ais.csv");
    const view = (await recon(ca, reference)).tax_reconciliation;
    const record = view.records[0];
    const reportId = view.reports[0].id;
    const other = await onboardCa("b");
    expect((await upload(other, reference, enc("Description,Amount\nSalary,1.00\n"), "x.csv")).status).toBe(404);
    expect((await other.post(recordRoute, { status: "confirmed", signature: record.signature }, { params: { reference, recordId: record.id } })).status).toBe(404);
    expect((await other.get(fileRoute, { params: { reference, reportId } })).status).toBe(404);
    expect((await other.post(withdrawRoute, {}, { params: { reference, reportId } })).status).toBe(404);
    expect((await upload(client, reference, enc("Description,Amount\nSalary,1.00\n"), "x.csv")).status).toBe(401);
    expect((await upload(ca, reference, enc("Description,Amount\nSalary,2.00\n"), "y.csv", "ais", { csrf: false })).status).toBe(403);
    expect((await ca.post(recordRoute, { status: "confirmed", signature: record.signature },
      { params: { reference, recordId: record.id }, csrf: false })).status).toBe(403);
    await env.db.query("UPDATE cases SET status = 'closed', closed_at = now()");
    expect((await upload(ca, reference, enc("Description,Amount\nSalary,3.00\n"), "z.csv")).status).toBe(409);
    expect((await ca.post(recordRoute, { status: "confirmed", signature: record.signature }, { params: { reference, recordId: record.id } })).status).toBe(409);
  });

  it("waits for a prepared review before comparing", async () => {
    const ca = await onboardCa("c");
    const code = (await (await ca.post(createCode)).json()).firm_code.code;
    const client = new Client();
    await client.post(start, { firm_code: code, email: "client-c@example.test" });
    const { reference } = (await (await client.post(openCase, { first_name: "Asha", financial_year: FY })).json()).case;
    expect((await upload(ca, reference, enc(AIS_CSV), "ais.csv")).status).toBe(201);
    const view = (await recon(ca, reference)).tax_reconciliation;
    expect([view.review_prepared, view.status]).toEqual([false, "open"]);
    expect(view.records.every((r: TaxReconRecord) => r.review === "open")).toBe(true);
  });
});
