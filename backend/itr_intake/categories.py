"""The 28 canonical transaction categories (see docs/classification-spec.md)."""

from enum import StrEnum


class Category(StrEnum):
    SALARY_PENSION = "Salary / Pension"
    BUSINESS_RECEIPTS = "Business / Professional Receipts"
    RENT_RECEIVED = "Rent Received"
    INTEREST_SAVINGS = "Interest – Savings Bank"
    INTEREST_DEPOSITS = "Interest – FD / RD / Others"
    DIVIDEND = "Dividend"
    INVESTMENT_REDEMPTION = "Sale / Redemption of Investments"
    INCOME_TAX_REFUND = "Income Tax Refund"
    LOANS_RECEIVED = "Loans Received / Repayment of Loans Given"
    GIFTS_NON_RELATIVES = "Gifts / Receipts from Non-relatives"
    INVESTMENTS_TAX_SAVING = "Investments – Tax-saving"
    INVESTMENTS_OTHERS = "Investments – Others"
    INSURANCE_HEALTH = "Insurance – Health"
    LOAN_EMI = "Loan EMI / Repayment"
    LOANS_GIVEN = "Loans Given"
    TAX_PAYMENTS = "Tax Payments"
    DONATIONS = "Donations"
    CREDIT_CARD_PAYMENTS = "Credit Card Payments"
    RENT_PAID = "Rent Paid"
    BUSINESS_EXPENSES = "Business / Professional Expenses"
    SELF_TRANSFER = "Self Transfer"
    FAMILY_TRANSFER = "Family Transfer"
    CASH_WITHDRAWAL = "Cash Withdrawal"
    CASH_DEPOSIT = "Cash Deposit"
    PERSONAL_EXPENSES = "Personal Expenses"
    BANK_CHARGES = "Bank Charges"
    REVERSALS_REFUNDS = "Reversals / Refunds"
    OTHERS_NEEDS_REVIEW = "Others – Needs Review"


CANONICAL_CATEGORIES: tuple[str, ...] = tuple(c.value for c in Category)
