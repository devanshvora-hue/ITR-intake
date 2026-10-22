// Stage 2: the dark CA shell, its navigation and brand mark, the loading, error
// and not-found boundaries, the light frame kept by the client portal, and the
// contrast of the scoped dark theme. Server-rendered; next/navigation is stubbed.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { createElement, type FunctionComponent, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const nav = { pathname: "/ca" };
vi.mock("next/navigation", () => ({ usePathname: () => nav.pathname, useRouter: () => ({ refresh() {}, replace() {}, push() {} }) }));
vi.mock("next/link", async () => {
  const React = await import("react");
  return { default: ({ href, children, ...rest }: { href: string; children: unknown }) =>
    React.createElement("a", { href, ...rest }, children as never) };
});

const { CaShell } = await import("@/components/ca/CaShell");
const { CA_NAV_LINKS, isCurrent } = await import("@/components/ca/CaNav");
const { BrandMark } = await import("@/components/BrandMark");
const { default: CaError } = await import("@/app/ca/error");
const { default: CaLoading } = await import("@/app/ca/loading");
const { default: NotFound } = await import("@/app/not-found");
const { default: ClientLayout } = await import("@/app/client/layout");
const { default: CaLayout } = await import("@/app/ca/layout");

function el<P extends object>(type: FunctionComponent<P>, props: Omit<P, "children">, children: ReactNode) {
  const all = { ...props, children } as P;
  return createElement(type, all);
}
const html = (element: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(element);

beforeEach(() => { nav.pathname = "/ca"; });

describe("CA navigation", () => {
  it("keeps the site's existing destinations", () => {
    expect(CA_NAV_LINKS.map((l) => l.href)).toEqual(["/ca", "/client", "/"]);
  });

  it("marks Dashboard current on the dashboard and case pages only", () => {
    expect(isCurrent("/ca", "/ca")).toBe(true);
    expect(isCurrent("/ca", "/ca/cases/IT-ABC-123")).toBe(true);
    for (const path of ["/ca/login", "/ca/register", "/ca/forgot-password", "/ca/reset-password", "/client", "/"]) {
      expect(isCurrent("/ca", path)).toBe(false);
    }
    expect(isCurrent("/client", "/client/verify")).toBe(true);
    expect(isCurrent("/", "/")).toBe(true);
    expect(isCurrent("/", "/ca")).toBe(false);
  });

  it("renders the shell with the brand, the current page marked and a labelled menu for small screens", () => {
    nav.pathname = "/ca/cases/IT-ABC-123";
    const markup = html(el(CaShell, {}, "Page body"));
    expect(markup).toMatch(/^<div class="theme-ca /);
    expect(markup).toContain('<nav aria-label="Main"');
    expect(markup).toContain(">ITR <span");
    expect(markup).toContain(">Intake</span>");
    // Each destination appears twice (inline links and the small-screen menu); only Dashboard is current.
    expect(markup.match(/aria-current="page"/g)).toHaveLength(2);
    expect(markup).toMatch(/<a href="\/ca" aria-current="page"[^>]*>Dashboard<\/a>/);
    expect(markup).not.toMatch(/<a href="\/client" aria-current/);
    const button = /<button type="button" aria-expanded="false" aria-controls="([^"]+)"/.exec(markup);
    expect(button).not.toBeNull();
    expect(markup).toContain(`<div id="${button![1]}" hidden=""`);
    expect(markup).toContain("<main class=\"flex-1\">Page body</main>");
    // The safety wording stays in the frame.
    expect(markup).toContain("ITR Intake does not calculate tax or file income tax returns.");
    expect(markup).toContain("Not a tax computation or filing tool. Demo data only.");
  });

  it("wraps every /ca route in the dark shell", () => {
    expect(html(el(CaLayout, {}, "x"))).toMatch(/^<div class="theme-ca /);
  });
});

describe("brand mark", () => {
  it("is decorative beside the wordmark and labelled when alone", () => {
    const decorative = html(createElement(BrandMark, {}));
    expect(decorative).toContain('aria-hidden="true"');
    expect(decorative).not.toContain("role=");
    const labelled = html(createElement(BrandMark, { label: "ITR Intake" }));
    expect(labelled).toContain('role="img" aria-label="ITR Intake"');
    expect(labelled).not.toContain("aria-hidden");
    expect(labelled).not.toMatch(/<image|href=/); // inline shapes only, no external image
  });
});

describe("boundaries", () => {
  it("shows a safe error page with a reference, a retry and a way back", () => {
    const error = Object.assign(new Error("connection to postgres://user:secret@db failed"), { digest: "4093721" });
    const markup = html(createElement(CaError, { error, retry: () => {} }));
    expect(markup).toContain("This page could not be shown");
    expect(markup).not.toContain("secret");
    expect(markup).not.toContain("postgres");
    expect(markup).toContain(">4093721<");
    expect(markup).toMatch(/<button type="button"[^>]*>Try again<\/button>/);
    expect(markup).toContain('<a href="/ca"');
    // A thrown non-Error value has no digest and shows no reference.
    expect(html(createElement(CaError, { error: "boom", retry: () => {} }))).not.toContain("Reference:");
  });

  it("announces loading and only pulses when motion is allowed", () => {
    const markup = html(createElement(CaLoading));
    expect(markup).toMatch(/^<div role="status" aria-live="polite"/);
    expect(markup).toContain('<span class="sr-only">Loading…</span>');
    expect(markup).not.toMatch(/(?<!motion-safe:)animate-pulse/);
  });

  it("offers the three starting points on the not-found page, in the light frame", () => {
    nav.pathname = "/missing";
    const markup = html(createElement(NotFound));
    expect(markup).toContain("Page not found");
    for (const href of ["/ca", "/client", "/"]) expect(markup).toContain(`href="${href}"`);
    expect(markup).not.toContain("theme-ca");
  });
});

describe("client portal frame", () => {
  it("keeps the light header and footer and never the dark theme", () => {
    nav.pathname = "/client";
    const markup = html(el(ClientLayout, {}, "Portal"));
    expect(markup).not.toContain("theme-ca");
    expect(markup).toContain('<nav aria-label="Main"');
    expect(markup).toContain("Demo prototype.");
    expect(markup).toContain('<main class="flex-1">Portal</main>');
  });

  it("uses no CA-only component", () => {
    const sources = (dir: string): string[] => readdirSync(dir).flatMap((f) => {
      const p = join(dir, f);
      return statSync(p).isDirectory() ? sources(p) : [p];
    });
    for (const file of [...sources("app/client"), ...sources("components/client")]) {
      expect(readFileSync(file, "utf8"), file).not.toMatch(/CaShell|theme-ca/);
    }
  });
});

// --- dark theme tokens ------------------------------------------------------------------------------

const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
const block = (re: RegExp) => Object.fromEntries([...re.exec(css)![1].matchAll(/--color-([a-z0-9-]+):\s*([^;]+);/g)]
  .map(([, name, value]) => [name, value.trim().toLowerCase()]));
const light = block(/@theme \{([\s\S]*?)\n\}/);
const dark = block(/\.theme-ca \{([\s\S]*?)\n\}/);

/** A token's value inside .theme-ca: its own override, else the light value, following var() references. */
function darkValue(name: string): string {
  let value = dark[name] ?? light[name];
  for (let i = 0; value?.startsWith("var("); i++) {
    if (i > 10) throw new Error(`token loop at ${name}`);
    const ref = /var\(--color-([a-z0-9-]+)\)/.exec(value)![1];
    value = dark[ref] ?? light[ref];
  }
  if (!value) throw new Error(`unknown token ${name}`);
  return value;
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(darkValue(a)), luminance(darkValue(b))].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

describe("dark CA theme", () => {
  it("redefines every colour the CA pages use, so nothing stays light", () => {
    for (const token of ["paper", "paper-deep", "line", "ink", "ink-soft", "ink-faint", "teal", "teal-deep", "teal-wash",
      "amber-wash", "amber-ink", "rose-wash", "rose-ink", "surface", "control", "on-accent", "accent", "accent-strong",
      "accent-bg", "accent-fg", "success-bg", "success-fg", "warning-bg", "warning-fg", "danger-bg", "danger-fg",
      "neutral-bg", "neutral-fg", "muted-fg"]) {
      expect(dark, token).toHaveProperty(token);
    }
    expect(darkValue("paper")).toBe("#101421");
    expect(darkValue("surface")).toBe("#1b2335");
    expect(darkValue("accent")).toBe("#2583ff");
  });

  it("keeps CA sources on tokens that the theme covers (no fixed white)", () => {
    const sources = (dir: string): string[] => readdirSync(dir).flatMap((f) => {
      const p = join(dir, f);
      return statSync(p).isDirectory() ? sources(p) : [p];
    });
    for (const file of [...sources("app/ca"), ...sources("components/ca"), ...sources("components/ui")]) {
      expect(readFileSync(file, "utf8"), file).not.toMatch(/\b(bg|text)-white\b/);
    }
  });

  it("meets WCAG AA for text on every background it sits on", () => {
    for (const fg of ["ink", "ink-soft", "ink-faint", "teal", "teal-deep", "amber-ink", "rose-ink"]) {
      for (const bg of ["paper", "surface", "paper-deep"]) expect(contrast(fg, bg), `${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
    }
    for (const [fg, bg] of [["success-fg", "success-bg"], ["warning-fg", "warning-bg"], ["danger-fg", "danger-bg"],
      ["neutral-fg", "neutral-bg"], ["muted-fg", "neutral-bg"], ["accent-fg", "accent-bg"], ["on-accent", "accent"],
      ["on-accent", "accent-strong"], ["amber-ink", "amber-wash"], ["rose-ink", "rose-wash"], ["teal-deep", "teal-wash"]]) {
      expect(contrast(fg, bg), `${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("gives controls and the focus ring 3:1 against the workspace", () => {
    for (const bg of ["paper", "surface"]) {
      expect(contrast("control", bg)).toBeGreaterThanOrEqual(3);
      expect(contrast("ca-blue-text", bg)).toBeGreaterThanOrEqual(3);
    }
    expect(css).toMatch(/\.theme-ca :focus-visible \{\s*outline: 2px solid var\(--color-ca-blue-text\);/);
  });

  it("keeps the success, warning and danger tones distinct", () => {
    const tones = ["success", "warning", "danger"].map((t) => `${darkValue(`${t}-bg`)}/${darkValue(`${t}-fg`)}`);
    expect(new Set(tones).size).toBe(3);
  });
});
