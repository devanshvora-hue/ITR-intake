"""Reliability tests: bank-charge context, short keywords and name-match
strength. All narrations and names are synthetic."""

from dataclasses import replace

import pytest
from conftest import make_txn

from itr_intake import (
    AnalysisConfig,
    Category,
    Confidence,
    FamilyMember,
    ReviewStatus,
    classify_statement,
)
from itr_intake.text import NameMatch, match_name


def classify(narration, profile, *, debit="0", credit="0", config=AnalysisConfig()):
    return classify_statement([make_txn(narration, debit=debit, credit=credit)], profile, config)[0]


# --- 1. bank charges ------------------------------------------------------------

@pytest.mark.parametrize(
    "narration",
    [
        "SMS ALERT CHRG APR-JUN 2025",
        "SMS CHARGES QTR MAR25 INCL GST",
        "ATM TXN CHRG EXCESS TXN 3",
        "MIN BAL CHRG MAR25",
        "NON MAINT CHARGES Q4",
        "AMB CHRG MAR 2025",
        "NEFT COMM 0001",
        "IMPS CHG REF 4455",
        "CHQ BOOK ISSUE CHRG",
        "ECS RTN CHRG 22-04-2025",
        "DEBIT CARD ANNUAL FEE INCL GST",
        "DC ISSUANCE FEE",
        "CGST ON SMS CHRG",
        "GST ON CHARGES",
        "CHRG: SMS ALERT",
        "CASH HANDLING CHARGES",
        "STOP PAYMENT CHARGES",
    ],
)
def test_known_bank_charge_patterns_are_bank_charges(profile, narration):
    t = classify(narration, profile, debit="118.00")
    assert t.category is Category.BANK_CHARGES, narration
    assert t.matched_rule == "bank.charges"


@pytest.mark.parametrize(
    "narration",
    [
        "NEFT DR-HDFC0001234-SHARMA LOGISTICS-DELIVERY CHARGES",
        "IMPS/P2A/509912345601/ABC COURIER/DELIVERY CHG",
        "UPI/DR/1/QUICK MOVERS/okaxis/Packing charges",
        "CHQ 123456 SUPPLIER SERVICE CHARGES INV 45",
        "PAYMENT TO XYZ ELECTRICALS INSTALLATION CHARGES",
        "GST ON DELIVERY CHARGES INV 12",
        "ANNUAL FEE GYM MEMBERSHIP",
        "TO TRANSFER-SMS CHARGES RECOVERED FROM FRIEND",
        "UPI/DR/1/SCHOOL/okicici/Term fee",
    ],
)
def test_supplier_payments_mentioning_charges_are_not_bank_charges(profile, narration):
    t = classify(narration, profile, debit="2500.00")
    assert t.category is not Category.BANK_CHARGES, narration
    assert t.category is Category.OTHERS_NEEDS_REVIEW
    assert t.review_status is ReviewStatus.NEEDS_REVIEW and t.classification_reason


def test_charge_reversal_context(profile):
    assert classify("CHRG REV SMS ALERT", profile, credit="23.60").category is Category.REVERSALS_REFUNDS
    assert classify("SMS CHARGES REVERSAL", profile, credit="23.60").category is Category.REVERSALS_REFUNDS
    assert classify("NEFT CR-X-REV SHARE PAYOUT-ABC MEDIA", profile, credit="900").category is not Category.REVERSALS_REFUNDS


def test_bank_tds_needs_interest_or_deposit_context(profile):
    assert classify("TDS ON FD INTEREST", profile, debit="120").matched_rule == "bank.tds"
    assert classify("INT TDS RECOVERED", profile, debit="120").matched_rule == "bank.tds"
    vendor = classify("NEFT DR-HDFC0001-ABC SUPPLIERS-TDS PAYMENT", profile, debit="5000")
    assert vendor.matched_rule != "bank.tds"


