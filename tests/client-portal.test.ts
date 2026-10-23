// Stage 7: the client portal. The next-step rule (lib/intake.ts), the scoped
// light theme's contrast, and the portal page server-rendered for each session
// state with the session lookup stubbed. The flows themselves run through the
// real routes in client-onboarding.test.ts and intake-flow.test.ts.

import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ClientCase, ClientMe, ClientSessionState } from "@/lib/client-session";
import { clientNextStep, type IntakeProgress } from "@/lib/intake";

const session: { value: ClientSessionState } = { value: { state: "signed_out" } };
vi.mock("@/lib/client-session", () => ({ getClientSession: async () => session.value }));
vi.mock("next/navigation", () => ({ usePathname: () => "/client", useRouter: () => ({ refresh() {}, replace() {}, push() {} }) }));
vi.mock("next/link", async () => {
  const React = await import("react");
  return { default: ({ href, children, ...rest }: { href: string; children: unknown }) =>
    React.createElement("a", { href, ...rest }, children as never) };
});

const { default: ClientPortal } = await import("@/app/client/page");
const { default: ClientLayout } = await import("@/app/client/layout");
const render = async () => renderToStaticMarkup(createElement(ClientLayout, null, await ClientPortal()));

const progress = (details: boolean, statement: boolean, outstanding: number): IntakeProgress => ({
  steps: [{ key: "details", done: details }, { key: "statement", done: statement },
    { key: "documents", done: outstanding === 0, outstanding }],
  complete: details && statement && outstanding === 0, last_client_upload_at: null,
});

describe("clientNextStep", () => {
  it("follows the stored steps in order", () => {
    expect(clientNextStep(progress(false, false, 2), "draft")).toMatchObject({ key: "details", title: "Add your details" });
    expect(clientNextStep(progress(true, false, 2), "draft")).toMatchObject({ key: "statement", title: "Upload your bank statement" });
    expect(clientNextStep(progress(true, true, 2), "documents_pending")).toMatchObject({ key: "documents", title: "Upload 2 required documents" });
    expect(clientNextStep(progress(true, true, 1), "documents_pending").title).toBe("Upload 1 required document");
    expect(clientNextStep(progress(true, true, 0), "ca_review_required")).toMatchObject({ key: "done", title: "You're up to date" });
  });

  it("explains a failed upload only when one actually failed", () => {
    const failed = clientNextStep(progress(true, false, 0), "statement_uploaded", ["rejected"]);
    expect(failed.detail).toContain("Your earlier upload could not be used.");
    expect(clientNextStep(progress(true, false, 0), "statement_uploaded", ["processing_failed"]).detail)
      .toContain("could not be used");
    expect(clientNextStep(progress(true, false, 0), "statement_uploaded", ["processing"]).detail).not.toContain("could not");
    expect(clientNextStep(progress(true, false, 0), "draft").detail).not.toContain("could not");
  });

  it("says a closed intake needs nothing more", () => {
    expect(clientNextStep(progress(false, false, 3), "closed")).toMatchObject({ key: "closed", title: "This intake is closed" });
  });
});

// --- the light theme ----------------------------------------------------------------------------------

const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
const block = (re: RegExp) => Object.fromEntries([...re.exec(css)![1].matchAll(/--color-([a-z0-9-]+):\s*([^;]+);/g)]
  .map(([, name, value]) => [name, value.trim().toLowerCase()]));
const site = block(/\.theme-site \{([\s\S]*?)\n\}/);
const lum = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
  .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)).reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i], 0);
