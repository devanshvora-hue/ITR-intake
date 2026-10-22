// The TypeScript classifier must give exactly the Python classifier's answers.
// tests/fixtures/classifier-golden.json was recorded from backend/itr_intake by
// running the Python classifier tests and the bundled synthetic statements
// (synthetic data only). Every category, rule, confidence, review status,
// flag, mode, counterparty and reason must match.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { classifyStatement, classifyTransaction, type ClientProfile } from "@/lib/statement/classifier";
import { matchName, similarity } from "@/lib/statement/text";
import type { Transaction } from "@/lib/statement/validation";

type GoldenTxn = { rowNumber: number; date: string; narration: string; debit: string | null; credit: string | null; balance: string | null };
type GoldenOut = { rowNumber: number; category: string; confidence: string; reviewStatus: string; matchedRule: string;
  flags: string[]; reason: string; mode: string; counterparty: string | null } | null;
type GoldenCase = { single?: boolean; profile: ClientProfile; transactions: GoldenTxn[]; expected: GoldenOut[] };

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
      const got = classifyStatement(txns, c.profile).map((t) => ({
        rowNumber: t.rowNumber, category: t.category, confidence: t.confidence, reviewStatus: t.reviewStatus,
        matchedRule: t.matchedRule, flags: t.flags, reason: rupees(t.classificationReason), mode: t.mode, counterparty: t.counterparty,
      }));
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
