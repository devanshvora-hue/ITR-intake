# ITR Intake backend

Deterministic bank-transaction validation and classification (Stage 2).
Business logic lives in `itr_intake/` and has no FastAPI dependency.

- `itr_intake/categories.py` – the 28 canonical categories
- `itr_intake/models.py` – typed raw and validated transaction records
- `itr_intake/validation.py` – row validation and balance reconciliation
- `itr_intake/classifier.py` – priority-ordered classifier
- `itr_intake/rules.py` – default narration rules (bank-generated, identifiable sources)
- `itr_intake/config.py` – client profile and configurable thresholds
- `itr_intake/workbook.py` – internal Excel workbook for CA review (never shown to clients)
- `itr_intake/questions.py` – Gemini-proposed adaptive client questions (one at a time)
- `itr_intake/intake_workflow.py` – stateless workflow with finding lifecycle and stopping rules
- `itr_intake_server/` – persistence (SQLite foundation; Stage 5.1)
- `itr_intake/sample_data/` – **synthetic** demo statements (no real customer data)
- `scripts/generate_demo_workbook.py` – builds a workbook from the synthetic statement

Classification rules and settings are documented in
[`../docs/classification-spec.md`](../docs/classification-spec.md).
This module does not compute tax or decide whether any amount is taxable,
exempt or deductible.

## Database foundation (`itr_intake_server.db`)

Stage 5.1. A separate package, `itr_intake_server`, holds persistence so the
`itr_intake` engine stays free of database code. Standard-library `sqlite3`
only.

- `connect(path)` opens a connection with foreign keys enforced (SQLite's
  default is off), `sqlite3.Row` rows, a busy timeout and WAL journaling;
  `transaction(conn)` gives `BEGIN IMMEDIATE ... COMMIT` with rollback on error.
- `initialize_database(path)` creates and migrates a database. The default is
  `backend/var/itr_intake.db` (git-ignored); tests always use temporary paths.
- Migrations are numbered files in `itr_intake_server/migrations/`
  (`0001_initial_schema.sql`, ...). Each runs in one transaction together with
  its `schema_migrations` row (version, name, SHA-256 checksum, UTC time), so a
  failure leaves nothing behind. Re-running is a no-op; gaps, duplicates,
  unknown applied versions and edited applied migrations are refused.
- Schema conventions: STRICT tables; UUID4 text IDs; UTC ISO-8601 timestamps
  ending in `Z`; money as decimal text. Case-scoped tables carry `firm_id` and
  reference `cases(id, firm_id)`, so no row can point at another firm's case;
  sessions, cases and firm-code usage are tied to their firm the same way.
  Partial unique indexes allow one open case per client, firm and financial
  year, one active firm code per firm, and one pending question per case.
  Document storage keys must sit inside their own `firm_id/case_id/` folder.
  Confirmations and audit events are append-only.

### Confirmed decisions

- **One open case per client, firm and financial year.** Only a case with
  status `closed` releases the slot. Every other status, including
  `submitted`, `ca_review_required` and `review_ready`, still counts as open,
  so a client cannot start a second case for the same year while one is
  submitted or awaiting CA review. Enforced by the partial unique index
  `cases_one_open_per_client_year_uq` (`WHERE status <> 'closed'`).
- **Firm registration numbers are unique (prototype).** A second firm with the
  same registration number is refused by `firms_registration_number_uq`;
  firms without a number are unaffected. *Caveat:* legitimate branches of one
  firm may share a registration number, so this constraint may need revising
  (for example, unique per firm-and-branch, or a warning instead of a hard
  constraint). Registration numbers are self-declared and are not verified by
  the database; changing the rule requires a new migration, not an edit to
  `0001_initial_schema.sql`.

## Repository layer (`itr_intake_server.repository`, `itr_intake_server.ids`)

Stage 5.2. Explicit functions per record type over the SQLite foundation;
no ORM. All values are bound parameters; the only SQL identifiers built in
code come from fixed allow-lists.