const contrast = (a: string, b: string) => {
  const [hi, lo] = [lum(site[a] ?? a), lum(site[b] ?? b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

describe("light site theme", () => {
  it("defines every colour the light pages use", () => {
    for (const token of ["paper", "paper-deep", "line", "ink", "ink-soft", "ink-faint", "teal", "teal-deep", "teal-wash",
      "amber-wash", "amber-ink", "rose-wash", "rose-ink", "surface", "control", "on-accent", "accent", "accent-strong",
      "accent-bg", "accent-fg", "success-bg", "success-fg", "warning-bg", "warning-fg", "danger-bg", "danger-fg",
      "neutral-bg", "neutral-fg", "muted-fg"]) {
      expect(site[token], token).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it("meets WCAG AA for text and 3:1 for controls and focus", () => {
    for (const fg of ["ink", "ink-soft", "ink-faint", "teal", "teal-deep", "amber-ink", "rose-ink"]) {
      for (const bg of ["paper", "paper-deep", "surface"]) expect(contrast(fg, bg), `${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
    }
    for (const [fg, bg] of [["on-accent", "accent"], ["on-accent", "accent-strong"], ["accent-fg", "accent-bg"],
      ["success-fg", "success-bg"], ["warning-fg", "warning-bg"], ["danger-fg", "danger-bg"], ["neutral-fg", "neutral-bg"],
      ["muted-fg", "neutral-bg"], ["#ffffff", "success-fg"]]) {
      expect(contrast(fg, bg), `${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
    }
    for (const bg of ["paper", "paper-deep", "surface"]) {
      expect(contrast("control", bg), `control on ${bg}`).toBeGreaterThanOrEqual(3);
      expect(contrast("accent", bg), `focus ring on ${bg}`).toBeGreaterThanOrEqual(3);
    }
    expect(css).toMatch(/\.theme-site :focus-visible \{\s*outline: 2px solid #1d4fc4;/);
  });
});

// --- the portal page ----------------------------------------------------------------------------------

function clientCase(over: Partial<ClientCase> = {}): ClientCase {
  return {
    reference: "IT-ASHA-SYN123", financial_year: "2025-26", status: "documents_pending",
    created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-02T00:00:00Z",
    profile: { full_name: "Asha Rao", bank_name: "Synthetic Bank", account_last4: "1234", income_sources: [], complete: true },
    statements: [], checklist: [], intake: progress(true, true, 1),
    document_requests: [
      { id: "r1", label: "Rent receipts", description: null, required: false, status: "waived", created_at: "2026-10-01T00:00:00Z", files: [] },
      { id: "r2", label: "Form 16 from employer", description: "From your employer for FY 2025-26.", required: true,
        status: "requested", created_at: "2026-10-02T00:00:00Z", files: [] },
    ],
    ...over,
  };
}

function me(cases: ClientCase[], over: Partial<ClientMe> = {}): ClientMe {
  return { client: { email: "asha@example.test" }, firm: { name: "Rao & Co (synthetic)" }, cases, financial_years: ["2026-27", "2025-26"],
    can_open_case: true, upload_limits: { pdf_bytes: 4_000_000, csv_bytes: 1_000_000, statements_per_case: 3, pdf_pages: 50 }, ...over };
}

describe("client portal page", () => {
  beforeEach(() => { session.value = { state: "signed_out" }; });

  it("welcomes a signed-out visitor with the real steps and the start form, in the light theme", async () => {
    const markup = await render();
    expect(markup).toMatch(/^<div class="theme-site /);
    expect(markup).not.toContain("theme-ca");
    expect(markup).toContain("Share what your CA needs for your income tax return.");
    for (const step of ["Enter your CA&#x27;s firm code", "Add your details and bank statement", "Upload what your CA asks for"]) {
      expect(markup).toContain(step);
    }
    expect(markup).toMatch(/<input id="firm_code"/);
    expect(markup).toMatch(/<input id="email" type="email"/);
    expect(markup).not.toMatch(/Coming in later stages|Guided clarification|What happens next/);
    expect(markup).not.toContain('role="alert"');
  });

  it("says when the server cannot be reached", async () => {
    session.value = { state: "unavailable" };
    expect(await render()).toContain('role="alert" class="mt-4 rounded-lg bg-danger-bg px-3 py-2 text-sm text-danger-fg">The ITR Intake server is not reachable.');
  });

  it("offers to start an intake when the client has none", async () => {
    session.value = { state: "signed_in", me: me([]) };
    const markup = await render();
    expect(markup).toContain(">Start your intake</h2>");
    expect(markup).toContain("You have not started an intake with Rao &amp; Co (synthetic) yet.");
    expect(markup).toMatch(/<select id="financial_year"/);
  });

  it("shows each intake's progress, one next step and every section", async () => {
    session.value = { state: "signed_in", me: me([clientCase()]) };
    const markup = await render();
    expect(markup).toContain("Financial year 2025-26");
    expect(markup).toContain('aria-label="Your progress"');
    expect(markup.match(/>Done</g)).toHaveLength(2);
    expect(markup).toContain(">1 still needed<");
    expect(markup).toContain(">Your next step<");
    expect(markup).toContain(">Upload 1 required document<");
    expect(markup).toContain('href="#requested-IT-ASHA-SYN123"');
    for (const heading of ["Your details", "Bank statement", "Documents your CA asked for", "Documents you may need"]) {
      expect(markup).toContain(`>${heading}</h3>`);
    }
    expect(markup).toContain("1 waiting · 2 in all");
    // The request still waiting comes before the waived one.
    expect(markup.indexOf("Form 16 from employer")).toBeLessThan(markup.indexOf("Rent receipts"));
    expect(markup).toContain(">Start an intake for another financial year</summary>");
  });

  it("explains a closed or blocked firm code instead of the start form", async () => {
    session.value = { state: "signed_in", me: me([clientCase()], { can_open_case: false }) };
    const markup = await render();
    expect(markup).toContain("The firm code you used is no longer active");
    expect(markup).not.toMatch(/<select id="financial_year"/);
  });

  it("marks an intake with nothing pending as up to date", async () => {
    session.value = { state: "signed_in", me: me([clientCase({ intake: progress(true, true, 0), document_requests: [] })]) };
    const markup = await render();
    expect(markup).toContain(">You&#x27;re up to date<");
    expect(markup).not.toContain(">Your next step<");
    expect(markup).toContain("Your CA has not requested any documents.");
  });
});
