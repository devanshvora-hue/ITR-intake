"""Stateless intake workflow with a deterministic finding lifecycle.

classified statement + history + confirmations -> next question, or a stop.

This module composes existing pieces and adds deterministic lifecycle rules:
  - findings come from `questions.build_findings` over the classifier's output
    (or are supplied by the caller and checked against it);
  - questions come from a `QuestionGenerator`, which builds the prompt (answers
    as untrusted data), validates the model's reply and rejects repeats;
  - finding states and stopping are decided here, by fixed rules, never by
    Gemini. Nothing here changes a transaction's category.

Finding lifecycle (evaluated for each finding, first matching rule wins)
-----------------------------------------------------------------------
1. RESOLVED        the finding is *confirmable* (its only issue is
                   "needs_confirmation": the classifier proposed a specific
                   category and asked for confirmation) and the client's latest
                   structured confirmation is CONFIRMED for that same proposed
                   category.
2. NEEDS_CA_REVIEW the client's latest confirmation is DENIED or UNSURE, or
                   names a category other than the current proposal; or the
                   finding is beyond the questioning limit (overflow); or
                   automated questioning has stopped (turn cap, the model had
                   no further question, or nothing was left to ask) and rule 1
                   does not apply.
3. ANSWERED        at least one answered question references the finding.
4. OPEN            otherwise.

A free-text answer never resolves a finding, and neither does a model reply
that no further question is needed: deciding that a free-text answer is
sufficient, or choosing a category for an unclassified or flagged transaction,
would be a classification or tax judgement. Such findings stay ANSWERED while
questioning continues and become NEEDS_CA_REVIEW when it stops; they are never
dropped.

Workflow status for a step
--------------------------
QUESTIONS_AVAILABLE           a validated next question was produced.
CA_REVIEW_REQUIRED            automated questioning has stopped and at least
                              one finding is not RESOLVED.
COMPLETE                      no unresolved findings remain (all RESOLVED, or
                              there were none).

Stopping rules, checked in order before any model call:
  a. no unresolved findings                -> COMPLETE (no model call);
  b. questioning already stopped           -> CA_REVIEW_REQUIRED (no model call);
  c. a question is pending and any of its findings is still OPEN or ANSWERED
                                           -> return the same question
                                              (QUESTIONS_AVAILABLE, no model call);
                                              otherwise withdraw it (it stays counted);
  d. questions issued >= policy.max_turns  -> stop (TURN_CAP_REACHED);
     (findings beyond policy.max_findings_for_questioning, in statement order,
     are NEEDS_CA_REVIEW from the start and never offered to the model, so at
     most that many findings are ever sent; see `overflow_finding_ids`)
  e. no OPEN or ANSWERED findings left     -> stop (NOTHING_LEFT_TO_ASK);
  f. otherwise ask the generator about OPEN and ANSWERED findings only; a new
     question becomes `pending` and increments `questions_issued`; a "no
     further question" reply stops questioning (MODEL_NO_FURTHER_QUESTION).
The cap counts questions issued, answered or not. A stop or pending question
is recorded on the returned `step.context`; the caller must continue from it.
Confirmations may still be recorded after a stop and can resolve confirmable
findings.

What this module enforces in memory, for contexts derived from each other
through steps and the with_* methods: findings match the classifier output;
history, confirmations and the pending question reference known findings; a
pending question is reused, not regenerated, and only it can be answered;
questions issued never decrease and the cap is applied to them; a stop is
never cleared. What it cannot enforce: that a context handed to it is the
latest one. A caller that passes an older context (or rebuilds one with a
shorter history, no pending question or no stop) gets that older state. A
future API must therefore load history, confirmations, the pending question,
questions_issued and the stop from authoritative server-side storage, never
from a client request, and check `new.assert_continues(stored)` before saving.

Generator errors (`QuestionGenerationError` and subclasses) propagate
unchanged; no stop is recorded and no fallback question is produced.
"""

from collections.abc import Iterable, Sequence
from dataclasses import dataclass, replace
from enum import StrEnum
from typing import Protocol

from .categories import CANONICAL_CATEGORIES
from .models import ReviewStatus, Transaction
from .questions import (
    MAX_FINDINGS_IN_PROMPT,
    AnsweredQuestion,
    Finding,
    NextQuestion,
    NoFurtherQuestion,
    QuestionResult,
    build_findings,
    transaction_id,
)

DEFAULT_MAX_TURNS = 8  # project setting


