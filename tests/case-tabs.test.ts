// Stage 5: case page sections selected by ?tab= (lib/case-tabs.ts), the tab
// links, and the overview's outstanding items. Server-rendered; the case
// lookup is stubbed, the full page with real data is in case-page-render.test.ts.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { CaseTabs } from "@/components/ca/case/CaseTabs";
import { TabPendingHint } from "@/components/ca/case/TabPendingHint";
import { pendingItems, priorityReasons } from "@/lib/case-priority";
import { CASE_TABS, caseTabHref, parseCaseTab } from "@/lib/case-tabs";

const lookup: { state: string } = { state: "signed_out" };
const linkStatus = { pending: false };
vi.mock("@/lib/ca-case", () => ({ getCaCase: async () => lookup }));
vi.mock("next/navigation", () => ({ redirect: (to: string) => { throw new Error(`NEXT_REDIRECT ${to}`); } }));
vi.mock("next/link", async () => {
  const React = await import("react");
  return { default: ({ href, children, ...rest }: { href: string; children: unknown }) =>
    React.createElement("a", { href, ...rest }, children as never), useLinkStatus: () => linkStatus };
});

describe("parseCaseTab", () => {
  it("accepts the four sections", () => {
    for (const tab of CASE_TABS) expect(parseCaseTab(tab)).toBe(tab);
  });

  it("falls back to the overview for missing, unknown, repeated or odd values", () => {
    for (const value of [undefined, "", "Overview", "TRANSACTIONS", "settings", "summary ", "../summary", ["documents", "summary"]]) {
      expect(parseCaseTab(value as string | string[] | undefined)).toBe("overview");
    }
  });

  it("builds links on the existing case route", () => {
    expect(caseTabHref("IT-ABC-123", "documents")).toBe("/ca/cases/IT-ABC-123?tab=documents");
    expect(caseTabHref("IT A/B", "summary")).toBe("/ca/cases/IT%20A%2FB?tab=summary");
  });
});

describe("CaseTabs", () => {
  it("links every section, marks the current one and shows pending counts", () => {
    const markup = renderToStaticMarkup(createElement(CaseTabs, { reference: "IT-ABC-123", current: "transactions",
      counts: { transactions: 4, documents: 0 } }));
    expect(markup).toContain('<nav aria-label="Case sections"');
    for (const tab of CASE_TABS) expect(markup).toContain(`href="/ca/cases/IT-ABC-123?tab=${tab}"`);
    expect(markup.match(/aria-current="page"/g)).toHaveLength(1);
    expect(markup).toMatch(/href="\/ca\/cases\/IT-ABC-123\?tab=transactions" aria-current="page"[^>]*>Transactions<span[^>]*>4<span class="sr-only"> pending<\/span>/);
    // A zero count shows no badge: the label is followed only by the (hidden) loading hint.
    expect(markup).toMatch(/>Documents<span aria-hidden="true" data-pending="false"/);
    expect(markup).not.toContain('role="tab"'); // navigation between URLs, not an in-page tab list
  });
});

describe("tab loading feedback", () => {
  const tabs = () => renderToStaticMarkup(createElement(CaseTabs, { reference: "IT-ABC-123", current: "overview" }));

  it("puts a hidden hint in every other tab, positioned so it never changes the tab's width", () => {
    linkStatus.pending = false;
    const markup = tabs();
    expect(markup.match(/data-pending="false"/g)).toHaveLength(3); // not in the current tab: nothing to load there
    const overview = /<a href="[^"]*tab=overview"[^>]*>(.*?)<\/a>/.exec(markup)![1];
    expect(overview).not.toContain("data-pending");
    expect(markup).toMatch(/<a href="[^"]*tab=transactions" class="relative /);
    expect(markup).toMatch(/aria-hidden="true" data-pending="false" class="pointer-events-none absolute [^"]*opacity-0"/);
    expect(markup).not.toContain("Loading section");
  });

  it("shows the pulsing bar and tells screen readers while the section loads", () => {
    linkStatus.pending = true;
    const markup = renderToStaticMarkup(createElement(TabPendingHint));
    expect(markup).toMatch(/data-pending="true" class="[^"]*opacity-100 motion-safe:animate-pulse"/);
    expect(markup).not.toMatch(/(?<!motion-safe:)animate-pulse/);
    expect(markup).toContain('<span role="status" class="sr-only">Loading section…</span>');
    linkStatus.pending = false;
    expect(renderToStaticMarkup(createElement(TabPendingHint))).toContain('<span role="status" class="sr-only"></span>');
  });
});

describe("pendingItems", () => {
  const base = { reference: "X", status: "documents_pending", updated_at: "2026-10-01T00:00:00Z",
    intake: { steps: [{ key: "details" as const, done: false }, { key: "statement" as const, done: true },
      { key: "documents" as const, done: false }], complete: false, last_client_upload_at: null } };
  const readiness = { statement: "unverified" as const, unverified_reasons: [], transactions_to_review: 3,
    documents: { required_outstanding: 2, required_received: 0, required_waived: 0, optional_outstanding: 0, total_requests: 2 } };

  it("gives each open item a key for where it is handled, in the dashboard's order and words", () => {
    const items = pendingItems({ ...base, readiness });
    expect(items.map((i) => i.key)).toEqual(["unverified", "documents", "transactions", "details"]);
    expect(items.map((i) => i.label)).toEqual(priorityReasons({ ...base, readiness }));
    expect(pendingItems({ ...base, readiness: { ...readiness, statement: "none" as const, transactions_to_review: 0,
      documents: { ...readiness.documents, required_outstanding: 0 } } }, ["rejected"]).map((i) => i.key))
      .toEqual(["unusable", "details"]);
  });
});

describe("case page", () => {
  it("still sends a signed-out visitor to sign in, whatever the tab", async () => {
    const { default: Page } = await import("@/app/ca/cases/[reference]/page");
    for (const tab of ["summary", "nonsense", undefined]) {
      await expect(Page({ params: Promise.resolve({ reference: "IT-ABC-123" }),
        searchParams: Promise.resolve(tab === undefined ? {} : { tab }) })).rejects.toThrow("NEXT_REDIRECT /ca/login");
    }
  });

  it("shows the not-found page without tabs", async () => {
    lookup.state = "not_found";
    const { default: Page } = await import("@/app/ca/cases/[reference]/page");
    const markup = renderToStaticMarkup(await Page({ params: Promise.resolve({ reference: "IT-NOPE" }),
      searchParams: Promise.resolve({ tab: "documents" }) }));
    expect(markup).toContain("Case not found");
    expect(markup).not.toContain("Case sections");
  });
});
