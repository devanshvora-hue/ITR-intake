// CA registration (immediately active, signed in), login, sessions and password
// reset through the real routes. Synthetic accounts only.

import { describe, expect, it } from "vitest";
import { GET as caCases } from "@/app/api/ca/cases/route";
import { POST as createCode } from "@/app/api/ca/firm-code/route";
import { POST as login } from "@/app/api/ca/login/route";
import { POST as logout } from "@/app/api/ca/logout/route";
import { GET as me } from "@/app/api/ca/me/route";
import { POST as register } from "@/app/api/ca/register/route";
import { POST as requestReset } from "@/app/api/ca/request-password-reset/route";
import { POST as resetPassword } from "@/app/api/ca/reset-password/route";
import { POST as openCase } from "@/app/api/client/cases/route";
import { POST as start } from "@/app/api/client/start/route";
import { authenticateCa, AuthenticationFailed, loginCa, MAX_FAILED_LOGINS } from "@/lib/server/ca-auth";
import { financialYearOptions } from "@/lib/server/client-auth";
import { readSessionToken } from "@/lib/server/cookies";
import { limits } from "@/lib/server/limits";
import { hashPassword } from "@/lib/server/passwords";
import { onboardCa } from "./helpers/ca";
import { Client, env, mailedToken, PASSWORD, rows, setupTestServer } from "./helpers/http";

setupTestServer();

const FY = financialYearOptions().includes("2025-26") ? "2025-26" : financialYearOptions()[0];

export function registration(tag = "a", extra: Record<string, unknown> = {}) {
  return { full_name: `CA ${tag} (synthetic)`, email: `ca-${tag}@example.test`, password: PASSWORD,
    firm_name: `Firm ${tag} (synthetic)`, ...extra };
}

async function startClient(ca: Client, email: string): Promise<Client> {
  const code = (await (await ca.post(createCode)).json()).firm_code.code;
  const client = new Client();
  expect((await client.post(start, { firm_code: code, email })).status).toBe(200);
  return client;
}