class WorkflowInputError(ValueError):
    """The statement, findings, history or confirmations are inconsistent."""


class FindingState(StrEnum):
    OPEN = "open"
    ANSWERED = "answered"
    RESOLVED = "resolved"
    NEEDS_CA_REVIEW = "needs_ca_review"


class WorkflowStatus(StrEnum):
    QUESTIONS_AVAILABLE = "questions_available"
    CA_REVIEW_REQUIRED = "ca_review_required"
    COMPLETE = "complete"


class StopReason(StrEnum):
    TURN_CAP_REACHED = "turn_cap_reached"
    MODEL_NO_FURTHER_QUESTION = "model_no_further_question"
    NOTHING_LEFT_TO_ASK = "nothing_left_to_ask"


class ConfirmationResponse(StrEnum):
    CONFIRMED = "confirmed"
    DENIED = "denied"
    UNSURE = "unsure"


@dataclass(frozen=True)
class ClientConfirmation:
    """A structured yes/no/unsure from the client on the classifier's proposal."""

    finding_id: str
    proposed_category: str
    response: ConfirmationResponse


@dataclass(frozen=True)
class LifecyclePolicy:
    max_turns: int = DEFAULT_MAX_TURNS
    # Only the first N findings of a case (statement order) are offered to
    # automated questioning; the rest go straight to CA review (overflow).
    max_findings_for_questioning: int = MAX_FINDINGS_IN_PROMPT

    def __post_init__(self) -> None:
        if not isinstance(self.max_turns, int) or self.max_turns < 0:
            raise ValueError("max_turns must be a non-negative integer")
        n = self.max_findings_for_questioning
        if not isinstance(n, int) or isinstance(n, bool) or not 1 <= n <= MAX_FINDINGS_IN_PROMPT:
            raise ValueError(f"max_findings_for_questioning must be between 1 and {MAX_FINDINGS_IN_PROMPT}")


def overflow_finding_ids(context: "IntakeContext", policy: LifecyclePolicy = LifecyclePolicy()) -> tuple[str, ...]:
    """Findings beyond the questioning limit, in statement order. Deterministic:
    the same case always has the same overflow, whatever has been answered."""
    return tuple(f.finding_id for f in context.findings[policy.max_findings_for_questioning:])


@dataclass(frozen=True)
class FindingStatus:
    finding_id: str
    state: FindingState
    reason: str


@dataclass(frozen=True)
class ConfirmationRequest:
    """A confirmable finding still awaiting the client's structured confirmation."""

    finding_id: str
    transaction_ids: tuple[str, ...]
    proposed_category: str
    classifier_reason: str


class QuestionSource(Protocol):
    def next_question(
        self, findings: Sequence[Finding], answered: Sequence[AnsweredQuestion] = ()
    ) -> QuestionResult: ...


def is_confirmable(finding: Finding) -> bool:
    """Only a finding whose sole issue is confirming the classifier's proposed
    category can be resolved by the client."""
    return finding.issues == ("needs_confirmation",) and finding.review_status == str(ReviewStatus.NEEDS_CONFIRMATION)


_UNSET: object = object()


def _response(value: "ConfirmationResponse | str") -> ConfirmationResponse:
    try:
        return ConfirmationResponse(value)
    except ValueError:
        raise WorkflowInputError(f"Unknown confirmation response: {value!r}.") from None


def _stop_reason(value: "StopReason | str | None") -> "StopReason | None":
    if value is None:
        return None
    try:
        return StopReason(value)
    except ValueError:
        raise WorkflowInputError(f"Unknown stop reason: {value!r}.") from None


