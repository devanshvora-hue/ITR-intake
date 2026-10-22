// Server-render the CA review components from a real review (produced through
// the routes from a synthetic statement) and check what a CA would see:
// validation panel, filters with counts, Indian currency, reasons, ITR summary
// and flags. No browser; next/navigation is stubbed.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as detailRoute } from "@/app/api/ca/cases/[reference]/route";
import { POST as reviewRoute } from "@/app/api/ca/cases/[reference]/review/route";
import { POST as createCode } from "@/app/api/ca/firm-code/route";
import { POST as openCase } from "@/app/api/client/cases/route";
import { POST as saveProfile } from "@/app/api/client/cases/[reference]/profile/route";
import { POST as uploadRoute } from "@/app/api/client/cases/[reference]/statements/route";
import { POST as start } from "@/app/api/client/start/route";
import { CaseItrSummary } from "@/components/ca/case/CaseItrSummary";
import { CaseReviewPanel } from "@/components/ca/case/CaseReviewPanel";
import { formatInr } from "@/lib/money";
import { financialYearOptions } from "@/lib/server/client-auth";
import { MemoryStore, setFileStoreForTests } from "@/lib/server/storage";
import { onboardCa } from "./helpers/ca";
import { Client, setupTestServer } from "./helpers/http";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {}, replace() {}, push() {} }) }));

setupTestServer();
beforeEach(() => setFileStoreForTests(new MemoryStore()));
afterEach(() => setFileStoreForTests(null));

const FY = financialYearOptions().includes("2025-26") ? "2025-26" : financialYearOptions()[0];
const CSV = new TextEncoder().encode([
  "Date,Narration,Debit,Credit,Balance",
  ",Opening Balance,,,\"1,00,000.00\"",
  "01/04/2025,UPI/MAHARASHTRA ELECTRICITY,2340.00,,97660.00",
  "02/04/2025,NEFT SALARY/DEMO SYSTEMS PVT LTD,,85000.00,182660.00",
  "03/04/2025,NACH MUTUAL FUND SIP/DEMO AMC,5000.00,,177660.00",
  "04/04/2025,UPI/RAHUL-MART,640.00,,177020.00",
  "05/04/2025,NEFT-SYNTH0099-UNKNOWN PARTY-REF,,60000.00,237020.00",
].join("\n") + "\n");

describe("formatInr", () => {
  it("formats exact decimal text in Indian grouping", () => {
    expect(["0.00", "640.00", "123456.78", "12345678.9", "-50000.00"].map((v) => formatInr(v)))
      .toEqual(["₹0.00", "₹640.00", "₹1,23,456.78", "₹1,23,45,678.90", "-₹50,000.00"]);
    expect([formatInr(null), formatInr("0.00", { blankZero: true })]).toEqual(["—", "—"]);
  });
});

describe("CA case review rendering", () => {
  it("shows validation, filters with counts, Indian amounts, reasons, the ITR summary and flags", async () => {
    const ca = await onboardCa("a");
    const code = (await (await ca.post(createCode)).json()).firm_code.code;
    const client = new Client();
    await client.post(start, { firm_code: code, email: "client@example.test" });
    const { reference } = (await (await client.post(openCase, { first_name: "Asha", financial_year: FY })).json()).case;
    await client.post(saveProfile, { full_name: "Asha Rao", bank_name: "Synthetic Bank Ltd" }, { params: { reference } });
    const up = await client.call(uploadRoute, { method: "POST", params: { reference }, rawBody: CSV,
      headers: { "content-type": "text/csv", "x-upload-filename": "s.csv" } });
    await ca.post(reviewRoute, { statement_id: (await up.json()).statement.id }, { params: { reference } });
    const { review } = await (await ca.get(detailRoute, { params: { reference } })).json();

    const panel = renderToStaticMarkup(createElement(CaseReviewPanel, { reference, review, caseClosed: false }));
    expect(panel).toContain("Balance reconciliation");
    expect(panel).toContain(">PASS<");
    expect(panel).toContain("₹1,00,000.00"); // opening, Indian grouping
    // Filter tabs with counts; the review queue is selected by default.
    expect(panel).toMatch(/aria-selected="true"[^>]*>Needs review <span[^>]*>2<\/span>/);
    expect(panel).toMatch(/>All <span[^>]*>5<\/span>/);
    expect(panel).toMatch(/>Auto-classified <span[^>]*>3<\/span>/);
    // The default filter is the review queue: the salary (confirm) and the unknown credit (manual), not the bill.
    expect(panel).toContain("NEFT SALARY/DEMO SYSTEMS PVT LTD");
    expect(panel).toContain("NEFT-SYNTH0099-UNKNOWN PARTY-REF");
    expect(panel).not.toContain("UPI/MAHARASHTRA ELECTRICITY");
    expect(panel).toContain("Confirm category");
    expect(panel).toContain("Classify manually");
    expect(panel).toContain("₹85,000.00");

    const summary = renderToStaticMarkup(createElement(CaseItrSummary, { reference, review }));
    expect(summary).toContain("Key figures for ITR");
    expect(summary).toContain("Salary / pension credits");
    expect(summary).toContain("Points to verify");
    expect(summary).toContain("Large unexplained credits");
    expect(summary).toContain("Download");
  });
});
