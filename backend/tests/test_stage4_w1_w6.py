"""Regression tests for review warnings W1 (count questions issued; reuse the
pending question) and W6 (sanitised model-facing prompt). Gemini is mocked
(no key, no network). Synthetic data only."""

import json
import logging
from dataclasses import replace
from types import SimpleNamespace

import pytest

from itr_intake import classify_statement, validate_statement
from itr_intake.intake_workflow import (
    FindingState,
    IntakeContext,
    LifecyclePolicy,
    StopReason,
    WorkflowInputError,
    WorkflowStatus,
    next_intake_step,
)
from itr_intake.questions import (
    SYSTEM_INSTRUCTION,
    AnsweredQuestion,
    GeminiSettings,
    InvalidModelOutput,
    NextQuestion,
    QuestionGenerator,
    build_findings,
    build_prompt,
    sanitise_for_model,
    validate_reply,
)
from itr_intake.synthetic import load_synthetic_statement


class ScriptedModels:
    def __init__(self, *replies):
        self.replies, self.prompts = list(replies), []

    @property
    def calls(self):
        return len(self.prompts)

    def generate_content(self, *, model, contents, config=None):
        self.prompts.append(contents)
        return SimpleNamespace(text=json.dumps(self.replies.pop(0)), candidates=[], prompt_feedback=None)


def generator(*replies):
    models = ScriptedModels(*replies)
    return QuestionGenerator(GeminiSettings(api_key="test-key-not-real"), client=SimpleNamespace(models=models)), models


def ask(fid, text=None):
    return {"action": "ask", "question": text or f"Can you tell us what transaction {fid.replace('F', 'T')} was for?",
            "purpose": "Clarify the transaction.", "finding_ids": [fid]}


NONE = {"action": "none", "reason": "No further question would help."}


@pytest.fixture
def classified():
    s = load_synthetic_statement()
    report = validate_statement(s.rows, s.opening_balance, s.closing_balance)
    return tuple(classify_statement(report.transactions, s.profile))


@pytest.fixture
def ctx(classified):
    return IntakeContext.from_classified(classified)


# === W1: questions issued, pending question reuse ==============================================

def test_w1_repeated_calls_with_the_returned_context_reuse_the_pending_question(ctx):
    gen, models = generator(ask("F0007"))
    first = next_intake_step(ctx, gen)
    assert first.context.pending == first.result and first.questions_issued == 1 and not first.reused_pending
    step = first
    for _ in range(5):
        step = next_intake_step(step.context, gen)
        assert step.result == first.result and step.reused_pending
        assert step.status is WorkflowStatus.QUESTIONS_AVAILABLE
    assert models.calls == 1 and step.questions_issued == 1


def test_w1_unanswered_questions_count_towards_the_cap(ctx):
    gen, models = generator(ask("F0007"), ask("F0024"), ask("F0004"))
    policy = LifecyclePolicy(max_turns=2)
    step = next_intake_step(ctx, gen, policy)
    step = next_intake_step(step.context.with_answer(step.result, "A loan."), gen, policy)
    assert step.questions_issued == 2 and step.answered_count == 1
    for _ in range(10):  # the client never answers the second question
        step = next_intake_step(step.context, gen, policy)
    assert models.calls == 2 and step.reused_pending
    step = next_intake_step(step.context.with_answer(step.result, "A shop."), gen, policy)
    assert step.status is WorkflowStatus.CA_REVIEW_REQUIRED
    assert step.context.stopped is StopReason.TURN_CAP_REACHED and models.calls == 2


@pytest.mark.parametrize("cap", [1, 2, 3])
def test_w1_exact_cap_boundary(ctx, cap):
    gen, models = generator(*[ask(f) for f in ("F0007", "F0024", "F0004", "F0012")])
    policy = LifecyclePolicy(max_turns=cap)
    step = next_intake_step(ctx, gen, policy)
    for n in range(1, cap + 1):
        assert step.status is WorkflowStatus.QUESTIONS_AVAILABLE and step.questions_issued == n
        assert next_intake_step(step.context, gen, policy).reused_pending  # at the cap the pending one is still served
        step = next_intake_step(step.context.with_answer(step.result, f"Answer {n}."), gen, policy)
    assert step.status is WorkflowStatus.CA_REVIEW_REQUIRED
    assert step.context.stopped is StopReason.TURN_CAP_REACHED
    assert models.calls == cap
    assert {s.state for s in step.finding_states} == {FindingState.NEEDS_CA_REVIEW}


