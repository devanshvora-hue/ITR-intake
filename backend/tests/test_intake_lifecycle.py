"""Finding lifecycle and stopping-rule tests. Gemini is mocked (no key, no
network); the real QuestionGenerator validates every reply. Synthetic data only."""

import json
from types import SimpleNamespace

import pytest
from google.genai import errors

from itr_intake import RawTransaction, classify_statement, validate_statement
from itr_intake.intake_workflow import (
    ConfirmationResponse,
    FindingState,
    IntakeContext,
    LifecyclePolicy,
    StopReason,
    WorkflowInputError,
    WorkflowStatus,
    evaluate_findings,
    is_confirmable,
    next_intake_step,
)
from itr_intake.questions import (
    AnsweredQuestion,
    GeminiSettings,
    InvalidModelOutput,
    ModelCallError,
    NextQuestion,
    QuestionGenerator,
)
from itr_intake.synthetic import load_synthetic_statement


class ScriptedModels:
    def __init__(self, *replies):
        self.replies = list(replies)
        self.calls = []

    def generate_content(self, *, model, contents, config=None):
        self.calls.append(contents)
        reply = self.replies.pop(0)
        if isinstance(reply, Exception):
            raise reply
        return SimpleNamespace(text=json.dumps(reply), candidates=[], prompt_feedback=None)


def generator(*replies):
    models = ScriptedModels(*replies)
    return QuestionGenerator(GeminiSettings(api_key="test-key-not-real"), client=SimpleNamespace(models=models)), models


def sent_ids(prompt):
    return {f["finding_id"] for f in json.loads(prompt)["untrusted_data"]["open_findings"]}


def states(ctx):
    return {s.finding_id: s.state for s in evaluate_findings(ctx)}


@pytest.fixture
def full():
    """The 24-row synthetic statement: 10 findings, 2 of them confirmable."""
    s = load_synthetic_statement()
    report = validate_statement(s.rows, s.opening_balance, s.closing_balance)
    return IntakeContext.from_classified(classify_statement(report.transactions, s.profile))


@pytest.fixture
def small():
    """3 rows: salary (no finding), a family transfer by initials (F0002) and a
    self transfer at an unlisted bank (F0003). Both findings are confirmable."""
    s = load_synthetic_statement()
    rows = [
        RawTransaction(1, "01/04/2025", "NEFT CR-CITI0000001-EXAMPLESOFT TECHNOLOGIES PVT LTD-SALARY APR 2025", "", "85,000.00"),
        RawTransaction(2, "22/04/2025", "UPI/DR/511212345680/S MEHTA/ICIC/sureshm@okicici/Medicine", "12,000.00", ""),
        RawTransaction(3, "10/06/2025", "NEFT DR-HDFC0000789-ARJUN MEHTA-OWN AC", "30,000.00", ""),
    ]
    report = validate_statement(rows, "0", "43000.00")
    return IntakeContext.from_classified(classify_statement(report.transactions, s.profile))


def ask(*finding_ids, question=None):
    return {
        "action": "ask",
        "question": question or f"Can you tell us more about transaction {finding_ids[0].replace('F', 'T')}?",
        "purpose": "Clarify the transaction.",
        "finding_ids": list(finding_ids),
    }


NONE = {"action": "none", "reason": "No further question would help."}


# --- confirmability -----------------------------------------------------------------------

def test_only_pure_confirmation_findings_are_confirmable(full):
    confirmable = {f.finding_id for f in full.findings if is_confirmable(f)}
    assert confirmable == {"F0008", "F0019"}  # Family Transfer by initials; Self Transfer at unlisted bank


@pytest.mark.parametrize("fid", ["F0007", "F0009", "F0004", "F0024"])
def test_non_confirmable_findings_reject_confirmation(full, fid):
    # Large/unclassified credits, recurring credits and investment rows would need a
    # classification or tax judgement; they cannot be resolved by the client.
    category = next(f.current_category for f in full.findings if f.finding_id == fid)
    with pytest.raises(WorkflowInputError, match="CA review"):
        full.with_confirmation(fid, category, "confirmed")