describe("registration", () => {
  it("creates an active firm and owner, signs the owner in, and sends no e-mail", async () => {
    const ca = new Client();
    const response = await ca.post(register, registration());
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ status: "registered" });
    expect(response.headers.get("set-cookie")).toMatch(/itr_ca_session=.+HttpOnly; SameSite=Lax/);
    expect(await rows(`SELECT f.status AS firm, f.approved_by, f.approved_at IS NOT NULL AS approved, u.status AS user_status,
                              u.role, u.email_verified_at FROM firms f JOIN ca_users u ON u.firm_id = f.id`))
      .toEqual([{ firm: "active", approved_by: "self-registration", approved: true, user_status: "active", role: "owner",
        email_verified_at: null }]);
    expect(await rows("SELECT count(*)::int AS n FROM email_outbox")).toEqual([{ n: 0 }]);
    expect(await rows("SELECT count(*)::int AS n FROM verification_challenges")).toEqual([{ n: 0 }]);
    expect(await rows("SELECT action FROM audit_events WHERE action = 'ca.registered'")).toEqual([{ action: "ca.registered" }]);
    const [{ password_hash }] = await rows<{ password_hash: string }>("SELECT password_hash FROM ca_users");
    expect(password_hash).not.toContain(PASSWORD);
  });

  it("gives the new firm its dashboard at once: /me, cases, a firm code and a client case", async () => {
    const ca = await onboardCa();
    expect(await (await ca.get(me)).json()).toMatchObject({
      user: { email: "ca-a@example.test", role: "owner" }, firm: { name: "Firm a (synthetic)", status: "active" } });
    expect(await (await ca.get(caCases)).json()).toEqual({ cases: [] });
    const client = await startClient(ca, "client-a@example.test");
    expect((await client.post(openCase, { first_name: "Asha", financial_year: FY })).status).toBe(201);
    expect((await (await ca.get(caCases)).json()).cases).toHaveLength(1);
  });

  it("signs in with the password alone, without any token or approval", async () => {
    await onboardCa();
    const fresh = new Client();
    expect((await fresh.post(login, { email: "CA-A@example.test", password: PASSWORD })).status).toBe(200);
    expect((await fresh.get(me)).status).toBe(200);
  });

  it("keeps firms isolated: a second firm sees only its own cases", async () => {
    const a = await onboardCa("a");
    const b = await onboardCa("b");
    const client = await startClient(a, "client-a@example.test");
    expect((await client.post(openCase, { first_name: "Asha", financial_year: FY })).status).toBe(201);
    expect((await (await a.get(caCases)).json()).cases).toHaveLength(1);
    expect(await (await b.get(caCases)).json()).toEqual({ cases: [] });
    expect((await (await b.get(me)).json()).firm.name).toBe("Firm b (synthetic)");
  });

  it("refuses a duplicate e-mail or registration number with 409 and creates nothing", async () => {
    await new Client().post(register, registration("a", { registration_number: "REG-1" }));
    const sameEmail = await new Client().post(register, registration("a", { email: "CA-A@Example.test", firm_name: "Other" }));
    expect(sameEmail.status).toBe(409);
    expect(await sameEmail.json()).toMatchObject({ error: "already_registered", code: "email_taken" });
    expect(sameEmail.headers.get("set-cookie")).toBeNull();
    const sameNumber = await new Client().post(register, registration("b", { registration_number: "REG-1" }));
    expect(sameNumber.status).toBe(409);
    expect(await sameNumber.json()).toMatchObject({ code: "registration_number_taken" });
    expect(await rows("SELECT (SELECT count(*)::int FROM firms) AS f, (SELECT count(*)::int FROM ca_users) AS u"))
      .toEqual([{ f: 1, u: 1 }]);
    expect((await new Client().post(login, { email: "ca-a@example.test", password: PASSWORD })).status).toBe(200);
  });

  it("refuses weak passwords, bad e-mails and unknown fields without creating anything", async () => {
    const ca = new Client();
    const weak = await ca.post(register, registration("a", { password: "short" }));
    expect(weak.status).toBe(400);
    expect(await weak.json()).toMatchObject({ error: "invalid_registration", code: "password_too_short" });
    expect(await (await ca.post(register, registration("a", { email: "not-an-email" }))).json())
      .toMatchObject({ code: "email_invalid" });
    const extra = await ca.post(register, { ...registration(), role: "admin", status: "active" });
    expect(extra.status).toBe(422);
    expect((await extra.json()).fields).toEqual(["role", "status"]);
    expect(await rows("SELECT count(*)::int AS n FROM firms")).toEqual([{ n: 0 }]);
    expect(ca.cookies.size).toBe(0);
  });

  it("refuses registration without the allowed origin and CSRF header", async () => {
    const ca = new Client();
    const refused: Record<string, string>[] = [{ origin: "https://evil.example.test" }, { "x-itr-request": "0" }];
    for (const headers of refused) {
      expect((await ca.call(register, { method: "POST", body: registration(), headers })).status).toBe(403);
    }
    expect((await ca.call(register, { method: "POST", body: registration(), csrf: false })).status).toBe(403);
    expect(await rows("SELECT count(*)::int AS n FROM firms")).toEqual([{ n: 0 }]);
  });

  it("limits registrations per address", async () => {
    for (let i = 0; i < limits.CA_REGISTRATIONS_PER_ADDRESS; i++) {
      expect((await new Client().post(register, registration(`r${i}`))).status).toBe(201);
    }
    const over = await new Client().post(register, registration("over"));
    expect(over.status).toBe(429);
    expect(await rows("SELECT count(*)::int AS n FROM ca_users WHERE email_norm = 'ca-over@example.test'")).toEqual([{ n: 0 }]);
  });

  it("replaces a CA session presented at registration", async () => {
    const ca = await onboardCa("a");
    const before = ca.cookies.get("itr_ca_session")!;
    expect((await ca.post(register, registration("b"))).status).toBe(201);
    expect(await authenticateCa(env.db, before)).toBeNull();
    expect((await (await ca.get(me)).json()).user.email).toBe("ca-b@example.test");
  });
});

