"""Regression tests for the Stage 4 review blockers B1-B3. Gemini is mocked
(no key, no network). Synthetic data only."""

import json
from dataclasses import replace
from types import SimpleNamespace

import pytest

from itr_intake import classify_statement, validate_statement
from itr_intake.intake_workflow import (
    ClientConfirmation,
    ConfirmationResponse,
    IntakeContext,
    LifecyclePolicy,
    StopReason,
    WorkflowInputError,
    WorkflowStatus,
    next_intake_step,
)
from itr_intake.questions import (
    AnsweredQuestion,
    Finding,
    GeminiSettings,
    InvalidModelOutput,
    NextQuestion,
    NoFurtherQuestion,
    QuestionGenerator,
    build_findings,
    validate_reply,
)
from itr_intake.synthetic import load_synthetic_statement


class ScriptedModels:
    def __init__(self, *replies):
        self.replies, self.calls = list(replies), 0

    def generate_content(self, *, model, contents, config=None):
        self.calls += 1
        return SimpleNamespace(text=json.dumps(self.replies.pop(0)), candidates=[], prompt_feedback=None)


def generator(*replies):
    models = ScriptedModels(*replies)
    return QuestionGenerator(GeminiSettings(api_key="test-key-not-real"), client=SimpleNamespace(models=models)), models


@pytest.fixture
def classified():
    s = load_synthetic_statement()
    report = validate_statement(s.rows, s.opening_balance, s.closing_balance)
    return tuple(classify_statement(report.transactions, s.profile))


@pytest.fixture
def derived(classified):
    return build_findings(classified)


def ask_reply(fid="F0024", question="Can you tell us what transaction T0024 was for?"):
    return {"action": "ask", "question": question, "purpose": "Clarify the transaction.", "finding_ids": [fid]}


NONE = {"action": "none", "reason": "No further question would help."}


# === B1: findings must match the classifier output ==========================================

def test_b1_forged_f0007_confirmation_cannot_complete_the_case(classified, derived):
    # Review probe: F0007 (unexplained ₹1,75,000 credit) rewritten as a confirmable
    # "Gifts" proposal, then confirmed -> previously resolved and complete.
    forged = replace(derived[[f.finding_id for f in derived].index("F0007")],
                     issues=("needs_confirmation",), review_status="Needs confirmation",
                     current_category="Gifts / Receipts from Non-relatives")
    tampered = [forged if f.finding_id == "F0007" else f for f in derived]
    with pytest.raises(WorkflowInputError, match=r"altered \['F0007'\]"):
        IntakeContext.from_classified(classified, findings=tampered)
    with pytest.raises(WorkflowInputError, match=r"altered \['F0007'\]"):
        IntakeContext(transactions=classified, findings=tuple(tampered))
    with pytest.raises(WorkflowInputError, match="missing"):
        IntakeContext.from_classified(classified, findings=[forged])
    # The genuine F0007 cannot be confirmed either.
    genuine = IntakeContext.from_classified(classified)
    with pytest.raises(WorkflowInputError, match="CA review"):
        genuine.with_confirmation("F0007", "Gifts / Receipts from Non-relatives", "confirmed")


def test_b1_empty_findings_cannot_hide_flagged_transactions(classified, derived):
    # Review probe: findings=[] on the 10-finding statement -> previously "complete".
    with pytest.raises(WorkflowInputError, match="missing"):
        IntakeContext.from_classified(classified, findings=[])
    with pytest.raises(WorkflowInputError, match="missing"):
        IntakeContext(transactions=classified, findings=())
    gen, models = generator(ask_reply())
    step = next_intake_step(IntakeContext.from_classified(classified), gen)
    assert step.status is not WorkflowStatus.COMPLETE and len(step.unresolved_finding_ids) == len(derived)


@pytest.mark.parametrize(
    "field, value",
    [
        ("current_category", "Salary / Pension"),
        ("review_status", "Auto-classified"),
        ("issues", ()),
        ("transaction_ids", ("T0001",)),
        ("amount", "1.00"),
        ("narration", "SALARY CREDIT"),
        ("date", "2025-01-01"),
        ("direction", "debit"),
        ("counterparty", "SOMEONE ELSE"),
        ("classifier_reason", "Confirmed by client."),
    ],
)
def test_b1_any_altered_field_is_rejected(classified, derived, field, value):
    tampered = [replace(f, **{field: value}) if f.finding_id == "F0007" else f for f in derived]
    with pytest.raises(WorkflowInputError, match="altered"):
        IntakeContext.from_classified(classified, findings=tampered)


def test_b1_extra_and_duplicate_findings_are_rejected(classified, derived):
    extra = replace(derived[0], finding_id="F0099", transaction_ids=("T0099",))
    with pytest.raises(WorkflowInputError, match=r"unexpected \['F0099'\]"):
        IntakeContext.from_classified(classified, findings=[*derived, extra])
    with pytest.raises(WorkflowInputError, match="duplicate"):
        IntakeContext.from_classified(classified, findings=[*derived, derived[0]])


