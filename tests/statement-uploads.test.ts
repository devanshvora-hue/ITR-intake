// Statement uploads through the real routes, with in-memory private storage,
// plus the CA statements list and case list (readiness). Synthetic files only.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GET as caCases } from "@/app/api/ca/cases/route";
import { POST as createCode } from "@/app/api/ca/firm-code/route";
import { GET as caStatements } from "@/app/api/ca/statements/route";
import { POST as openCase } from "@/app/api/client/cases/route";
import { POST as saveProfile } from "@/app/api/client/cases/[reference]/profile/route";
import { POST as uploadRoute } from "@/app/api/client/cases/[reference]/statements/route";
import { POST as start } from "@/app/api/client/start/route";
import { financialYearOptions } from "@/lib/server/client-auth";
import { MemoryStore, setFileStoreForTests, StorageError } from "@/lib/server/storage";
import { onboardCa } from "./helpers/ca";
import { Client, rows, setupTestServer } from "./helpers/http";
import { goodPdf } from "./helpers/synthetic-pdf";

setupTestServer();

let store: MemoryStore;
beforeEach(() => {
  store = new MemoryStore();
  setFileStoreForTests(store);
});
afterEach(() => setFileStoreForTests(null));

// The synthetic rows are dated April 2025; other years only add a "dates outside the year" review flag.
const FY = financialYearOptions().includes("2025-26") ? "2025-26" : financialYearOptions()[0];
const CSV_OK = new TextEncoder().encode("Date,Narration,Debit,Credit,Balance\n01/04/2025,UPI SYNTHETIC SHOP,250.00,,9750.00\n"
  + "02/04/2025,NEFT SALARY SYNTHETIC,,50000.00,59750.00\n");

async function clientWithCase(ca: Client, email = "client-one@example.test", profile = true) {
  const code = (await (await ca.post(createCode)).json()).firm_code.code;
  const client = new Client();
  await client.post(start, { firm_code: code, email });
  const { reference } = (await (await client.post(openCase, { first_name: "Asha", financial_year: FY })).json()).case;
  if (profile) {
    await client.post(saveProfile, { full_name: "Asha Rao", bank_name: "Synthetic Bank Ltd" }, { params: { reference } });
  }
  return { client, reference };
}

function upload(client: Client, reference: string, data: Uint8Array, name = "s.csv", type = "text/csv",
                extra: Record<string, string> = {}) {
  return client.call(uploadRoute, {
    method: "POST", params: { reference }, rawBody: data,
    headers: { "content-type": type, "x-upload-filename": encodeURIComponent(name), ...extra },
  });
}