describe("accounts from the earlier verify-and-approve flow", () => {
  async function legacyAccount(firmStatus: string, userStatus = "pending") {
    const [firm] = await rows<{ id: string }>(
      `INSERT INTO firms (name, status, approved_at) VALUES ('Legacy firm (synthetic)', $1,
         CASE WHEN $1 IN ('active', 'suspended') THEN now() END) RETURNING id`, [firmStatus]);
    await rows(`INSERT INTO ca_users (firm_id, email_norm, full_name, password_hash, role, status)
                VALUES ($1, 'legacy@example.test', 'Legacy CA (synthetic)', $2, 'owner', $3)`,
      [firm.id, await hashPassword(PASSWORD), userStatus]);
  }

  for (const firmStatus of ["pending_verification", "pending_approval"]) {
    it(`activates a ${firmStatus} account on its first correct sign-in`, async () => {
      await legacyAccount(firmStatus);
      expect((await new Client().post(login, { email: "legacy@example.test", password: "wrong-password-123" })).status).toBe(401);
      expect(await rows("SELECT status FROM firms")).toEqual([{ status: firmStatus }]);
      const ca = new Client();
      expect((await ca.post(login, { email: "legacy@example.test", password: PASSWORD })).status).toBe(200);
      expect(await rows(`SELECT f.status AS firm, f.approved_at IS NOT NULL AS approved, u.status AS user_status
                         FROM firms f JOIN ca_users u ON u.firm_id = f.id`))
        .toEqual([{ firm: "active", approved: true, user_status: "active" }]);
      expect(await rows("SELECT details_json FROM audit_events WHERE action = 'ca.activated'"))
        .toEqual([{ details_json: { previous_firm_status: firmStatus } }]);
      expect((await ca.get(caCases)).status).toBe(200);
    });
  }

  it("never activates a suspended firm or a disabled user", async () => {
    await legacyAccount("suspended");
    expect((await new Client().post(login, { email: "legacy@example.test", password: PASSWORD })).status).toBe(401);
    expect(await rows("SELECT status FROM firms")).toEqual([{ status: "suspended" }]);
    await rows("DELETE FROM ca_users");
    await rows("DELETE FROM firms");
    await legacyAccount("active", "disabled");
    expect((await new Client().post(login, { email: "legacy@example.test", password: PASSWORD })).status).toBe(401);
    expect(await rows("SELECT status FROM ca_users")).toEqual([{ status: "disabled" }]);
  });
});