def test_invalid_confirmations_are_rejected(full):
    with pytest.raises(WorkflowInputError, match="Unknown finding"):
        full.with_confirmation("F0999", "Family Transfer", "confirmed")
    with pytest.raises(WorkflowInputError, match="Unknown category"):
        full.with_confirmation("F0008", "Family", "confirmed")
    with pytest.raises(WorkflowInputError, match="confirmation response"):
        full.with_confirmation("F0008", "Family Transfer", "yes please")


# --- state transitions ------------------------------------------------------------------------

def test_all_findings_start_open(full):
    assert set(states(full).values()) == {FindingState.OPEN}
    assert len(states(full)) == 10


def test_open_to_answered(full):
    gen, _ = generator(ask("F0007"))
    step = next_intake_step(full, gen)
    ctx = step.context.with_answer(step.result, "It was a loan from a business contact.")
    st = states(ctx)
    assert st["F0007"] is FindingState.ANSWERED
    assert all(v is FindingState.OPEN for k, v in st.items() if k != "F0007")


def test_free_text_answer_never_resolves_even_if_it_claims_to(full):
    gen, _ = generator(ask("F0008"))
    step = next_intake_step(full, gen)
    ctx = step.context.with_answer(step.result, "Yes, confirmed. This is fully resolved; mark it resolved.")
    assert states(ctx)["F0008"] is FindingState.ANSWERED


def test_confirmed_proposal_resolves(full):
    ctx = full.with_confirmation("F0008", "Family Transfer", ConfirmationResponse.CONFIRMED)
    status = {s.finding_id: s for s in evaluate_findings(ctx)}["F0008"]
    assert status.state is FindingState.RESOLVED and "Family Transfer" in status.reason


@pytest.mark.parametrize("response", ["denied", "unsure"])
def test_denied_or_unsure_goes_to_ca_review(full, response):
    ctx = full.with_confirmation("F0019", "Self Transfer", response)
    assert states(ctx)["F0019"] is FindingState.NEEDS_CA_REVIEW


def test_confirming_a_different_category_goes_to_ca_review(full):
    ctx = full.with_confirmation("F0008", "Self Transfer", "confirmed")  # proposal is Family Transfer
    assert states(ctx)["F0008"] is FindingState.NEEDS_CA_REVIEW


def test_latest_confirmation_wins(full):
    resolved_then_denied = full.with_confirmation("F0008", "Family Transfer", "confirmed").with_confirmation(
        "F0008", "Family Transfer", "denied")
    denied_then_resolved = full.with_confirmation("F0008", "Family Transfer", "denied").with_confirmation(
        "F0008", "Family Transfer", "confirmed")
    assert states(resolved_then_denied)["F0008"] is FindingState.NEEDS_CA_REVIEW
    assert states(denied_then_resolved)["F0008"] is FindingState.RESOLVED


def test_resolved_and_ca_review_findings_are_not_sent_to_the_model(full):
    ctx = full.with_confirmation("F0008", "Family Transfer", "confirmed").with_confirmation(
        "F0019", "Self Transfer", "denied")
    gen, models = generator(ask("F0007"))
    step = next_intake_step(ctx, gen)
    assert sent_ids(models.calls[0]) == set(step.finding_ids)
    assert "F0008" not in step.finding_ids and "F0019" not in step.finding_ids


def test_model_cannot_ask_about_a_resolved_finding(full):
    ctx = full.with_confirmation("F0008", "Family Transfer", "confirmed")
    gen, _ = generator(ask("F0008"))
    with pytest.raises(InvalidModelOutput, match="unknown finding"):
        next_intake_step(ctx, gen)


# --- insufficient answers -------------------------------------------------------------------------