- **Scope.** Firm-owned data is reachable only with a `FirmScope(firm_id)`,
  which trusted server code must build from the authenticated principal
  (never from a firm ID sent by a browser). Case-scoped queries constrain
  both `firm_id` and the case ID; related records (questions, documents,
  requests, ...) also match on case and their own ID. Clients see a case only
  through `get_client_case`, which additionally matches the client identity.
  Deliberately unscoped lookups happen before a principal exists:
  `find_active_firm_by_code`, `get_ca_user_for_login`,
  `get_session_by_token_hash`, `get_challenge`, plus registration
  (`create_firm`, `create_ca_user`) and the operator-only
  `admin_set_firm_status`.
- **Errors.** `NotFound` for missing *and* out-of-scope records, and for
  malformed IDs, so another firm's record cannot be told apart from a
  nonexistent one. `Conflict(code)` for rule violations (`open_case_exists`,
  `stale_version`, `registration_number_taken`, ...), `InvalidInput(field)`
  for bad values, `NotPermitted` for append-only targets. Messages never
  contain SQL, database errors or row data.
- **IDs.** `parse_id` accepts only canonical lower-case UUID4 text and never
  generates an ID; new records get `generate_id()`. Case references
  (`IT-<FIRSTNAME>-<6 Crockford base32>`) are drawn randomly and retried on a
  collision; they identify, never authenticate.
