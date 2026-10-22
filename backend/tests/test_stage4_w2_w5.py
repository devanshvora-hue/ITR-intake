"""Regression tests for review warnings W2 (unsupported facts), W3 (tax-advice
wording), W4 (paraphrased duplicates) and W5 (all model-generated text).
No model calls. Synthetic data only."""

import json

import pytest

from itr_intake.questions import (
    AnsweredQuestion,
    DuplicateQuestionError,
    Finding,
    InvalidModelOutput,
    NextQuestion,
    NoFurtherQuestion,
    question_intents,
    validate_reply,
)

ALPHA = Finding("F9001", ("T9001",), ("unclassified",), "2025-05-14", "credit", "48500.00",  # a Wednesday
                "NEFT CR-SYNT0000001-DEMO PAYER ALPHA-REF 7781 (SYNTHETIC)", "DEMO PAYER ALPHA",
                "Others – Needs Review", "Needs review", "No priority rule matched.")
LAKH = Finding("F9005", ("T9005",), ("unclassified", "large_credit"), "2025-04-18", "credit", "175000.00",
               "NEFT CR-SYNT0000005-DEMO PAYER BETA-INV 3321 (SYNTHETIC)", "DEMO PAYER BETA",
               "Others – Needs Review", "Needs review", "No priority rule matched.")


def ask(question, f=ALPHA, purpose="Clarify a synthetic credit.", answered=()):
    reply = {"action": "ask", "question": question, "purpose": purpose, "finding_ids": [f.finding_id]}
    return validate_reply(json.dumps(reply), [f], list(answered))


def none(reason, findings=(ALPHA,)):
    return validate_reply(json.dumps({"action": "none", "reason": reason}), list(findings), [])


# === W2: amounts in words or shorthand ==========================================================

@pytest.mark.parametrize(
    "question",
    [
        "Was the 2 lakh rupees credit from DEMO PAYER ALPHA a loan?",  # review probe
        "Was the 1.75 lakh credit a loan?",  # review probe
        "Was the 52k credit a loan?",  # review probe
        "Was the ₹2 crore credit a loan?",
        "Was the Rs 1.5L credit a loan?",
        "Was the fifty thousand rupees credit a loan?",
        "Was it about a lakh?",
        "Was it a few thousand rupees?",
        "Was 500 rupees of this a refund?",
        "Was Rs. 500/- of this a refund?",
    ],
)
def test_w2_unsupported_word_or_shorthand_amounts_are_rejected(question):
    with pytest.raises(InvalidModelOutput, match="amount"):
        ask(question)


@pytest.mark.parametrize(
    "question, f",
    [
        ("Was the 1.75 lakh credit from DEMO PAYER BETA a loan?", LAKH),
        ("Was the Rs 1.75 lakh credit a loan?", LAKH),
        ("Was the ₹1.75L credit a loan?", LAKH),
        ("Was the 48.5k credit from DEMO PAYER ALPHA a loan?", ALPHA),
        ("Was the 48500 rupees credit a loan?", ALPHA),
    ],
)
def test_w2_grounded_shorthand_amounts_are_allowed(question, f):
    assert isinstance(ask(question, f), NextQuestion)


# === W2: dates ===================================================================================

@pytest.mark.parametrize(
    "question",
    [
        "What was the credit on 15-May-2025 for?",  # review probe
        "What was the credit on 2025/05/15 for?",  # review probe
        "What was the credit on the 15th for?",  # review probe
        "What was the credit dated 3rd for?",
        "Is it paid on the 20th of the month?",
        "Was this credit received in June 2025?",
        "Was this credit received yesterday?",
        "Did this arrive last week?",
        "Was this received a few days ago?",
        "Did this arrive on a Tuesday?",
    ],
)
def test_w2_unsupported_dates_are_rejected(question):
    with pytest.raises(InvalidModelOutput, match="date|day|month|weekday"):
        ask(question)