def test_b1_exact_findings_in_any_order_are_accepted(classified, derived):
    assert set(IntakeContext.from_classified(classified, findings=reversed(derived)).findings) == set(derived)


# === B2: unavoidable validation and stop / history integrity ===================================

def _entry(qid="Q-1", fids=("F0007",), answer="A loan.", question="What was it for?"):
    return AnsweredQuestion(qid, question, fids, answer)


@pytest.mark.parametrize(
    "kwargs, match",
    [
        (dict(history=(_entry(fids=("F9999",)),)), "unknown finding"),
        (dict(history=(_entry(), _entry())), "already been answered"),
        (dict(history=(_entry(fids=()),)), "distinct finding IDs"),
        (dict(history=(_entry(fids=("F0007", "F0007")),)), "distinct finding IDs"),
        (dict(history=(_entry(answer="  "),)), "no answer"),
        (dict(history=(_entry(question=""),)), "no question text"),
        (dict(history=(_entry(qid=""),)), "question ID"),
        (dict(history=[_entry()]), "must be a tuple"),
        (dict(confirmations=(ClientConfirmation("F0007", "Others – Needs Review", ConfirmationResponse.CONFIRMED),)),
         "CA review"),
        (dict(confirmations=(ClientConfirmation("F0999", "Family Transfer", ConfirmationResponse.CONFIRMED),)),
         "Unknown finding"),
        (dict(confirmations=(ClientConfirmation("F0008", "Family", ConfirmationResponse.CONFIRMED),)),
         "Unknown category"),
        (dict(confirmations=(ClientConfirmation("F0008", "Family Transfer", "confirmed"),)),
         "confirmation response"),
        (dict(stopped="paused"), "stop reason"),
    ],
)
def test_b2_direct_construction_is_validated(classified, derived, kwargs, match):
    with pytest.raises(WorkflowInputError, match=match):
        IntakeContext(transactions=classified, findings=tuple(derived), **kwargs)


def test_b2_direct_construction_rejects_unclassified_or_duplicate_transactions(classified, derived):
    with pytest.raises(WorkflowInputError, match="classified"):
        IntakeContext(transactions=(replace(classified[0], matched_rule=None), *classified[1:]), findings=tuple(derived))
    with pytest.raises(WorkflowInputError, match="duplicate row"):
        IntakeContext(transactions=(*classified, classified[0]), findings=tuple(derived))


def test_b2_restoring_without_explicit_stop_state_is_rejected(classified):
    with pytest.raises(WorkflowInputError, match="pass `stopped` explicitly"):
        IntakeContext.from_classified(classified, history=[_entry()])
    with pytest.raises(WorkflowInputError, match="pass `stopped` explicitly"):
        IntakeContext.from_classified(classified, confirmations=[
            ClientConfirmation("F0008", "Family Transfer", ConfirmationResponse.CONFIRMED)])
    restored = IntakeContext.from_classified(classified, history=[_entry()],
                                             stopped="model_no_further_question")
    assert restored.stopped is StopReason.MODEL_NO_FURTHER_QUESTION
    assert IntakeContext.from_classified(classified, history=[_entry()], stopped=None).stopped is None


def test_b2_omitted_stop_is_detected_on_continuation(classified):
    gen, models = generator(NONE)
    stopped = next_intake_step(IntakeContext.from_classified(classified), gen).context
    assert stopped.stopped is StopReason.MODEL_NO_FURTHER_QUESTION
    # Review probe: a rebuilt context with the stop dropped would ask again.
    rebuilt = IntakeContext.from_classified(stopped.transactions, history=stopped.history, stopped=None)
    with pytest.raises(WorkflowInputError, match="Stop state was cleared"):
        rebuilt.assert_continues(stopped)


def test_b2_existing_stop_cannot_be_replaced(classified):
    ctx = IntakeContext.from_classified(classified).with_stop(StopReason.TURN_CAP_REACHED)
    assert ctx.with_stop(StopReason.NOTHING_LEFT_TO_ASK).stopped is StopReason.TURN_CAP_REACHED
    assert not hasattr(ctx, "with_restart")


def test_b2_truncated_history_is_detected_on_continuation(classified):
    history = tuple(_entry(f"Q-{i}", ("F0024",), question=f"Question {i}?") for i in range(8))
    full = IntakeContext.from_classified(classified, history=history, stopped=None)
    gen, models = generator(ask_reply())
    capped = next_intake_step(full, gen, LifecyclePolicy(max_turns=8))
    assert capped.status is WorkflowStatus.CA_REVIEW_REQUIRED and models.calls == 0

    truncated = IntakeContext.from_classified(classified, history=history[:2], stopped=None)
    with pytest.raises(WorkflowInputError, match="truncated"):
        truncated.assert_continues(capped.context)
    # Documented limit: on its own, a truncated context is indistinguishable from
    # a short case, so cross-request integrity needs authoritative stored state.
    assert next_intake_step(truncated, gen, LifecyclePolicy(max_turns=8)).status is WorkflowStatus.QUESTIONS_AVAILABLE


