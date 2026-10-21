"""Rule-based transaction classifier.

Priority (first match wins), per docs/classification-spec.md:
  1. Self Transfer          4. Specific identifiable sources
  2. Family Transfer        5. Client-specific instructions
  3. Bank-generated entries 6. Recurring credits
  7. Otherwise "Others – Needs Review", with the reason recorded.

Classification only sets category, reason, confidence, review status, the
matched rule and flags. Dates, narrations and amounts are never changed.
"""

import re
from dataclasses import dataclass, replace
from decimal import Decimal
from statistics import median

from .categories import Category
from .config import DEFAULT_CONFIG, AnalysisConfig, ClientProfile, FamilyMember, KeywordRule
from .models import (
    FLAG_LARGE_CREDIT,
    FLAG_RECURRING_CREDIT,
    Confidence,
    Direction,
    ReviewStatus,
    Transaction,
)
from .text import NameMatch, NameMatchResult, match_name, normalise, tokens

_COMPANY_SUFFIXES = {"PVT", "PRIVATE", "LTD", "LIMITED", "LLP", "INC", "CO", "COMPANY", "THE"}


@dataclass(frozen=True)
class _Result:
    category: Category
    confidence: Confidence
    review_status: ReviewStatus
    rule: str
    reason: str


def _money(amount: Decimal) -> str:
    return f"₹{amount:,}"


def _digit_runs(text: str) -> list[str]:
    return re.findall(r"\d+", text)


def _contains_number(narration: str, number: str) -> bool:
    target = re.sub(r"\D", "", number)
    return bool(target) and any(target in run for run in _digit_runs(narration))


# --- Rule 1: self transfer -------------------------------------------------

def _match_self(t: Transaction, profile: ClientProfile, config: AnalysisConfig) -> _Result | None:
    upper = t.narration.upper()
    lower = t.narration.lower()

    for acct in profile.accounts:
        if len(re.sub(r"\D", "", acct.account_number)) >= 6 and _contains_number(t.narration, acct.account_number):
            return _Result(
                Category.SELF_TRANSFER, Confidence.HIGH, ReviewStatus.AUTO_CLASSIFIED, "self.account_number",
                f"Narration contains the client's {acct.bank_name} account number.",
            )
    for upi in profile.upi_ids:
        if upi and upi.lower() in lower:
            return _Result(
                Category.SELF_TRANSFER, Confidence.HIGH, ReviewStatus.AUTO_CLASSIFIED, "self.upi_id",
                "Narration contains the client's UPI ID.",
            )
    for mobile in profile.mobile_numbers:
        digits = re.sub(r"\D", "", mobile)[-10:]
        if len(digits) == 10 and any(run.endswith(digits) and len(run) <= 12 for run in _digit_runs(t.narration)):
            return _Result(
                Category.SELF_TRANSFER, Confidence.HIGH, ReviewStatus.AUTO_CLASSIFIED, "self.mobile_number",
                "Narration contains the client's linked mobile number.",
            )
    masked = re.findall(r"[X*]{2,}(\d{4})\b", upper)
    for acct in profile.accounts:
        last4 = re.sub(r"\D", "", acct.account_number)[-4:]
        if last4 and last4 in masked:
            return _Result(
                Category.SELF_TRANSFER, Confidence.MEDIUM, ReviewStatus.NEEDS_CONFIRMATION, "self.masked_account",
                f"Masked account number ending {last4} matches the client's {acct.bank_name} account; "
                "confirm it is the same account.",
            )

    name_match = match_name(profile.name, t.narration, config.name_similarity_threshold)
    # A weak fragment or loose resemblance is never enough (see _weak_name_hints).
    if name_match is None or name_match.strength is NameMatch.WEAK:
        return None
    listed = [
        acct.bank_name
        for acct in profile.accounts
        if any(ident.upper() in upper for ident in (acct.bank_name, *acct.bank_identifiers) if ident)
    ]
    if name_match.strength is NameMatch.EXACT:
        if listed:
            return _Result(
                Category.SELF_TRANSFER, Confidence.MEDIUM, ReviewStatus.AUTO_CLASSIFIED, "self.name_listed_bank",
                f"Client's name appears with a listed bank ({listed[0]}).",
            )
        return _Result(
            Category.SELF_TRANSFER, Confidence.MEDIUM, ReviewStatus.NEEDS_CONFIRMATION, "self.name_unlisted_bank",
            "Client's name appears, but not against any of the client's listed banks; "
            "confirm this is the client's own account.",
        )

    # Partial or variant match on the client's name: never auto-classified.
    family = _family_matches(t, profile, config)
    if any(r.strength is NameMatch.EXACT for _, r in family):
        return None  # an exact family-member match is stronger; let rule 2 decide
    bank = f"with a listed bank ({listed[0]})" if listed else "not against any of the client's listed banks"
    reason = f"Client's name matched only partially ({name_match.describe()}), {bank}."
    also = [m for m, r in family if r.strength is not NameMatch.WEAK]
    if also:
        reason += " It could also refer to family member " + ", ".join(f"{m.name} ({m.relation})" for m in also) + "."
    return _Result(
        Category.SELF_TRANSFER, Confidence.LOW, ReviewStatus.NEEDS_CONFIRMATION, "self.name_partial",
        reason + " Confirm this is the client's own account.",
    )