def test_interest_from_a_named_party_is_not_bank_interest(profile):
    t = classify("NEFT CR-UTIB0001-R K FRIEND-INTEREST CREDIT ON LOAN", profile, credit="5000")
    assert t.category is not Category.INTEREST_SAVINGS


# --- 2. short keywords ----------------------------------------------------------

@pytest.mark.parametrize(
    "narration, side, expected",
    [
        ("NEFT CR-X-UNKNOWN CO-SAL FOR APR 2025", "credit", Category.SALARY_PENSION),
        ("SAL CR APR25 REF 9911", "credit", Category.SALARY_PENSION),
        ("NEFT CR-X-UNKNOWN CO-MONTHLY SAL", "credit", Category.SALARY_PENSION),
        ("BSE STAR MF PURCHASE", "debit", Category.INVESTMENTS_OTHERS),
        ("MF UTILITIES PURCHASE 778", "debit", Category.INVESTMENTS_OTHERS),
        ("NACH DR MF SIP EXAMPLE AMC", "debit", Category.INVESTMENTS_OTHERS),
        ("NACH DR SIP EXAMPLE AMC", "debit", Category.INVESTMENTS_OTHERS),
        ("ACH CR EXAMPLE LTD FINAL DIV", "credit", Category.DIVIDEND),
        ("DIV CR EXAMPLE LTD 2024-25", "credit", Category.DIVIDEND),
        ("NACH DR EXAMPLE FINANCE EMI", "debit", Category.LOAN_EMI),
        ("LOAN EMI 5 OF 24", "debit", Category.LOAN_EMI),
        ("EMI 123456 EXAMPLE FINANCE", "debit", Category.LOAN_EMI),
        ("ITD REFUND AY 2024-25", "credit", Category.INCOME_TAX_REFUND),
        ("SSY DEPOSIT A C 7788", "debit", Category.INVESTMENTS_TAX_SAVING),
    ],
)
def test_short_keywords_match_with_context(profile, narration, side, expected):
    t = classify(narration, profile, **{side: "5000"})
    assert t.category is expected, narration


@pytest.mark.parametrize(
    "narration, side, not_expected",
    [
        ("UPI/CR/1/SAL ENTERPRISES/okaxis/Invoice 7", "credit", Category.SALARY_PENSION),
        ("NEFT CR-X-SALIM TRADERS-INV 22", "credit", Category.SALARY_PENSION),
        ("NEFT CR-X-SAL TRADING CO-PMT", "credit", Category.SALARY_PENSION),
        ("UPI/DR/1/MF ENTERPRISES/okaxis/Bill", "debit", Category.INVESTMENTS_OTHERS),
        ("NEFT DR-X-MF TEXTILES-INV 99", "debit", Category.INVESTMENTS_OTHERS),
        ("UPI/DR/1/SIP N SNACKS/okaxis/Cafe", "debit", Category.INVESTMENTS_OTHERS),
        ("NEFT CR-X-DIV ENGINEERING-PMT", "credit", Category.DIVIDEND),
        ("UPI/CR/1/DIVYA RAO/okaxis/Return", "credit", Category.DIVIDEND),
        ("UPI/DR/1/EMI SHARMA/okaxis/Dinner", "debit", Category.LOAN_EMI),
        ("NEFT CR-X-ITD TRADERS-PAYMENT", "credit", Category.INCOME_TAX_REFUND),
        ("UPI/DR/1/SSY TRADERS/okaxis/Bill", "debit", Category.INVESTMENTS_TAX_SAVING),
        ("UPI/DR/1/ATM ELECTRONICS/okaxis/Repair", "debit", Category.CASH_WITHDRAWAL),
        ("HDFC SECURITY DEPOSIT REFUND", "credit", Category.INVESTMENT_REDEMPTION),
    ],
)
def test_short_keywords_without_context_do_not_match(profile, narration, side, not_expected):
    t = classify(narration, profile, **{side: "5000"})
    assert t.category is not not_expected, narration


