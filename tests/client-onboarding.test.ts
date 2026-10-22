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
import { POST as start } from "@/app/api/client/start/route";
import { POST as verify } from "@/app/api/client/verify/route";
import { financialYearOptions } from "@/lib/server/client-auth";
import { onboardCa } from "./helpers/ca";
import { Client, env, mailedToken, rows, setupTestServer } from "./helpers/http";

setupTestServer();

const FY = financialYearOptions()[0];

async function firmWithCode(tag = "a"): Promise<{ ca: Client; code: string }> {
  const ca = await onboardCa(tag);
  const response = await ca.post(createCode);
  return { ca, code: (await response.json()).firm_code.code };
}

async function signIn(code: string, email = "client-one@example.test"): Promise<Client> {
  const client = new Client();
  await client.post(start, { firm_code: code, email });
  const response = await client.post(verify, { token: await mailedToken(email) });
  expect(response.status).toBe(200);
  return client;
}

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

describe("client sign-in", () => {
  it("answers the same for valid and invalid codes and e-mails only for a valid one", async () => {
    const { code } = await firmWithCode();
    const anon = new Client();
    const good = await (await anon.post(start, { firm_code: code.toLowerCase(), email: "client-one@example.test" })).json();
    const bad = await (await anon.post(start, { firm_code: "ZZZZ-ZZZZ-ZZZZ", email: "client-two@example.test" })).json();
    expect(bad).toEqual(good);
    expect(good).toMatchObject({ status: "check_email", email_delivery: "simulated" });
    await mailedToken("client-one@example.test");
    await expect(mailedToken("client-two@example.test")).rejects.toThrow();
  });

  it("signs in with the link once, shows the firm, and opens one case per year", async () => {
    const { code } = await firmWithCode();
    const client = await signIn(code);
    const me = await (await client.get(clientMe)).json();
    expect(me).toMatchObject({ client: { email: "client-one@example.test" }, firm: { name: "Firm a (synthetic)" },
      cases: [], can_open_case: true, financial_years: financialYearOptions() });

    const created = await client.post(openCase, { first_name: "Asha", financial_year: FY });
    expect(created.status).toBe(201);
    const { reference } = (await created.json()).case;
    expect(reference).toMatch(/^IT-ASHA-[0-9A-Z]{6}$/);
    const repeat = await client.post(openCase, { first_name: "Asha", financial_year: FY });
    expect(repeat.status).toBe(200);
    expect((await repeat.json()).case.reference).toBe(reference);
    expect((await client.post(openCase, { first_name: "Asha", financial_year: "2001-02" })).status).toBe(400);
    expect(await rows("SELECT action FROM audit_events WHERE action = 'case.created'")).toHaveLength(1);
  });

  it("refuses a used link and keeps client and CA sessions apart", async () => {
    const { ca, code } = await firmWithCode();
    const client = new Client();
    await client.post(start, { firm_code: code, email: "client-one@example.test" });
    const token = await mailedToken("client-one@example.test");
    expect((await client.post(verify, { token })).status).toBe(200);
    expect((await new Client().post(verify, { token })).status).toBe(400);
    expect((await client.get(caMe)).status).toBe(401);   // a client cookie is not a CA session
    expect((await ca.get(clientMe)).status).toBe(401);   // and the other way round
    await client.post(clientLogout);
    expect((await client.get(clientMe)).status).toBe(401);
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

  it("stops new cases and pending links once the code is revoked", async () => {
    const { ca, code } = await firmWithCode();
    const client = await signIn(code);
    const pending = new Client();
    await pending.post(start, { firm_code: code, email: "client-two@example.test" });
    const link = await mailedToken("client-two@example.test");
    await ca.post(revokeCode);
    const refused = await client.post(openCase, { first_name: "Asha", financial_year: FY });
    expect(refused.status).toBe(409);
    expect((await refused.json()).error).toBe("onboarding_closed");
    expect((await pending.post(verify, { token: link })).status).toBe(400);
  });
});
