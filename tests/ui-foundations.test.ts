// Stage 1 UI foundations: the shared components in components/ui, the semantic
// tones behind the status maps, and the design tokens. The parity tests resolve
// every colour class through app/globals.css to its final value, so a refactor
// that swaps a class name but keeps the colour passes, and one that changes a
// colour fails.

import { readFileSync } from "node:fs";
import { createElement, type FunctionComponent, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { primaryButton } from "@/components/ca/Field";
import { Badge } from "@/components/ui/Badge";
import { Button, buttonClasses } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Field } from "@/components/ui/Field";
import { FormMessage } from "@/components/ui/FormMessage";
import { TabPanel, tabKeyTarget, Tabs } from "@/components/ui/Tabs";
import { STATEMENT_TONES } from "@/lib/case-readiness";
import { LEVEL_TONES } from "@/lib/checklist";
import { REQUEST_STATUS_TONES } from "@/lib/document-requests";
import { STATUS_TONES } from "@/lib/statements";
import { TONE_CLASSES } from "@/lib/tones";

const html = (element: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(element);

/** createElement for a component whose props include children. */
function el<P extends object>(type: FunctionComponent<P>, props: Omit<P, "children">, children: ReactNode) {
  const all = { ...props, children } as P;
  return createElement(type, all);
}

// --- tokens ---------------------------------------------------------------------------------------

const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
const theme = Object.fromEntries(
  [...css.matchAll(/--color-([a-z0-9-]+):\s*([^;]+);/g)].map(([, name, value]) => [name, value.trim().toLowerCase()]));
theme.white = "#ffffff"; // Tailwind's own white

/** The final value of a colour token, following var(--color-…) references. */
function resolve(name: string): string {
  let value = theme[name];
  for (let i = 0; value?.startsWith("var("); i++) {
    if (i > 10) throw new Error(`token loop at ${name}`);
    value = theme[/var\(--color-([a-z0-9-]+)\)/.exec(value)![1]];
  }
  if (!value) throw new Error(`unknown colour token ${name}`);
  return value;
}

/** A class list as a set, with every colour utility rewritten to its resolved colour value. */
function rendered(classes: string): Set<string> {
  return new Set(classes.split(/\s+/).filter(Boolean).map((cls) => {
    const m = /^((?:[a-z-]+:)*(?:bg|text|border))-([a-z0-9-]+?)(\/\d+)?$/.exec(cls);
    return m && theme[m[2]] !== undefined ? `${m[1]}-[${resolve(m[2])}]${m[3] ?? ""}` : cls;
  }));
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

describe("design tokens", () => {
  it("point every semantic token at the colour it replaces", () => {
    expect({
      surface: resolve("surface"), accent: resolve("accent"), "accent-strong": resolve("accent-strong"),
      "success-bg": resolve("success-bg"), "success-fg": resolve("success-fg"),
      "warning-bg": resolve("warning-bg"), "warning-fg": resolve("warning-fg"),
      "danger-bg": resolve("danger-bg"), "danger-fg": resolve("danger-fg"),
      "neutral-bg": resolve("neutral-bg"), "neutral-fg": resolve("neutral-fg"), "muted-fg": resolve("muted-fg"),
      "accent-bg": resolve("accent-bg"), "accent-fg": resolve("accent-fg"),
    }).toEqual({
      surface: "#ffffff", accent: resolve("teal"), "accent-strong": resolve("teal-deep"),
      "success-bg": resolve("teal-wash"), "success-fg": resolve("teal-deep"),
      "warning-bg": resolve("amber-wash"), "warning-fg": resolve("amber-ink"),
      "danger-bg": resolve("rose-wash"), "danger-fg": resolve("rose-ink"),
      "neutral-bg": resolve("paper-deep"), "neutral-fg": resolve("ink-soft"), "muted-fg": resolve("ink-faint"),
      "accent-bg": resolve("teal-wash"), "accent-fg": resolve("teal-deep"),
    });
  });

  it("define the planned CA palette without changing the page background or text", () => {
    expect([
      "ca-midnight", "ca-indigo", "ca-blue", "ca-surface", "ca-text", "ca-text-soft", "ca-success", "ca-warning", "ca-border",
    ].map(resolve)).toEqual(["#101421", "#172b76", "#2583ff", "#1b2335", "#f0f3f8", "#a7b0c7", "#70d6ae", "#ffc777", "#30384e"]);
    expect(css).toMatch(/body \{\s*background: var\(--color-paper\);\s*color: var\(--color-ink\);/);
  });

  it("meet WCAG AA where the CA palette notes say they do", () => {
    const [midnight, surface, indigo] = ["ca-midnight", "ca-surface", "ca-indigo"].map(resolve);
    // Electric blue itself is not enough for small text on the raised surface or indigo…
    expect(contrast(resolve("ca-blue"), surface)).toBeLessThan(4.5);
    expect(contrast(resolve("ca-blue"), indigo)).toBeLessThan(4.5);
    // …so small text uses the lighter tint, which passes on all three backgrounds.
    for (const bg of [midnight, surface, indigo]) {
      expect(contrast(resolve("ca-blue-text"), bg)).toBeGreaterThanOrEqual(4.5);
      for (const fg of ["ca-text", "ca-text-soft", "ca-success", "ca-warning"]) {
        expect(contrast(resolve(fg), bg)).toBeGreaterThanOrEqual(4.5);
      }
    }
    // Text on a blue fill: the dark ink passes, white does not.
    expect(contrast(resolve("ca-on-blue"), resolve("ca-blue"))).toBeGreaterThanOrEqual(4.5);
    expect(contrast("#ffffff", resolve("ca-blue"))).toBeLessThan(4.5);
    // Control outlines need 3:1 against the backgrounds they sit on (WCAG 1.4.11).
    for (const bg of [midnight, surface]) expect(contrast(resolve("ca-border-strong"), bg)).toBeGreaterThanOrEqual(3);
  });
});

// --- status tones ---------------------------------------------------------------------------------

describe("status tone maps", () => {
  // The literal classes these maps held before Stage 1.
  const before = {
    statement: { none: "bg-paper-deep text-ink-soft", not_prepared: "bg-paper-deep text-ink-soft",
      unverified: "bg-amber-wash text-amber-ink", verified: "bg-teal-wash text-teal-deep" },
    upload: { processing: "bg-paper-deep text-ink-soft", extracted: "bg-teal-wash text-teal-deep",
      manual_review_required: "bg-amber-wash text-amber-ink", rejected: "bg-rose-wash text-rose-ink",
      processing_failed: "bg-rose-wash text-rose-ink" },
    level: { required: "bg-amber-wash text-amber-ink", conditional: "bg-paper-deep text-ink-soft",
      optional: "bg-paper-deep text-ink-faint" },
    request: { requested: "bg-amber-wash text-amber-ink", received: "bg-teal-wash text-teal-deep",
      waived: "bg-paper-deep text-ink-soft" },
  };
  const after = { statement: STATEMENT_TONES, upload: STATUS_TONES, level: LEVEL_TONES, request: REQUEST_STATUS_TONES };

  for (const [name, map] of Object.entries(before)) {
    it(`keeps every ${name} status and its colours`, () => {
      const now = after[name as keyof typeof after] as Record<string, string>;
      expect(Object.keys(now).sort()).toEqual(Object.keys(map).sort());
      for (const [status, classes] of Object.entries(map)) expect(rendered(now[status])).toEqual(rendered(classes));
    });
  }

  it("keeps the success, warning, danger and neutral distinctions apart", () => {
    const resolved = ["success", "warning", "danger", "neutral", "muted"]
      .map((t) => [...rendered(TONE_CLASSES[t as keyof typeof TONE_CLASSES])].join(" "));
    expect(new Set(resolved).size).toBe(resolved.length);
  });
});

// --- Button ---------------------------------------------------------------------------------------

describe("Button", () => {
  it("renders a native button of the given type, not full width by default", () => {
    const markup = html(el(Button, { type: "submit" }, "Save details"));
    expect(markup).toMatch(/^<button type="submit" class="[^"]+">Save details<\/button>$/);
    expect(markup).not.toContain("w-full");
    expect(html(el(Button, { type: "button" }, "Cancel"))).toContain('type="button"');
  });

  it("keeps the old classes, colour for colour, for every migrated button", () => {
    const base = "rounded-lg px-4 py-2 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60";
    // FirmCodePanel (primary, secondary, danger) and WorkbookDownload (secondary) before Stage 1.
    expect(rendered(buttonClasses({ variant: "primary" }))).toEqual(rendered(`${base} bg-teal text-white hover:bg-teal-deep`));
    expect(rendered(buttonClasses({ variant: "secondary" })))
      .toEqual(rendered(`${base} border border-line bg-white hover:border-ink-faint`));
    expect(rendered(buttonClasses({ variant: "danger" })))
      .toEqual(rendered(`${base} border border-rose-ink/30 bg-white text-rose-ink hover:bg-rose-wash`));
    // The shared full-width form button.
    expect(rendered(primaryButton)).toEqual(rendered(
      "w-full rounded-lg bg-teal px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-teal-deep disabled:cursor-not-allowed disabled:opacity-60"));
  });

  it("supports a small size and extra classes", () => {
    expect(buttonClasses({ size: "sm" })).toContain("px-3 py-1.5 text-xs");
    expect(html(el(Button, { type: "button", className: "w-full" }, "Go"))).toMatch(/class="[^"]* w-full"/);
  });

  it("disables while disabled or loading, and marks loading as busy", () => {
    expect(html(el(Button, { type: "button", disabled: true }, "Save"))).toContain('disabled=""');
    const loading = html(el(Button, { type: "button", loading: true }, "Saving…"));
    expect(loading).toContain('disabled=""');
    expect(loading).toContain('aria-busy="true"');
    expect(loading).toContain(">Saving…<");
    const idle = html(el(Button, { type: "button" }, "Save"));
    expect(idle).not.toContain('disabled=""');
    expect(idle).not.toContain("aria-busy");
  });

  it("passes through accessible names and other attributes", () => {
    const markup = html(el(Button, { type: "button", "aria-label": "Copy firm code" }, "Copy"));
    expect(markup).toContain('aria-label="Copy firm code"');
  });
});

// --- Badge, Card, FormMessage, Field ---------------------------------------------------------------

describe("Badge and Card", () => {
  it("shows the label with the tone's colours", () => {
    const markup = html(el(Badge, { tone: "warning" }, "Review unverified"));
    expect(markup).toContain(">Review unverified</span>");
    expect(markup).toContain(TONE_CLASSES.warning);
    expect(markup).toContain("px-2.5 py-0.5");
    expect(html(el(Badge, { tone: "success", size: "md" }, "Received"))).toContain("px-3 py-1");
  });

  it("renders a card surface without padding of its own", () => {
    const markup = html(el(Card, { as: "section", className: "p-6", "aria-labelledby": "x" }, "Body"));
    expect(markup).toBe('<section aria-labelledby="x" class="rounded-2xl border border-line bg-surface p-6">Body</section>');
    expect(rendered("bg-surface")).toEqual(rendered("bg-white"));
  });
});

describe("FormMessage", () => {
  it("announces errors as alerts and other messages as status, in the same colours as before", () => {
    const error = html(el(FormMessage, { tone: "error" }, "Invalid email or password."));
    expect(error).toMatch(/^<p role="alert" class="[^"]*">Invalid email or password\.<\/p>$/);
    expect(html(el(FormMessage, { tone: "info" }, "Saved."))).toContain('role="status"');
    expect(html(el(FormMessage, { tone: "success" }, "Saved."))).toContain('role="status"');
    const cls = (tone: "error" | "info" | "success") =>
      /class="([^"]+)"/.exec(html(el(FormMessage, { tone }, "x")))![1];
    expect(rendered(cls("error"))).toEqual(rendered("rounded-lg px-3 py-2 text-sm bg-rose-wash text-rose-ink"));
    expect(rendered(cls("info"))).toEqual(rendered("rounded-lg px-3 py-2 text-sm bg-teal-wash text-teal-deep"));
  });
});

describe("Field", () => {
  it("labels the input, marks optional fields and links the hint", () => {
    const markup = html(createElement(Field, { id: "email", label: "Email", type: "email", required: true, hint: "Work address." }));
    expect(markup).toContain('<label for="email"');
    expect(markup).toMatch(/<input id="email" type="email" [^>]*name="email"\/>/);
    expect(markup).toContain('required=""');
    expect(markup).toContain('aria-describedby="email-hint"');
    expect(markup).toContain('<p id="email-hint"');
    expect(markup).not.toContain("(optional)");
    expect(markup).not.toContain("aria-invalid");
    expect(html(createElement(Field, { id: "phone", label: "Phone" }))).toContain("(optional)");
  });

  it("associates an error with the input and marks it invalid", () => {
    const markup = html(createElement(Field, { id: "pw", label: "Password", required: true, hint: "12+ characters.",
      error: "Too short." }));
    expect(markup).toContain('aria-describedby="pw-hint pw-error"');
    expect(markup).toContain('aria-invalid="true"');
    expect(markup).toContain('<p id="pw-error" class="mt-1 text-xs text-danger-fg">Too short.</p>');
  });

  it("is the same component the CA and client forms import", async () => {
    const legacy = await import("@/components/ca/Field");
    expect(legacy.Field).toBe(Field);
    expect(legacy.FormMessage).toBe(FormMessage);
  });
});

// --- Tabs -----------------------------------------------------------------------------------------

describe("Tabs", () => {
  const items = [{ key: "overview", label: "Overview" }, { key: "transactions", label: "Transactions" },
    { key: "documents", label: "Documents" }];

  it("renders an ARIA tab list with one selected, focusable tab", () => {
    const markup = html(createElement(Tabs<string>, { label: "Case sections", idPrefix: "case", items, value: "transactions",
      onChange: () => {} }));
    expect(markup).toContain('role="tablist" aria-label="Case sections"');
    expect(markup.match(/role="tab"/g)).toHaveLength(3);
    expect(markup).toMatch(/id="case-tab-transactions" aria-selected="true" aria-controls="case-panel-transactions" tabindex="0"/);
    expect(markup).toMatch(/id="case-tab-overview" aria-selected="false" tabindex="-1"/);
    expect(markup).not.toContain('aria-controls="case-panel-overview"');
    expect(markup.match(/type="button"/g)).toHaveLength(3);
  });

  it("labels its panel by the selected tab", () => {
    const markup = html(el(TabPanel, { idPrefix: "case", tabKey: "transactions" }, "Rows"));
    expect(markup).toBe('<div role="tabpanel" id="case-panel-transactions" aria-labelledby="case-tab-transactions" tabindex="0">Rows</div>');
  });

  it("moves with arrow keys (wrapping), Home and End, and ignores other keys", () => {
    expect(tabKeyTarget("ArrowRight", 0, 3)).toBe(1);
    expect(tabKeyTarget("ArrowRight", 2, 3)).toBe(0);
    expect(tabKeyTarget("ArrowLeft", 0, 3)).toBe(2);
    expect(tabKeyTarget("Home", 2, 3)).toBe(0);
    expect(tabKeyTarget("End", 0, 3)).toBe(2);
    expect(tabKeyTarget("Enter", 1, 3)).toBeNull();
    expect(tabKeyTarget("a", 1, 3)).toBeNull();
  });
});