def test_unmatched_short_keyword_stays_reviewable(profile):
    t = classify("UPI/CR/1/SAL ENTERPRISES/okaxis/Invoice 7", profile, credit="5000")
    assert t.category is Category.OTHERS_NEEDS_REVIEW
    assert t.review_status is ReviewStatus.NEEDS_REVIEW and t.matched_rule == "uncertain"


# --- 3. name matching: unit level ---------------------------------------------------

@pytest.mark.parametrize(
    "name, narration, strength",
    [
        ("Priya Mehta", "IMPS/P2A/1/PRIYA MEHTA/HDFC/Household", NameMatch.EXACT),
        ("Suresh Mehta", "UPI/DR/1/S MEHTA/ICIC/sureshm@okicici/Medicine", NameMatch.PARTIAL),
        ("Arjun Mehta", "UPI/DR/1/MEHTA ARJUN/HDFC/x", NameMatch.PARTIAL),
        ("Arjun Mehta", "UPI/DR/1/ARJUN TRADERS/HDFC/MEHTA STORE/x", NameMatch.PARTIAL),
        ("Priya Mehta", "UPI/DR/1/PRIYA MEHATA/HDFC/x", NameMatch.VARIANT),
        ("Priya Mehta", "UPI/DR/1/PRIY MEHTA/HDFC/x", NameMatch.VARIANT),
        ("Priya Mehta", "UPI/DR/1/PRIYAM MEHTA/HDFC/x", NameMatch.WEAK),
        ("Priya Mehta", "UPI/DR/1/PRI MEHTA/HDFC/x", NameMatch.WEAK),
        ("Priya Mehta", "UPI/DR/1/PRIYA MEHRA/HDFC/x", NameMatch.WEAK),
        ("Priya Mehta", "UPI/DR/1/PRIYANKA MEHTA/HDFC/x", NameMatch.WEAK),
    ],
)
def test_name_match_strength(name, narration, strength):
    result = match_name(name, narration)
    assert result is not None and result.strength is strength, result


@pytest.mark.parametrize(
    "name, narration",
    [
        ("Priya Mehta", "UPI/DR/1/MEHTA ENTERPRISES/x"),  # surname only
        ("Priya Mehta", "UPI/DR/1/P M/x"),  # surname as an initial
        ("Priya Mehta", "UPI/DR/1/RIYA KAPOOR/x"),
        ("Arjun", "UPI/DR/1/ARJUNA/x"),  # single-word names need an exact match
    ],
)
def test_name_no_match(name, narration):
    assert match_name(name, narration) is None


# --- 3. name matching: classification ------------------------------------------------

def test_exact_family_name_is_auto_classified(profile):
    t = classify("IMPS/P2A/1/PRIYA MEHTA/HDFC/Household", profile, debit="10000")
    assert t.category is Category.FAMILY_TRANSFER and t.review_status is ReviewStatus.AUTO_CLASSIFIED


def test_family_initials_need_confirmation(profile):
    t = classify("UPI/DR/1/S MEHTA/ICIC/x@okicici/Medicine", profile, debit="12000")
    assert t.category is Category.FAMILY_TRANSFER
    assert t.review_status is ReviewStatus.NEEDS_CONFIRMATION
    assert t.matched_rule == "family.name_initials"
    assert "'S' as an initial for SURESH" in t.classification_reason


def test_similar_but_distinct_family_name_stays_in_needs_review(profile):
    t = classify("UPI/DR/1/PRIYAM MEHTA/HDFC/x@ok/Gift", profile, debit="500")
    assert t.category is Category.OTHERS_NEEDS_REVIEW
    assert t.review_status is ReviewStatus.NEEDS_REVIEW
    assert "Weak name resemblance to family member Priya Mehta" in t.classification_reason
    assert "'PRIYAM' extends PRIYA with extra letters and may be a different name" in t.classification_reason
    assert "not used for classification" in t.classification_reason


# --- regression: name extensions vs. supported variants --------------------------

