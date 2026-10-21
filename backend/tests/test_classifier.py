from dataclasses import replace
from datetime import date
from decimal import Decimal

from conftest import make_txn

from itr_intake import (
    FLAG_LARGE_CREDIT,
    FLAG_RECURRING_CREDIT,
    AnalysisConfig,
    Category,
    ClientRule,
    Confidence,
    Direction,
    FamilyMember,
    ReviewStatus,
    classify_statement,
)


def classify_one(txn, profile, config=AnalysisConfig()):
    return classify_statement([txn], profile, config)[0]


# --- rule 1: self transfer ------------------------------------------------

def test_self_transfer_by_account_number(profile):
    t = classify_one(make_txn("NEFT DR-SBIN0001-TRANSFER-39876543210", debit="1000"), profile)
    assert t.category is Category.SELF_TRANSFER
    assert t.confidence is Confidence.HIGH and t.review_status is ReviewStatus.AUTO_CLASSIFIED
    assert t.matched_rule == "self.account_number"


def test_self_transfer_by_upi_id_and_mobile(profile):
    upi = classify_one(make_txn("UPI/CR/1/SOMEONE/EXMP/arjun.demo@okexample/x", credit="10"), profile)
    mobile = classify_one(make_txn("IMPS/P2A/1/919800000001/Transfer", debit="10"), profile)
    assert upi.category is Category.SELF_TRANSFER and upi.matched_rule == "self.upi_id"
    assert mobile.category is Category.SELF_TRANSFER and mobile.matched_rule == "self.mobile_number"


def test_client_name_with_listed_bank_is_self_transfer(profile):
    t = classify_one(make_txn("UPI/DR/1/ARJUN MEHTA/SBIN/arjunm@oksbi/Own", debit="500"), profile)
    assert t.category is Category.SELF_TRANSFER
    assert t.review_status is ReviewStatus.AUTO_CLASSIFIED


def test_client_name_with_unlisted_bank_needs_confirmation(profile):
    t = classify_one(make_txn("NEFT DR-HDFC0000789-ARJUN MEHTA-OWN AC", debit="30000"), profile)
    assert t.category is Category.SELF_TRANSFER
    assert t.review_status is ReviewStatus.NEEDS_CONFIRMATION
    assert t.matched_rule == "self.name_unlisted_bank"
    assert "confirm" in t.classification_reason


# --- rule 2: family transfer ----------------------------------------------

def test_family_transfer_exact_name(profile):
    t = classify_one(make_txn("IMPS/P2A/1/PRIYA MEHTA/HDFC/Household", debit="10000"), profile)
    assert t.category is Category.FAMILY_TRANSFER
    assert t.confidence is Confidence.HIGH and "spouse" in t.classification_reason


def test_family_transfer_by_initial_needs_confirmation(profile):
    t = classify_one(make_txn("UPI/DR/1/S MEHTA/ICIC/x@okicici/Medicine", debit="12000"), profile)
    assert t.category is Category.FAMILY_TRANSFER
    assert t.review_status is ReviewStatus.NEEDS_CONFIRMATION
    assert "Suresh Mehta" in t.classification_reason


def test_family_transfer_by_spelling_variation(profile):
    t = classify_one(make_txn("UPI/DR/1/PRIYA MEHATA/HDFC/x@ok/Gift", debit="100"), profile)
    assert t.category is Category.FAMILY_TRANSFER
    assert t.matched_rule == "family.name_variant"


def test_ambiguous_family_initial_is_flagged(profile):
    p = replace(profile, family_members=profile.family_members + (FamilyMember("Sunita Mehta", "mother"),))
    t = classify_one(make_txn("UPI/DR/1/S MEHTA/ICIC/x@ok/Gift", debit="100"), p)
    assert t.category is Category.FAMILY_TRANSFER
    assert t.matched_rule == "family.ambiguous"
    assert t.review_status is ReviewStatus.NEEDS_CONFIRMATION


def test_surname_alone_does_not_match_family(profile):
    t = classify_one(make_txn("UPI/DR/1/MEHTA ENTERPRISES/ICIC/x@ok/Bill", debit="100"), profile)
    assert t.category is not Category.FAMILY_TRANSFER


# --- rules 3 and 4 --------------------------------------------------------

def test_bank_generated_entries(profile):
    cases = {
        "SB INTEREST CREDIT 01-04-2025 TO 30-06-2025": ("credit", Category.INTEREST_SAVINGS),
        "FD INT CREDIT 123456": ("credit", Category.INTEREST_DEPOSITS),
        "SMS CHARGES QTR MAR25 INCL GST": ("debit", Category.BANK_CHARGES),
        "GST ON CHARGES": ("debit", Category.BANK_CHARGES),
        "TDS ON FD INTEREST": ("debit", Category.TAX_PAYMENTS),
        "SMS CHARGES REVERSAL": ("credit", Category.REVERSALS_REFUNDS),
    }
    for narration, (side, expected) in cases.items():
        t = classify_one(make_txn(narration, **{side: "100"}), profile)
        assert t.category is expected, narration


