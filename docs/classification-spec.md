# Transaction classification specification

Source: the project document *Prompt - Bank Statement to ITR Summary*, as
summarised by the project owner. Settings marked **(project setting)** are not
defined in that document; they are explicit, configurable choices made for
this prototype.

## Canonical categories (28)

Names must be used exactly as written.

1. Salary / Pension
2. Business / Professional Receipts
3. Rent Received
4. Interest – Savings Bank
5. Interest – FD / RD / Others
6. Dividend
7. Sale / Redemption of Investments
8. Income Tax Refund
9. Loans Received / Repayment of Loans Given
10. Gifts / Receipts from Non-relatives
11. Investments – Tax-saving
12. Investments – Others
13. Insurance – Health
14. Loan EMI / Repayment
15. Loans Given
16. Tax Payments
17. Donations
18. Credit Card Payments
19. Rent Paid
20. Business / Professional Expenses
21. Self Transfer
22. Family Transfer
23. Cash Withdrawal
24. Cash Deposit
25. Personal Expenses
26. Bank Charges
27. Reversals / Refunds
28. Others – Needs Review

## Classification priority

Rules are applied in this order; the first rule that matches wins.

1. **Self Transfer** – match the client's own name, account number, UPI ID or
   linked mobile number. If the client's name appears against an unlisted
   bank, classify as Self Transfer but flag for confirmation.
2. **Family Transfer** – match listed family members, allowing for spelling
   variations and initials.
3. **Bank-generated entries** – interest, bank charges, GST on charges, bank
   TDS and refunds, using the appropriate specific category.
4. **Specific identifiable entries** – employers, tax department, insurers,
   mutual fund providers, brokers, loan accounts, NPS/PPF and similar sources.
5. **Client-specific instructions** – applied only after rules 1–4.
6. **Recurring credits** of similar amount and timing from the same source.
7. **When uncertain** – use exactly `Others – Needs Review`, record the
   reason, and do not guess.

## Matching safeguards (project rules)

These refine *how* rules 1–4 match; the categories and priority order above
are unchanged.

**Name strength (rules 1 and 2).** Each name match is graded:

| Strength | Example (family member Priya Mehta) | Result |
|---|---|---|
| Exact – every part in full, adjacent, in order | `PRIYA MEHTA` | Classified by the priority rules (family: auto; client: auto only with a listed bank) |
| Partial – initials, or parts not adjacent / in order | `P MEHTA`, `MEHTA PRIYA` | Classified, but always **Needs confirmation** |
| Variant – spelling variation (similarity ≥ 0.85) or truncation keeping ≥ 4 letters and ≥ 60% of the part | `PRIYA MEHATA`, `PRIYYA MEHTA`, `PRIY MEHTA` | Classified, but always **Needs confirmation** |
| Weak – short fragment, loose resemblance, or the full part with extra letters added (usually a different name) | `PRI MEHTA`, `PRIYA MEHRA`, `PRIYAM MEHTA`, `PRIYANKA MEHTA`, `PRIYA MEHTANI` | **Not** used to classify; stays in `Others – Needs Review` with the possible match noted in the reason |

A surname alone, or a surname given only as an initial, never matches. When
an initial could be the client or a family member, or more than one family
member, the transaction is flagged for confirmation and the candidates are
named. An exact family-member match takes precedence over a partial match on
the client's name.

**Bank-generated context (rule 3).** Bank charges, bank TDS and bank interest
require a known bank-entry pattern (for example `SMS ALERT CHRG`,
`MIN BAL CHRG`, `ECS RTN CHRG`, `GST ON SMS CHRG`, `TDS ON FD INT`). The words
CHARGES, CHG or FEE on their own are not enough, and transfers to or from a
named party (UPI, `NEFT DR-…`, `IMPS P2A`, `ACH D-…`) are never treated as
bank-generated.

**Short abbreviations (rule 4).** SAL, MF, SIP, DIV, EMI, ITD, SSY and similar
tokens count only with supporting context (for example `SAL CR`,
`BSE STAR MF`, `NACH DR … SIP`, `FINAL DIV`, `LOAN EMI`, `ITD … REFUND`).

## Data-handling requirements

- Preserve exact narration and original monetary amounts.
- Use `Decimal` for monetary calculations.
- Reconcile: opening balance + total credits − total debits = closing balance.
- Report extracted transaction counts and reconciliation differences; never
  silently change amounts.
- Keep uncertain classifications reviewable.
- Do not infer taxability or deductibility solely from narration.
- Use synthetic data only.

## Thresholds and settings

| Setting | Value | Origin |
|---|---|---|
| Large-credit review threshold | ₹50,000 | Example in the source document; configurable. Not a legal threshold. |
| Reconciliation tolerance | ₹0.01 | **(project setting)** |
| Recurring credit: minimum occurrences | 3 | **(project setting)** |
| Recurring credit: amount tolerance | ±10% of the group median | **(project setting)** |
| Recurring credit: interval between credits | 25–35 days | **(project setting)** |
| Name spelling-variation similarity | 0.85 (0.70–0.85 is reported as weak only) | **(project setting)** |
| Recurring credit: category assigned | none (stays `Others – Needs Review`, flagged as recurring) | **(project setting)** – the source does not say which category a recurring credit belongs to, so the prototype records the pattern for the CA instead of guessing. |

All of these live in `backend/itr_intake/config.py` (`AnalysisConfig`).
