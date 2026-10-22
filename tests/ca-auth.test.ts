// CA registration, verification, approval, login, sessions and password reset
// through the real routes. Synthetic accounts only.

import { describe, expect, it } from "vitest";
import { POST as login } from "@/app/api/ca/login/route";
import { POST as logout } from "@/app/api/ca/logout/route";
import { GET as me } from "@/app/api/ca/me/route";
import { POST as register } from "@/app/api/ca/register/route";
import { POST as requestReset } from "@/app/api/ca/request-password-reset/route";
import { POST as resend } from "@/app/api/ca/resend-verification/route";
import { POST as resetPassword } from "@/app/api/ca/reset-password/route";
import { POST as verifyEmail } from "@/app/api/ca/verify-email/route";
import { approveCa, authenticateCa, AuthenticationFailed, loginCa, MAX_FAILED_LOGINS } from "@/lib/server/ca-auth";
import { readSessionToken } from "@/lib/server/cookies";
import { onboardCa } from "./helpers/ca";
import { Client, env, mailedToken, PASSWORD, rows, setupTestServer } from "./helpers/http";

setupTestServer();

export function registration(tag = "a", extra: Record<string, unknown> = {}) {
  return { full_name: `CA ${tag} (synthetic)`, email: `ca-${tag}@example.test`, password: PASSWORD,
    firm_name: `Firm ${tag} (synthetic)`, ...extra };
}

describe("registration and verification", () => {
  it("creates a pending firm, e-mails a link and activates nothing", async () => {
    const ca = new Client();
    const response = await ca.post(register, registration());
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ status: "verification_required", email_delivery: "simulated",
      dev_outbox_url: "http://localhost:3000/api/dev/outbox" });
    expect(await rows("SELECT f.status AS firm, u.status AS user_status FROM firms f JOIN ca_users u ON u.firm_id = f.id"))
      .toEqual([{ firm: "pending_verification", user_status: "pending" }]);
    expect(await mailedToken("ca-a@example.test")).toMatch(/^[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/);
    expect((await ca.post(login, { email: "ca-a@example.test", password: PASSWORD })).status).toBe(401);
  });

  it("answers a duplicate exactly like a new registration", async () => {
    const ca = new Client();
    const first = await (await ca.post(register, registration())).json();
    const again = await ca.post(register, registration("a", { full_name: "Someone else" }));
    expect(again.status).toBe(202);
    expect(await again.json()).toEqual(first);
    expect(await rows("SELECT count(*)::int AS n FROM ca_users")).toEqual([{ n: 1 }]);
  });

  it("refuses weak passwords with a code and unknown fields with their names", async () => {
    const ca = new Client();
    const weak = await ca.post(register, registration("a", { password: "short" }));
    expect(weak.status).toBe(400);
    expect(await weak.json()).toMatchObject({ error: "invalid_registration", code: "password_too_short" });
    const extra = await ca.post(register, { ...registration(), role: "admin" });
    expect(extra.status).toBe(422);
    expect((await extra.json()).fields).toEqual(["role"]);
  });

  it("verifies once, moves the firm to pending approval and still refuses login until approved", async () => {
    const ca = new Client();
    await ca.post(register, registration());
    const token = await mailedToken("ca-a@example.test");
    const ok = await ca.post(verifyEmail, { token });
    expect(await ok.json()).toEqual({ status: "email_verified", next: "awaiting_approval" });
    expect((await ca.post(verifyEmail, { token })).status).toBe(400);
    expect(await rows("SELECT status FROM firms")).toEqual([{ status: "pending_approval" }]);
    expect((await ca.post(login, { email: "ca-a@example.test", password: PASSWORD })).status).toBe(401);
  });

  it("refuses tampered and malformed verification links", async () => {
    const ca = new Client();
    await ca.post(register, registration());
    const token = await mailedToken("ca-a@example.test");
    for (const bad of [`${token.split(".")[0]}.${"x".repeat(43)}`, "nonsense", `${token}.extra`]) {
      expect((await ca.post(verifyEmail, { token: bad })).status).toBe(400);
    }
  });

  it("resends a link only to a pending, unverified account, with the same answer for everyone", async () => {
    const ca = new Client();
    await ca.post(register, registration());
    const first = await mailedToken("ca-a@example.test");
    const known = await (await ca.post(resend, { email: "ca-a@example.test" })).json();
    const unknown = await (await ca.post(resend, { email: "nobody@example.test" })).json();
    expect(unknown).toEqual(known);
    const second = await mailedToken("ca-a@example.test");
    expect(await rows("SELECT count(*)::int AS n FROM dev_mailbox")).toEqual([{ n: 2 }]);
    expect((await ca.post(verifyEmail, { token: first })).status).toBe(400); // the newer link replaced it
    expect((await ca.post(verifyEmail, { token: second })).status).toBe(200);
  });

  it("approval needs a verified e-mail", async () => {
    await new Client().post(register, registration());
    await expect(approveCa(env.db, { email: "ca-a@example.test", approvedBy: "Operator" }))
      .rejects.toMatchObject({ code: "email_not_verified" });
  });
});

describe("login and sessions", () => {
  it("signs in an approved CA with an HttpOnly cookie, shows /me, and signs out", async () => {
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