def test_identifiable_sources(profile):
    cases = {
        "NEFT CR-CITI0001-EXAMPLESOFT TECHNOLOGIES PVT LTD-SALARY": ("credit", Category.SALARY_PENSION),
        "INCOME TAX REFUND CMP ITD AY 2024-25": ("credit", Category.INCOME_TAX_REFUND),
        "ADVANCE TAX ITNS 280 CHALLAN": ("debit", Category.TAX_PAYMENTS),
        "NACH DR STAR HEALTH INSURANCE PREMIUM": ("debit", Category.INSURANCE_HEALTH),
        "ACH D- BSE STAR MF-EXAMPLE MUTUAL FUND SIP": ("debit", Category.INVESTMENTS_OTHERS),
        "MUTUAL FUND REDEMPTION CAMS": ("credit", Category.INVESTMENT_REDEMPTION),
        "TRF TO PPF A/C XXXX4321": ("debit", Category.INVESTMENTS_TAX_SAVING),
        "EMI 0012345 HOME LOAN": ("debit", Category.LOAN_EMI),
        "ATM WDL ATM ID 1234": ("debit", Category.CASH_WITHDRAWAL),
        "CASH DEPOSIT BRANCH": ("credit", Category.CASH_DEPOSIT),
        "ACH CR DIVIDEND EXAMPLE LTD": ("credit", Category.DIVIDEND),
        "CREDIT CARD PAYMENT XXXX9999": ("debit", Category.CREDIT_CARD_PAYMENTS),
    }
    for narration, (side, expected) in cases.items():
        t = classify_one(make_txn(narration, **{side: "100"}), profile)
        assert t.category is expected, narration


def test_listed_employer_is_high_confidence_but_bare_salary_keyword_needs_confirmation(profile):
    employer = classify_one(make_txn("NEFT CR-X-EXAMPLESOFT TECHNOLOGIES-APR", credit="85000"), profile)
    keyword = classify_one(make_txn("NEFT CR-X-UNKNOWN CO-SALARY", credit="85000"), profile)
    assert employer.matched_rule == "source.employer" and employer.confidence is Confidence.HIGH
    assert keyword.category is Category.SALARY_PENSION
    assert keyword.review_status is ReviewStatus.NEEDS_CONFIRMATION


def test_tax_refund_is_not_treated_as_bank_refund(profile):
    t = classify_one(make_txn("TAX REFUND ITD", credit="3540"), profile)
    assert t.category is Category.INCOME_TAX_REFUND


def test_direction_matters(profile):
    # An interest-like narration on a debit is not interest income.
    t = classify_one(make_txn("SB INTEREST CREDIT", debit="100"), profile)
    assert t.category is not Category.INTEREST_SAVINGS


def test_investment_categories_are_reviewable(profile):
    sip = classify_one(make_txn("ACH D- BSE STAR MF-SIP", debit="5000"), profile)
    ppf = classify_one(make_txn("TRF TO PPF ACCOUNT", debit="1500"), profile)
    assert sip.review_status is ReviewStatus.NEEDS_REVIEW
    assert ppf.review_status is ReviewStatus.NEEDS_REVIEW
    assert "cannot be determined" in sip.classification_reason


# --- priority -------------------------------------------------------------

def test_self_transfer_beats_family_and_client_rules(profile):
    p = replace(profile, client_rules=(ClientRule("All MEHTA is business", (r"\bMEHTA\b",), Category.BUSINESS_RECEIPTS),))
    t = classify_one(make_txn("UPI/CR/1/ARJUN MEHTA/SBIN/x@oksbi/back", credit="100"), p)
    assert t.category is Category.SELF_TRANSFER


def test_family_beats_bank_and_source_rules(profile):
    t = classify_one(make_txn("UPI/DR/1/PRIYA MEHTA/HDFC/x@ok/SALARY ADVANCE EMI", debit="100"), profile)
    assert t.category is Category.FAMILY_TRANSFER


def test_bank_rule_beats_source_rule(profile):
    # TDS (bank-generated) and "INCOME TAX" (source rule) both match a debit.
    t = classify_one(make_txn("TDS DEDUCTED INCOME TAX ON FD INT", debit="100"), profile)
    assert t.matched_rule == "bank.tds"


def test_client_rule_applies_only_after_rules_1_to_4(profile):
    p = replace(profile, client_rules=(
        ClientRule("Treat ATM as business", (r"\bATM\b",), Category.BUSINESS_EXPENSES),
        ClientRule("Food delivery is personal.", (r"\bSWIGGY\b",), Category.PERSONAL_EXPENSES, Direction.DEBIT),
    ))
    atm = classify_one(make_txn("ATM WDL ATM ID 1234", debit="2000"), p)
    swiggy = classify_one(make_txn("UPI/DR/1/SWIGGY/YESB/swiggy@ok/Order", debit="450"), p)
    assert atm.category is Category.CASH_WITHDRAWAL
    assert swiggy.category is Category.PERSONAL_EXPENSES and swiggy.matched_rule == "client_rule"
    assert "Client instruction" in swiggy.classification_reason


# --- rule 6: recurring credits --------------------------------------------

