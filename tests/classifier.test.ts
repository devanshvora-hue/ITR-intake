// The TypeScript classifier must give the Python classifier's answers, except
// for the documented, specification-driven changes below.
// tests/fixtures/classifier-golden.json was recorded from backend/itr_intake by
// running the Python classifier tests and the bundled synthetic statements
// (synthetic data only). Every category, rule, confidence, review status,
// flag, mode, counterparty and reason must match unless `deliberateChange`
// allows the difference.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { classifyStatement, classifyTransaction, type ClientProfile } from "@/lib/statement/classifier";
import { matchName, similarity } from "@/lib/statement/text";
import type { Transaction } from "@/lib/statement/validation";

type GoldenTxn = { rowNumber: number; date: string; narration: string; debit: string | null; credit: string | null; balance: string | null };
type GoldenOut = { rowNumber: number; category: string; confidence: string; reviewStatus: string; matchedRule: string;
  flags: string[]; reason: string; mode: string; counterparty: string | null } | null;
type GoldenCase = { single?: boolean; profile: ClientProfile; transactions: GoldenTxn[]; expected: GoldenOut[] };

type Got = { category: string; reviewStatus: string; matchedRule: string; counterparty?: string | null };

/**
 * Differences from the recorded Python answers that the specification asks for:
 * - rows Python left unclassified may now get a category from new identifiable-payee rules (source.*) or, for
 *   UPI debits only, a personal-expense category by payment mode (mode.*), never an income category by mode;
 * - mutual fund purchases are auto-classified and tax-saving instruments need confirmation instead of review;
 * - an identifiable merchant (priority rule 4) now wins over a client instruction (rule 5) with the same category.
 */
function deliberateChange(expected: NonNullable<GoldenOut>, got: Got): boolean {
  if (expected.matchedRule === "uncertain" && got.matchedRule !== "uncertain") {
    return got.matchedRule.startsWith("source.") || (got.matchedRule.startsWith("mode.") && got.category === "Personal Expenses");
  }
  if (["source.investment_purchase", "source.tax_saving_instrument"].includes(expected.matchedRule)) {
    return got.matchedRule === expected.matchedRule && got.category === expected.category;
  }
  return expected.matchedRule === "client_rule" && got.matchedRule === "source.known_merchant" && got.category === expected.category;
}

const golden = JSON.parse(readFileSync(new URL("./fixtures/classifier-golden.json", import.meta.url), "utf8")) as { cases: GoldenCase[] };

// Python prints an amount with the decimals its input had ("₹15,000"); the port
// always prints two ("₹15,000.00", as real statement amounts have). The fixture
// stores paise, so compare explanation texts with amounts cut to whole rupees.
const rupees = (text: string) => text.replace(/₹([\d,]+)(?:\.\d+)?/g, "₹$1");

function toTxn(t: GoldenTxn): Transaction {
  return { rowNumber: t.rowNumber, date: t.date, narration: t.narration, debit: BigInt(t.debit ?? "0"),
    credit: BigInt(t.credit ?? "0"), balance: t.balance === null ? null : BigInt(t.balance), rawDebit: null, rawCredit: null,
    rawBalance: null };
}

describe("classifier parity with the Python implementation", () => {
  it("has a substantial recorded corpus", () => {
    expect(golden.cases.length).toBeGreaterThan(100);
  });

  golden.cases.forEach((c, i) => {
    const label = `${c.single ? "transaction" : "statement"} #${i} (${c.transactions.length} rows)`;
    it(label, () => {
      const txns = c.transactions.map(toTxn);
      if (c.single) {
        const got = classifyTransaction(txns[0], c.profile);
        const want = c.expected[0];
        if (want === null) expect(got).toBeNull();
        else expect(got && { ...got, reason: rupees(got.reason) }).toEqual({ category: want.category, confidence: want.confidence,
          reviewStatus: want.reviewStatus, matchedRule: want.matchedRule, reason: rupees(want.reason) });
        return;
      }
      const got = classifyStatement(txns, c.profile).map((t, i) => {
        const e = c.expected[i];
        const row = {
          rowNumber: t.rowNumber, category: t.category, confidence: t.confidence, reviewStatus: t.reviewStatus,
          matchedRule: t.matchedRule, flags: t.flags, reason: rupees(t.classificationReason), mode: t.mode,
          // A counterparty Python did not recognise may now be read from short layouts.
          counterparty: e && e.counterparty === null ? null : t.counterparty,
        };
        return e && deliberateChange(e, row) ? { ...e, reason: rupees(e.reason) } : row;
      });
      expect(got).toEqual(c.expected.map((e) => e && { ...e, reason: rupees(e.reason) }));
    });
  });
});

describe("name matching helpers", () => {
  it("computes difflib's similarity ratio", () => {
    // Values from Python: difflib.SequenceMatcher(None, a, b).ratio()
    expect(similarity("MEHATA", "MEHTA")).toBeCloseTo(0.9090909, 6);
    expect(similarity("MEHRA", "MEHTA")).toBeCloseTo(0.8, 6);
    expect(similarity("ABCD", "XYZ")).toBe(0);
  });

  it("grades name matches", () => {
    expect(matchName("Arjun Mehta", "NEFT ARJUN MEHTA SBI")?.strength).toBe("exact");
    expect(matchName("Arjun Mehta", "IMPS A MEHTA")?.strength).toBe("partial");
    expect(matchName("Arjun Mehta", "UPI ARJUN MEHATA")?.strength).toBe("variant");
    expect(matchName("Arjun Mehta", "UPI ARJUN SHARMA")).toBeNull();
  });
});
