// Firm codes and client sign-in, cases and profile through the real routes.
// Synthetic accounts only.

import { describe, expect, it } from "vitest";
import { GET as caMe } from "@/app/api/ca/me/route";
import { GET as getCode, POST as createCode } from "@/app/api/ca/firm-code/route";
import { POST as revokeCode } from "@/app/api/ca/firm-code/revoke/route";
import { POST as rotateCode } from "@/app/api/ca/firm-code/rotate/route";
import { POST as openCase } from "@/app/api/client/cases/route";
import { POST as saveProfile } from "@/app/api/client/cases/[reference]/profile/route";
import { POST as clientLogout } from "@/app/api/client/logout/route";
import { GET as clientMe } from "@/app/api/client/me/route";
import { POST as resumeCodeRoute } from "@/app/api/client/resume-code/route";
import { POST as start } from "@/app/api/client/start/route";
import { POST as verify } from "@/app/api/client/verify/route";
import { financialYearOptions, startClientOnboarding } from "@/lib/server/client-auth";
import { onboardCa } from "./helpers/ca";
import { Client, env, rows, setupTestServer } from "./helpers/http";

setupTestServer();

const FY = financialYearOptions()[0];

async function firmWithCode(tag = "a"): Promise<{ ca: Client; code: string }> {
  const ca = await onboardCa(tag);
  const response = await ca.post(createCode);
  return { ca, code: (await response.json()).firm_code.code };
}

async function signIn(code: string, email = "client-one@example.test"): Promise<Client> {
  const client = new Client();
  const response = await client.post(start, { firm_code: code, email });
  expect(response.status).toBe(200);
  return client;
}

const resumeCodeOf = async (response: Response): Promise<string> => (await response.json()).resume_code;

describe("firm codes", () => {
  it("creates one active code, rotates it and revokes it, auditing only code IDs", async () => {
    const { ca, code } = await firmWithCode();
    expect(code).toMatch(/^[0-9A-Z]{12}$/);
    const again = await ca.post(createCode);
    expect(again.status).toBe(200);
    expect((await again.json()).firm_code.code).toBe(code);

    const rotated = (await (await ca.post(rotateCode)).json()).firm_code;
    expect(rotated.code).not.toBe(code);
    const state = await (await ca.get(getCode)).json();
    expect(state.active.code).toBe(rotated.code);
    expect(state.previous.map((p: { code: string; status: string }) => [p.code, p.status])).toEqual([[code, "revoked"]]);

    expect((await ca.post(revokeCode)).status).toBe(200);
    expect((await ca.post(revokeCode)).status).toBe(409);
    const audits = await rows<{ action: string; details_json: Record<string, string> }>(
      "SELECT action, details_json FROM audit_events WHERE action LIKE 'firm_code.%' ORDER BY created_at");
    expect(audits.map((a) => a.action)).toEqual(["firm_code.created", "firm_code.rotated", "firm_code.revoked"]);
    expect(JSON.stringify(audits)).not.toContain(code);
  });

  it("lets only the firm owner change the code", async () => {
    const { ca } = await firmWithCode();
    await env.db.query("UPDATE ca_users SET role = 'member'");
    expect((await ca.post(rotateCode)).status).toBe(403);
    expect((await ca.get(getCode)).status).toBe(200);
  });

  it("limits firm code changes per firm", async () => {
    const { ca } = await firmWithCode();
    for (let i = 0; i < 9; i++) expect((await ca.post(rotateCode)).status).toBe(200);
    expect((await ca.post(rotateCode)).status).toBe(429);
  });
});

