// Stage 3: the sign-in style screens. Server-rendered with next/navigation and
// the session lookup stubbed; the flows themselves are covered through the
// real routes in ca-auth.test.ts and client-onboarding.test.ts. These check what
// each screen offers, that the security wording is unchanged, and that the
// client link check stays in the light frame.

import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const session: { state: string } = { state: "signed_out" };
const redirects: string[] = [];
vi.mock("next/navigation", () => ({
  usePathname: () => "/ca/login",
  useRouter: () => ({ refresh() {}, replace() {}, push() {} }),
  redirect: (to: string) => { redirects.push(to); throw new Error("NEXT_REDIRECT"); },
}));
vi.mock("next/link", async () => {
  const React = await import("react");
  return { default: ({ href, children, ...rest }: { href: string; children: unknown }) =>
    React.createElement("a", { href, ...rest }, children as never) };
});
vi.mock("@/lib/ca-session", () => ({ getCaSession: async () => session }));

const { default: LoginPage } = await import("@/app/ca/login/page");
const { default: RegisterPage } = await import("@/app/ca/register/page");
const { default: ForgotPage } = await import("@/app/ca/forgot-password/page");
const { default: ResetPage } = await import("@/app/ca/reset-password/page");
const { default: VerifyPage } = await import("@/app/client/verify/page");
const { default: ClientLayout } = await import("@/app/client/layout");

