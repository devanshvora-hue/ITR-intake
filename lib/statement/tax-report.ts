// Reading an AIS / TIS / Form 26AS report for reconciliation. Pure functions:
// no files, network or database.
//
// Supported: CSV (UTF-8) and Excel .xlsx files whose table has a recognisable
// header (an amount column and a description, category or section column), as
// produced when the report data is exported or saved from a spreadsheet.
// Refused with a fixed reason, never accepted silently: PDF (portal PDFs are
// password-protected and their layouts are not read in this version), JSON,
// legacy .xls, and anything else. A row whose amount cannot be read is skipped
// and reported by row number and code; nothing is guessed or filled in.

import ExcelJS from "exceljs";
import { CsvError, readCsv } from "./import";
import { parseAmount, parseDate } from "./validation";

export const TAX_REPORT_KINDS = ["ais", "tis", "form26as"] as const;
export type TaxReportKind = (typeof TAX_REPORT_KINDS)[number];
export const TAX_RECORD_CATEGORIES = ["salary", "interest_savings", "interest_deposit", "interest_other", "dividend",
  "securities_sale", "rent", "tax_refund", "cash_deposit", "other"] as const;
export type TaxRecordCategory = (typeof TAX_RECORD_CATEGORIES)[number];

export type TaxRecord = {
  sourceRow: number; category: TaxRecordCategory; description: string; party: string | null; date: string | null;
  amount: bigint; taxDeducted: bigint | null; raw: string[];
};
export type TaxReportWarning = { row: number; code: string };
export type ParsedTaxReport =
  | { ok: true; fileType: "csv" | "xlsx"; records: TaxRecord[]; warnings: TaxReportWarning[] }
  | { ok: false; code: string };

const MAX_ROWS = 5_000;
const HEADER_SCAN = 25;

const SYNONYMS: Record<string, string[]> = {
  description: ["information description", "description", "nature of payment", "nature of transaction", "transaction type",
    "income type", "particulars", "information code description"],
  category: ["information category", "category", "type of information"],
  section: ["section", "section code", "section/sft code", "sft code"],
  party: ["information source", "source", "name of deductor", "deductor name", "deductor", "name of deductor/collector",
    "deductor / collector name", "name of payer", "payer", "reported by", "name of the reporting entity"],
  date: ["date", "transaction date", "date of payment/credit", "date of payment / credit", "date of payment",
    "date of credit", "date of booking", "transaction date / date of credit"],
  amount: ["amount", "amount paid/credited", "amount paid / credited", "amount paid/credited (rs.)", "reported value",
    "value", "total amount", "amount (rs.)", "amount (₹)", "income amount", "gross amount", "transaction amount"],
  tax: ["tds", "tds deducted", "tax deducted", "tds/tcs", "tax deducted/collected", "tds deposited", "tcs collected",
    "tax deducted (rs.)", "tds amount", "tax deducted/collected (rs.)"],
};

const norm = (cell: string) => cell.replace(/^﻿/, "").trim().toLowerCase().replace(/\s+/g, " ").replace(/[:.]+$/, "");

function matchHeader(cells: string[]): Record<string, number> | null {
  const names = cells.map(norm);
  const found: Record<string, number> = {};
  for (const [key, synonyms] of Object.entries(SYNONYMS)) {
    const index = names.findIndex((n) => synonyms.includes(n));
    if (index >= 0) found[key] = index;
  }
  return "amount" in found && ("description" in found || "category" in found || "section" in found) ? found : null;
}

/** The reporting category of a record from its description, category and section texts. */
export function classifyTaxRecord(text: string): TaxRecordCategory {
  const t = text.toUpperCase();
  if (/\bSALARY\b|\b192\b|\bSECTION 192\b/.test(t)) return "salary";
  if (/\bREFUND\b/.test(t)) return "tax_refund";
  if (/\bDIVIDEND\b|\b194\b(?![A-Z0-9-])/.test(t)) return "dividend";
  if (/\bRENT\b|\b194-?I(B)?\b/.test(t)) return "rent";
  if (/\bCASH DEPOSIT/.test(t)) return "cash_deposit";
  if (/\bSALE OF (SECURITIES|UNITS|SHARES)\b|\bMUTUAL FUND\b|\bREDEMPTION\b|\bPURCHASE OF SECURITIES\b|\bSALE OF\b/.test(t)) {
    return "securities_sale";
  }
  if (/\bINTEREST\b|\b194A\b/.test(t)) {
    if (/\bSAVING/.test(t)) return "interest_savings";
    if (/\b(DEPOSIT|TIME DEPOSIT|TERM DEPOSIT|FIXED|RECURRING|FD|RD)\b|\b194A\b/.test(t)) return "interest_deposit";
    return "interest_other";
  }
  return "other";
}

const clean = (text: string, max: number) => text.replace(/\s+/g, " ").trim().slice(0, max);