@dataclass(frozen=True)
class IntakeContext:
    """Everything needed for one step. Immutable.

    Every instance, however it is constructed, passes `__post_init__`, which
    re-derives the findings from the classified transactions and validates the
    history, confirmations and stop state against them. An inconsistent context
    cannot be built, and no method clears a stop.

    Cross-request integrity: the stop and the turn cap are only as reliable as
    the history, confirmations, pending question, questions_issued and stop
    that the caller passes in. A stateless module cannot tell a truncated
    history from a short one. A caller that persists cases (for example an
    API) must load this state from its own authoritative storage, never from a
    client request, and should check each new or restored context with
    `assert_continues(previous)` before saving it.
    """

    transactions: tuple[Transaction, ...]
    findings: tuple[Finding, ...]
    history: tuple[AnsweredQuestion, ...] = ()
    confirmations: tuple[ClientConfirmation, ...] = ()
    stopped: StopReason | None = None
    # The question issued by the last step and not yet answered. While it is
    # pending and still relevant, steps return it again without a model call.
    pending: NextQuestion | None = None
    # Questions issued so far, answered or not (the turn cap counts these).
    # None means "derive the minimum": len(history) + (1 if pending).
    questions_issued: int | None = None

    def __post_init__(self) -> None:
        for name in ("transactions", "findings", "history", "confirmations"):
            if not isinstance(getattr(self, name), tuple):
                raise WorkflowInputError(f"{name} must be a tuple.")

        txns = self.transactions
        if any(not isinstance(t, Transaction) for t in txns):
            raise WorkflowInputError("transactions must be Transaction objects.")
        if any(t.matched_rule is None for t in txns):
            raise WorkflowInputError("Transactions must be classified before questioning.")
        txn_ids = [transaction_id(t) for t in txns]
        if len(set(txn_ids)) != len(txn_ids):
            raise WorkflowInputError("Transactions have duplicate row numbers.")

        # Findings must be exactly what the classifier output produces.
        ids = [f.finding_id for f in self.findings]
        if len(set(ids)) != len(ids):
            raise WorkflowInputError("Findings have duplicate finding IDs.")
        # One finding per transaction: several issues on one transaction are
        # carried together in that finding's `issues`, never as separate
        # findings, so the same transaction cannot be questioned or resolved
        # twice through different findings.
        seen: dict[str, str] = {}
        for f in self.findings:
            for t in f.transaction_ids:
                if t in seen:
                    raise WorkflowInputError(
                        f"Findings {seen[t]} and {f.finding_id} both refer to transaction {t}; "
                        "a transaction's issues must be in one finding."
                    )
                seen[t] = f.finding_id
        derived = {f.finding_id: f for f in build_findings(txns)}
        supplied = {f.finding_id: f for f in self.findings}
        missing = sorted(set(derived) - set(supplied))
        unexpected = sorted(set(supplied) - set(derived))
        altered = sorted(i for i in set(derived) & set(supplied) if supplied[i] != derived[i])
        if missing or unexpected or altered:
            raise WorkflowInputError(
                "Findings do not match the classifier output "
                f"(missing {missing}, unexpected {unexpected}, altered {altered})."
            )

        # History: well-formed, unique entries that reference known findings.
        for a in self.history:
            if not isinstance(a, AnsweredQuestion):
                raise WorkflowInputError("history entries must be AnsweredQuestion objects.")
            if not isinstance(a.question_id, str) or not a.question_id.strip():
                raise WorkflowInputError("History entries need a question ID.")
            if not isinstance(a.question, str) or not a.question.strip():
                raise WorkflowInputError(f"History entry {a.question_id} has no question text.")
            if not isinstance(a.answer, str) or not a.answer.strip():
                raise WorkflowInputError(f"History entry {a.question_id} has no answer.")
            if not isinstance(a.finding_ids, tuple) or not a.finding_ids or len(set(a.finding_ids)) != len(a.finding_ids):
                raise WorkflowInputError(f"History entry {a.question_id} needs distinct finding IDs.")
        qids = [a.question_id for a in self.history]
        repeated = sorted({q for q in qids if qids.count(q) > 1})
        if repeated:
            raise WorkflowInputError(f"Question {repeated[0]} has already been answered.")
        unknown_findings = sorted({i for a in self.history for i in a.finding_ids} - set(derived))
        if unknown_findings:
            raise WorkflowInputError(f"History references unknown finding IDs: {unknown_findings}.")

        # Confirmations: only for confirmable findings, known categories and responses.
        for c in self.confirmations:
            if not isinstance(c, ClientConfirmation):
                raise WorkflowInputError("confirmations must be ClientConfirmation objects.")
            finding = derived.get(c.finding_id)
            if finding is None:
                raise WorkflowInputError(f"Unknown finding ID: {c.finding_id}.")
            if not is_confirmable(finding):
                raise WorkflowInputError(
                    f"Finding {c.finding_id} cannot be resolved by client confirmation; it needs CA review."
                )
            if c.proposed_category not in CANONICAL_CATEGORIES:
                raise WorkflowInputError(f"Unknown category: {c.proposed_category!r}.")
            if not isinstance(c.response, ConfirmationResponse):
                raise WorkflowInputError(f"Unknown confirmation response: {c.response!r}.")

        if self.stopped is not None and not isinstance(self.stopped, StopReason):
            raise WorkflowInputError(f"Unknown stop reason: {self.stopped!r}.")

        # Pending question: must reference known findings with matching
        # transaction IDs, and must not already be answered.
        p = self.pending
        if p is not None:
            if not isinstance(p, NextQuestion):
                raise WorkflowInputError("pending must be a NextQuestion.")
            unknown = sorted(set(p.finding_ids) - set(derived))
            if not p.finding_ids or unknown:
                raise WorkflowInputError(f"Pending question references unknown finding IDs: {unknown}.")
            expected = {t for i in p.finding_ids for t in derived[i].transaction_ids}
            if set(p.transaction_ids) != expected:
                raise WorkflowInputError("Pending question transaction IDs do not match its findings.")
            if p.question_id in set(qids):
                raise WorkflowInputError(f"Pending question {p.question_id} has already been answered.")

        minimum = len(self.history) + (1 if p is not None else 0)
        if self.questions_issued is None:
            object.__setattr__(self, "questions_issued", minimum)
        elif not isinstance(self.questions_issued, int) or isinstance(self.questions_issued, bool):
            raise WorkflowInputError("questions_issued must be an integer.")
        elif self.questions_issued < minimum:
            raise WorkflowInputError(
                f"questions_issued ({self.questions_issued}) is less than the answered and pending "
                f"questions ({minimum})."
            )

    @classmethod
    def from_classified(
        cls,
        transactions: Iterable[Transaction],
        history: Iterable[AnsweredQuestion] = (),
        findings: Iterable[Finding] | None = None,
        confirmations: Iterable[ClientConfirmation] = (),
        stopped: "StopReason | None | object" = _UNSET,
        pending: NextQuestion | None = None,
        questions_issued: int | None = None,
    ) -> "IntakeContext":
        """Build a context from classified transactions.

        Findings are always derived from the transactions; `findings`, if given,
        must match them exactly (it is kept only for compatibility). When
        restoring a case with history or confirmations, `stopped` must be passed
        explicitly (None if questioning had not stopped), so a stop can never be
        dropped by omission.
        """
        txns = tuple(transactions)
        past = tuple(history)
        confs = tuple(confirmations)
        if stopped is _UNSET:
            if past or confs or pending is not None or questions_issued:
                raise WorkflowInputError(
                    "When restoring history or confirmations, pass `stopped` explicitly "
                    "(None if questioning had not stopped)."
                )
            stopped = None
        built = tuple(build_findings(txns)) if findings is None else tuple(findings)
        normalised = tuple(
            ClientConfirmation(c.finding_id, c.proposed_category, _response(c.response)) for c in confs
        )
        return cls(transactions=txns, findings=built, history=past, confirmations=normalised,
                   stopped=_stop_reason(stopped), pending=pending, questions_issued=questions_issued)

    def with_answer(self, question: NextQuestion, answer: str) -> "IntakeContext":
        """A new context with the client's free-text answer appended. The answer
        is stored as given, treated as untrusted data in later prompts, and
        never resolves a finding by itself."""
        if self.stopped is not None:
            raise WorkflowInputError("Automated questioning has stopped; no further answers are accepted.")
        if not isinstance(answer, str) or not answer.strip():
            raise WorkflowInputError("Answer must be a non-empty string.")
        unknown = sorted(set(question.finding_ids) - {f.finding_id for f in self.findings})
        if unknown:
            raise WorkflowInputError(f"Question references unknown finding IDs: {unknown}.")
        entry = AnsweredQuestion(question.question_id, question.question, tuple(question.finding_ids), answer)
        if self.pending is not None:
            # A question is pending: only that question can be answered. It was
            # already counted when issued.
            if question.question_id != self.pending.question_id:
                raise WorkflowInputError(
                    f"Question {question.question_id} does not match the pending question {self.pending.question_id}."
                )
            return replace(self, history=self.history + (entry,), pending=None)
        # No pending question recorded (e.g. answering against an earlier
        # context): count the answered question if it was not counted yet.
        issued = max(self.questions_issued, len(self.history) + 1)
        return replace(self, history=self.history + (entry,), questions_issued=issued)

    def with_confirmation(
        self, finding_id: str, proposed_category: str, response: ConfirmationResponse | str
    ) -> "IntakeContext":
        """A new context with the client's structured confirmation of the
        classifier's proposed category for one confirmable finding. The latest
        confirmation for a finding is the one that counts."""
        entry = ClientConfirmation(finding_id, proposed_category, _response(response))
        return replace(self, confirmations=self.confirmations + (entry,))

    def with_stop(self, reason: StopReason) -> "IntakeContext":
        """A new context with questioning stopped. An existing stop is kept."""
        return replace(self, stopped=self.stopped or _stop_reason(reason))

    def assert_continues(self, previous: "IntakeContext") -> None:
        """Raise unless this context validly continues `previous`: same
        statement; history and confirmations only appended to; questions
        issued never decreasing; a pending question kept, answered or
        withdrawn (never replaced while unanswered); and any stop preserved.
        Use it to check a rebuilt or restored context against the last
        authoritative one."""
        if self.transactions != previous.transactions:
            raise WorkflowInputError("Context is for a different statement.")
        if self.history[: len(previous.history)] != previous.history:
            raise WorkflowInputError("History was truncated or altered.")
        if self.confirmations[: len(previous.confirmations)] != previous.confirmations:
            raise WorkflowInputError("Confirmations were truncated or altered.")
        if self.questions_issued < previous.questions_issued:
            raise WorkflowInputError(
                f"Questions issued went down ({previous.questions_issued} -> {self.questions_issued})."
            )
        p = previous.pending
        if p is not None and self.pending != p:
            answered = p.question_id in {a.question_id for a in self.history}
            if self.pending is not None and not answered:
                raise WorkflowInputError(f"Pending question {p.question_id} was replaced before it was answered.")
        if previous.stopped is not None and self.stopped != previous.stopped:
            raise WorkflowInputError(f"Stop state was cleared or changed (was {previous.stopped}).")