const html = (element: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(element);
const source = (path: string) => readFileSync(path, "utf8");

beforeEach(() => {
  session.state = "signed_out";
  redirects.length = 0;
});

describe("CA sign in", () => {
  it("offers email, password, the reset link and registration", async () => {
    const markup = html(await LoginPage());
    expect(markup).toContain(">Sign in</h1>");
    expect(markup).toMatch(/<input id="email" type="email" autoComplete="username" required=""/);
    expect(markup).toMatch(/<input id="password" type="password" autoComplete="current-password" required=""/);
    expect(markup).toMatch(/<a href="\/ca\/forgot-password"[^>]*>Forgot password\?<\/a>/);
    expect(markup).toMatch(/<a href="\/ca\/register"[^>]*>Register a CA account<\/a>/);
    expect(markup).toMatch(/<button type="submit"[^>]*>Sign in<\/button>/);
    expect(markup).not.toContain('role="alert"');
  });

  it("announces an unreachable server with the same words", async () => {
    session.state = "unavailable";
    expect(html(await LoginPage())).toContain(
      '<p role="alert" class="rounded-lg px-3 py-2 text-sm bg-danger-bg text-danger-fg">The ITR Intake server is not reachable. Start it, then reload this page.</p>');
  });

  it("still sends a signed-in CA to the dashboard", async () => {
    session.state = "signed_in";
    await expect(LoginPage()).rejects.toThrow("NEXT_REDIRECT");
    expect(redirects).toEqual(["/ca"]);
  });

  it("keeps the generic failure messages", () => {
    const form = source("components/ca/LoginForm.tsx");
    expect(form).toContain('"Invalid email or password."');
    expect(form).toContain('"The server could not be reached. Check your connection and try again."');
    expect(form).toContain('router.replace("/ca")');
  });
});

describe("CA registration", () => {
  it("groups the same seven fields, with the same names and rules", () => {
    const markup = html(createElement(RegisterPage));
    expect(markup.match(/<fieldset/g)).toHaveLength(2);
    expect(markup).toContain(">Your account</legend>");
    expect(markup).toContain(">Your firm</legend>");
    for (const name of ["full_name", "email", "password", "firm_name"]) {
      expect(markup).toMatch(new RegExp(`<input id="${name}"[^>]*required=""[^>]*name="${name}"`));
    }
    for (const name of ["contact_phone", "contact_address", "registration_number"]) {
      expect(markup).toMatch(new RegExp(`<input id="${name}"(?![^>]*required)[^>]*name="${name}"`));
    }
    expect(markup).toMatch(/<input id="password" type="password" autoComplete="new-password" required="" minLength="12" maxLength="256"/);
    expect(markup).toMatch(/<button type="submit"[^>]*>Create account<\/button>/);
    expect(markup).toMatch(/<a href="\/ca\/login"[^>]*>Sign in<\/a>/);
    expect(markup).toContain("max-w-xl");
  });

  it("keeps the success wording and the way to the dashboard", () => {
    const form = source("components/ca/RegisterForm.tsx");
    expect(form).toContain("Your firm is registered. Your account is ready. You can now access your CA dashboard.");
    expect(form).toMatch(/<Link href="\/ca"[^>]*>\s*Continue to dashboard/);
    expect(form).toContain("result.status === 201");
  });
});

describe("password reset", () => {
  it("asks only for the email and never says whether an account exists", () => {
    const markup = html(createElement(ForgotPage));
    expect(markup).toContain(">Reset your password</h1>");
    expect(markup.match(/<input /g)).toHaveLength(1);
    expect(markup).toMatch(/<button type="submit"[^>]*>Send reset link<\/button>/);
    expect(markup).toMatch(/<a href="\/ca\/login"[^>]*>← Back to sign in<\/a>/);
    expect(source("components/ca/ForgotPasswordForm.tsx"))
      .toContain("If an account exists for that address, a password reset link is on its way.");
  });

  it("asks for the new password twice and keeps the token out of the page", () => {
    const markup = html(createElement(ResetPage));
    expect(markup).toMatch(/<input id="new_password" type="password" autoComplete="new-password" required="" minLength="12"/);
    expect(markup).toMatch(/<input id="confirm_password" type="password" autoComplete="new-password" required="" minLength="12"/);
    expect(markup).toMatch(/<button type="submit"[^>]*>Set new password<\/button>/);
    expect(markup).not.toContain("token");
    const form = source("components/ca/ResetPasswordForm.tsx");
    expect(form).toContain('window.history.replaceState(null, "", window.location.pathname)');
    expect(form).toContain("This reset link is invalid or has expired. Request a new one from the sign-in page.");
    expect(form).toContain('"The two passwords do not match."');
  });
});

describe("form fallback", () => {
  it("posts every CA auth form, so a submit before hydration never puts a password in the URL", async () => {
    // Found in Stage 3 browser checks: without a method, a click before React attached its handler sent
    // the fields, password included, as a GET query string. The handlers still preventDefault and call the API.
    for (const markup of [html(await LoginPage()), html(createElement(RegisterPage)), html(createElement(ForgotPage)),
      html(createElement(ResetPage))]) {
      expect(markup).toMatch(/<form [^>]*method="post"/);
      expect(markup).not.toMatch(/<form(?![^>]*method="post")[^>]*>/);
    }
  });
});

describe("client link check", () => {
  it("shows the check in progress, in the light site frame", () => {
    const markup = html(createElement(ClientLayout, null, createElement(VerifyPage)));
    expect(markup).not.toContain("theme-ca");
    expect(markup).toContain(">Confirming your email</h1>");
    expect(markup).toMatch(/<div role="status"[^>]*>.*Checking your link…/);
    expect(markup).toContain("motion-safe:animate-spin");
    expect(markup).not.toMatch(/(?<!motion-safe:)animate-spin/);
  });

  it("keeps the verification wording and every outcome's way forward", () => {
    const view = source("components/client/ClientVerify.tsx");
    expect(view).toContain("This link is invalid or has expired. Links work once and expire after 30 minutes.");
    expect(view).toContain("The ITR Intake server is not reachable. Please try again later.");
    expect(view).toContain("Too many attempts. Please try again later.");
    expect(view).toMatch(/<Link href="\/client"/);
    expect(view).toContain('postJson("/api/client/verify", { token })');
    expect(view).toContain('router.replace("/client")');
  });
});