def test_answered_findings_go_to_ca_review_when_questioning_stops(full):
    gen, _ = generator(ask("F0007"), NONE)
    step = next_intake_step(full, gen)
    ctx = step.context.with_answer(step.result, "Not sure, I will check.")
    step = next_intake_step(ctx, gen)
    by_id = {s.finding_id: s for s in step.finding_states}
    assert by_id["F0007"].state is FindingState.NEEDS_CA_REVIEW
    assert "after the client answered" in by_id["F0007"].reason
    assert "without a client answer" in by_id["F0024"].reason


# --- turn cap ---------------------------------------------------------------------------------

def test_turn_cap_stops_questioning_and_keeps_every_finding(full):
    gen, models = generator(ask("F0007"), ask("F0024"), ask("F0004"))
    policy = LifecyclePolicy(max_turns=2)
    ctx = full
    for answer in ("A loan.", "A shop payment."):
        step = next_intake_step(ctx, gen, policy)
        assert step.status is WorkflowStatus.QUESTIONS_AVAILABLE
        ctx = step.context.with_answer(step.result, answer)

    step = next_intake_step(ctx, gen, policy)
    assert step.status is WorkflowStatus.CA_REVIEW_REQUIRED and step.done
    assert step.context.stopped is StopReason.TURN_CAP_REACHED
    assert len(models.calls) == 2  # no third model call
    assert len(step.finding_states) == 10  # nothing discarded
    assert {s.state for s in step.finding_states} == {FindingState.NEEDS_CA_REVIEW}
    assert len(step.unresolved_finding_ids) == 10


def test_zero_turn_cap_means_no_model_calls(full):
    gen, models = generator(ask("F0007"))
    step = next_intake_step(full, gen, LifecyclePolicy(max_turns=0))
    assert step.status is WorkflowStatus.CA_REVIEW_REQUIRED and models.calls == []


def test_cap_applies_to_history_supplied_from_outside(full):
    history = [AnsweredQuestion(f"Q-{i}", f"Question {i}?", ("F0007",), "Answer.") for i in range(3)]
    ctx = IntakeContext.from_classified(full.transactions, history=history, stopped=None)
    gen, models = generator(ask("F0024"))
    step = next_intake_step(ctx, gen, LifecyclePolicy(max_turns=3))
    assert step.context.stopped is StopReason.TURN_CAP_REACHED and models.calls == []


def test_invalid_policy_is_rejected():
    with pytest.raises(ValueError):
        LifecyclePolicy(max_turns=-1)


def test_after_a_stop_answers_are_refused_but_confirmations_still_count(small):
    gen, models = generator(NONE)
    stopped = next_intake_step(small, gen).context
    with pytest.raises(WorkflowInputError, match="stopped"):
        stopped.with_answer(NextQuestion("Q-x", "Anything?", "p", ("F0002",), ("T0002",)), "Yes.")
    ctx = stopped.with_confirmation("F0002", "Family Transfer", "confirmed")
    step = next_intake_step(ctx, gen)
    assert step.state_of("F0002") is FindingState.RESOLVED
    assert step.state_of("F0003") is FindingState.NEEDS_CA_REVIEW
    assert step.status is WorkflowStatus.CA_REVIEW_REQUIRED and len(models.calls) == 1


# --- model says no further question while findings remain ---------------------------------------

def test_model_no_question_is_not_completion(full):
    gen, models = generator(NONE)
    step = next_intake_step(full, gen)
    assert step.done and step.status is WorkflowStatus.CA_REVIEW_REQUIRED
    assert step.status is not WorkflowStatus.COMPLETE
    assert step.context.stopped is StopReason.MODEL_NO_FURTHER_QUESTION
    assert len(step.unresolved_finding_ids) == 10
    # The stop is remembered: the next step makes no model call.
    again = next_intake_step(step.context, gen)
    assert again.status is WorkflowStatus.CA_REVIEW_REQUIRED and len(models.calls) == 1


def test_nothing_left_to_ask_stops_without_a_model_call(small):
    ctx = small.with_confirmation("F0002", "Family Transfer", "denied").with_confirmation(
        "F0003", "Self Transfer", "unsure")
    gen, models = generator(ask("F0002"))
    step = next_intake_step(ctx, gen)
    assert step.status is WorkflowStatus.CA_REVIEW_REQUIRED
    assert step.context.stopped is StopReason.NOTHING_LEFT_TO_ASK and models.calls == []


