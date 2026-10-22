// PDF page text for the statement parser, using pdf.js (via unpdf) in
// process; no external program. Each page is rebuilt as lines of fixed-width
// character columns from the text positions, the same shape as xpdf
// `pdftotext -simple` output that the parser's column bands expect. Only the
// relative positions on one page matter (a header is trusted only on its own
// page). Limits: page count, total text size, a timeout and at most two
// extractions at a time.

import { getDocumentProxy } from "unpdf";

export const MAX_PDF_PAGES = 100;
const MAX_TEXT_CHARS = 8 * 1024 * 1024;
const TIMEOUT_MS = 30_000;
const MAX_CONCURRENT = 2;
const WAIT_MS = 10_000;
const COPY_PERMISSION = 0x10; // pdf.js PermissionFlag.COPY

export class ExtractionFailed extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "ExtractionFailed";
  }
}

/** Every extraction slot stayed busy; the client should retry shortly. */
export class ExtractorBusy extends Error {
  constructor() {
    super("busy");
    this.name = "ExtractorBusy";
  }
}

let active = 0;
const waiting: (() => void)[] = [];

async function acquire(): Promise<void> {
  if (active < MAX_CONCURRENT) {
    active++;
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      const i = waiting.indexOf(go);
      if (i >= 0) waiting.splice(i, 1);
      reject(new ExtractorBusy());
    }, WAIT_MS);
    const go = () => {
      clearTimeout(timer);
      active++;
      resolve();
    };
    waiting.push(go);
  });
}

function release(): void {
  active--;
  waiting.shift()?.();
}

type Item = { str: string; x: number; y: number; size: number; charWidth: number | null };

/**
 * Where one text item landed: `col` is its first character's index in the
 * laid-out line; `x0`/`x1` are its true left and right edges in the same
 * character units. They differ when a preceding item was wider in characters
 * than on the page and pushed this one right.
 */
export type Cell = { col: number; x0: number; x1: number; str: string };
export type LaidOutLine = { text: string; cells: Cell[] };
export type PdfPage = { text: string; lines: LaidOutLine[] };

/** Lay one page's text items out as fixed-width lines, keeping each item's true position. */
export function layoutPageGeometry(items: Item[]): PdfPage {
  const widths = items.map((i) => i.charWidth).filter((w): w is number => w !== null && w > 0).sort((a, b) => a - b);
  const sizes = items.map((i) => i.size).sort((a, b) => a - b);
  const cw = widths[Math.floor(widths.length / 2)] ?? (sizes[Math.floor(sizes.length / 2)] ?? 10) * 0.6;
  const sorted = [...items].sort((a, b) => b.y - a.y || a.x - b.x);
  const groups: Item[][] = [];
  for (const item of sorted) {
    const line = groups[groups.length - 1];
    if (line && Math.abs(line[0].y - item.y) <= Math.max(1, Math.min(line[0].size, item.size) * 0.4)) line.push(item);
    else groups.push([item]);
  }
  const lines = groups.map((group) => {
    let out = "";
    const cells: Cell[] = [];
    for (const item of group.sort((a, b) => a.x - b.x)) {
      let col = Math.max(0, Math.round(item.x / cw));
      if (col < out.length) col = out.length + (out.length && !out.endsWith(" ") ? 1 : 0);
      out = out.padEnd(col, " ") + item.str;
      const length = [...item.str].length;
      const width = item.charWidth !== null ? item.charWidth * length : length * cw;
      cells.push({ col, x0: item.x / cw, x1: (item.x + width) / cw, str: item.str });
    }
    return { text: out.trimEnd(), cells };
  });
  return { text: lines.map((l) => l.text).join("\n"), lines };
}

/** Lay one page's text items out as fixed-width lines. */
export function layoutPage(items: Item[]): string {
  return layoutPageGeometry(items).text;
}

async function extract(data: Uint8Array): Promise<PdfPage[]> {
  let pdf;
  try {
    pdf = await getDocumentProxy(new Uint8Array(data), { disableFontFace: true });
  } catch (error) {
    const name = error && typeof error === "object" && "name" in error ? String(error.name) : "";
    throw new ExtractionFailed(name === "PasswordException" ? "pdf_password_protected" : "pdf_unreadable");
  }
  try {
    if (pdf.numPages > MAX_PDF_PAGES) throw new ExtractionFailed("too_many_pages");
    if (new TextDecoder("latin1").decode(data).includes("/Encrypt")) {
      const permissions = await pdf.getPermissions();
      if (permissions && ![...permissions].includes(COPY_PERMISSION)) throw new ExtractionFailed("pdf_copy_restricted");
    }
    const pages: PdfPage[] = [];
    let total = 0;
    for (let n = 1; n <= pdf.numPages; n++) {
      const page = await pdf.getPage(n);
      const content = await page.getTextContent();
      const items: Item[] = [];
      for (const raw of content.items) {
        if (!("str" in raw) || !raw.str) continue;
        const [, , c, d, e, f] = raw.transform as number[];
        const size = Math.hypot(c, d) || raw.height || 10;
        const length = [...raw.str].length;
        items.push({ str: raw.str, x: e, y: f, size, charWidth: raw.width > 0 && length ? raw.width / length : null });
      }
      const laidOut = layoutPageGeometry(items);
      total += laidOut.text.length;
      if (total > MAX_TEXT_CHARS) throw new ExtractionFailed("pdf_text_too_large");
      pages.push(laidOut);
      page.cleanup();
    }
    return pages;
  } catch (error) {
    if (error instanceof ExtractionFailed) throw error;
    console.error("pdf text extraction failed", error instanceof Error ? error.name : typeof error);
    throw new ExtractionFailed("pdf_unreadable");
  } finally {
    const closable = pdf as unknown as { destroy?: () => Promise<void>; cleanup?: () => Promise<void> | void };
    await Promise.resolve((closable.destroy ?? closable.cleanup)?.call(pdf)).catch(() => undefined);
  }
}

/** Laid-out pages of a PDF (text plus true item positions). Raises ExtractionFailed (fixed codes) or ExtractorBusy. */
export async function extractPdfPages(data: Uint8Array): Promise<PdfPage[]> {
  await acquire();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      extract(data),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new ExtractionFailed("pdf_timeout")), TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    release();
  }
}

/** Image XObjects are visible in the raw file (they can not live in object streams). */
export function containsImages(data: Uint8Array): boolean {
  return /\/Subtype\s*\/Image/.test(new TextDecoder("latin1").decode(data));
}