# --- Rule 2: family transfer -----------------------------------------------

_STRENGTH_ORDER = (NameMatch.EXACT, NameMatch.PARTIAL, NameMatch.VARIANT, NameMatch.WEAK)


def _family_matches(
    t: Transaction, profile: ClientProfile, config: AnalysisConfig
) -> list[tuple[FamilyMember, NameMatchResult]]:
    """Best name match per family member (over name and aliases)."""
    out: list[tuple[FamilyMember, NameMatchResult]] = []
    for member in profile.family_members:
        results = [
            r for r in (match_name(c, t.narration, config.name_similarity_threshold) for c in (member.name, *member.aliases))
            if r is not None
        ]
        if results:
            out.append((member, min(results, key=lambda r: _STRENGTH_ORDER.index(r.strength))))
    return out


def _match_family(t: Transaction, profile: ClientProfile, config: AnalysisConfig) -> _Result | None:
    matches = [(m, r) for m, r in _family_matches(t, profile, config) if r.strength is not NameMatch.WEAK]
    if not matches:
        return None
    exact = [(m, r) for m, r in matches if r.strength is NameMatch.EXACT]
    if len(exact) == 1:
        member = exact[0][0]
        return _Result(
            Category.FAMILY_TRANSFER, Confidence.HIGH, ReviewStatus.AUTO_CLASSIFIED, "family.name",
            f"Matches listed family member {member.name} ({member.relation}).",
        )
    if len(matches) > 1:
        names = ", ".join(f"{m.name} ({m.relation})" for m, _ in matches)
        return _Result(
            Category.FAMILY_TRANSFER, Confidence.MEDIUM, ReviewStatus.NEEDS_CONFIRMATION, "family.ambiguous",
            f"Narration could refer to more than one listed family member: {names}; confirm which.",
        )
    member, result = matches[0]
    rule = "family.name_initials" if result.strength is NameMatch.PARTIAL else "family.name_variant"
    return _Result(
        Category.FAMILY_TRANSFER, Confidence.MEDIUM, ReviewStatus.NEEDS_CONFIRMATION, rule,
        f"Possibly listed family member {member.name} ({member.relation}), but the name matched only "
        f"partially ({result.describe()}); confirm.",
    )


def _weak_name_hints(t: Transaction, profile: ClientProfile, config: AnalysisConfig) -> str:
    """Describe weak name resemblances, which are reported but never used to classify."""
    hints: list[str] = []
    client = match_name(profile.name, t.narration, config.name_similarity_threshold)
    if client is not None and client.strength is NameMatch.WEAK:
        hints.append(f"the client {profile.name} ({client.describe()})")
    for member, result in _family_matches(t, profile, config):
        if result.strength is NameMatch.WEAK:
            hints.append(f"family member {member.name} ({result.describe()})")
    if not hints:
        return ""
    return " Weak name resemblance to " + "; ".join(hints) + ", not used for classification."


# --- Rules 3-5: narration rules --------------------------------------------

def _keyword_match(rule: KeywordRule, text: str, direction: Direction) -> bool:
    if rule.direction is not None and rule.direction is not direction:
        return False
    if not any(re.search(p, text) for p in rule.patterns):
        return False
    return not any(re.search(p, text) for p in rule.exclude)


def _apply_keyword_rules(rules: tuple[KeywordRule, ...], t: Transaction) -> _Result | None:
    text = normalise(t.narration)
    for rule in rules:
        if _keyword_match(rule, text, t.direction):
            return _Result(rule.category, rule.confidence, rule.review_status, rule.name, rule.note)
    return None


def _match_profile_sources(t: Transaction, profile: ClientProfile) -> _Result | None:
    text = f" {normalise(t.narration)} "
    if t.direction is Direction.CREDIT:
        for employer in profile.employers:
            core = " ".join(tok for tok in tokens(employer) if tok not in _COMPANY_SUFFIXES)
            if core and f" {core} " in text:
                return _Result(
                    Category.SALARY_PENSION, Confidence.HIGH, ReviewStatus.AUTO_CLASSIFIED, "source.employer",
                    f"Credit from listed employer {employer}.",
                )
    else:
        for loan in profile.loan_account_numbers:
            if _contains_number(t.narration, loan):
                return _Result(
                    Category.LOAN_EMI, Confidence.HIGH, ReviewStatus.AUTO_CLASSIFIED, "source.loan_account",
                    "Payment to the client's listed loan account.",
                )
    return None