- **Writes.** Multi-step writes are atomic (the `db.transaction` helper, or a
  savepoint inside a caller's transaction). `update_case` uses optimistic
  locking on `version` and an allow-list of fields. Document storage keys are
  generated as `<firm_id>/<case_id>/<document_id>.<ext>`. Confirmations and
  audit events have no update or delete functions.

## CA authentication (`itr_intake_server.ca_auth`)

Stage 5.3. Service functions only; no routes, cookies or e-mail yet.

- **Lifecycle.** `register_ca` creates a `pending_verification` firm and a
  `pending` owner account (no firm code). `confirm_email` marks the e-mail
  verified and moves the firm to `pending_approval`; it never activates.
  `admin_approve_ca` (operator only, no public endpoint, no built-in admin
  password) requires a verified e-mail and activates firm and user.
  `admin_deactivate_ca_user` and `admin_suspend_firm` revoke the affected
  sessions; sessions are also rejected and revoked at the next request if a
  status changes by any other route.
- **Passwords.** Standard-library scrypt (N=2^15, r=8, p=1, 16-byte salt),
  stored as `scrypt$N$r$p$salt$hash`; verified with `hmac.compare_digest`.
  Malformed stored values verify as false. Minimum 12 characters.
- **Login.** Only an active, verified user of an active firm succeeds. Every
  failure (unknown e-mail, wrong password, pending, unapproved, disabled,
  suspended, locked) raises the same `AuthenticationFailed("Invalid email or
  password.")`, and unknown e-mails still cost a hash. 10 wrong passwords lock
  the account for 15 minutes.
- **Sessions.** Tokens are `secrets.token_urlsafe(32)`, returned once and
  never stored; the database holds only their SHA-256 digest. 30 minutes idle,
  12 hours absolute. Login always issues a new token and revokes a presented
  old one; `rotate_ca_session` replaces a token keeping its absolute expiry;
  `logout_ca` revokes. Every operation starts from a presented token, never a
  session ID, and the principal's firm scope comes from the stored account.
- **Cookies (later routes).** `CA_SESSION_COOKIE`: HttpOnly, SameSite=Lax,
  Path=/, Secure and `__Host-` prefix in production.
- **Password reset (Stage 5.3A).** `request_password_reset` returns a
  `PasswordResetRequest` for a future outbox step; it is empty for unknown,
  malformed or disabled e-mails, and the route must answer identically either
  way. Tokens are `<challenge_id>.<secret>` (256-bit secret, SHA-256 stored),
  valid 30 minutes, single use, 5 attempts. `confirm_password_reset` checks the
  password policy before touching the token, then sets the new hash, clears the
  login lock and revokes every session of the account. It never activates a
  pending account and is refused for a disabled one.
- **Challenge replacement.** Issuing a verification or reset challenge ends
  the account's earlier outstanding ones of the same purpose in the same
  transaction (the schema has no "superseded" state, so their expiry is set to
  the issue time). Attempts already made stay recorded.
- **Lockout.** The failure counter is one relative `UPDATE`, so concurrent
  failures are never lost (tested with parallel connections). After a lock
  expires, counting restarts instead of re-locking on the next failure.
  **Remaining risk:** anyone who knows a CA's e-mail can still lock that
  account for 15 minutes by failing 10 times. When HTTP routes are added,
  trusted-proxy-aware IP rate limiting (never trusting client-supplied
  `X-Forwarded-For`) must be implemented and tested, and the lock policy
  revisited (e.g. progressive delays).
- **Timing.** Every login path runs exactly one scrypt verification: unknown
  e-mails, malformed stored hashes and non-string or oversized passwords use
  a dummy hash built without extra work. The paths are not perfectly uniform:
  a wrong password also writes the failure counter.

## Run the CA sign-in flow locally

Three terminals, all from the project root (the third is the e-mail worker).

1. API server (development mode: loopback only, simulated e-mail):

   ```bash
   cd backend
   ../.venv/Scripts/python -m itr_intake_server --dev
   ```

   It listens on http://127.0.0.1:8000 and keeps its database in
   `backend/var/itr_intake.db` (git-ignored). Without `--dev` it runs with
   production settings, which require `ITR_ALLOWED_ORIGINS` and
   `ITR_PUBLIC_BASE_URL` (https) and have no developer outbox.

2. Website:

   ```bash
   npm run dev -- --hostname 127.0.0.1
   ```

   Open http://localhost:3000/ca/register. Next.js forwards `/api/*` to the
   API server (set `ITR_API_ORIGIN` to change where).

3. E-mail worker (a separate process; requests only queue mail):

   ```bash
   cd backend
   ../.venv/Scripts/python -m itr_intake_server.email_worker --dev
   ```

Flow: register → open the developer outbox at http://127.0.0.1:8000/dev/outbox
(development only, this computer only; no e-mail is sent; messages appear once
the worker has run) and follow the verification link → approve from the command line:

```bash
cd backend
../.venv/Scripts/python -m itr_intake_server.admin list-pending
../.venv/Scripts/python -m itr_intake_server.admin approve --email <email> --approved-by "<your name>"
```

→ sign in at http://localhost:3000/ca/login → the dashboard at /ca shows the
signed-in firm. "Sign out" revokes the session.

Security notes: the session token lives only in an HttpOnly, SameSite=Lax
cookie (Secure and `__Host-` in production); POSTs need an allowed Origin and
the `X-ITR-Request: 1` header; `/ca` is checked server-side on every request;
there is no HTTP admin or approval route. Delete `backend/var/itr_intake.db*`
to start over.

## E-mail outbox and worker (Stage 5.4)

- Request handlers never send e-mail. They queue a row in `email_outbox`
  (`email_service.queue_ca_email`); the separate worker
  (`python -m itr_intake_server.email_worker --dev [--once]`) delivers it.
- Development: a simulated sender writes to the development-only
  `dev_mailbox` table (shown at `/dev/outbox`) and the row is recorded as
  `simulated`, never `sent`. Development always simulates, even if SMTP is set.
- Production: SMTP (`smtp_sender.py`, standard library only; works with any
  provider offering SMTP submission). Configured only by environment variables:

  | Variable | Meaning |
  |---|---|
  | `ITR_SMTP_HOST` | required to enable e-mail |
  | `ITR_EMAIL_FROM` | required plain sender address, e.g. `no-reply@example.com` |
  | `ITR_SMTP_PORT` | default 587 (or 465 with implicit TLS) |
  | `ITR_SMTP_TLS` | `starttls` (default) or `implicit`; TLS with certificate checks is always used |
  | `ITR_SMTP_USERNAME` / `ITR_SMTP_PASSWORD` | optional, set together; never logged |

  With these set, the API queues mail and reports `email_delivery: "email"`;
  run `python -m itr_intake_server.email_worker` (no `--dev`) as a separate
  process with the same variables and `ITR_DB_PATH`, and rows become `sent`.
  Without them, nothing is queued, the API reports `"not_configured"` and the
  worker refuses to start. A partial or invalid configuration stops the API
  and the worker at startup with a message naming the variable (never its
  value). SMTP failures map to fixed codes: permanent rejections
  (`recipient_refused`, `rejected`, `invalid_message`) are not retried;
  `auth_failed`, `temporary_failure`, `tls_failed`, `connection_failed` are.
- Retries: 1 min, 5 min, 30 min, 2 h after the 1st–4th failure; the 5th
  failure (or a non-retryable error) makes the row `dead`. Error codes are
  short fixed strings. `python -m itr_intake_server.admin email-status` shows
  counts and failed/dead messages with masked recipients and no bodies.
- Secrets: verification/reset rows are `sensitive`. The body (with the link)
  is cleared when delivered, when finally failed, when superseded by a newer
  link, or at the link's own expiry (24 h verification, 30 min reset), whichever
  comes first. Logs hold template, id, masked recipient and a code only. The
  simulated inbox row is deleted when the link expires.
- Password reset: `POST /api/ca/request-password-reset` (always the same 202)
  and `POST /api/ca/reset-password`. Limits per hashed e-mail (3/h), per
  connected peer and overall; client-supplied IP headers are ignored. Behind
  the Next.js proxy the "peer" is the proxy, so that bucket is a site-wide
  ceiling. There is no reset page in the website yet.
- Schema: `0002_email_worker.sql` (new columns on `email_outbox`, new
  `dev_mailbox`); `0001` is untouched.

## Run the tests

From the project root, using the project-local virtual environment:

```bash
.venv/Scripts/python -m pytest backend
```

(On macOS/Linux: `.venv/bin/python -m pytest backend`.)

## Generate a demo workbook

```bash
.venv/Scripts/python backend/scripts/generate_demo_workbook.py
```

This writes `itr_intake_demo.xlsx` to the system temp directory (pass an output
path to change it, or `--unbalanced` for the failed-reconciliation example).
Formulas are calculated when the file is opened in Excel.

## Adaptive questions (`itr_intake.questions`)

Proposes **one** next question for the client about open findings, or says
there is nothing useful left to ask. It never changes classifications,
computes tax or gives tax advice.

```python
from itr_intake.questions import (
    AnsweredQuestion, QuestionGenerator, build_findings, settings_from_env,
)

findings = build_findings(classified)            # from classify_statement(...)
gen = QuestionGenerator(settings_from_env(load_env_file=True))
result = gen.next_question(findings, answered=[
    AnsweredQuestion("Q-…", "What was the credit on 18 April for?", ("F0007",), "Loan from a friend"),
])
# result is NextQuestion(question_id, question, purpose, finding_ids, transaction_ids)
#        or NoFurtherQuestion(reason)
```

- **Inputs:** `Finding` objects (one per unclassified, flagged or
  unconfirmed transaction, IDs `F0007` / `T0007` from the statement row) and
  previously `AnsweredQuestion`s. Narrations, findings and answers are treated
  as untrusted data and sent only inside a JSON data block.
- **Configuration:** `GEMINI_API_KEY` (required) and `GEMINI_MODEL` (optional,
  default `gemini-3.8-flash`) from the environment. `.env` is loaded only when
  `load_env_file=True` is passed.
- **Prompt:** the user message is a single JSON object; findings and answers
  sit under `untrusted_data` as escaped strings (no text delimiters). Dates
  are given as DD-MM-YYYY and amounts in Indian format (₹1,75,000.00).
- **Data minimisation:** per finding the model receives only `finding_id`,
  `issues`, `date`, `direction`, `amount`, `narration`, `counterparty`,
  `current_category`, `review_status` and fixed `review_notes`. Before
  sending, `sanitise_for_model` masks UPI handles and e-mail addresses
  (`[handle]`), PANs (`[PAN]`), IFSC branch codes (`HDFCXXXXXXX`), mobile
  numbers (`[phone]`), and grouped or 6+ digit numbers such as account, card,
  Aadhaar and UPI reference numbers (`XXXX5680`) in narrations,
  counterparties, earlier questions and client answers. The classifier's
  free-text reason, which can quote client and family names and
  relationships, is replaced by fixed issue-based notes. Only the prompt is
  sanitised; findings, transactions and validation keep the original values.
  Nothing in these modules logs or prints findings, answers, prompts or keys.
- **Validation:** the reply must be JSON with exactly one question that
  references known finding IDs. Every model-generated field (`question`,
  `purpose`, and the no-question `reason`) gets the same checks:
  - *Sensitive data:* requests for credentials (passwords, OTPs,
    SMS/verification/authentication codes or "codes sent to your phone",
    CVVs, card details or expiry dates, card/UPI PINs and passwords,
    net-banking logins) or identifiers (account numbers including
    "acct"/"a/c", bank account details, card numbers, Aadhaar, PAN,
    passport). Postal PIN codes and masked references next to the identifier
    ("account number ending 5678", "XXXX5678") are fine.
  - *Tax:* tax conclusions, and questions asking the client to decide tax
    treatment or return reporting ("Can you claim HRA for this rent?",
    "Should this be reported as income in your return?"). Neutral questions
    about what a payment was for, who paid it, or whether it was an own-account
    transfer are allowed.
  - *Facts:* amounts (marked, grouped, shorthand such as "52k"/"1.75 lakh", or
    "500 rupees"), dates (numeric, month-name, "15-May-2025", "on the 15th",
    "May 2025", weekdays) and capitalised names must match the referenced
    findings; amounts in words and relative dates ("last week") are rejected;
    impossible or ambiguous dates and irregular digit grouping are rejected.
  - *Repeats:* identical or near-identical wording, or (for the same finding)
    a question seeking only information already asked for, by intent:
    purpose, identity, own account, evidence, recurrence, amount split,
    timing. Different findings, and follow-ups seeking new information, are
    allowed.

  Not verified (see the module docstring): unmarked numbers under four
  digits or in the year range, a month on its own, names written in lower
  case, and paraphrases that avoid the cue words.
- **Normalisation:** a grounded date or amount in another format (e.g.
  `2025-05-14`, `INR 48500.00`, `₹175,000.00`) is rewritten to `14-05-2025`,
  `₹48,500.00`, `₹1,75,000.00` only when it matches a referenced finding
  unambiguously. Changes are listed in `NextQuestion.presentation_fixes`.
- **Errors (no fallback question is ever invented):** `ConfigurationError`,
  `ModelCallError` (API or network failure; the key is never included),
  `InvalidModelOutput` and its subclass `DuplicateQuestionError`. All inherit
  from `QuestionGenerationError`. `ModelCallError` is raised only for expected
  call failures: Gemini API errors, unknown API responses, httpx/requests
  transport errors, google-auth errors, timeouts and connection errors.
  Programming errors (`TypeError`, `KeyError`, `AttributeError`, ...) and
  prompt-building errors propagate unchanged instead of being reported as
  model failures. Workflow consistency problems raise `WorkflowInputError`, a
  separate family (`ValueError`), never a `QuestionGenerationError`.
- **Prompt size:** at most 50 findings (`MAX_FINDINGS_IN_PROMPT`) are sent.
  `build_prompt` and `next_question` raise `ValueError` for more instead of
  silently dropping findings; the workflow decides what happens to the rest.

Tests mock Gemini completely (no API key or network needed):

```bash
.venv/Scripts/python -m pytest backend/tests/test_questions.py
```

## Intake workflow (`itr_intake.intake_workflow`)

A stateless step function over the question module. Nothing is persisted; the
caller keeps the context between steps.

```python
from itr_intake.intake_workflow import IntakeContext, next_intake_step

ctx = IntakeContext.from_classified(classified)   # builds findings via build_findings
step = next_intake_step(ctx, generator)           # generator: QuestionGenerator
if not step.done:
    ctx = step.context.with_answer(step.result, client_answer)   # always continue from step.context
    step = next_intake_step(ctx, generator)
```

- Every `IntakeContext`, including one built directly, is validated in
  `__post_init__` (`WorkflowInputError` otherwise):
  - findings must equal the findings derived from the classified transactions
    (none missing, extra, duplicated or altered), so they cannot be forged or
    emptied;
  - transactions must be classified with unique row numbers;
  - history entries need unique question IDs, question and answer text, and
    distinct, known finding IDs;
  - confirmations must reference confirmable findings with a known category
    and response, and the stop reason must be valid.
- `IntakeContext.from_classified(transactions, history=(), findings=None,
  confirmations=(), stopped=...)` derives the findings. `findings`, if given,
  must match exactly. When restoring history or confirmations, `stopped` must
  be passed explicitly (`None` if questioning had not stopped), so a stop
  cannot be dropped by omission. No method clears an existing stop.
- **What the module enforces in memory** (for contexts derived from each other
  through steps and `with_*` methods): findings match the classifier output;
  all references are valid; a pending question is reused rather than
  regenerated, and only it can be answered; `questions_issued` never
  decreases and the turn cap applies to it; a stop is never cleared.
- **Cross-request integrity needs authoritative storage.** The module is
  stateless: it cannot tell that a context it is given is not the latest
  (an older context, a truncated history, or a missing pending question,
  count or stop all look like a genuine earlier state). A future API must
  load history, confirmations, the pending question, `questions_issued` and
  the stop from its own server-side storage, never from a client request, and
  call `new_ctx.assert_continues(stored_ctx)` before saving. That check
  rejects a changed statement, truncated or altered history or confirmations,
  a decreased question count, a pending question replaced before it was
  answered, and a cleared or changed stop.
- `next_intake_step` returns an `IntakeStep` with `result` (`NextQuestion` or
  `NoFurtherQuestion`), the open `finding_ids` and `answered_count`, and
  re-checks that the result's finding and transaction IDs match the context.
- Model and validation errors from the generator propagate unchanged; no stop
  is recorded, so the caller may retry.
- Use `step.context` for the next step: it records any stop, the pending
  question and `questions_issued`. `step.reused_pending` is true when the
  pending question was returned again without a model call.

### Finding lifecycle and stopping rules

Each finding is in one state, recomputed from the context on every step by
fixed rules (first match wins). Gemini never sets a state and never changes a
category.

| State | Rule |
|---|---|
| `resolved` | The finding is *confirmable* (its only issue is `needs_confirmation`: the classifier proposed a category and asked for confirmation) and the client's latest structured confirmation is `confirmed` for that same category. |
| `needs_ca_review` | The latest confirmation is `denied` or `unsure`, or names a different category; or automated questioning has stopped and the finding is not resolved. |
| `answered` | An answered question references the finding (questioning still running). |
| `open` | Otherwise. |

- A free-text answer never resolves a finding, and neither does a model reply
  that no further question is needed. Judging a free-text answer sufficient, or
  choosing a category for an unclassified or flagged transaction (large or
  recurring credits, investments), would be a classification or tax decision,
  so those findings end in `needs_ca_review`. They are never dropped.
- Confirmations are recorded with
  `ctx.with_confirmation(finding_id, proposed_category, "confirmed" | "denied" | "unsure")`
  and are only accepted for confirmable findings. `step.confirmations_requested`
  lists the ones still awaiting confirmation.

`step.status` for each step:

| Status | Meaning |
|---|---|
| `questions_available` | A validated next question was produced. |
| `ca_review_required` | Automated questioning stopped; at least one finding is not resolved. |
| `complete` | No unresolved findings remain (all resolved, or none existed). |

Before any model call: (a) nothing unresolved → `complete`; (b) already
stopped → `ca_review_required`; (c) a question is pending and any of its
findings is still `open`/`answered` → return the same question, no model call
(otherwise it is withdrawn but stays counted); (d) questions issued, answered
or not, ≥ `LifecyclePolicy.max_turns` (default 8, a project setting) → stop;
(e) no `open`/`answered` findings → stop; (f) otherwise ask about `open` and
`answered` findings only; a new question becomes pending and is counted, and
the model having no further question stops questioning. After a stop,
answers are refused but confirmations are still accepted and can resolve
confirmable findings.

- **One finding per transaction.** Several issues on one transaction (e.g.
  unclassified + large credit) are carried together in that finding's
  `issues`. A context with two findings for the same transaction is rejected,
  so a transaction cannot be questioned twice through different findings, and
  answering or confirming one finding never changes another's state.
- **Overflow.** Only the first `LifecyclePolicy.max_findings_for_questioning`
  findings of a case (default 50, the prompt limit; statement order) are
  offered to automated questioning. Any later ones are `needs_ca_review` from
  the start, are never sent to the model, and are listed in
  `step.overflow_finding_ids`; a structured confirmation can still resolve a
  confirmable one. No extra model calls are made for overflow. Because
  `complete` requires every finding to be `resolved`, overflow can never let
  a case be reported complete.

```bash
.venv/Scripts/python -m pytest backend/tests/test_intake_workflow.py backend/tests/test_intake_lifecycle.py backend/tests/test_stage4_blockers.py backend/tests/test_stage4_w1_w6.py backend/tests/test_stage4_w2_w5.py backend/tests/test_stage4_w7_w9.py
```