describe("statement uploads", () => {
  it("needs a complete profile first", async () => {
    const ca = await onboardCa();
    const { client, reference } = await clientWithCase(ca, "client-one@example.test", false);
    const response = await upload(client, reference, CSV_OK);
    expect(response.status).toBe(409);
    expect((await response.json()).error).toBe("profile_required");
  });

  it("stores a CSV privately, records the outcome and moves the case on", async () => {
    const ca = await onboardCa();
    const { client, reference } = await clientWithCase(ca);
    const response = await upload(client, reference, CSV_OK, "../../Statement April.csv");
    expect(response.status).toBe(201);
    const { statement } = await response.json();
    expect(statement).toMatchObject({ file_type: "csv", display_name: "Statement April.csv", rows_extracted: 2,
      period_start: "2025-04-01", period_end: "2025-04-02" });
    expect(["extracted", "manual_review_required"]).toContain(statement.status);
    const [doc] = await rows<{ storage_key: string; kind: string }>("SELECT storage_key, kind FROM documents");
    expect(doc.kind).toBe("bank_statement");
    expect([...store.objects.keys()]).toEqual([doc.storage_key]);
    expect(await rows("SELECT status FROM cases")).toEqual([{ status: "statement_uploaded" }]);
    expect(await rows("SELECT action FROM audit_events WHERE action = 'statement.uploaded'")).toHaveLength(1);

    const again = await upload(client, reference, CSV_OK);
    expect(again.status).toBe(200);
    expect((await again.json()).created).toBe(false);
    expect(store.objects.size).toBe(1);
  });

  it("reads a PDF statement in process", async () => {
    const ca = await onboardCa();
    const { client, reference } = await clientWithCase(ca);
    const response = await upload(client, reference, goodPdf(), "s.pdf", "application/pdf");
    expect(response.status).toBe(201);
    expect((await response.json()).statement).toMatchObject({ file_type: "pdf", rows_extracted: 5, pages_total: 2 });
  });

  it("records a refused file as rejected and stores nothing", async () => {
    const ca = await onboardCa();
    const { client, reference } = await clientWithCase(ca);
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    for (const [data, name, type, code] of [
      [png, "s.csv", "text/csv", "unsupported_content"], [CSV_OK, "s.pdf", "application/pdf", "type_mismatch"],
      [CSV_OK, "s.xlsx", "text/csv", "unsupported_file_type"], [CSV_OK, "s.csv", "image/png", "type_mismatch"],
    ] as const) {
      const response = await upload(client, reference, data, name, type);
      expect(response.status).toBe(422);
      expect((await response.json()).statement).toMatchObject({ status: "rejected", error_code: code });
    }
    expect(store.objects.size).toBe(0);
    expect(await rows("SELECT count(*)::int AS n FROM documents")).toEqual([{ n: 0 }]);
  });

  it("limits stored statements per case", async () => {
    const ca = await onboardCa();
    const { client, reference } = await clientWithCase(ca);
    for (let i = 0; i < 5; i++) {
      const data = new TextEncoder().encode(`Date,Narration,Debit\n0${i + 1}/04/2025,SYNTHETIC ${i},1.00\n`);
      expect((await upload(client, reference, data)).status).toBe(201);
    }
    const sixth = await upload(client, reference, new TextEncoder().encode("Date,Narration,Debit\n09/04/2025,SYNTHETIC X,1.00\n"));
    expect(sixth.status).toBe(409);
  });

  it("is limited to the owning client and protected against cross-site requests", async () => {
    const ca = await onboardCa();
    const { client, reference } = await clientWithCase(ca);
    const { client: other } = await clientWithCase(ca, "client-two@example.test");
    expect((await upload(other, reference, CSV_OK)).status).toBe(404);
    expect((await upload(new Client(), reference, CSV_OK)).status).toBe(401);
    expect((await upload(client, reference, CSV_OK, "s.csv", "text/csv", { origin: "https://evil.example.test" })).status).toBe(403);
    expect(store.objects.size).toBe(0);
  });

  it("refuses an oversized body before reading it", async () => {
    const ca = await onboardCa();
    const { client, reference } = await clientWithCase(ca);
    const big = new Uint8Array(4 * 1024 * 1024 + 1).fill(65);
    const response = await upload(client, reference, big);
    expect(response.status).toBe(413);
  });

  it("records nothing when private storage fails", async () => {
    const ca = await onboardCa();
    const { client, reference } = await clientWithCase(ca);
    setFileStoreForTests({ put: async () => { throw new StorageError("storage_failed"); }, get: store.get.bind(store),
      remove: store.remove.bind(store) });
    expect((await upload(client, reference, CSV_OK)).status).toBe(500);
    expect(await rows("SELECT count(*)::int AS n FROM statement_uploads")).toEqual([{ n: 0 }]);
  });
});

describe("CA views", () => {
  it("lists the firm's statements and cases with readiness, and nothing of another firm", async () => {
    const ca = await onboardCa();
    const { client, reference } = await clientWithCase(ca);
    let cases = (await (await ca.get(caCases)).json()).cases;
    expect(cases[0]).toMatchObject({ reference, client_email: "client-one@example.test",
      readiness: { statement: "none", documents: { total_requests: 0 } } });
    await upload(client, reference, CSV_OK);
    cases = (await (await ca.get(caCases)).json()).cases;
    expect(cases[0].readiness.statement).toBe("not_prepared");
    const list = (await (await ca.get(caStatements)).json()).statements;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ case_reference: reference, client_first_name: "Asha", bank_name: "Synthetic Bank Ltd" });

    const other = await onboardCa("b");
    expect((await (await other.get(caCases)).json()).cases).toEqual([]);
    expect((await (await other.get(caStatements)).json()).statements).toEqual([]);
    expect((await new Client().get(caCases)).status).toBe(401);
  });
});