@pytest.mark.parametrize(
    "question, expected",
    [
        ("What was the credit on 14-May-2025 for?", "What was the credit on 14-May-2025 for?"),
        ("What was the credit on 2025/05/14 for?", "What was the credit on 14-05-2025 for?"),
        ("What was the credit on the 14th for?", "What was the credit on the 14th for?"),
        ("Is it paid on the 14th of the month?", "Is it paid on the 14th of the month?"),
        ("Was this credit received in May 2025?", "Was this credit received in May 2025?"),
        ("Did this credit arrive on a Wednesday?", "Did this credit arrive on a Wednesday?"),
    ],
)
def test_w2_grounded_dates_are_allowed(question, expected):
    assert ask(question).question == expected


# === W2: names ===================================================================================

@pytest.mark.parametrize(
    "question",
    [
        "Was this credit from your cousin RAHUL VERMA?",  # review probe
        "Was this credit from Rahul Verma?",
        "Did Arjun send this credit?",  # the client's own name is not in this finding
        "Is DEMO PAYER GAMMA the same person as the payer?",
        "Was this credit received into your HDFC account?",  # bank not in this narration
    ],
)
def test_w2_unsupported_names_are_rejected(question):
    with pytest.raises(InvalidModelOutput, match="name"):
        ask(question)


@pytest.mark.parametrize(
    "question",
    [
        "Who is DEMO PAYER ALPHA?",
        "Is Demo Payer Alpha a relative of yours?",
        "What is DEMO PAYER ALPHA's business?",
        "Was this paid to you through UPI or NEFT?",
        "Should this stay in Others – Needs Review, or is it a Family Transfer?",
        "Does reference 7781 on this credit mean anything to you?",
        "Was this credit received in May or June?",
    ],
)
def test_w2_grounded_names_and_ordinary_capitals_are_allowed(question):
    assert isinstance(ask(question), NextQuestion)


# === W3: tax-treatment and return-reporting decisions ===============================================

@pytest.mark.parametrize(
    "question",
    [
        "Can you claim HRA for this rent?",  # review probe
        "Should this be reported as income in your return?",  # review probe
        "Did you include this in your ITR?",
        "Do you want to show this in your income tax return?",
        "Should this be treated as business income?",
        "Is this eligible under section 80C?",
        "Should we consider this as a gift for tax purposes?",
        "Do you need to declare this?",
        "Should you pay tax on this?",
        "Would you like to claim a deduction for this premium?",
        "Is this income from other sources?",
    ],
)
def test_w3_tax_decision_questions_are_rejected(question):
    with pytest.raises(InvalidModelOutput, match="tax"):
        ask(question)


@pytest.mark.parametrize(
    "question",
    [
        "What was this payment for?",
        "Who paid you this amount?",
        "Was this a transfer between your own accounts?",
        "Was this an income tax refund?",
        "Was this the return of a loan you had given?",
        "Did you claim this amount back from your employer as a reimbursement?",
        "Is this rent from a tenant?",
        "Do you have the rent receipts for this payment?",
        "Was this salary from your employer?",
        "Was this a gift from a relative?",
        "Does your bank statement show this as a refund?",
    ],
)
def test_w3_neutral_fact_finding_is_allowed(question):
    assert isinstance(ask(question), NextQuestion)


# === W4: paraphrased duplicates =====================================================================

PREV_PURPOSE = AnsweredQuestion("Q-1", "What was the credit from DEMO PAYER ALPHA for?", ("F9001",), "A loan.")
PREV_IDENTITY = AnsweredQuestion("Q-2", "Who is DEMO PAYER ALPHA?", ("F9001",), "A business contact.")


