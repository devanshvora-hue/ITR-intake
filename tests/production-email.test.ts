// Production behaviour: Secure __Host- cookies, "not configured" answers
// without SMTP, and real delivery through SMTP (a fake transport).

import { describe, expect, it } from "vitest";
import { POST as requestReset } from "@/app/api/ca/request-password-reset/route";
import { POST as register } from "@/app/api/ca/register/route";
import { readConfig, setConfigForTests } from "@/lib/server/config";
import { classifySendError, setMailTransportForTests } from "@/lib/server/email";
import { Client, flush, PASSWORD, PROD_CONFIG, PROD_ORIGIN, rows, setupTestServer } from "./helpers/http";

setupTestServer(PROD_CONFIG);

const SMTP_CONFIG = readConfig({
  APP_ENV: "production", DATABASE_URL: "postgresql://u:p@localhost/db", APP_BASE_URL: PROD_ORIGIN,
  SUPABASE_URL: "https://project.supabase.example.test", SUPABASE_SERVICE_ROLE_KEY: "synthetic-key",
  SMTP_HOST: "smtp.example.test", EMAIL_FROM: "no-reply@example.test", SMTP_USER: "u", SMTP_PASSWORD: "synthetic-smtp-pass",
});
const body = { full_name: "CA (synthetic)", email: "ca-p@example.test", password: PASSWORD, firm_name: "Firm (synthetic)" };

describe("production without SMTP", () => {
  it("says e-mail is not configured, queues nothing and offers no developer outbox", async () => {
    const client = new Client(PROD_ORIGIN);
    const response = await client.post(register, body);
    expect(await response.json()).toEqual({ status: "verification_required", email_delivery: "not_configured" });
    await client.post(requestReset, { email: "ca-p@example.test" });
    await flush();
    expect(await rows("SELECT count(*)::int AS n FROM email_outbox")).toEqual([{ n: 0 }]);
  });
});

describe("production with SMTP", () => {
  it("sends the verification e-mail after the response and clears the link from the database", async () => {
    setConfigForTests(SMTP_CONFIG);
    const sent: { to: string; subject: string; text: string; from: string }[] = [];
    setMailTransportForTests({ sendMail: async (m: never) => { sent.push(m); return { messageId: "<m1@example.test>" }; } } as never);
    const response = await new Client(PROD_ORIGIN).post(register, body);
    expect(await response.json()).toEqual({ status: "verification_required", email_delivery: "email" });
    expect(sent).toHaveLength(0); // nothing is sent before the response
    await flush();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: "ca-p@example.test", from: "no-reply@example.test" });
    expect(sent[0].text).toContain(`${PROD_ORIGIN}/ca/verify-email#token=`);
    expect(await rows("SELECT status, body_text, provider_message_id FROM email_outbox"))
      .toEqual([{ status: "sent", body_text: null, provider_message_id: "<m1@example.test>" }]);
  });

  it("records failures with fixed codes: retryable ones wait, permanent ones are dead", async () => {
    setConfigForTests(SMTP_CONFIG);
    setMailTransportForTests({ sendMail: async () => { throw Object.assign(new Error("535 provider text"), { code: "EAUTH" }); } } as never);
    await new Client(PROD_ORIGIN).post(register, body);
    await flush();
    const [row] = await rows<{ status: string; last_error: string; body_text: string | null }>(
      "SELECT status, last_error, body_text FROM email_outbox");
    expect(row).toMatchObject({ status: "failed", last_error: "auth_failed" });
    expect(row.body_text).not.toBeNull();
    expect(classifySendError({ responseCode: 550 })).toMatchObject({ code: "rejected", retryable: false });
    expect(classifySendError({ responseCode: 451 })).toMatchObject({ code: "temporary_failure", retryable: true });
    expect(classifySendError({ code: "ECONNECTION" })).toMatchObject({ code: "connection_failed", retryable: true });
  });

  it("uses Secure __Host- cookies", async () => {
    setConfigForTests(SMTP_CONFIG);
    const { setSessionCookie } = await import("@/lib/server/cookies");
    expect(setSessionCookie(new Response(), "ca", "t").headers.get("set-cookie")).toMatch(/^__Host-itr_ca_session=t; .*Secure/);
  });
});