def test_b2_altered_confirmations_or_statement_are_detected(classified):
    base = IntakeContext.from_classified(classified).with_confirmation("F0008", "Family Transfer", "denied")
    flipped = IntakeContext.from_classified(classified, confirmations=[
        ClientConfirmation("F0008", "Family Transfer", ConfirmationResponse.CONFIRMED)], stopped=None)
    with pytest.raises(WorkflowInputError, match="Confirmations"):
        flipped.assert_continues(base)
    other = IntakeContext.from_classified(classified[:20])
    with pytest.raises(WorkflowInputError, match="different statement"):
        other.assert_continues(IntakeContext.from_classified(classified))


def test_b2_every_workflow_step_continues_its_input(classified):
    gen, _ = generator(ask_reply(), ask_reply("F0004", "What was transaction T0004 for?"), NONE)
    ctx = IntakeContext.from_classified(classified)
    for answer in ("A shop payment.", "A mutual fund SIP."):
        step = next_intake_step(ctx, gen)
        step.context.assert_continues(ctx)
        nxt = step.context.with_answer(step.result, answer)
        nxt.assert_continues(step.context)
        ctx = nxt
    final = next_intake_step(ctx, gen)
    final.context.assert_continues(ctx)
    assert final.context.stopped is StopReason.MODEL_NO_FURTHER_QUESTION


# === B3: sensitive requests in any model-generated text =====================================

ALPHA = Finding("F9001", ("T9001",), ("unclassified",), "2025-05-14", "credit", "48500.00",
                "NEFT CR-SYNT0000001-DEMO PAYER ALPHA-REF 7781 (SYNTHETIC)", "DEMO PAYER ALPHA",
                "Others – Needs Review", "Needs review", "No priority rule matched.")


def check(question, purpose="Clarify a synthetic credit."):
    reply = {"action": "ask", "question": question, "purpose": purpose, "finding_ids": ["F9001"]}
    return validate_reply(json.dumps(reply), [ALPHA], [])


@pytest.mark.parametrize(
    "question",
    [
        # OTPs, SMS and authentication codes
        "Please share the 6-digit code sent to your phone?",
        "What is the verification code you received?",
        "Could you tell us the SMS code we texted you?",
        "What authentication code did your bank send?",
        "What is the security code for your account?",
        "What is the OTP for this credit?",
        "Can you read out the code you received from the bank?",
        # PAN as an identifier
        "What is your PAN?",
        "Please share the PAN of DEMO PAYER ALPHA?",
        "Can you provide the payer's PAN?",
        # account numbers and abbreviations
        "What is your acct number?",
        "What is your a/c no. at this bank?",
        "What is your savings account number?",
        "Please share your bank account details?",
        "Is the account ending 7781 yours, and what is your account number?",
        # card details and expiry
        "Can you share your card details?",
        "What is the expiry date of your debit card?",
        "When does your card's expiry fall?",
        # UPI PINs and other credentials
        "What is your UPI PIN?",
        "What is your UPI password?",
        "What is your MPIN for mobile banking?",
        "Please share your net banking credentials?",
    ],
)
def test_b3_sensitive_requests_are_rejected(question):
    with pytest.raises(InvalidModelOutput, match="sensitive"):
        check(question)


@pytest.mark.parametrize(
    "purpose",
    [
        "Collect the OTP to verify the payment.",
        "Obtain the client's PAN for our records.",
        "Get the client's account number for reconciliation.",
        "Ask for the card expiry date.",
    ],
)
def test_b3_sensitive_content_in_purpose_is_rejected(purpose):
    with pytest.raises(InvalidModelOutput, match="'purpose' requests sensitive"):
        check("What was the credit from DEMO PAYER ALPHA for?", purpose)


def test_b3_sensitive_content_in_no_question_reason_is_rejected():
    reply = {"action": "none", "reason": "Ask the client for their UPI PIN next time."}
    with pytest.raises(InvalidModelOutput, match="'reason' refers to sensitive"):
        validate_reply(json.dumps(reply), [ALPHA], [])
    ok = validate_reply(json.dumps({"action": "none", "reason": "All open findings were answered."}), [ALPHA], [])
    assert isinstance(ok, NoFurtherQuestion)


@pytest.mark.parametrize(
    "question",
    [
        "What is the postal PIN code of the property this payment relates to?",
        "Which city or PIN code is DEMO PAYER ALPHA located in?",
        "Is the account number ending 7781 your own account?",
        "Is the XXXX7781 account number one of yours?",
        "Is the account ending 7781 one of your own accounts?",
        "Which of your bank accounts received this credit?",
        "Was this a refund of a security deposit?",
        "Did you pay this by debit card at a shop?",
        "Was this payment received through UPI?",
        "Did this relate to a pan-India sales trip?",
        "Did DEMO PAYER ALPHA send this after you shared a QR code?",
    ],
)
def test_b3_legitimate_questions_are_still_allowed(question):
    assert isinstance(check(question), NextQuestion)