def evaluate_findings(
    context: IntakeContext, policy: LifecyclePolicy = LifecyclePolicy()
) -> tuple[FindingStatus, ...]:
    """Apply the lifecycle rules (see module docstring) to every finding."""
    latest: dict[str, ClientConfirmation] = {}
    for c in context.confirmations:
        latest[c.finding_id] = c
    answered_ids = {i for a in context.history for i in a.finding_ids}
    overflow = set(overflow_finding_ids(context, policy))
    limit = policy.max_findings_for_questioning

    statuses: list[FindingStatus] = []
    for f in context.findings:
        confirmation = latest.get(f.finding_id)
        if confirmation is not None and is_confirmable(f):
            if confirmation.proposed_category != f.current_category:
                state, reason = FindingState.NEEDS_CA_REVIEW, (
                    f"Client confirmed '{confirmation.proposed_category}', which is not the current "
                    f"proposal '{f.current_category}'."
                )
            elif confirmation.response is ConfirmationResponse.CONFIRMED:
                state, reason = FindingState.RESOLVED, f"Client confirmed the proposed category '{f.current_category}'."
            else:
                state, reason = FindingState.NEEDS_CA_REVIEW, (
                    f"Client answered '{confirmation.response}' to the proposed category '{f.current_category}'."
                )
        elif f.finding_id in overflow:
            state, reason = FindingState.NEEDS_CA_REVIEW, (
                f"Beyond the first {limit} findings of this case, so it was not offered to automated "
                "questioning; CA review is required."
            )
        elif context.stopped is not None:
            state = FindingState.NEEDS_CA_REVIEW
            how = "after the client answered" if f.finding_id in answered_ids else "without a client answer"
            reason = f"Automated questioning stopped ({context.stopped}) {how}; sufficiency was not established."
        elif f.finding_id in answered_ids:
            state, reason = FindingState.ANSWERED, "The client has answered; the answer has not been confirmed sufficient."
        else:
            state, reason = FindingState.OPEN, "Needs clarification."
        statuses.append(FindingStatus(f.finding_id, state, reason))
    return tuple(statuses)