@pytest.mark.parametrize(
    "narration, member",
    [
        ("UPI/DR/1/PRIYAM MEHTA/HDFC/x@ok/Gift", "Priya Mehta"),
        ("UPI/DR/1/PRIYANKA MEHTA/HDFC/x@ok/Gift", "Priya Mehta"),
        ("IMPS/P2A/1/SURESHA MEHTA/ICIC/Transfer", "Suresh Mehta"),
        ("UPI/DR/1/PRIYA MEHTANI/HDFC/x@ok/Gift", "Priya Mehta"),  # extended surname
    ],
)
def test_extended_name_resemblance_is_never_family_transfer(profile, narration, member):
    t = classify(narration, profile, debit="500")
    assert t.category is Category.OTHERS_NEEDS_REVIEW
    assert t.matched_rule == "uncertain"
    assert f"family member {member}" in t.classification_reason
    assert "may be a different name" in t.classification_reason


@pytest.mark.parametrize(
    "narration",
    [
        "UPI/DR/1/ARJUNA MEHTA/SBIN/x@oksbi/Own",  # listed bank: still not enough
        "NEFT DR-HDFC0000789-ARJUN MEHTANI-OWN AC",
    ],
)
def test_extended_name_resemblance_is_never_self_transfer(profile, narration):
    t = classify(narration, profile, debit="5000")
    assert t.category is Category.OTHERS_NEEDS_REVIEW
    assert t.review_status is ReviewStatus.NEEDS_REVIEW
    assert "Weak name resemblance to the client Arjun Mehta" in t.classification_reason
    assert "may be a different name" in t.classification_reason


@pytest.mark.parametrize(
    "narration, rule, status",
    [
        ("IMPS/P2A/1/PRIYA MEHTA/HDFC/Household", "family.name", ReviewStatus.AUTO_CLASSIFIED),
        ("UPI/DR/1/PRIYA MEHATA/HDFC/x@ok/Gift", "family.name_variant", ReviewStatus.NEEDS_CONFIRMATION),
        ("UPI/DR/1/PRIYYA MEHTA/HDFC/x@ok/Gift", "family.name_variant", ReviewStatus.NEEDS_CONFIRMATION),
        ("UPI/DR/1/PRIY MEHTA/HDFC/x@ok/Gift", "family.name_variant", ReviewStatus.NEEDS_CONFIRMATION),
        ("UPI/DR/1/P MEHTA/HDFC/x@ok/Gift", "family.name_initials", ReviewStatus.NEEDS_CONFIRMATION),
    ],
)
def test_exact_and_supported_family_variants_are_unchanged(profile, narration, rule, status):
    t = classify(narration, profile, debit="500")
    assert t.category is Category.FAMILY_TRANSFER
    assert t.matched_rule == rule and t.review_status is status


@pytest.mark.parametrize(
    "narration, rule, status",
    [
        ("UPI/DR/1/ARJUN MEHTA/SBIN/arjunm@oksbi/Own", "self.name_listed_bank", ReviewStatus.AUTO_CLASSIFIED),
        ("NEFT DR-HDFC0000789-ARJUN MEHTA-OWN AC", "self.name_unlisted_bank", ReviewStatus.NEEDS_CONFIRMATION),
        ("UPI/DR/1/ARJUN MEHATA/SBIN/x@oksbi/Own", "self.name_partial", ReviewStatus.NEEDS_CONFIRMATION),
    ],
)
def test_exact_and_supported_self_variants_are_unchanged(profile, narration, rule, status):
    t = classify(narration, profile, debit="5000")
    assert t.category is Category.SELF_TRANSFER
    assert t.matched_rule == rule and t.review_status is status


def test_upi_id_extension_does_not_block_exact_name(profile):
    # The UPI ID 'arjunm' extends ARJUN, but the exact name beside it wins.
    t = classify("UPI/DR/1/ARJUN MEHTA/SBIN/arjunm@oksbi/Own", profile, debit="5000")
    assert t.matched_rule == "self.name_listed_bank"
    assert "Weak" not in t.classification_reason