def _neha(day, month, amount="15000", row=1):
    return make_txn(f"UPI/CR/{row}/NEHA KAPOOR/YESB/neha.k@okyes/x", credit=amount, on=date(2025, month, day), row=row)


def test_recurring_credits_are_detected_but_not_guessed(profile):
    txns = [_neha(25, 4, row=1), _neha(25, 5, row=2), _neha(25, 6, "15200", row=3)]
    out = classify_statement(txns, profile)
    for t in out:
        assert FLAG_RECURRING_CREDIT in t.flags
        assert t.category is Category.OTHERS_NEEDS_REVIEW
        assert t.review_status is ReviewStatus.NEEDS_CONFIRMATION
        assert "Recurring credit: 3 credits" in t.classification_reason


def test_recurring_category_can_be_configured(profile):
    txns = [_neha(25, 4, row=1), _neha(25, 5, row=2), _neha(25, 6, row=3)]
    out = classify_statement(txns, profile, AnalysisConfig(recurring_credit_category=Category.RENT_RECEIVED))
    assert all(t.category is Category.RENT_RECEIVED for t in out)
    assert all(t.review_status is ReviewStatus.NEEDS_CONFIRMATION for t in out)


def test_irregular_credits_are_not_recurring(profile):
    amounts = [_neha(25, 4, row=1), _neha(25, 5, "40000", row=2), _neha(25, 6, row=3)]
    too_few = [_neha(25, 4, row=1), _neha(25, 5, row=2)]
    gaps = [_neha(1, 4, row=1), _neha(5, 4, row=2), _neha(9, 4, row=3)]
    for txns in (amounts, too_few, gaps):
        assert all(FLAG_RECURRING_CREDIT not in t.flags for t in classify_statement(txns, profile))


# --- rule 7: uncertain ----------------------------------------------------

def test_uncertain_transaction_goes_to_needs_review_with_reason(profile):
    t = classify_one(make_txn("UPI/DR/1/KRISHNA STORES/PYTM/k@paytm/Misc", debit="2350"), profile)
    assert t.category is Category.OTHERS_NEEDS_REVIEW
    assert t.category.value == "Others – Needs Review"
    assert t.review_status is ReviewStatus.NEEDS_REVIEW
    assert t.confidence is Confidence.LOW
    assert t.matched_rule == "uncertain" and t.classification_reason


def test_large_unexplained_credit_is_flagged(profile):
    t = classify_one(make_txn("NEFT CR-UTIB0000456-R K TRADERS-PAYMENT", credit="175000"), profile)
    assert t.category is Category.OTHERS_NEEDS_REVIEW
    assert FLAG_LARGE_CREDIT in t.flags
    assert "50,000" in t.classification_reason


def test_large_credit_threshold_is_configurable_and_inclusive(profile):
    at = classify_one(make_txn("NEFT CR-X-UNKNOWN PAYER-REF", credit="50000"), profile)
    below = classify_one(make_txn("NEFT CR-X-UNKNOWN PAYER-REF", credit="49999.99"), profile)
    custom = classify_one(
        make_txn("NEFT CR-X-UNKNOWN PAYER-REF", credit="20000"), profile,
        AnalysisConfig(large_credit_threshold=Decimal("10000")),
    )
    assert FLAG_LARGE_CREDIT in at.flags
    assert FLAG_LARGE_CREDIT not in below.flags
    assert FLAG_LARGE_CREDIT in custom.flags


def test_classified_large_credit_is_not_flagged(profile):
    t = classify_one(make_txn("NEFT CR-X-EXAMPLESOFT TECHNOLOGIES-SALARY", credit="85000"), profile)
    assert FLAG_LARGE_CREDIT not in t.flags


# --- preservation and tax neutrality --------------------------------------

def test_classification_never_changes_original_fields(profile):
    txns = [
        make_txn("  NEFT CR-X-R K Traders-Ref  ", credit="175000.005", row=1),
        make_txn("SMS CHARGES QTR", debit="23.60", row=2),
    ]
    out = classify_statement(txns, profile)
    for before, after in zip(txns, out):
        assert (after.row_number, after.date, after.narration) == (before.row_number, before.date, before.narration)
        assert (after.debit, after.credit, after.balance) == (before.debit, before.credit, before.balance)
        assert (after.raw_debit, after.raw_credit) == (before.raw_debit, before.raw_credit)


def test_reasons_never_state_a_tax_conclusion(profile):
    narrations = [
        ("TRF TO PPF ACCOUNT", "debit"),
        ("NACH DR STAR HEALTH INSURANCE PREMIUM", "debit"),
        ("ACH D- BSE STAR MF-ELSS SIP", "debit"),
        ("NEFT CR-X-EXAMPLESOFT TECHNOLOGIES-SALARY", "credit"),
        ("NEFT CR-X-R K TRADERS-PAYMENT", "credit"),
    ]
    banned = ("is taxable", "is deductible", "is exempt", "tax-free", "eligible for deduction")
    for narration, side in narrations:
        reason = classify_one(make_txn(narration, **{side: "100000"}), profile).classification_reason.lower()
        assert not any(b in reason for b in banned), (narration, reason)