@pytest.mark.parametrize(
    "question, prev",
    [
        ("Could you explain why DEMO PAYER ALPHA sent you this money?", PREV_PURPOSE),  # review probe
        ("Why did DEMO PAYER ALPHA send you this money?", PREV_PURPOSE),
        ("Can you describe what this credit relates to?", PREV_PURPOSE),
        ("What is your relationship with DEMO PAYER ALPHA?", PREV_IDENTITY),
    ],
)
def test_w4_paraphrased_repeats_are_rejected(question, prev):
    with pytest.raises(DuplicateQuestionError):
        ask(question, answered=[prev])


@pytest.mark.parametrize(
    "question",
    [
        "Who is DEMO PAYER ALPHA to you?",
        "Do you have a receipt or agreement for this credit?",
        "Is the account that received this one of your own accounts?",
        "Will DEMO PAYER ALPHA continue sending this every month?",
        "How much of this credit was a repayment?",
    ],
)
def test_w4_follow_ups_seeking_new_information_are_allowed(question):
    assert isinstance(ask(question, answered=[PREV_PURPOSE]), NextQuestion)


def test_w4_same_intent_about_a_different_finding_is_allowed():
    other = Finding("F9002", ("T9002",), ("unclassified",), "2025-05-20", "credit", "48500.00",
                    "NEFT CR-SYNT0000002-DEMO PAYER BETA-REF 7782 (SYNTHETIC)", "DEMO PAYER BETA",
                    "Others – Needs Review", "Needs review", "No priority rule matched.")
    result = ask("Could you explain why DEMO PAYER BETA sent you this money?", other, answered=[PREV_PURPOSE])
    assert isinstance(result, NextQuestion)


def test_w4_intent_detection():
    assert question_intents("What was the credit from DEMO PAYER ALPHA for?") == {"purpose"}
    assert question_intents("Could you explain why DEMO PAYER ALPHA sent you this money?") == {"purpose"}
    assert question_intents("Do you have a receipt?") == {"evidence"}
    assert question_intents("Who is this?") == {"identity"}


# === W5: purpose and reason get the same checks ========================================================

@pytest.mark.parametrize(
    "purpose, match",
    [
        ("Check the Rs 9,99,999 figure.", "amount"),
        ("Verify the 2 lakh payment.", "amount"),
        ("Collect the OTP to verify the payment.", "sensitive"),
        ("Decide whether to claim HRA in the return.", "tax"),
        ("Confirm the 30-06-2025 payment.", "date"),
        ("Confirm the 2025-06-30 payment from RAHUL VERMA.", "date|name"),
        ("Identify why RAHUL VERMA paid.", "name"),
        ("Follow up on last week's payment.", "relative date"),
    ],
)
def test_w5_purpose_is_validated(purpose, match):
    with pytest.raises(InvalidModelOutput, match=match):
        ask("What was the credit from DEMO PAYER ALPHA for?", purpose=purpose)


def test_w5_grounded_purpose_is_kept_as_written():
    purpose = "Identify the ₹48,500.00 credit from DEMO PAYER ALPHA on 2025-05-14."
    result = ask("What was the credit from DEMO PAYER ALPHA for?", purpose=purpose)
    assert result.purpose == purpose and result.presentation_fixes == ()


@pytest.mark.parametrize(
    "reason, match",
    [
        ("The ₹2,00,000.00 credit is explained.", "amount"),
        ("The 52k credit is explained.", "amount"),
        ("Ask the client for their UPI PIN next time.", "sensitive"),
        ("The client can claim HRA; nothing more to ask.", "tax"),
        ("The 30-06-2025 credit is explained.", "date"),
        ("RAHUL VERMA explained the credit.", "name"),
    ],
)
def test_w5_no_question_reason_is_validated(reason, match):
    with pytest.raises(InvalidModelOutput, match=match):
        none(reason)


def test_w5_grounded_reason_is_allowed():
    result = none("The answer about DEMO PAYER ALPHA and the ₹48,500.00 credit on 14-05-2025 covers F9001.")
    assert isinstance(result, NoFurtherQuestion)