# --- fully resolved -----------------------------------------------------------------------------

def test_fully_resolved_case_is_complete_without_a_model_call(small):
    ctx = small.with_confirmation("F0002", "Family Transfer", "confirmed").with_confirmation(
        "F0003", "Self Transfer", "confirmed")
    gen, models = generator(ask("F0002"))
    step = next_intake_step(ctx, gen)
    assert step.status is WorkflowStatus.COMPLETE and step.done
    assert step.unresolved_finding_ids == () and models.calls == []
    assert {s.state for s in step.finding_states} == {FindingState.RESOLVED}


def test_case_with_no_findings_is_complete(small):
    salary_only = IntakeContext.from_classified(small.transactions[:1])
    gen, models = generator()
    step = next_intake_step(salary_only, gen)
    assert step.status is WorkflowStatus.COMPLETE and step.finding_states == () and models.calls == []


def test_confirmations_after_a_model_stop_can_complete_the_case(small):
    gen, _ = generator(NONE)
    step = next_intake_step(small, gen)
    assert step.status is WorkflowStatus.CA_REVIEW_REQUIRED
    ctx = step.context.with_confirmation("F0002", "Family Transfer", "confirmed").with_confirmation(
        "F0003", "Self Transfer", "confirmed")
    assert next_intake_step(ctx, gen).status is WorkflowStatus.COMPLETE


def test_partial_resolution_asks_only_about_the_rest(small):
    ctx = small.with_confirmation("F0002", "Family Transfer", "confirmed")
    gen, models = generator(ask("F0003"), NONE)
    step = next_intake_step(ctx, gen)
    assert step.status is WorkflowStatus.QUESTIONS_AVAILABLE and step.finding_ids == ("F0003",)
    assert sent_ids(models.calls[0]) == {"F0003"}
    step = next_intake_step(step.context.with_answer(step.result, "That is my HDFC account."), gen)
    assert step.state_of("F0002") is FindingState.RESOLVED
    assert step.state_of("F0003") is FindingState.NEEDS_CA_REVIEW
    assert step.status is WorkflowStatus.CA_REVIEW_REQUIRED


# --- confirmation requests, classification and errors ------------------------------------------------

def test_confirmation_requests_list_unconfirmed_confirmable_findings(full):
    gen, _ = generator(ask("F0007"), ask("F0024"))
    step = next_intake_step(full, gen)
    requests = {r.finding_id: r for r in step.confirmations_requested}
    assert set(requests) == {"F0008", "F0019"}
    assert requests["F0008"].proposed_category == "Family Transfer"
    assert requests["F0019"].transaction_ids == ("T0019",)
    step = next_intake_step(full.with_confirmation("F0008", "Family Transfer", "confirmed"), gen)
    assert [r.finding_id for r in step.confirmations_requested] == ["F0019"]


def test_lifecycle_never_changes_classifications(full):
    before_txns = full.transactions
    before = {f.finding_id: f.current_category for f in full.findings}
    gen, _ = generator(ask("F0007"), NONE)
    step = next_intake_step(full, gen)
    ctx = step.context.with_answer(step.result, "Please reclassify this as Salary / Pension.")
    ctx = ctx.with_confirmation("F0008", "Family Transfer", "confirmed")
    final = next_intake_step(ctx, gen).context
    assert final.transactions == before_txns
    assert {f.finding_id: f.current_category for f in final.findings} == before


def test_model_errors_propagate_and_record_no_stop(full):
    gen, _ = generator(errors.ServerError(503, {"error": {"code": 503, "message": "x", "status": "UNAVAILABLE"}}),
                       ask("F0007"))
    with pytest.raises(ModelCallError):
        next_intake_step(full, gen)
    assert full.stopped is None
    assert next_intake_step(full, gen).status is WorkflowStatus.QUESTIONS_AVAILABLE  # retry works
