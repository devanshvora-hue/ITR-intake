// A tiny PDF writer for synthetic test statements (port of
// backend/tests/synthetic_pdf.py): real PDF files with Courier text at chosen
// positions, optional image-only pages and compressed streams. No real data.

import { deflateSync } from "node:zlib";

export const PAGE_W = 842;
export const PAGE_H = 595; // A4 landscape, points
export const COL_DATE = 40, COL_NARR = 130, COL_DEBIT_R = 560, COL_CREDIT_R = 660, COL_BAL_R = 790;
export const CHAR_W = 9 * 0.6; // Courier advance at 9 pt

const escape = (s: string) => s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");

export class Page {
  ops: string[] = [];
  text(x: number, y: number, s: string, size = 9): this {
    this.ops.push(`BT /F1 ${size} Tf ${x.toFixed(1)} ${y.toFixed(1)} Td (${escape(s)}) Tj ET`);
    return this;
  }
  image(x: number, y: number, w: number, h: number): this {
    this.ops.push(`q ${w.toFixed(1)} 0 0 ${h.toFixed(1)} ${x.toFixed(1)} ${y.toFixed(1)} cm /Im1 Do Q`);
    return this;
  }
}

export function buildPdf(pages: Page[], { compress = false } = {}): Uint8Array {
  const objects: Buffer[] = [];
  const add = (body: Buffer | string) => objects.push(Buffer.isBuffer(body) ? body : Buffer.from(body, "latin1"));
  add(""); // catalog placeholder
  add(""); // pages placeholder
  const font = (add("<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>"), objects.length);
  const pixels = Buffer.alloc(64, 128);
  const image = (add(Buffer.concat([Buffer.from(`<< /Type /XObject /Subtype /Image /Width 8 /Height 8 /ColorSpace /DeviceGray /BitsPerComponent 8 /Length ${pixels.length} >>\nstream\n`), pixels, Buffer.from("\nendstream")])), objects.length);
  const kids: number[] = [];
  for (const page of pages) {
    const content = Buffer.from(page.ops.join("\n"), "latin1");
    const data = compress ? deflateSync(content) : content;
    add(Buffer.concat([Buffer.from(`<< /Length ${data.length}${compress ? " /Filter /FlateDecode" : ""} >>\nstream\n`), data, Buffer.from("\nendstream")]));
    const stream = objects.length;
    add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << /Font << /F1 ${font} 0 R >> /XObject << /Im1 ${image} 0 R >> >> /Contents ${stream} 0 R >>`);
    kids.push(objects.length);
  }
  objects[0] = Buffer.from("<< /Type /Catalog /Pages 2 0 R >>");
  objects[1] = Buffer.from(`<< /Type /Pages /Count ${kids.length} /Kids [${kids.map((k) => `${k} 0 R`).join(" ")}] >>`);
  const parts: Buffer[] = [Buffer.from("%PDF-1.4\n%\xe2\xe3\xcf\xd3\n", "latin1")];
  let length = parts[0].length;
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(length);
    const chunk = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`), body, Buffer.from("\nendobj\n")]);
    parts.push(chunk);
    length += chunk.length;
  });
  const xref = length;
  parts.push(Buffer.from(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
    + offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")
    + `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`));
  return new Uint8Array(Buffer.concat(parts));
}

const right = (page: Page, edge: number, y: number, s: string) => page.text(edge - s.length * CHAR_W, y, s);

export type Row = [date: string, narration: string, debit: string, credit: string, balance: string];

export function statementPage(rows: Row[], opts: { header?: boolean; opening?: string; closing?: string; pageNo?: number;
  labels?: [string, string, string, string, string] } = {}): Page {
  const labels = opts.labels ?? ["Date", "Particulars", "Withdrawals", "Deposits", "Balance"];
  const page = new Page();
  let y = PAGE_H - 40;
  page.text(COL_DATE, y, "SYNTHETIC BANK - ACCOUNT STATEMENT", 11);
  y -= 16;
  page.text(COL_DATE, y, "Account holder: Synthetic Person   Account: XXXXXXXX0000");
  y -= 24;
  if (opts.header ?? true) {
    page.text(COL_DATE, y, labels[0]);
    page.text(COL_NARR, y, labels[1]);
    right(page, COL_DEBIT_R, y, labels[2]);
    right(page, COL_CREDIT_R, y, labels[3]);
    right(page, COL_BAL_R, y, labels[4]);
    y -= 16;
  }
  if (opts.opening !== undefined) {
    page.text(COL_NARR, y, "Opening Balance");
    right(page, COL_BAL_R, y, opts.opening);
    y -= 14;
  }
  for (const [date, narration, debit, credit, balance] of rows) {
    const lines = narration.split("\n");
    page.text(COL_DATE, y, date);
    page.text(COL_NARR, y, lines[0]);
    if (debit) right(page, COL_DEBIT_R, y, debit);
    if (credit) right(page, COL_CREDIT_R, y, credit);
    if (balance) right(page, COL_BAL_R, y, balance);
    for (const extra of lines.slice(1)) {
      y -= 12;
      page.text(COL_NARR, y, extra);
    }
    y -= 14;
  }
  if (opts.closing !== undefined) {
    page.text(COL_NARR, y, "Closing Balance");
    right(page, COL_BAL_R, y, opts.closing);
  }
  if (opts.pageNo !== undefined) page.text(COL_DATE, 30, `Page ${opts.pageNo}   This is a computer generated statement.`);
  return page;
}

export const imageOnlyPage = () => new Page().image(40, 40, 760, 500);

/** A header in real text, but the table is an image (not extractable). */
export function mixedPage(): Page {
  const page = new Page();
  page.text(COL_DATE, PAGE_H - 40, "SYNTHETIC BANK - ACCOUNT STATEMENT", 11);
  page.text(COL_DATE, PAGE_H - 56, "Account holder: Synthetic Person   Account: XXXXXXXX0000");
  page.text(COL_DATE, PAGE_H - 80, "Date");
  page.text(COL_NARR, PAGE_H - 80, "Particulars");
  right(page, COL_DEBIT_R, PAGE_H - 80, "Withdrawals");
  right(page, COL_CREDIT_R, PAGE_H - 80, "Deposits");
  right(page, COL_BAL_R, PAGE_H - 80, "Balance");
  return page.image(40, 60, 760, 440);
}
export const blankPage = () => new Page();

export const PAGE1: Row[] = [
  ["01/04/2025", "UPI/100001/SYNTHETIC GROCER", "1,250.00", "", "48,750.00"],
  ["03/04/2025", "NEFT SALARY SYNTHETIC CO\nREF SYN0001", "", "85,000.00", "1,33,750.00"],
  ["04/04/2025", "UPI/100002/SYNTHETIC CAFE", "250.00", "", "1,33,500.00"],
];
export const PAGE2: Row[] = [
  ["05/04/2025", "ATM WDL SYNTHETIC BRANCH", "5,000.00", "", "1,28,500.00"],
  ["07/04/2025", "INTEREST CREDIT SYNTHETIC", "", "12.35", "1,28,512.35"],
];

export function goodPdf(compress = false): Uint8Array {
  return buildPdf([statementPage(PAGE1, { opening: "50,000.00", pageNo: 1 }),
    statementPage(PAGE2, { closing: "1,28,512.35", pageNo: 2 })], { compress });
}
