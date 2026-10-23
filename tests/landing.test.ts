// Stage 8: the public landing page. Server-rendered and checked for what it
// promises (CTAs to real routes, claims the app supports, safety wording) and
// for what keeps it fast (no images, media, third-party assets or client
// script of its own; fonts preloaded only where they are used).

import { existsSync, readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ usePathname: () => "/" }));
vi.mock("next/link", async () => {
  const React = await import("react");
  return { default: ({ href, children, ...rest }: { href: string; children: unknown }) =>
    React.createElement("a", { href, ...rest }, children as never) };
});

const { default: Home } = await import("@/app/page");
const markup = renderToStaticMarkup(Home());
const source = (path: string) => readFileSync(path, "utf8");

/** The page file behind a site path, if one exists. */
function routeExists(href: string): boolean {
  const path = href === "/" ? "app/page.tsx" : `app${href}/page.tsx`;
  return existsSync(path);
}

describe("landing page content", () => {
  it("says what it is, who it is for and what to do next, in the hero", () => {
    expect(markup).toContain('<h1 id="hero"');
    expect(markup).toContain("From a client’s bank statement to a reviewed ITR workbook.");
    expect(markup).toContain("Client intake for Indian CA firms");
    const hero = markup.slice(markup.indexOf('id="hero"'), markup.indexOf('id="workflow"'));
    expect(hero).toMatch(/<a href="\/ca\/register"[^>]*>Register your firm<\/a>/);
    expect(hero).toMatch(/<a href="\/client"[^>]*>Start a client intake<\/a>/);
    expect(hero).toMatch(/<a href="\/ca\/login"[^>]*>Sign in<\/a>/);
  });

  it("links only to routes that exist", () => {
    const hrefs = [...new Set([...markup.matchAll(/href="([^"]+)"/g)].map((m) => m[1]))];
    expect(hrefs.length).toBeGreaterThan(3);
    for (const href of hrefs) {
      expect(href, href).toMatch(/^\//);
      expect(routeExists(href), href).toBe(true);
    }
  });

  it("shows the workspace as a captioned, decorative illustration with synthetic data", () => {
    expect(markup).toMatch(/<figure class="relative"><div aria-hidden="true" class="theme-ca /);
    expect(markup).toContain("The CA review workspace, shown with synthetic data.");
  });

  it("makes no claims the application cannot back", () => {
    const text = markup.replace(/<[^>]+>/g, " ");
    expect(text).not.toMatch(/\bAI\b|artificial intelligence|machine learning|testimonial|trusted by|customers love|\d+\s?%|certified|guarantee|bank-grade|ISO\s?\d+/i);
    expect(text).toContain("28 categories");
    expect(text).toContain("It does not compute tax or file returns");
    expect(text).toContain("Not a tax computation or filing tool.");
    expect(text).toContain("ITR Intake does not calculate tax or file income tax returns.");
  });
});

describe("landing page weight", () => {
  it("has no images, media, frames or third-party assets", () => {
    expect(markup).not.toMatch(/<img|<video|<iframe|<picture|<audio|<canvas/);
    expect(markup).not.toMatch(/(src|href)="https?:/);
    expect(markup).not.toContain("<script");
    expect(markup).not.toMatch(/animate-/); // nothing moves on its own
  });

  it("adds no client script of its own", () => {
    for (const file of ["app/page.tsx", "components/landing/WorkspacePreview.tsx", "components/SiteFooter.tsx", "components/SiteHeader.tsx"]) {
      expect(source(file), file).not.toMatch(/^["']use client["']/m);
    }
  });

  it("preloads only the fonts first paint needs", () => {
    const layout = source("app/layout.tsx");
    expect(layout).not.toMatch(/import[^;]*Fraunces|Fraunces\(/); // loaded only by the light frame
    expect(layout).toMatch(/IBM_Plex_Mono\(\{[^}]*preload: false/);
    expect(source("components/SiteChrome.tsx")).toMatch(/Fraunces\(\{/);
    const css = source("app/globals.css");
    expect(css).toMatch(/\.theme-site \{[\s\S]*--font-serif: var\(--font-fraunces\)/);
  });

  it("needs only the two preloaded font files (no mono, no extended-Latin glyphs in Plex)", () => {
    // Plex Mono is not preloaded; using it here would download it anyway.
    expect(markup).not.toContain("font-mono");
    // "₹" and arrows sit outside Plex Sans's basic Latin file; each "₹" is drawn in the system font instead.
    expect(markup).not.toMatch(/[→←↗]/);
    const rupees = markup.split("₹").length - 1;
    expect(rupees).toBeGreaterThan(0);
    expect(markup.match(/<span class="font-\[system-ui\]">₹<\/span>/g)).toHaveLength(rupees);
  });

  it("does not let the page's dark panels set the page background", () => {
    const css = source("app/globals.css");
    expect(css).toContain("body:has(> .theme-ca)");
    expect(css).toContain("body:has(> .theme-site)");
    expect(css).not.toMatch(/body:has\(\.theme-(ca|site)\)/);
  });
});