@dataclass(frozen=True)
class IntakeStep:
    """Result of one step."""

    status: WorkflowStatus
    result: QuestionResult  # the next question, or why there is none this step
    finding_ids: tuple[str, ...]  # findings that were open to questioning this step
    answered_count: int
    finding_states: tuple[FindingStatus, ...]
    confirmations_requested: tuple[ConfirmationRequest, ...]
    context: IntakeContext  # the context after this step (records any stop or pending question)
    reused_pending: bool = False  # True when the pending question was returned without a model call
    # Findings beyond the questioning limit: never sent to the model, always
    # NEEDS_CA_REVIEW unless resolved by a structured confirmation.
    overflow_finding_ids: tuple[str, ...] = ()

    @property
    def questions_issued(self) -> int:
        return self.context.questions_issued

    @property
    def done(self) -> bool:
        """No question was produced this step (see `status` for why)."""
        return not isinstance(self.result, NextQuestion)

    @property
    def unresolved_finding_ids(self) -> tuple[str, ...]:
        return tuple(s.finding_id for s in self.finding_states if s.state is not FindingState.RESOLVED)

    def state_of(self, finding_id: str) -> FindingState:
        for s in self.finding_states:
            if s.finding_id == finding_id:
                return s.state
        raise KeyError(finding_id)