def test_w1_withdrawn_pending_question_stays_counted(ctx):
    gen, models = generator(ask("F0008"), ask("F0007"))
    step = next_intake_step(ctx, gen)
    assert step.result.finding_ids == ("F0008",)
    resolved = step.context.with_confirmation("F0008", "Family Transfer", "confirmed")
    nxt = next_intake_step(resolved, gen)  # pending question about a resolved finding is withdrawn
    assert nxt.result.finding_ids == ("F0007",) and not nxt.reused_pending
    assert nxt.questions_issued == 2 and models.calls == 2
    capped = next_intake_step(resolved, gen, LifecyclePolicy(max_turns=1))
    assert capped.status is WorkflowStatus.CA_REVIEW_REQUIRED and capped.context.stopped is StopReason.TURN_CAP_REACHED
    assert capped.state_of("F0008") is FindingState.RESOLVED and models.calls == 2


def test_w1_only_the_pending_question_can_be_answered(ctx):
    gen, _ = generator(ask("F0007"))
    step = next_intake_step(ctx, gen)
    other = NextQuestion("Q-other", "What was transaction T0024 for?", "p", ("F0024",), ("T0024",))
    with pytest.raises(WorkflowInputError, match="pending question"):
        step.context.with_answer(other, "Something.")
    answered = step.context.with_answer(step.result, "A loan.")
    assert answered.pending is None and answered.questions_issued == 1 and len(answered.history) == 1


def test_w1_stopped_case_makes_no_further_calls(ctx):
    gen, models = generator(NONE)
    step = next_intake_step(ctx, gen)
    for _ in range(5):
        step = next_intake_step(step.context, gen)
        assert step.status is WorkflowStatus.CA_REVIEW_REQUIRED
    assert models.calls == 1
    with pytest.raises(WorkflowInputError, match="stopped"):
        step.context.with_answer(NextQuestion("Q-x", "Anything?", "p", ("F0007",), ("T0007",)), "Yes.")


def test_w1_continuation_rejects_rollbacks(ctx):
    gen, _ = generator(ask("F0007"), ask("F0024"))
    step = next_intake_step(ctx, gen)
    step.context.assert_continues(ctx)
    # Handing back the pre-step context loses the pending question and its count.
    with pytest.raises(WorkflowInputError, match="Questions issued went down"):
        ctx.assert_continues(step.context)
    # Replacing a pending question before it is answered is rejected.
    swapped = replace(step.context, pending=next_intake_step(ctx, gen).result, questions_issued=2)
    with pytest.raises(WorkflowInputError, match="replaced before it was answered"):
        swapped.assert_continues(step.context)
    step.context.with_answer(step.result, "A loan.").assert_continues(step.context)


def test_w1_documented_limit_an_older_context_triggers_a_new_call(ctx):
    # The module cannot know that a newer context exists; the API must persist it.
    gen, models = generator(ask("F0007"), ask("F0007"))
    next_intake_step(ctx, gen)
    next_intake_step(ctx, gen)
    assert models.calls == 2


@pytest.mark.parametrize(
    "kwargs, match",
    [
        (dict(pending=NextQuestion("Q-1", "x?", "p", ("F0999",), ("T0999",))), "unknown finding"),
        (dict(pending=NextQuestion("Q-1", "x?", "p", ("F0007",), ("T0001",))), "transaction IDs"),
        (dict(pending=NextQuestion("Q-1", "x?", "p", ("F0007",), ("T0007",)),
              history=(AnsweredQuestion("Q-1", "x?", ("F0007",), "a"),)), "already been answered"),
        (dict(questions_issued=0, history=(AnsweredQuestion("Q-1", "x?", ("F0007",), "a"),)), "less than"),
        (dict(questions_issued=True), "integer"),
    ],
)
def test_w1_pending_and_count_are_validated(classified, kwargs, match):
    with pytest.raises(WorkflowInputError, match=match):
        IntakeContext(transactions=classified, findings=tuple(build_findings(classified)), **kwargs)