def _match_client_rules(t: Transaction, profile: ClientProfile) -> _Result | None:
    text = normalise(t.narration)
    for rule in profile.client_rules:
        if rule.direction is not None and rule.direction is not t.direction:
            continue
        if any(re.search(p, text) for p in rule.patterns):
            return _Result(
                rule.category, Confidence.MEDIUM, ReviewStatus.AUTO_CLASSIFIED, "client_rule",
                f"Client instruction: {rule.description}",
            )
    return None


# --- Rule 6: recurring credits ---------------------------------------------

def _source_key(t: Transaction) -> str:
    if t.counterparty:
        return normalise(t.counterparty)
    return " ".join(tok for tok in tokens(t.narration) if not tok.isdigit())


def _find_recurring(candidates: list[Transaction], config: AnalysisConfig) -> dict[int, str]:
    """Return {row_number: reason} for credits forming a recurring pattern."""
    groups: dict[str, list[Transaction]] = {}
    for t in candidates:
        groups.setdefault(_source_key(t), []).append(t)

    found: dict[int, str] = {}
    for key, group in groups.items():
        if not key or len(group) < config.recurrence_min_occurrences:
            continue
        group.sort(key=lambda t: t.date)
        mid = Decimal(median(t.credit for t in group))
        if mid <= 0 or any(abs(t.credit - mid) > mid * config.recurrence_amount_tolerance for t in group):
            continue
        gaps = [(b.date - a.date).days for a, b in zip(group, group[1:])]
        if not all(config.recurrence_min_interval_days <= g <= config.recurrence_max_interval_days for g in gaps):
            continue
        reason = (
            f"Recurring credit: {len(group)} credits of about {_money(mid)} from the same source "
            f"('{key}'), {min(gaps)}–{max(gaps)} days apart."
        )
        for t in group:
            found[t.row_number] = reason
    return found


# --- Orchestration ----------------------------------------------------------

def _apply(t: Transaction, r: _Result) -> Transaction:
    return replace(
        t,
        category=r.category,
        confidence=r.confidence,
        review_status=r.review_status,
        matched_rule=r.rule,
        classification_reason=r.reason,
    )


def classify_transaction(
    t: Transaction, profile: ClientProfile, config: AnalysisConfig = DEFAULT_CONFIG
) -> Transaction | None:
    """Apply priority rules 1-5 to one transaction. Returns None if none match."""
    for step in (
        lambda: _match_self(t, profile, config),
        lambda: _match_family(t, profile, config),
        lambda: _apply_keyword_rules(config.bank_rules, t),
        lambda: _match_profile_sources(t, profile),
        lambda: _apply_keyword_rules(config.source_rules, t),
        lambda: _match_client_rules(t, profile),
    ):
        result = step()
        if result is not None:
            return _apply(t, result)
    return None


def classify_statement(
    transactions: list[Transaction] | tuple[Transaction, ...],
    profile: ClientProfile,
    config: AnalysisConfig = DEFAULT_CONFIG,
) -> list[Transaction]:
    """Classify every transaction, keeping the original order."""
    first_pass = [(t, classify_transaction(t, profile, config)) for t in transactions]

    unmatched_credits = [t for t, c in first_pass if c is None and t.direction is Direction.CREDIT]
    recurring = _find_recurring(unmatched_credits, config)

    out: list[Transaction] = []
    for t, classified in first_pass:
        if classified is None and t.row_number in recurring:
            category = config.recurring_credit_category or Category.OTHERS_NEEDS_REVIEW
            reason = recurring[t.row_number]
            if config.recurring_credit_category is None:
                reason += " The source and nature are not identified; confirm with the client."
            classified = replace(
                _apply(t, _Result(category, Confidence.LOW, ReviewStatus.NEEDS_CONFIRMATION, "recurring_credit", reason)),
                flags=t.flags + (FLAG_RECURRING_CREDIT,),
            )
        elif classified is None:
            classified = _apply(
                t,
                _Result(
                    Category.OTHERS_NEEDS_REVIEW, Confidence.LOW, ReviewStatus.NEEDS_REVIEW, "uncertain",
                    "No priority rule matched; the nature of this transaction cannot be "
                    "determined from the narration.",
                ),
            )

        if classified.matched_rule in ("uncertain", "recurring_credit"):
            hint = _weak_name_hints(t, profile, config)
            if hint:
                classified = replace(classified, classification_reason=classified.classification_reason + hint)

        if (
            classified.direction is Direction.CREDIT
            and classified.category is Category.OTHERS_NEEDS_REVIEW
            and classified.credit >= config.large_credit_threshold
        ):
            classified = replace(
                classified,
                review_status=ReviewStatus.NEEDS_REVIEW,
                flags=classified.flags + (FLAG_LARGE_CREDIT,),
                classification_reason=classified.classification_reason
                + f" Unexplained credit of {_money(classified.credit)} is at or above the "
                f"configured review threshold of {_money(config.large_credit_threshold)}.",
            )
        out.append(classified)
    return out