function readRows(rows: string[][]): ParsedTaxReport {
  let headerIndex = -1;
  let cols: Record<string, number> | null = null;
  for (let i = 0; i < Math.min(rows.length, HEADER_SCAN); i++) {
    cols = matchHeader(rows[i]);
    if (cols) {
      headerIndex = i;
      break;
    }
  }
  if (!cols) return { ok: false, code: "missing_required_columns" };
  if (rows.length - headerIndex - 1 > MAX_ROWS) return { ok: false, code: "too_many_rows" };
  const records: TaxRecord[] = [];
  const warnings: TaxReportWarning[] = [];
  const c = cols;
  for (let i = headerIndex + 1; i < rows.length; i++) {
    const row = rows[i];
    const cell = (key: string) => (c[key] !== undefined ? (row[c[key]] ?? "").trim() : "");
    if (!row.some((v) => v.trim())) continue;
    const sourceRow = i + 1;
    const description = clean([cell("description"), cell("category")].filter(Boolean).join(" – ") || cell("section"), 300);
    if (/^(total|grand total|sub ?total)\b/i.test(description) || /^(total|grand total)\b/i.test(row[0]?.trim() ?? "")) continue;
    const amountText = cell("amount").replace(/^(₹|rs\.?|inr)\s*/i, "");
    if (!amountText) {
      warnings.push({ row: sourceRow, code: "missing_amount" });
      continue;
    }
    let amount: bigint;
    try {
      amount = parseAmount(amountText);
    } catch {
      warnings.push({ row: sourceRow, code: "invalid_amount" });
      continue;
    }
    if (!description) {
      warnings.push({ row: sourceRow, code: "missing_description" });
      continue;
    }
    let taxDeducted: bigint | null = null;
    const taxText = cell("tax").replace(/^(₹|rs\.?|inr)\s*/i, "");
    if (taxText) {
      try {
        taxDeducted = parseAmount(taxText);
      } catch {
        warnings.push({ row: sourceRow, code: "invalid_tax_amount" });
      }
    }
    let date: string | null = null;
    const dateText = cell("date");
    if (dateText) {
      try {
        date = parseDate(dateText);
      } catch {
        warnings.push({ row: sourceRow, code: "invalid_date" });
      }
    }
    records.push({
      sourceRow, category: classifyTaxRecord(`${description} ${cell("section")}`), description,
      party: cell("party") ? clean(cell("party"), 200) : null, date, amount, taxDeducted, raw: row.map((v) => v.slice(0, 500)),
    });
  }
  if (!records.length) return { ok: false, code: "no_records" };
  return { ok: true, fileType: "csv", records, warnings };
}

const startsWith = (data: Uint8Array, text: string) => [...text].every((ch, i) => data[i] === ch.charCodeAt(0));

function cellText(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) {
    const iso = value.toISOString();
    return `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
  }
  if (typeof value === "number") return Number.isInteger(value) ? String(value) : value.toFixed(2);
  if (typeof value === "object") {
    if ("result" in value && value.result !== undefined) return cellText(value.result as ExcelJS.CellValue);
    if ("richText" in value) return value.richText.map((r) => r.text).join("");
    if ("text" in value) return String(value.text);
    return "";
  }
  return String(value);
}

/** Read an uploaded report. The file name's extension and the content must agree. */
export async function parseTaxReport(data: Uint8Array, filename: string): Promise<ParsedTaxReport> {
  const ext = (/\.([A-Za-z0-9]{1,5})\s*$/.exec(filename)?.[1] ?? "").toLowerCase();
  if (!data.length) return { ok: false, code: "empty_file" };
  if (startsWith(data, "%PDF-")) return { ok: false, code: "pdf_not_supported" };
  if (ext === "json" || /^\s*[[{]/.test(new TextDecoder("latin1").decode(data.subarray(0, 64)))) {
    return { ok: false, code: "json_not_supported" };
  }
  if (ext === "xls" || startsWith(data, "\xD0\xCF\x11\xE0")) return { ok: false, code: "xls_not_supported" };
  if (ext === "xlsx") {
    if (!startsWith(data, "PK\x03\x04")) return { ok: false, code: "type_mismatch" };
    const wb = new ExcelJS.Workbook();
    try {
      await wb.xlsx.load(data.slice().buffer as ArrayBuffer);
    } catch {
      return { ok: false, code: "unreadable_file" };
    }
    for (const ws of wb.worksheets) {
      const rows: string[][] = [];
      ws.eachRow({ includeEmpty: true }, (row) => {
        const values = row.values as ExcelJS.CellValue[];
        rows.push(values.slice(1).map(cellText));
      });
      const parsed = readRows(rows);
      if (parsed.ok) return { ...parsed, fileType: "xlsx" };
      if (parsed.code !== "missing_required_columns") return parsed;
    }
    return { ok: false, code: "missing_required_columns" };
  }
  if (ext !== "csv" && ext !== "txt") return { ok: false, code: "unsupported_file_type" };
  if (data.includes(0) || startsWith(data, "PK")) return { ok: false, code: "type_mismatch" };
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(data);
  } catch {
    return { ok: false, code: "unsupported_encoding" };
  }
  const delimiter = text.split(/\r?\n/, 1)[0];
  let rows: string[][];
  try {
    // Form 26AS text exports use "^" between fields; plain CSV uses commas.
    rows = delimiter.includes("^") && !delimiter.includes(",")
      ? text.split(/\r?\n/).map((line) => line.split("^"))
      : readCsv(text);
  } catch (error) {
    if (error instanceof CsvError) return { ok: false, code: "malformed_csv" };
    throw error;
  }
  return readRows(rows);
}