def test_w1_restoring_pending_state_requires_explicit_stop_and_is_reused(classified):
    pending = NextQuestion("Q-r", "Can you tell us what transaction T0007 was for?", "p", ("F0007",), ("T0007",))
    with pytest.raises(WorkflowInputError, match="pass `stopped` explicitly"):
        IntakeContext.from_classified(classified, pending=pending)
    restored = IntakeContext.from_classified(classified, pending=pending, questions_issued=3, stopped=None)
    gen, models = generator(ask("F0024"))
    step = next_intake_step(restored, gen)
    assert step.result == pending and step.reused_pending and models.calls == 0 and step.questions_issued == 3


# === W6: sanitised model-facing prompt ============================================================

def test_w6_exact_prompt_payload_is_sanitised(classified):
    findings = [f for f in build_findings(classified) if f.finding_id in ("F0008", "F0009")]
    history = [AnsweredQuestion(
        "Q-1", "Is 9800000001 your number, and did you pay via arjun.demo@okexample from HDFC0000789?",
        ("F0008",), "Yes, from my a/c 50100012345678; my PAN is ABCDE1234F and Aadhaar 1234 5678 9012.")]
    payload = json.loads(build_prompt(findings, history))["untrusted_data"]
    assert payload == {
        "open_findings": [
            {
                "finding_id": "F0008",
                "issues": ["needs_confirmation"],
                "date": "22-04-2025",
                "direction": "debit",
                "amount": "₹12,000.00",
                "narration": "UPI/DR/XXXX5680/S MEHTA/ICIC/[handle]/Medicine",
                "counterparty": "S MEHTA",
                "current_category": "Family Transfer",
                "review_status": "Needs confirmation",
                "review_notes": ["The proposed category needs the client's confirmation."],
            },
            {
                "finding_id": "F0009",
                "issues": ["unclassified", "needs_confirmation", "recurring_credit"],
                "date": "25-04-2025",
                "direction": "credit",
                "amount": "₹15,000.00",
                "narration": "UPI/CR/XXXX5681/NEHA KAPOOR/YESB/[handle]/Apr",
                "counterparty": "NEHA KAPOOR",
                "current_category": "Others – Needs Review",
                "review_status": "Needs confirmation",
                "review_notes": [
                    "The narration does not identify what the transaction was.",
                    "The proposed category needs the client's confirmation.",
                    "One of several similar credits from the same source at regular intervals.",
                ],
            },
        ],
        "answered_questions": [
            {
                "question": "Is XXXX0001 your number, and did you pay via [handle] from HDFCXXXXXXX?",
                "finding_ids": ["F0008"],
                "client_answer": "Yes, from my a/c XXXX5678; my PAN is [PAN] and Aadhaar XXXX9012.",
            }
        ],
    }


def test_w6_no_original_sensitive_strings_reach_the_model(classified):
    findings = build_findings(classified)
    history = [AnsweredQuestion("Q-1", "Did you use arjun.demo@okexample or +91 98000 00001?", ("F0008",),
                                "Card 4111 1111 1111 1111, account 50100012345678.")]
    gen, models = generator(NONE)
    gen.next_question(findings, history)
    sent = models.prompts[0]
    for raw in ("sureshm@okicici", "neha.k@okyes", "krishnastores@paytm", "arjun.demo@okexample",
                "511212345680", "511512345681", "50100012345678", "98000 00001", "4111 1111 1111 1111",
                "UTIB0000456", "CITI0000001", "Suresh Mehta", "SURESH", "father", "spouse", "Arjun Mehta"):
        assert raw not in sent, raw
    assert "classifier_reason" not in sent
    # Facts needed for useful questions are still there.
    for kept in ("R K TRADERS", "NEHA KAPOOR", "S MEHTA", "₹1,75,000.00", "18-04-2025", "Family Transfer"):
        assert kept in sent, kept