@pytest.mark.parametrize(
    "narration",
    [
        "UPI/DR/1/PRI MEHTA/HDFC/x@ok/Gift",  # short fragment
        "UPI/DR/1/PRIYA MEHRA/HDFC/x@ok/Gift",  # different surname
        "UPI/DR/1/PRIYANKA MEHTA/HDFC/x@ok/Gift",  # different given name
    ],
)
def test_weak_family_match_is_not_classified_but_is_reported(profile, narration):
    t = classify(narration, profile, debit="500")
    assert t.category is Category.OTHERS_NEEDS_REVIEW
    assert t.review_status is ReviewStatus.NEEDS_REVIEW
    assert "Weak name resemblance to family member Priya Mehta" in t.classification_reason
    assert "not used for classification" in t.classification_reason


def test_spelling_variant_of_client_name_at_listed_bank_needs_confirmation(profile):
    # Previously auto-classified; a variant must not be enough.
    t = classify("UPI/DR/1/ARJUN MEHATA/SBIN/x@oksbi/Own", profile, debit="5000")
    assert t.category is Category.SELF_TRANSFER
    assert t.review_status is ReviewStatus.NEEDS_CONFIRMATION
    assert t.confidence is Confidence.LOW and t.matched_rule == "self.name_partial"
    assert "spelling variation of MEHTA" in t.classification_reason


def test_client_initial_needs_confirmation(profile):
    t = classify("UPI/DR/1/A MEHTA/SBIN/x@oksbi/Own", profile, debit="5000")
    assert t.category is Category.SELF_TRANSFER
    assert t.review_status is ReviewStatus.NEEDS_CONFIRMATION
    assert t.matched_rule == "self.name_partial"


def test_initial_shared_by_client_and_family_member_is_flagged(profile):
    p = replace(profile, family_members=profile.family_members + (FamilyMember("Anita Mehta", "sister"),))
    t = classify("UPI/DR/1/A MEHTA/HDFC/x@okhdfc/Transfer", p, debit="5000")
    assert t.review_status is ReviewStatus.NEEDS_CONFIRMATION
    assert "Anita Mehta" in t.classification_reason


def test_exact_family_match_beats_partial_client_match(profile):
    p = replace(profile, family_members=profile.family_members + (FamilyMember("Anita Mehta", "sister"),))
    t = classify("UPI/DR/1/ANITA MEHTA/HDFC/a@okhdfc/A", p, debit="5000")
    assert t.category is Category.FAMILY_TRANSFER and t.matched_rule == "family.name"


def test_weak_client_fragment_is_not_self_transfer(profile):
    t = classify("UPI/DR/1/ARJ MEHTA/SBIN/x@oksbi/Own", profile, debit="5000")
    assert t.category is not Category.SELF_TRANSFER
    assert "Weak name resemblance to the client Arjun Mehta" in t.classification_reason


def test_scattered_client_name_parts_need_confirmation(profile):
    t = classify("UPI/DR/1/ARJUN TRADERS/SBIN/MEHTA STORE/x", profile, debit="5000")
    assert t.category is Category.SELF_TRANSFER
    assert t.review_status is ReviewStatus.NEEDS_CONFIRMATION
    assert "not adjacent" in t.classification_reason


def test_exact_client_name_keeps_existing_behaviour(profile):
    listed = classify("UPI/DR/1/ARJUN MEHTA/SBIN/arjunm@oksbi/Own", profile, debit="5000")
    unlisted = classify("NEFT DR-HDFC0000789-ARJUN MEHTA-OWN AC", profile, debit="5000")
    assert listed.matched_rule == "self.name_listed_bank" and listed.review_status is ReviewStatus.AUTO_CLASSIFIED
    assert unlisted.matched_rule == "self.name_unlisted_bank"
    assert unlisted.review_status is ReviewStatus.NEEDS_CONFIRMATION
