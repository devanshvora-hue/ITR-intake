"""Regression tests for review warnings W7 (several findings for one
transaction), W8 (exception handling) and W9 (more than 50 findings).
Gemini is mocked (no key, no network). Synthetic data only."""

import json
from collections import Counter
from dataclasses import replace
from decimal import Decimal
from types import SimpleNamespace

import httpx
import pytest
import requests
from google.auth import exceptions as auth_errors
from google.genai import errors

import itr_intake.questions as questions_module
from itr_intake import RawTransaction, classify_statement, validate_statement
from itr_intake.intake_workflow import (
    FindingState,
    IntakeContext,
    LifecyclePolicy,
    StopReason,
    WorkflowInputError,
    WorkflowStatus,
    evaluate_findings,
    next_intake_step,
    overflow_finding_ids,
)
from itr_intake.questions import (
    MAX_FINDINGS_IN_PROMPT,
    DuplicateQuestionError,
    GeminiSettings,
    InvalidModelOutput,
    ModelCallError,
    QuestionGenerationError,
    QuestionGenerator,
    build_findings,
    build_prompt,
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
        reply = self.replies.pop(0)
        if isinstance(reply, BaseException):
            raise reply
        if not isinstance(reply, dict):
            return reply
        return SimpleNamespace(text=json.dumps(reply), candidates=[], prompt_feedback=None)


def generator(*replies):
    models = ScriptedModels(*replies)
    return QuestionGenerator(GeminiSettings(api_key="test-key-not-real"), client=SimpleNamespace(models=models)), models


def ask(*fids):
    return {"action": "ask", "question": f"Can you tell us what transaction {fids[0].replace('F', 'T')} was for?",
            "purpose": "Clarify the transaction.", "finding_ids": list(fids)}


NONE = {"action": "none", "reason": "No further question would help."}

PROFILE = load_synthetic_statement().profile


def sent_ids(prompt):
    return [f["finding_id"] for f in json.loads(prompt)["untrusted_data"]["open_findings"]]


def case(n_shops=0, n_family=0):
    """A synthetic statement whose every row is a finding: `n_shops`
    unexplained debits, then `n_family` confirmable family transfers."""
    narrations = [f"UPI/DR/{500000 + i}/DEMO SHOP {i:03d}/okexample/Misc" for i in range(n_shops)]
    narrations += [f"UPI/DR/{600000 + i}/S MEHTA/ICIC/sureshm@okicici/Medicine" for i in range(n_family)]
    rows = [RawTransaction(i, "01/05/2025", n, "100.00", "") for i, n in enumerate(narrations, start=1)]
    opening = Decimal("100000.00")
    report = validate_statement(rows, str(opening), str(opening - 100 * len(rows)))
    return IntakeContext.from_classified(classify_statement(report.transactions, PROFILE))


@pytest.fixture
def synthetic():
    s = load_synthetic_statement()
    report = validate_statement(s.rows, s.opening_balance, s.closing_balance)
    return IntakeContext.from_classified(classify_statement(report.transactions, s.profile))


# === W7: one finding per transaction ===========================================================

def test_w7_each_flagged_transaction_has_exactly_one_finding(synthetic):
    counts = Counter(t for f in synthetic.findings for t in f.transaction_ids)
    assert counts and set(counts.values()) == {1}
    flagged = [t for t in synthetic.transactions if t.review_status.value != "Auto-classified"
               or t.flags or t.category.value == "Others – Needs Review"]
    assert len(flagged) == len(synthetic.findings)


def test_w7_several_issues_are_kept_together_in_one_finding(synthetic):
    by_id = {f.finding_id: f for f in synthetic.findings}
    assert by_id["F0007"].issues == ("unclassified", "large_credit")
    assert by_id["F0009"].issues == ("unclassified", "needs_confirmation", "recurring_credit")
    assert by_id["F0007"].transaction_ids == ("T0007",) and by_id["F0009"].transaction_ids == ("T0009",)


def test_w7_redundant_finding_for_the_same_transaction_is_rejected(synthetic):
    f7 = next(f for f in synthetic.findings if f.finding_id == "F0007")
    split = replace(f7, finding_id="F0107", issues=("large_credit",))
    with pytest.raises(WorkflowInputError, match="F0007 and F0107 both refer to transaction T0007"):
        IntakeContext.from_classified(synthetic.transactions, findings=[*synthetic.findings, split])
    with pytest.raises(WorkflowInputError, match="both refer to transaction T0007"):
        IntakeContext(transactions=synthetic.transactions, findings=(*synthetic.findings, split))


def test_w7_answering_one_finding_never_resolves_another(synthetic):
    gen, _ = generator(ask("F0009", "F0015", "F0021"))
    step = next_intake_step(synthetic, gen)
    ctx = step.context.with_answer(step.result, "Rent from my tenant.")
    states = {s.finding_id: s.state for s in evaluate_findings(ctx)}
    assert {states[i] for i in ("F0009", "F0015", "F0021")} == {FindingState.ANSWERED}
    assert FindingState.RESOLVED not in states.values()
    ctx = ctx.with_confirmation("F0008", "Family Transfer", "confirmed")
    states = {s.finding_id: s.state for s in evaluate_findings(ctx)}
    assert states["F0008"] is FindingState.RESOLVED
    assert states["F0019"] is FindingState.OPEN  # the other confirmable finding is untouched
    assert sum(s is FindingState.RESOLVED for s in states.values()) == 1


def test_w7_repeat_question_through_an_overlapping_finding_is_rejected(synthetic):
    gen, _ = generator(
        {**ask("F0009", "F0015", "F0021"), "question": "What were the credits from NEHA KAPOOR for?"},
        {**ask("F0015"), "question": "Why did NEHA KAPOOR send you this money?"},
    )
    step = next_intake_step(synthetic, gen)
    ctx = step.context.with_answer(step.result, "Rent.")
    with pytest.raises(DuplicateQuestionError):
        next_intake_step(ctx, gen)


# === W8: expected failures handled, programming errors not disguised ===============================

@pytest.mark.parametrize(
    "error",
    [
        errors.ServerError(503, {"error": {"code": 503, "message": "x", "status": "UNAVAILABLE"}}),
        errors.ClientError(429, {"error": {"code": 429, "message": "x", "status": "RESOURCE_EXHAUSTED"}}),
        errors.UnknownApiResponseError("unexpected response shape"),
        httpx.ConnectError("connection refused"),
        httpx.ReadTimeout("read timed out"),
        requests.exceptions.ConnectionError("connection reset"),
        auth_errors.TransportError("auth transport failed"),
        TimeoutError("timed out"),
        ConnectionError("network down"),
    ],
)
def test_w8_expected_model_failures_become_model_call_errors(synthetic, error):
    gen, _ = generator(error)
    with pytest.raises(ModelCallError):
        gen.next_question(synthetic.findings)


@pytest.mark.parametrize(
    "error",
    [TypeError("bad argument"), AttributeError("missing attribute"), KeyError("missing key"),
     AssertionError("broken invariant"), NameError("undefined"), ZeroDivisionError("division"), IndexError("index")],
)
def test_w8_programming_errors_are_not_disguised_as_model_failures(synthetic, error):
    gen, _ = generator(error)
    with pytest.raises(type(error)) as info:
        gen.next_question(synthetic.findings)
    assert not isinstance(info.value, QuestionGenerationError)


def test_w8_unreadable_response_text_vs_programming_error(synthetic):
    class NoParts:
        candidates, prompt_feedback = [], None

        @property
        def text(self):
            raise ValueError("response has no text parts")

    class Buggy(NoParts):
        @property
        def text(self):
            raise AttributeError("bug in response handling")

    gen, _ = generator(NoParts())
    with pytest.raises(InvalidModelOutput, match="could not be read"):
        gen.next_question(synthetic.findings)
    gen, _ = generator(Buggy())
    with pytest.raises(AttributeError):
        gen.next_question(synthetic.findings)


def test_w8_prompt_building_bugs_propagate_before_any_call(synthetic, monkeypatch):
    def broken(*args, **kwargs):
        raise TypeError("bug while building the prompt")

    monkeypatch.setattr(questions_module, "build_prompt", broken)
    gen, models = generator(ask("F0007"))
    with pytest.raises(TypeError):
        gen.next_question(synthetic.findings)
    assert models.calls == 0


def test_w8_error_families_stay_distinct_through_the_workflow(synthetic):
    assert not issubclass(WorkflowInputError, QuestionGenerationError)
    assert not issubclass(QuestionGenerationError, WorkflowInputError)
    gen, _ = generator(TimeoutError("timed out"))
    with pytest.raises(ModelCallError):
        next_intake_step(synthetic, gen)
    gen, _ = generator(KeyError("bug"))
    with pytest.raises(KeyError):
        next_intake_step(synthetic, gen)
    with pytest.raises(WorkflowInputError):
        IntakeContext(transactions=synthetic.transactions, findings=())
    assert synthetic.stopped is None and synthetic.pending is None  # nothing recorded on failure


# === W9: more findings than the prompt limit ===========================================================

def test_w9_exactly_the_limit_has_no_overflow():
    ctx = case(n_shops=MAX_FINDINGS_IN_PROMPT)
    gen, models = generator(ask("F0001"))
    step = next_intake_step(ctx, gen)
    assert step.overflow_finding_ids == () and len(sent_ids(models.prompts[0])) == 50
    assert step.status is WorkflowStatus.QUESTIONS_AVAILABLE


def test_w9_one_over_the_limit_goes_to_ca_review_and_is_not_sent():
    ctx = case(n_shops=51)
    gen, models = generator(ask("F0001"))
    step = next_intake_step(ctx, gen)
    assert step.overflow_finding_ids == ("F0051",)
    status = {s.finding_id: s for s in step.finding_states}["F0051"]
    assert status.state is FindingState.NEEDS_CA_REVIEW and "Beyond the first 50" in status.reason
    sent = sent_ids(models.prompts[0])
    assert len(sent) == 50 and "F0051" not in sent
    assert step.status is WorkflowStatus.QUESTIONS_AVAILABLE


def test_w9_model_cannot_ask_about_an_overflow_finding():
    gen, _ = generator(ask("F0051"))
    with pytest.raises(InvalidModelOutput, match="unknown finding"):
        next_intake_step(case(n_shops=51), gen)


def test_w9_model_no_question_with_overflow_is_ca_review_not_complete():
    gen, _ = generator(NONE)
    step = next_intake_step(case(n_shops=60), gen)
    assert step.status is WorkflowStatus.CA_REVIEW_REQUIRED
    assert len(step.unresolved_finding_ids) == 60 and len(step.overflow_finding_ids) == 10


def test_w9_overflow_blocks_completion_until_resolved():
    ctx = case(n_family=51)  # all confirmable
    for i in range(1, 51):
        ctx = ctx.with_confirmation(f"F{i:04d}", "Family Transfer", "confirmed")
    gen, models = generator(ask("F0051"))
    step = next_intake_step(ctx, gen)
    assert step.status is WorkflowStatus.CA_REVIEW_REQUIRED and step.status is not WorkflowStatus.COMPLETE
    assert step.unresolved_finding_ids == ("F0051",) and step.state_of("F0051") is FindingState.NEEDS_CA_REVIEW
    assert step.context.stopped is StopReason.NOTHING_LEFT_TO_ASK and models.calls == 0
    # A structured confirmation (no model, no judgement) can still resolve it.
    done = next_intake_step(step.context.with_confirmation("F0051", "Family Transfer", "confirmed"), gen)
    assert done.status is WorkflowStatus.COMPLETE and models.calls == 0


def test_w9_complete_only_when_every_finding_is_resolved():
    scenarios = []
    ctx = case(n_family=52)
    gen, _ = generator(*[NONE] * 3)
    scenarios.append(next_intake_step(ctx, gen))
    for i in range(1, 53):
        ctx = ctx.with_confirmation(f"F{i:04d}", "Family Transfer", "confirmed" if i != 52 else "unsure")
    scenarios.append(next_intake_step(ctx, gen))
    scenarios.append(next_intake_step(ctx.with_confirmation("F0052", "Family Transfer", "confirmed"), gen))
    for step in scenarios:
        all_resolved = all(s.state is FindingState.RESOLVED for s in step.finding_states)
        assert (step.status is WorkflowStatus.COMPLETE) == all_resolved
    assert [s.status for s in scenarios] == [WorkflowStatus.CA_REVIEW_REQUIRED] * 2 + [WorkflowStatus.COMPLETE]


def test_w9_overflow_is_stable_and_configurable(synthetic):
    policy = LifecyclePolicy(max_findings_for_questioning=3)
    expected = tuple(f.finding_id for f in synthetic.findings[3:])
    assert overflow_finding_ids(synthetic, policy) == expected
    gen, models = generator(ask("F0004"), NONE)
    step = next_intake_step(synthetic, gen, policy)
    assert sent_ids(models.prompts[0]) == ["F0004", "F0005", "F0007"]
    later = next_intake_step(step.context.with_answer(step.result, "A SIP."), gen, policy)
    assert later.overflow_finding_ids == expected == step.overflow_finding_ids
    assert all(later.state_of(i) is FindingState.NEEDS_CA_REVIEW for i in expected)


@pytest.mark.parametrize("bad", [0, MAX_FINDINGS_IN_PROMPT + 1, True, "10"])
def test_w9_invalid_questioning_limit_is_rejected(bad):
    with pytest.raises(ValueError):
        LifecyclePolicy(max_findings_for_questioning=bad)


def test_w9_generator_refuses_to_drop_findings_silently():
    findings = list(case(n_shops=51).findings)
    gen, models = generator(ask("F0001"))
    with pytest.raises(ValueError, match="exceed the prompt limit"):
        gen.next_question(findings)
    with pytest.raises(ValueError, match="exceed the prompt limit"):
        build_prompt(findings, [])
    assert models.calls == 0
    assert len(json.loads(build_prompt(findings[:50], []))["untrusted_data"]["open_findings"]) == 50
    assert build_findings(case(n_shops=51).transactions) == findings  # nothing removed from the case