def test_w6_earlier_question_text_is_sanitised_and_clipped(classified):
    long_q = "Was this from arjun.demo@okexample " + "Z" * 1000 + "?"
    prompt = build_prompt(build_findings(classified), [AnsweredQuestion("Q-1", long_q, ("F0008",), "No.")])
    sent_q = json.loads(prompt)["untrusted_data"]["answered_questions"][0]["question"]
    assert "arjun.demo@okexample" not in sent_q and "[handle]" in sent_q
    assert len(sent_q) <= 300 + len("…[truncated]")


@pytest.mark.parametrize(
    "raw, expected",
    [
        ("UPI/DR/511212345680/S MEHTA/ICIC/sureshm@okicici/Medicine", "UPI/DR/XXXX5680/S MEHTA/ICIC/[handle]/Medicine"),
        ("mail demo.payer@example.com", "mail [handle]"),
        ("PAN ABCDE1234F", "PAN [PAN]"),
        ("NEFT DR-HDFC0000789-ARJUN MEHTA-OWN AC", "NEFT DR-HDFCXXXXXXX-ARJUN MEHTA-OWN AC"),
        ("call +91 98000 00001", "call [phone]"),
        ("Aadhaar 1234 5678 9012", "Aadhaar XXXX9012"),
        ("card 4111-1111-1111-1111", "card XXXX1111"),
        ("a/c 39876543210", "a/c XXXX3210"),
    ],
)
def test_w6_sanitiser_masks_identifiers(raw, expected):
    assert sanitise_for_model(raw) == expected


@pytest.mark.parametrize(
    "text",
    [
        "SB INTEREST CREDIT 01-04-2025 TO 30-06-2025",
        "INCOME TAX REFUND CMP ITD AY 2024-25",
        "NEFT CR-X-R K TRADERS-PAYMENT REF 7781",
        "TRF TO PPF A/C XXXX4321",
        "₹48,500.00 on 14-05-2025 in FY 2025-26",
        "NEHA KAPOOR",
    ],
)
def test_w6_sanitiser_keeps_useful_facts(text):
    assert sanitise_for_model(text) == text


def test_w6_underlying_findings_and_transactions_are_unchanged(classified):
    findings = build_findings(classified)
    before = (list(findings), list(classified))
    build_prompt(findings, [])
    assert (list(findings), list(classified)) == before
    f8 = next(f for f in findings if f.finding_id == "F0008")
    assert "sureshm@okicici" in f8.narration and "Suresh Mehta" in f8.classifier_reason


def test_w6_masked_reference_digits_remain_usable_but_not_invented(classified):
    findings = [f for f in build_findings(classified) if f.finding_id == "F0008"]
    ok = {"action": "ask", "question": "Was the payment with reference ending 5680 for medicine for a relative?",
          "purpose": "Clarify.", "finding_ids": ["F0008"]}
    assert isinstance(validate_reply(json.dumps(ok), findings, []), NextQuestion)
    bad = {**ok, "question": "Was the payment with reference ending 9999 for medicine?"}
    with pytest.raises(InvalidModelOutput, match="number"):
        validate_reply(json.dumps(bad), findings, [])
    assert "masked" in SYSTEM_INSTRUCTION and "XXXX5680" in SYSTEM_INSTRUCTION


def test_w6_nothing_is_logged_or_printed(classified, caplog, capsys):
    caplog.set_level(logging.DEBUG)
    ctx = IntakeContext.from_classified(classified)
    gen, _ = generator(ask("F0007"))
    step = next_intake_step(ctx, gen)
    next_intake_step(step.context.with_answer(step.result, "My a/c 50100012345678."), generator(NONE)[0])
    out = capsys.readouterr()
    assert out.out == "" and out.err == ""
    assert not [r for r in caplog.records if r.name.startswith("itr_intake")]