describe("login and sessions", () => {
  it("signs in a registered CA with an HttpOnly cookie, shows /me, and signs out", async () => {
    const ca = await onboardCa();
    const response = await ca.get(me);
    expect(await response.json()).toMatchObject({
      user: { full_name: "CA a (synthetic)", email: "ca-a@example.test", role: "owner" },
      firm: { name: "Firm a (synthetic)", status: "active" },
    });
    const login2 = await new Client().post(login, { email: "ca-a@example.test", password: PASSWORD });
    expect(login2.headers.get("set-cookie")).toMatch(/HttpOnly; SameSite=Lax/);
    expect((await ca.post(logout)).status).toBe(200);
    expect(ca.cookies.size).toBe(0);
    expect((await ca.get(me)).status).toBe(401);
  });

  it("gives one generic answer for unknown e-mails and wrong passwords", async () => {
    await onboardCa();
    const client = new Client();
    const unknown = await (await client.post(login, { email: "nobody@example.test", password: PASSWORD })).json();
    const wrong = await (await client.post(login, { email: "ca-a@example.test", password: "wrong-password-123" })).json();
    expect(unknown).toEqual(wrong);
    expect(wrong).toEqual({ error: "invalid_credentials", message: "Invalid email or password." });
  });

  it("locks an account after repeated failures, then unlocks after the lockout", async () => {
    await onboardCa();
    const now = new Date();
    for (let i = 0; i < MAX_FAILED_LOGINS; i++) {
      await expect(loginCa(env.db, "ca-a@example.test", "wrong-password-123", null, now)).rejects.toThrow(AuthenticationFailed);
    }
    await expect(loginCa(env.db, "ca-a@example.test", PASSWORD, null, now)).rejects.toThrow(AuthenticationFailed);
    const later = new Date(now.getTime() + 16 * 60 * 1000);
    await expect(loginCa(env.db, "ca-a@example.test", PASSWORD, null, later)).resolves.toMatchObject({ token: expect.any(String) });
  });

  it("expires an idle session and rotates the token on a new login", async () => {
    const ca = await onboardCa();
    const token = readSessionToken(new Request("http://x", { headers: { cookie: `itr_ca_session=${ca.cookies.get("itr_ca_session")}` } }), "ca");
    expect(await authenticateCa(env.db, token, new Date(Date.now() + 31 * 60 * 1000))).toBeNull();
    const ca2 = await onboardCa("b");
    const before = ca2.cookies.get("itr_ca_session");
    await ca2.post(login, { email: "ca-b@example.test", password: PASSWORD });
    expect(ca2.cookies.get("itr_ca_session")).not.toBe(before);
    expect(await authenticateCa(env.db, before)).toBeNull();
  });

  it("refuses state changes without the allowed origin and CSRF header", async () => {
    const ca = new Client();
    const refused: Record<string, string>[] = [{ origin: "https://evil.example.test" }, { "x-itr-request": "0" }];
    for (const headers of refused) {
      expect((await ca.call(login, { method: "POST", body: { email: "a@example.test", password: "x" }, headers })).status)
        .toBe(403);
    }
    expect((await ca.call(login, { method: "POST", body: { email: "a@example.test", password: "x" }, csrf: false })).status)
      .toBe(403);
  });
});

describe("password reset", () => {
  it("answers the same for unknown e-mails and resets with a single-use link", async () => {
    const ca = await onboardCa();
    const anon = new Client();
    const known = await (await anon.post(requestReset, { email: "ca-a@example.test" })).json();
    const unknown = await (await anon.post(requestReset, { email: "nobody@example.test" })).json();
    expect(unknown).toEqual(known);
    const token = await mailedToken("ca-a@example.test");

    const weak = await anon.post(resetPassword, { token, new_password: "short" });
    expect(await weak.json()).toMatchObject({ error: "invalid_password", code: "password_too_short" });
    const ok = await anon.post(resetPassword, { token, new_password: "a-brand-new-pass-91" });
    expect(await ok.json()).toEqual({ status: "password_reset" });
    expect((await anon.post(resetPassword, { token, new_password: "another-new-pass-22" })).status).toBe(400);

    expect((await ca.get(me)).status).toBe(401); // every session was revoked
    expect((await anon.post(login, { email: "ca-a@example.test", password: PASSWORD })).status).toBe(401);
    expect((await anon.post(login, { email: "ca-a@example.test", password: "a-brand-new-pass-91" })).status).toBe(200);
  });

  it("limits reset e-mails per address while answering the same", async () => {
    await onboardCa();
    const anon = new Client();
    for (let i = 0; i < 5; i++) expect((await anon.post(requestReset, { email: "ca-a@example.test" })).status).toBe(202);
    await mailedToken("ca-a@example.test");
    expect(await rows("SELECT count(*)::int AS n FROM email_outbox WHERE template = 'ca_password_reset'")).toEqual([{ n: 3 }]);
  });
});