describe("client entry without e-mail verification", () => {
  it("signs a new client straight in with a resume code and sends no e-mail", async () => {
    const { code } = await firmWithCode();
    const client = new Client();
    const response = await client.post(start, { firm_code: code.toLowerCase(), email: " Client-One@Example.test " });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ status: "signed_in", created: true });
    expect(body.resume_code).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
    const me = await (await client.get(clientMe)).json();
    expect(me).toMatchObject({ client: { email: "client-one@example.test" }, firm: { name: "Firm a (synthetic)" },
      cases: [], can_open_case: true, financial_years: financialYearOptions() });
    expect(await rows("SELECT id FROM email_outbox WHERE template LIKE 'client%'")).toEqual([]);
    const [identity] = await rows<{ email_verified_at: Date | null; resume_code_hash: string }>(
      "SELECT email_verified_at, resume_code_hash FROM client_identities");
    expect(identity.email_verified_at).toBeNull(); // recorded as unverified
    expect(identity.resume_code_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(await rows("SELECT action, details_json FROM audit_events WHERE action = 'client.entered'")).toEqual([
      { action: "client.entered", details_json: { method: "direct", new_identity: true } }]);
  });

  it("names a bad firm code or e-mail and creates nothing", async () => {
    await firmWithCode();
    const anon = new Client();
    const badCode = await anon.post(start, { firm_code: "ZZZZ-ZZZZ-ZZZZ", email: "client-one@example.test" });
    expect([badCode.status, (await badCode.json()).error]).toEqual([400, "invalid_firm_code"]);
    const { code } = await firmWithCode("b");
    const badEmail = await anon.post(start, { firm_code: code, email: "not-an-email" });
    expect([badEmail.status, (await badEmail.json()).error]).toEqual([400, "invalid_email"]);
    expect((await anon.post(start, { firm_code: code })).status).toBe(422);
    expect(await rows("SELECT id FROM client_identities")).toEqual([]);
    expect((await anon.get(clientMe)).status).toBe(401);
  });

  it("resumes the same client and case in the same browser or with the resume code, never a duplicate", async () => {
    const { code } = await firmWithCode();
    const first = new Client();
    const resume = await resumeCodeOf(await first.post(start, { firm_code: code, email: "client-one@example.test" }));
    const { reference } = (await (await first.post(openCase, { first_name: "Asha", financial_year: FY })).json()).case;

    // Same browser: the session is kept and no new code is issued.
    const again = await first.post(start, { firm_code: code, email: "client-one@example.test" });
    expect(await again.json()).toEqual({ status: "signed_in", created: false, resume_code: null });

    // Another browser: the e-mail alone is not enough.
    const other = new Client();
    const refused = await other.post(start, { firm_code: code, email: "client-one@example.test" });
    expect([refused.status, (await refused.json()).error]).toEqual([409, "resume_code_required"]);
    expect((await other.get(clientMe)).status).toBe(401);
    const wrong = await other.post(start, { firm_code: code, email: "client-one@example.test", resume_code: "AAAA-AAAA-AAAA" });
    expect([wrong.status, (await wrong.json()).error]).toEqual([400, "resume_code_invalid"]);
    const right = await other.post(start, { firm_code: code, email: "client-one@example.test",
      resume_code: resume.replace(/-/g, "").toLowerCase() });
    expect(await right.json()).toMatchObject({ status: "signed_in", created: false, resume_code: null });
    const me = await (await other.get(clientMe)).json();
    expect(me.cases.map((c: { reference: string }) => c.reference)).toEqual([reference]);
    expect((await (await other.post(openCase, { first_name: "Asha", financial_year: FY })).json()).case.reference).toBe(reference);
    expect(await rows("SELECT count(*)::int AS n FROM client_identities")).toEqual([{ n: 1 }]);
    expect(await rows("SELECT count(*)::int AS n FROM cases")).toEqual([{ n: 1 }]);
  });

  it("limits wrong resume codes per client", async () => {
    const { code } = await firmWithCode();
    const resume = await resumeCodeOf(await new Client().post(start, { firm_code: code, email: "client-one@example.test" }));
    const attacker = new Client();
    for (let i = 0; i < 10; i++) {
      await attacker.post(start, { firm_code: code, email: "client-one@example.test", resume_code: `AAAA-AAAA-AAA${i}` });
    }
    const blocked = await attacker.post(start, { firm_code: code, email: "client-one@example.test", resume_code: resume });
    expect([blocked.status, (await blocked.json()).error]).toEqual([429, "rate_limited"]);
  });

  it("issues a new resume code on request, and the old one stops working", async () => {
    const { code } = await firmWithCode();
    const client = new Client();
    const old = await resumeCodeOf(await client.post(start, { firm_code: code, email: "client-one@example.test" }));
    const fresh = (await (await client.post(resumeCodeRoute)).json()).resume_code;
    expect(fresh).not.toBe(old);
    expect((await new Client().post(resumeCodeRoute)).status).toBe(401);
    const stale = await new Client().post(start, { firm_code: code, email: "client-one@example.test", resume_code: old });
    expect(stale.status).toBe(400);
    expect((await new Client().post(start, { firm_code: code, email: "client-one@example.test", resume_code: fresh })).status)
      .toBe(200);
  });

  it("gives a client from the old e-mailed-link flow a first resume code", async () => {
    const { code } = await firmWithCode();
    const challenge = await startClientOnboarding(env.db, code, "client-one@example.test");
    const legacy = new Client();
    expect((await legacy.post(verify, { token: challenge!.token })).status).toBe(200); // the kept link flow still works
    const response = await new Client().post(start, { firm_code: code, email: "client-one@example.test" });
    expect((await response.json()).resume_code).toMatch(/^[0-9A-Z]{4}-/);
    const second = await new Client().post(start, { firm_code: code, email: "client-one@example.test" });
    expect(second.status).toBe(409); // only the first entry claims it
  });

  it("keeps client and CA sessions apart", async () => {
    const { ca, code } = await firmWithCode();
    const client = await signIn(code);
    expect((await client.get(caMe)).status).toBe(401);   // a client cookie is not a CA session
    expect((await ca.get(clientMe)).status).toBe(401);   // and the other way round
    await client.post(clientLogout);
    expect((await client.get(clientMe)).status).toBe(401);
  });

  it("opens one case per year with a unique reference", async () => {
    const { code } = await firmWithCode();
    const client = await signIn(code);
    const created = await client.post(openCase, { first_name: "Asha", financial_year: FY });
    expect(created.status).toBe(201);
    const { reference } = (await created.json()).case;
    expect(reference).toMatch(/^IT-ASHA-[0-9A-Z]{6}$/);
    const repeat = await client.post(openCase, { first_name: "Asha", financial_year: FY });
    expect([repeat.status, (await repeat.json()).case.reference]).toEqual([200, reference]);
    expect((await client.post(openCase, { first_name: "Asha", financial_year: "2001-02" })).status).toBe(400);
    expect(await rows("SELECT action FROM audit_events WHERE action = 'case.created'")).toHaveLength(1);

    const others = await Promise.all(["two", "three", "four"].map((n) => signIn(code, `client-${n}@example.test`)));
    const refs = await Promise.all(others.map(async (c) =>
      (await (await c.post(openCase, { first_name: "Asha", financial_year: FY })).json()).case.reference));
    expect(new Set([reference, ...refs]).size).toBe(4);
    // The database itself refuses a repeated reference.
    await expect(env.db.query(
      `INSERT INTO cases (firm_id, client_identity_id, reference, financial_year, client_first_name)
       SELECT firm_id, client_identity_id, $1, '2023-24', 'Asha' FROM cases LIMIT 1`, [reference])).rejects.toThrow();
  });

  it("saves a valid profile and names the bad fields only", async () => {
    const { code } = await firmWithCode();
    const client = await signIn(code);
    const { reference } = (await (await client.post(openCase, { first_name: "Asha", financial_year: FY })).json()).case;
    const ok = await client.post(saveProfile, { full_name: "Asha Rao", bank_name: "Synthetic Bank Ltd",
      account_last4: "0000" }, { params: { reference } });
    expect(await ok.json()).toMatchObject({ profile: { full_name: "Asha Rao", bank_name: "Synthetic Bank Ltd",
      account_last4: "0000", complete: true } });
    const bad = await client.post(saveProfile, { full_name: "A1", bank_name: "", account_last4: "12345" },
      { params: { reference } });
    expect(await bad.json()).toMatchObject({ error: "invalid_request", fields: ["full_name", "bank_name", "account_last4"] });
  });

  it("never shows a case to another client or another firm", async () => {
    const { code } = await firmWithCode();
    const one = await signIn(code, "client-one@example.test");
    const { reference } = (await (await one.post(openCase, { first_name: "Asha", financial_year: FY })).json()).case;
    const two = await signIn(code, "client-two@example.test");
    expect((await two.post(saveProfile, { full_name: "Mallory", bank_name: "Bank" }, { params: { reference } })).status).toBe(404);
    expect(await (await two.get(clientMe)).json()).toMatchObject({ cases: [] });

    const other = await firmWithCode("b");
    const outsider = await signIn(other.code, "client-one@example.test"); // same e-mail, other firm: unrelated identity
    expect((await (await outsider.get(clientMe)).json()).cases).toEqual([]);
    expect((await outsider.post(saveProfile, { full_name: "Asha", bank_name: "Bank" }, { params: { reference } })).status).toBe(404);
  });

  it("stops new entries and new cases once the code is revoked", async () => {
    const { ca, code } = await firmWithCode();
    const client = await signIn(code);
    await ca.post(revokeCode);
    const refused = await client.post(openCase, { first_name: "Asha", financial_year: FY });
    expect(refused.status).toBe(409);
    expect((await refused.json()).error).toBe("onboarding_closed");
    const entry = await new Client().post(start, { firm_code: code, email: "client-two@example.test" });
    expect([entry.status, (await entry.json()).error]).toEqual([400, "invalid_firm_code"]);
  });
});