def _confirmation_requests(context: IntakeContext) -> tuple[ConfirmationRequest, ...]:
    confirmed = {c.finding_id for c in context.confirmations}
    return tuple(
        ConfirmationRequest(f.finding_id, f.transaction_ids, f.current_category, f.classifier_reason)
        for f in context.findings
        if is_confirmable(f) and f.finding_id not in confirmed
    )


def _step(
    context: IntakeContext,
    status: WorkflowStatus,
    result: QuestionResult,
    asked: tuple[str, ...],
    policy: LifecyclePolicy,
    reused_pending: bool = False,
) -> IntakeStep:
    states = evaluate_findings(context, policy)
    return IntakeStep(
        status=status,
        result=result,
        finding_ids=asked,
        answered_count=len(context.history),
        finding_states=states,
        confirmations_requested=_confirmation_requests(context),
        context=context,
        reused_pending=reused_pending,
        overflow_finding_ids=overflow_finding_ids(context, policy),
    )


def next_intake_step(
    context: IntakeContext,
    questions: QuestionSource,
    policy: LifecyclePolicy = LifecyclePolicy(),
) -> IntakeStep:
    """Apply the stopping rules, then (if questioning continues) ask the
    question source about OPEN and ANSWERED findings only."""
    states = evaluate_findings(context, policy)
    unresolved = [s for s in states if s.state is not FindingState.RESOLVED]

    if not unresolved:
        reason = "All findings are resolved." if context.findings else "There are no findings to clarify."
        return _step(context, WorkflowStatus.COMPLETE, NoFurtherQuestion(reason), (), policy)

    askable_ids = {s.finding_id for s in states if s.state in (FindingState.OPEN, FindingState.ANSWERED)}
    askable_order = tuple(f.finding_id for f in context.findings if f.finding_id in askable_ids)

    if context.stopped is None and context.pending is not None:
        if askable_ids & set(context.pending.finding_ids):
            # Still waiting for the client: return the same question, no model call.
            return _step(context, WorkflowStatus.QUESTIONS_AVAILABLE, context.pending, askable_order, policy,
                         reused_pending=True)
        # Its findings were resolved or sent to CA review meanwhile: withdraw it.
        # It stays counted in questions_issued.
        context = replace(context, pending=None)

    if context.stopped is None and context.questions_issued >= policy.max_turns:
        context = context.with_stop(StopReason.TURN_CAP_REACHED)
    if context.stopped is None and not askable_ids:
        context = context.with_stop(StopReason.NOTHING_LEFT_TO_ASK)
    if context.stopped is not None:
        return _step(
            context,
            WorkflowStatus.CA_REVIEW_REQUIRED,
            NoFurtherQuestion(f"Automated questioning stopped ({context.stopped}); CA review is required."),
            (),
            policy,
        )

    askable = tuple(f for f in context.findings if f.finding_id in askable_ids)
    result = questions.next_question(askable, context.history)

    if isinstance(result, NextQuestion):
        by_id = {f.finding_id: f for f in askable}
        unknown = sorted(set(result.finding_ids) - set(by_id))
        if unknown:
            raise WorkflowInputError(f"Question references findings not open to questioning: {unknown}.")
        expected_txns = {t for i in result.finding_ids for t in by_id[i].transaction_ids}
        if set(result.transaction_ids) != expected_txns:
            raise WorkflowInputError("Question transaction IDs do not match its findings.")
        issued = replace(context, pending=result, questions_issued=context.questions_issued + 1)
        return _step(issued, WorkflowStatus.QUESTIONS_AVAILABLE, result, askable_order, policy)

    if isinstance(result, NoFurtherQuestion):
        # The model's "nothing more to ask" stops questioning; it resolves nothing.
        # The askable findings were unresolved, so they now need CA review.
        stopped = context.with_stop(StopReason.MODEL_NO_FURTHER_QUESTION)
        return _step(stopped, WorkflowStatus.CA_REVIEW_REQUIRED, result, askable_order, policy)

    raise TypeError(f"Unexpected question result: {type(result).__name__}")
