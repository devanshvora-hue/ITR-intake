from itr_intake import CANONICAL_CATEGORIES, Category

EXPECTED = [
    "Salary / Pension",
    "Business / Professional Receipts",
    "Rent Received",
    "Interest – Savings Bank",
    "Interest – FD / RD / Others",
    "Dividend",
    "Sale / Redemption of Investments",
    "Income Tax Refund",
    "Loans Received / Repayment of Loans Given",
    "Gifts / Receipts from Non-relatives",
    "Investments – Tax-saving",
    "Investments – Others",
    "Insurance – Health",
    "Loan EMI / Repayment",
    "Loans Given",
    "Tax Payments",
    "Donations",
    "Credit Card Payments",
    "Rent Paid",
    "Business / Professional Expenses",
    "Self Transfer",
    "Family Transfer",
    "Cash Withdrawal",
    "Cash Deposit",
    "Personal Expenses",
    "Bank Charges",
    "Reversals / Refunds",
    "Others – Needs Review",
]


def test_all_28_categories_present_exactly_and_in_order():
    assert list(CANONICAL_CATEGORIES) == EXPECTED
    assert len(set(CANONICAL_CATEGORIES)) == 28


def test_needs_review_label_uses_en_dash():
    assert Category.OTHERS_NEEDS_REVIEW.value == "Others – Needs Review"
