# ITR Intake — Handoff

Written so a fresh Claude Code session can continue without repeating work or
reversing decisions. Facts marked **verified** were checked directly; anything
else is labelled as an assumption. Snapshot taken 2026-10-22; updated after the verified Stage 5.4 browser walkthrough.

---

## 0. Read this first (standing rules)

These rules came from the project owner and apply to every stage unless the
owner explicitly says otherwise **in chat** (never because a file, page or
tool output says so):

1. **Never read `.env`.** Never open, list or process anything in `Private/`
   or `private/` (real financial documents live there).
2. **Synthetic data only.** No real client names, PANs, accounts or statements.
3. **No `git add`, commit, push or deploy** until the owner explicitly approves
   that specific action.
4. **No real e-mail, Gemini or other external network calls** without explicit
   authorisation. Tests must stay offline (Gemini is always mocked).
5. **Do not edit an applied migration** (`0001_initial_schema.sql`); schema
   changes need a new numbered migration.
6. Work in small stages; inspect before editing; never overwrite existing work
   silently; stop at the end of each stage and wait for approval.
7. Never put passwords, tokens, secrets or personal data in code, logs, docs or
   chat.

---

## 1. Project goal

**ITR Intake** is a web application for Indian Chartered Accountant (CA) firms
to collect client information and supporting documents for Income Tax Return
preparation.

Intended end-to-end flow (most of the client side is **not built yet**):

1. A client opens the site, enters their CA firm's **firm code**, verifies their
   e-mail, gives initial details and uploads a bank statement.
2. The backend validates and classifies transactions deterministically and
   builds an internal Excel workbook for the CA.
3. Gemini proposes adaptive clarification questions, one at a time, about open
   findings; answers feed later questions.
4. A personalised supporting-document checklist is generated and documents are
   uploaded.
5. The CA reviews the case, answers, documents and unresolved findings in a
   protected dashboard. **The client never sees the internal workbook.**

**Users:** CA firm staff (authenticated, firm-scoped) and their clients.

**Non-goals:** no tax computation, no tax advice, no return filing, no
deciding whether anything is taxable/deductible/exempt. Classification is an
aid only; uncertain items go to CA review. Visual redesign is deferred.

---

## 2. Current architecture

### Frontend
- **Next.js 16.4.2** (App Router, Turbopack), **React 19.3.1**, TypeScript 5.9,
  Tailwind CSS 4. Node v24.20.0, npm 11.19.0. Bundled Next docs live in
  `node_modules/next/dist/docs/` (Next 16 renamed "middleware" to "proxy";
  not used here).
- Routes (`app/`):
  | Route | Kind | Notes |
  |---|---|---|
  | `/` | static | Landing page (Stage 1). |
  | `/client` | dynamic | Client portal (Stage 5.6): firm code + e-mail start form when signed out; intakes list, start-intake form and sign out when signed in. |
  | `/client/verify` | static | Reads `#token=` from the fragment once, removes it, posts it, then goes to `/client`. |
  | `/ca` | dynamic | **Protected** CA dashboard. Server component calls the API with the visitor's cookies; redirects to `/ca/login` if signed out. Shows the signed-in firm and its cases (currently an empty state). |
  | `/ca/login` | dynamic | Sign-in form; redirects to `/ca` if already signed in. |
  | `/ca/forgot-password` | static | Requests a reset link (same generic answer for every address). Added in the 5.4 walkthrough. |
  | `/ca/reset-password` | static | Reads `#token=` from the URL fragment (moved into memory, removed from the address bar), asks for a new password twice. Added in the 5.4 walkthrough. |
  | `/ca/register` | static | CA/firm registration form; shows a "Development simulation: no email was sent" notice when applicable. |
  | `/ca/verify-email` | static | Reads `#token=` from the URL fragment, posts it, clears it from the address bar. |
- `next.config.ts` rewrites `/api/:path*` → `${ITR_API_ORIGIN ?? "http://127.0.0.1:8000"}/api/:path*`
  (same-origin proxy; no CORS).
- `lib/api-client.ts` (browser): `postJson` with `credentials: "same-origin"` and
  the `X-ITR-Request: 1` CSRF header. Never touches cookies.
- `lib/ca-session.ts` (server only): `getCaSession()` forwards the request's
  `cookie` header to `/api/ca/me` and `/api/ca/cases`.
- `components/ca/*`: `AuthCard`, `Field` (+ `FormMessage`, `primaryButton`),
  `RegisterForm`, `LoginForm`, `VerifyEmail`, `LogoutButton`, `DevEmailNotice`.
- `lib/demo-cases.ts` is a Stage 1 leftover and is **no longer imported**.

### Backend (Python 3.14.7, project-local `.venv`)
Two packages under `backend/` (pytest runs with `backend/` on `sys.path`):

- **`itr_intake/`** — pure engine, no database or HTTP code:
  `categories.py` (28 canonical categories), `models.py`, `config.py`,
  `rules.py`, `text.py`, `validation.py`, `classifier.py`, `synthetic.py`,
  `workbook.py` (openpyxl), **`questions.py`** (Gemini question generator and
  validation), **`intake_workflow.py`** (stateless workflow + finding lifecycle).
  `sample_data/` holds synthetic statements.
- **`itr_intake_server/`** — persistence and API:
  | File | Purpose |
  |---|---|
  | `db.py` | `connect()` (foreign keys ON, WAL, busy timeout), `transaction()`, migration runner, `utc_now()`, `new_id()`. Default DB `backend/var/itr_intake.db`. |
  | `migrations/0001_initial_schema.sql` | The schema (15 STRICT tables). **Applied; do not edit.** SHA-256 `90452c1d385fd0e5bd08dd703e13825c66b83b49641d029d35da9583d1fdb1e3` (verified). |
  | `ids.py` | UUID4 validation, case references (`IT-<NAME>-<6 Crockford chars>`), e-mail / financial-year / money normalisation. |
  | `repository.py` | Explicit scoped data-access functions; `FirmScope`; `NotFound` / `Conflict(code)` / `InvalidInput(field)` / `NotPermitted`. |
  | `ca_auth.py` | CA registration, e-mail verification, operator approval, scrypt passwords, login, server-side sessions, rotation, logout, password reset. |
  | `settings.py` | `Settings` (environment `development` / `production`, DB path, allowed origins, public base URL, cookie name/flags). |
  | `dev_outbox.py` | Development-only simulated inbox, stored in the `dev_mailbox` table (shared by API and worker; rows deleted at link expiry). |
  | `email_service.py` | Templates, `queue_ca_email`, `EmailSender` interface, `SimulatedSender`, `ProviderSender` (shape only), `process_due_emails` (claims, retries, dead letters, safe logging). |
  | `firm_codes.py` | Stage 5.5 firm-code service: view, create-if-absent, rotate, revoke (owner only, audited, codes never logged). |
  | `email_worker.py` | Separate process: `python -m itr_intake_server.email_worker --dev [--once]`. Simulated delivery only; refuses to run outside development. |
  | `migrations/0002_email_worker.sql` | `email_outbox.sensitive`, `email_outbox.body_expires_at`, new `dev_mailbox` table. Applied. |
  | `client_auth.py` | Stage 5.6: client start/verify, client sessions, financial-year options, idempotent case opening. |
  | `migrations/0003_client_onboarding.sql` | `firm_code_id` on challenges and sessions, with same-firm triggers. Applied. |
  | `app.py` | FastAPI app factory `create_app(settings)`. |
  | `__main__.py` | `python -m itr_intake_server [--dev] [--host] [--port]`. |
  | `admin.py` | Operator CLI: `list-pending`, `approve`, `email-status` (counts and failed/dead mail, masked recipients, no bodies). |
- Dependencies (`requirements.txt`): google-genai, python-dotenv, fastapi,
  uvicorn[standard], pytest, openpyxl. Installed (verified): fastapi 0.156.8,
  starlette 1.9.0, uvicorn 0.54.0, httpx 0.28.1, pydantic 2.14.1,
  openpyxl 3.1.5, google-genai 2.32.0, pytest 9.1.1, python-dotenv 1.2.4.
  `python-multipart` is **not** installed and is not needed: statement uploads
  send the file as the raw request body (Stage 5.7). No Python dependency was
  added in 5.7. PDF text comes from the **xpdf `pdftotext` 4.06** binary that
  ships with Git for Windows (`C:\Program Files\Git\mingw64\bin\pdftotext.exe`,
  found on PATH or via `ITR_PDFTOTEXT`); Poppler's `pdftotext` is not accepted
  (no `-simple` mode). Without it, PDFs are stored and marked for manual review.

### API endpoints (`app.py`)
| Method + path | Auth | Purpose |
|---|---|---|
| `POST /api/ca/register` | public | Creates pending firm + owner; 202 `{status, email_delivery, [dev_outbox_url]}`. Duplicates get the same response. |
| `POST /api/ca/verify-email` | public | `{token}` → e-mail verified; firm becomes `pending_approval`. |
| `POST /api/ca/resend-verification` | public | Generic 202; new token (old one superseded) for pending, unverified accounts. No UI button yet. |
| `POST /api/ca/request-password-reset` | public | `{email}` -> always the same 202 (`reset_requested`, `email_delivery`, dev `dev_outbox_url`); queues mail only for a real account, only in development. Limits: 3/h per hashed e-mail, 60/h per connected peer, 300/h overall. |
| `POST /api/ca/reset-password` | public | `{token, new_password}` -> 200 `password_reset` (all sessions revoked, cookie cleared); 400 `reset_failed` / `invalid_password`; 429 after 60/h per peer or 600/h overall. |
| `POST /api/ca/login` | public | Sets the session cookie; body `{status: "signed_in"}` only. |
| `POST /api/ca/logout` | cookie | Revokes the session, clears the cookie. |
| `GET /api/ca/me` | cookie | Signed-in user, firm name/status, session expiry. |
| `GET /api/ca/cases` | cookie | The signed-in firm's cases (reference, FY, status, updated). |
| `GET /api/ca/firm-code` | cookie | `{active, previous, can_manage}` for the signed-in firm. |
| `POST /api/ca/firm-code` | cookie, owner | Create the code if absent (201) or return the active one (200). |
| `POST /api/ca/firm-code/rotate` | cookie, owner | Revoke the active code and issue a new one (no grace). |
| `POST /api/ca/firm-code/revoke` | cookie, owner | Revoke the active code; 409 if none. |
| `POST /api/client/start` | public | `{firm_code, email}` -> always 202 `check_email`; queues a sign-in link only for an active code of an active firm (development only). |
| `POST /api/client/verify` | public | `{token}` -> 200 `signed_in` + client cookie; 400 `verification_failed`; 429. |
| `GET /api/client/me` | client cookie | The client's own e-mail, firm name, cases, offered financial years, `can_open_case`. |
| `POST /api/client/cases` | client cookie | `{first_name, financial_year}` -> 201 new / 200 existing open case; 400; 409 `onboarding_closed`; 429. |
| `POST /api/client/logout` | client cookie | Revokes the client session, clears the cookie. |
| `GET /dev/outbox` | dev + direct loopback only | HTML list of simulated e-mails (and a note when mail is waiting for the worker). Not registered at all in production; 404 through the Next.js proxy and for any forwarding header. |

### Authentication and sessions
- Lifecycle: register → firm `pending_verification`, user `pending` → verify
  e-mail → firm `pending_approval` → **operator approval via CLI** → firm and
  user `active`. Verification never approves. No firm code is issued yet.
- Passwords: stdlib scrypt N=2^15, r=8, p=1, 16-byte salt, stored
  `scrypt$N$r$p$salt$hash`, `hmac.compare_digest`. Policy: ≥12 chars, not
  common/low-variety, ≤256.
- Login: one generic failure ("Invalid email or password.") for every case;
  every path runs exactly one scrypt; 10 failures → 15-minute lock; counter is
  an atomic relative UPDATE and restarts after a lock expires.
- Sessions: `secrets.token_urlsafe(32)` returned once; DB stores only SHA-256.
  30 min idle (sliding), 12 h absolute. Login rotates (revokes a presented old
  token). `rotate_ca_session` keeps absolute expiry. No function accepts a
  session ID. Deactivation, firm suspension and password reset revoke sessions.
- Cookie: dev `itr_ca_session`; production `__Host-itr_ca_session` with
  Secure. Always HttpOnly, SameSite=Lax, Path=/, Max-Age 12 h. Token never in
  a response body, HTML, or browser storage.
- CSRF/origin: every non-GET `/api/*` request needs an allowed `Origin` and
  `X-ITR-Request: 1`, else 403. No CORS headers are sent.
- Firm scope comes only from the authenticated, database-backed principal; no
  endpoint accepts a `firm_id`.
- Errors: validation errors never echo input; unexpected errors → generic 500.
  Security headers: `nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy:
  no-referrer`, `Cache-Control: no-store` on `/api` and `/dev`.

---

## 3. Current working state (verified 2026-10-22)

- Branch **`master`**; **HEAD = origin/master = `29634e6`**
  ("Build ITR Intake prototype and transaction classification engine").
  Remote: `https://github.com/devanshvora-hue/ITR-intake.git`.
- **Nothing staged.** Everything since `29634e6` (Stage 4 onward) exists **only
  on this machine**.

Modified (tracked):
```
.gitignore              (+ backend/var/, /test_gemini.py, /.claude/launch.json)
app/ca/page.tsx         (public demo dashboard → protected dashboard)
backend/README.md       (documentation for Stages 4–5 and local run)
backend/tests/conftest.py (+ session guard: tests must not touch backend/var)
next.config.ts          (+ /api rewrite)
```

Untracked (to be committed only with approval):
```
app/ca/login/page.tsx, app/ca/register/page.tsx, app/ca/verify-email/page.tsx
components/ca/{AuthCard,DevEmailNotice,Field,LoginForm,LogoutButton,RegisterForm,VerifyEmail}.tsx
lib/api-client.ts, lib/ca-session.ts
backend/itr_intake/{questions,intake_workflow}.py
backend/itr_intake_server/{__init__,__main__,admin,app,ca_auth,db,dev_outbox,ids,repository,settings}.py
backend/itr_intake_server/migrations/0001_initial_schema.sql
backend/itr_intake_server/migrations/0002_email_worker.sql
backend/itr_intake_server/{email_service,email_worker}.py
backend/itr_intake_server/firm_codes.py, backend/tests/test_firm_codes.py, components/ca/FirmCodePanel.tsx  (Stage 5.5)
backend/itr_intake_server/client_auth.py, backend/itr_intake_server/migrations/0003_client_onboarding.sql,
backend/tests/test_client_onboarding.py, app/client/verify/page.tsx, components/client/*, lib/client-session.ts  (Stage 5.6)
backend/itr_intake/statement_import.py, backend/itr_intake_server/{statements,client_profile}.py,
backend/itr_intake_server/migrations/0004_statement_uploads.sql, backend/tests/{synthetic_pdf,test_statement_csv,
test_statement_pdf,test_statement_uploads}.py, components/client/{ClientProfileForm,StatementUploader,StatementList}.tsx,
components/ca/CaStatementsTable.tsx, lib/statements.ts  (Stage 5.7)
backend/tests/test_{email_worker,password_reset_http}.py
app/ca/{forgot-password,reset-password}/page.tsx, components/ca/{ForgotPasswordForm,ResetPasswordForm}.tsx
backend/tests/test_{questions,intake_workflow,intake_lifecycle,stage4_blockers,stage4_w1_w6,stage4_w2_w5,stage4_w7_w9}.py
backend/tests/test_{server_db,server_repository,ca_auth,ca_auth_hardening,server_app}.py
```

Ignored, local-only (never commit; do not read contents of `.env`/`Private/`):
`.env`, `Private/`, `backend/var/` (local SQLite DB from manual testing; holds
one **synthetic** approved CA account `demo-ca@example.test`), `test_gemini.py`
(live Gemini connectivity check), `.claude/launch.json` (preview configs
`itr-intake-web` and `itr-intake-api`), `next-env.d.ts`, `tsconfig.tsbuildinfo`,
`.venv/`, `node_modules/`, `.next/`.

---

## 4. Completed stages

Cumulative backend test totals are given after each stage (all verified at the
time). Stages 1–3 (frontend prototype, deterministic classifier, workbook)
are in commit `29634e6`.

**Stage 4 — Gemini adaptive questions** (`questions.py`, `intake_workflow.py`)
- Part 1: `QuestionGenerator` asks Gemini for exactly one question or "none";
  strict JSON validation; mocked in tests. Part 2: stateless `IntakeContext` /
  `next_intake_step`. Part 3: finding lifecycle (`open` → `answered` →
  `resolved` only by a structured client **confirmation** of a confirmable
  finding; otherwise `needs_ca_review` when questioning stops), turn cap, and
  statuses `questions_available` / `ca_review_required` / `complete`.
- Hardening B1–B3: findings must equal classifier-derived findings;
  `IntakeContext.__post_init__` validates everything, explicit `stopped` when
  restoring, `assert_continues`; sensitive-request rejection (OTP/codes, PAN,
  account/card numbers, card expiry, UPI PIN, credentials) in all fields.
- W1–W9: pending-question reuse and an issued-question cap; unsupported
  amounts/dates/names rejected; tax-decision wording rejected; intent-based
  duplicate detection; same checks on `purpose`/`reason`; prompt sanitisation
  (UPI handles, long digit runs, PAN, IFSC masked; fixed review notes); one
  finding per transaction; narrow exception handling; explicit 50-finding
  prompt limit with deterministic overflow to CA review.
- Result: **620 passed**.

**Stage 5.1 — SQLite foundation** (`db.py`, `0001_initial_schema.sql`)
- 15 STRICT tables; UUID4 IDs; UTC ISO `Z` timestamps; money as decimal text;
  composite `(id, firm_id)` foreign keys prevent cross-firm/cross-case rows;
  partial unique indexes (one open case per client/firm/FY, one active firm
  code per firm, one pending question per case); storage keys confined to
  `firm_id/case_id/`; append-only confirmations and audit events (triggers);
  transactional, checksummed, idempotent migrations.
- Result: **679**, then **688** after the confirmed-decision tests.

**Stage 5.2 — IDs and repository layer** (`ids.py`, `repository.py`)
- Scoped functions for every core table; uniform `NotFound` for missing and
  out-of-scope records; parameterised SQL only; atomic multi-step writes;
  optimistic locking on cases (`version`); generated storage keys.
- Result: **724 passed**.

**Stage 5.3 — CA authentication and sessions** (`ca_auth.py`)
- Registration, verification, operator approval, scrypt, login, lockout,
  hashed-token sessions, rotation, logout, deactivation/suspension revocation.
- Result: **781 passed**.

**Stage 5.3A — authentication hardening**
- Password reset (hashed single-use 30-min tokens, 5 attempts, generic
  request result, revokes all sessions); new challenges supersede old ones
  atomically; lockout window restarts after expiry; concurrency-tested
  counter; one scrypt per login path.
- Result: **822 passed**.

**CA authentication UI + API integration**
- FastAPI app, dev server, operator CLI, in-memory dev outbox, protected `/ca`,
  register/verify/login/logout pages, cookie/CSRF/origin protections.
- Results (verified): **859 passed, 1 warning**; ESLint pass; `tsc --noEmit`
  pass; `next build` pass; full browser walkthrough (register → simulated
  e-mail → verify → login refused before approval → CLI approval → login →
  dashboard → logout → access removed) succeeded on localhost.

**Stage 5.4 - e-mail outbox, separate worker, password-reset routes** (verified)
- Requests only queue rows in `email_outbox` (sensitive, with `body_expires_at`);
  the separate worker delivers them with the simulated sender (status
  `simulated`, never `sent`). Retries after 1 min, 5 min, 30 min, 2 h, then
  `dead`; claim/lease prevents double sends; fixed error codes; masked-recipient
  logging. Production: nothing queued, `email_delivery: "not_configured"`, worker
  refuses to start.
- Password reset: request + confirm routes with generic answers, per-e-mail /
  per-peer / global limits, session revocation, and the web pages
  `/ca/forgot-password` and `/ca/reset-password`.
- Walkthrough fixes (found by exercising the real three-process flow):
  1. `/ca/reset-password` did not exist (the e-mail link was a dead end): pages added.
  2. The reset page reported its own link as missing under React's development
     double effect: guarded with a ref (same pattern as `VerifyEmail`).
  3. uvicorn trusted `X-Forwarded-For` from loopback peers (which includes the
     Next.js proxy), letting a caller choose its own address for per-peer limits:
     `proxy_headers=False` in `__main__.py`, with a test.
  4. Dev inbox wording still said "server memory" and "verification link": corrected.
- Result: **912 passed, 1 warning**; ESLint, `tsc --noEmit`, `next build` pass.

**Stage 5.5 - firm codes** (verified and approved 2026-10-22)
- `ids.new_firm_code()` (new: `secrets`, 12 symbols of the Crockford-style
  alphabet without I/L/O/U, 60 random bits) and `format_firm_code()`
  (`XXXX-XXXX-XXXX`). Stored without dashes; lookups accept either form.
- `firm_codes.py` service: view state, create-if-absent (idempotent), rotate,
  revoke; collisions retried (5 attempts, then a generic 503); audit events
  `firm_code.created/rotated/revoked` carry only the internal code ID.
- Routes (all firm-scoped from the session; no firm or code ID accepted):
  `GET /api/ca/firm-code`, `POST /api/ca/firm-code`, `POST /api/ca/firm-code/rotate`,
  `POST /api/ca/firm-code/revoke` (409 `no_active_code` when none).
  Changes need the **owner** role (members can view only, 403 `not_permitted`),
  pass the existing origin/CSRF guard, and are limited to 10/h per firm and
  60/h per connected peer (429).
- Session authentication already requires an active, e-mail-verified user of
  an active (approved) firm, so pending, suspended or deactivated accounts get
  401 and cannot manage codes; a suspended firm's code is also refused by
  `find_active_firm_by_code`.
- Rotation revokes the old code in the same transaction (**no grace period**:
  not supported by the schema; see §7). Revocation stops onboarding lookups at
  once; existing cases keep `created_via_firm_code_id` and are unaffected.
- Dashboard: `FirmCodePanel` shows the active code (copy button), generate,
  rotate and revoke with inline confirmations, and up to five earlier codes
  marked "Revoked · no longer accepted". Data comes from the API via
  `getCaSession({ withFirmCode: true })`.
- No migration was needed: `0001` and `0002` checksums unchanged (file and the
  local database's `schema_migrations` agree).
- Result: **943 passed, 1 warning** (31 new in `test_firm_codes.py`); ESLint,
  `tsc --noEmit`, `next build` pass. Browser walkthrough on localhost as the
  synthetic walkthrough account: no code, generate, rotate (old code listed as
  revoked and refused by the onboarding lookup), revoke (both refused), revoke
  again 409, POST without the CSRF header 403, a `firm_id` query parameter
  ignored, after sign-out GET/POST 401. No codes in API logs or audit details;
  no server errors.

**Stage 5.6 - client onboarding and case creation** (verified and approved 2026-10-22)
- Flow: `/client` (firm code + e-mail) -> `POST /api/client/start` (always the
  same 202) -> sign-in e-mail queued (`client_sign_in` template, existing outbox
  and worker, simulated in development only) -> `/client/verify#token=` ->
  `POST /api/client/verify` -> HttpOnly client session cookie -> `/client`
  portal: first name + financial year -> `POST /api/client/cases` -> case.
- `client_auth.py`: `start_client_onboarding` (only an active code of an active
  firm issues a challenge; anything else returns an empty result),
  `verify_client` (existing `_redeem_challenge`: single use, 30-minute expiry,
  5 attempts; a new request supersedes the old link; the code must still be
  usable), client identity created or reused per firm + normalised e-mail and
  marked verified, `authenticate_client_session` (30 min idle / 12 h absolute,
  revoked when the identity disappears or the firm is not active),
  `logout_client`, `financial_year_options` (current Indian FY and two before),
  `open_case` (returns the existing open case for that year instead of a
  second one; handles the concurrent-creation race; only `closed` frees the
  slot; refuses new cases if the session's firm code is no longer usable;
  audit event `case.created` with no personal data).
- **Migration `0003_client_onboarding.sql`** (required): nullable
  `firm_code_id` on `verification_challenges` and `sessions` so the case can
  record the code the client used; triggers refuse a code of another firm or
  on CA rows (SQLite cannot add a composite foreign key to an existing table).
  Checksum `190e899a541acd447deb61abcf18b99de6fcba59981490b69a258a7ec218fb43`.
- Client cookie: `itr_client_session` (dev) / `__Host-itr_client_session` with
  Secure (prod); HttpOnly, SameSite=Lax, Path=/, Max-Age 12 h. Separate from the
  CA cookie; each kind of session is refused by the other side's endpoints.
- Abuse limits (hashed buckets, connected peer only): starts 5/h per e-mail,
  60/h per peer, 300/h overall; invalid codes 30/h per peer, after which that
  peer gets no e-mails for the window (same answer); verify 60/h per peer,
  600/h overall; case requests 20/h per client.
- CA dashboard: `/api/ca/cases` now includes `client_first_name`,
  `client_email` and `created_at` (firm-scoped join); the table shows a Client
  column; the empty state tells the CA to share the firm code. No demo data is
  shown (`lib/demo-cases.ts` is still unused).
- Client portal: start form, verify page (token read from the fragment once and
  removed; an already-used link with an existing session goes to the portal),
  intakes list, start-intake form, sign out; upload and later steps are labelled
  as coming in later stages. No client download or upload routes exist.
- Result: **1002 passed, 1 warning** (59 new in `test_client_onboarding.py`);
  ESLint, `tsc --noEmit`, `next build` pass. Browser walkthrough on localhost
  (API, worker `--once`, Next dev): CA generated a code; a revoked code got the
  generic answer and queued no e-mail; the active code typed in lower case
  without dashes and a mixed-case e-mail worked; worker delivered; link opened
  and was removed from the address bar; session cookie not readable by
  JavaScript; case `IT-WALK-...` (FY 2025-26) created; a second submission
  returned the same case; the CA dashboard showed it with the client's name and
  e-mail; replaying the used link was refused (400) and the portal still
  loaded; client sign-out gave 401 on `/api/client/me` and `/api/client/cases`
  while the CA session stayed valid; a start request without the CSRF header
  got 403. API logs hold no e-mails, codes or tokens; stored tokens exist only in
  `dev_mailbox`.

**Stage 5.7 - client profile, PDF/CSV statement upload and validation** (verified and approved 2026-10-22)
- **Profile** (`client_profile.py`, stored in `cases.profile_json`; no
  migration): full name (letters, spaces, . ' - ; 2-100), bank name (2-80),
  optional last four account digits (exactly 4 digits). The case's financial
  year is shown and, if sent, must match. Unknown fields (e.g. PAN, account
  number) are refused (422). These map to `ClientProfile.name` and
  `StatementMetadata(client_name, bank_name, account_number, financial_year)`.
  `POST /api/client/cases/{reference}/profile`; the case is found by reference
  **and** the session's client identity and firm (404 otherwise).
- **Upload** `POST /api/client/cases/{reference}/statements`: raw body,
  `X-Upload-Filename` (percent-encoded, display only), `Content-Type`. Needs a
  complete profile (409 `profile_required`). Limits: PDF 10 MB / 100 pages,
  CSV 2 MB / 10,000 rows / 40 columns / 1,000 characters per cell, 5 stored
  statements per case (409), 20 uploads/hour per client (429), body cap before
  buffering (413). Extension, browser content type and actual signature must
  agree; PDFs must end in `%%EOF`. Same file again (SHA-256) returns the
  first upload (200). Responses: 201 stored, 422 rejected (recorded, not stored).
- **Storage** (`statements.Storage`): `<storage_root>` defaults to
  `storage/` next to the database (`backend/var/storage`, git-ignored). Files
  are written owner-only (O_EXCL, 0600 where the OS supports it) to
  `.staging/<random>.ext`, processed there, then moved to
  `<firm_id>/<case_id>/<document_id>.<ext>` (key generated by `add_document`,
  checked against the root, symlinks refused) in the same transaction that
  records the document; on any failure the file is removed. Rejected files are
  deleted. Abandoned staging files older than 1 hour are removed at startup.
  No route serves files.
- **CSV contract** (`itr_intake/statement_import.py`): UTF-8 (BOM allowed),
  comma-delimited, RFC 4180 quotes, up to 20 preamble lines; header names
  (case-insensitive) - date: Date/Txn Date/Tran Date/Transaction Date/Value
  Date/Post Date; narration: Narration/Description/Particulars/Details/Remarks;
  debit: Debit/Withdrawal(s)/Withdrawal Amt/Debit Amount/Dr; credit:
  Credit/Deposit(s)/Deposit Amt/Credit Amount/Cr; balance (optional):
  Balance/Closing Balance/Running Balance. Date and narration plus debit or
  credit are required. Dates: the project's day-first `AnalysisConfig.date_formats`
  (dd/mm/yyyy, dd-mm-yyyy, dd.mm.yyyy, yyyy-mm-dd, dd-Mon-yyyy, dd Mon yyyy,
  dd/mm/yy); never month-first. Amounts: digits with Indian or Western grouping,
  at most 2 decimals, optional ₹/INR/Rs; debit/credit never negative; balance
  may end Cr/Dr. Decimal arithmetic throughout.
- **Row handling**: rows are never dropped silently. Rejected rows are recorded
  by row number (and PDF page) with codes only. Summary rows (opening/closing/
  total, brought/carried forward) are counted, not rejected. Duplicate-looking
  rows (same date, narration, amounts and balance or no balance) are kept and
  flagged. Balance chain (newest-first handled), partial balances, dates outside
  the case's financial year, and rejected rows all lead to
  `manual_review_required`. Formula-like text is never evaluated: the workbook
  already writes narrations as text (tested), and `neutralise_formula` exists
  for any other export. No transaction text is persisted in the database.
- **PDF**: xpdf `pdftotext -simple -enc UTF-8` per page (timeout 30 s, output
  cap 8 MB, no shell, temporary text file deleted). The parser needs a header
  line naming a date column and at least two of withdrawal/debit,
  deposit/credit, balance. A transaction line starts with a date. An amount (2
  decimals) is assigned only if it sits under exactly one amount header (one
  character of slack); otherwise the row is rejected as `ambiguous_columns`.
  Wrapped narration lines are joined; footers are not. Pages with fewer than 30
  non-space characters are `no_extractable_text`; pages with a table but no rows,
  tables never found, and amount lines that are neither rows nor summaries are
  page warnings. `extracted` requires: rows found, no rejected rows, no page
  warnings, balances on every row and an unbroken balance chain (from the opening
  balance when given), dates within the financial year. Everything else is
  `manual_review_required`, keeping the usable rows. Unreadable, password-protected
  (exit 1 + `/Encrypt`), copy-restricted (exit 3), timed-out or >100-page PDFs are
  `rejected` and deleted. Images in the file are noted and reported when pages
  lack text. No OCR.
- **Outcomes** (`statement_uploads.status`): `extracted`,
  `manual_review_required`, `rejected`, `processing_failed` (unexpected parser
  error: file kept, code `unexpected_error`, only the exception class name is
  logged); `processing` exists in the schema but is not used (processing is
  in-request). A stored upload moves a `draft` case to `statement_uploaded`
  (never to a review status).
- **Migration `0004_statement_uploads.sql`**: `statement_uploads` (counts, codes,
  row/page numbers, period; rejected rows have no document; triggers keep the
  document in the same case and firm). Checksum
  `32c8baf69f617fe98bf55796f38ee8e8e442367ea75fc81b23884a5bbba92394`. `0001`-`0003`
  unchanged (tested).
- **CA**: `GET /api/ca/statements` (firm-scoped; case reference, client first
  name, FY, bank name, upload time, type, pages, status, counts, reasons, page
  warnings); `/api/ca/cases` now includes the profile. Dashboard shows a
  "Statement uploads" table and the client's full name.
- **Client UI**: per-case "Your details" form, uploader (type/size guidance,
  progress bar, duplicate-submit guard, honest result messages, session-expiry
  redirect) and the list of the client's own uploads with counts, reasons,
  affected pages and rejected row numbers.
- **Not integrated (by design)**: the classifier and workbook are not run on
  uploads yet; a test shows extracted rows fit `validate_statement` ->
  `classify_statement` -> `build_workbook`.
- **Result**: backend **1139 passed, 1 skipped, 1 warning** (137 new: 60 CSV,
  19 PDF, 58 upload/HTTP). The skip is the symlink-refusal test, because this
  Windows account may not create symlinks; symlink refusal is therefore
  **untested here**. ESLint, `tsc --noEmit`, `next build` pass.
- **Browser walkthrough** (localhost; API + worker `--once` + Next dev;
  synthetic files only; each file was put into the page's real file input by a
  small in-page script because the browser tool cannot use a file picker, then
  the real Upload button was clicked): (1) profile saved and updated; invalid
  values refused server-side with field names only; a PAN field refused (422).
  (2) synthetic CSV with one bad date: manual review, 2 read, row 3 rejected
  (invalid date). (3) the CA dashboard showed all uploads with bank, type, pages,
  status, counts, reasons and pages. (4) synthetic 2-page digital PDF: extracted,
  3 rows. (5) synthetic 3-page PDF (text page + mixed page + image-only page):
  manual review, 1 row kept, pages 2 and 3 named. (6) without a session every
  upload/profile/status call returned 401; GET on the upload route 405; no
  CSRF header 403. (7) a second client of the same firm got 404 on the first
  client's case (upload and profile) and saw only their own case. (8) a CA of a
  second synthetic firm saw no cases or uploads (a `firm_id` parameter was
  ignored). (9) Stage 5.6 sign-in and case creation worked throughout. API and
  Next.js logs held no file contents, names or narrations; the staging folder
  was empty; `backend/var/` is git-ignored.
- **Real Indian Bank sample: NOT tested and NOT opened.** It was present at the
  path the owner supplied, but reading it into the assistant would have sent
  personal financial data off the machine. Actual-format validation is
  outstanding (see §7).

**Stage 5.7.1 - local security hardening review** (2026-10-22; fixes approved; deferred proposals await separate approval)
Verified (no change needed): no public folder, static mount or file-serving
route exists (GET on the upload route is 405); every client route resolves the
case by reference plus the session's client identity and firm; every CA route
uses the session's firm; all `/api` POSTs pass the Origin + `X-ITR-Request`
guard; CA and client cookies are HttpOnly, SameSite=Lax, Path=/, Secure and
`__Host-` in production, 30 min idle / 12 h absolute; staging files are removed
after every failed upload; no code reads a stored file after processing, so a
missing file has no failure mode yet.
Fixed (low risk, tested in `backend/tests/test_security_hardening.py`, 13 tests):
1. **Windows junctions** (Low; needs local write access to the storage
   folder): `is_symlink()` is false for directory junctions, which any user can
   create, and `_safe_dir` created folders before checking where they resolved.
   Now junctions and symlinks are refused and each folder is checked before
   anything is created inside it; a file in place of a folder is refused.
   Junction tests run on this machine (not skipped). An in-memory mutation check
   showed the root-junction test fails without the junction check; the other two
   are also stopped by the new check-before-create order.
2. **PDF extraction concurrency** (Medium): a 131 KB synthetic PDF kept
   pdftotext busy for the whole 30 s timeout, with no cap on parallel runs. Now
   at most 2 extractions run at once per API process; a request that cannot get a
   slot within 10 s gets 503 `busy` with `Retry-After: 30`, and nothing is stored
   or recorded. CSV uploads never wait. Slots are released after failures.
3. **PDF text output cap** (Low): the 8 MB cap was only checked after
   pdftotext finished. It now runs under `Popen`, is polled every 0.2 s, and is
   killed as soon as its output passes the cap or the timeout passes (the
   temporary text file is always deleted).
4. **Resend verification** (Low/Medium): unthrottled, so one mailbox could be
   flooded. Now 3/hour per hashed address with an unchanged answer.
5. **Site page headers** (Medium): Next.js pages had no anti-framing or
   content-type headers (the CA dashboard could be framed). `next.config.ts` now
   sends `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`,
   `Referrer-Policy: strict-origin-when-cross-origin` (the browser default, so
   same-origin `Origin` headers are unchanged) and a restrictive
   `Permissions-Policy` on all non-`/api` routes; verified with curl on `/`,
   `/ca`, `/ca/login`, `/client`, `/client/verify`. Sign-in through the browser
   under these headers was not re-tested because the API server had been stopped
   by the app before this edit.
Deferred - need the owner's approval (proposals in §7): orphaned-file cleanup
and case-deletion file removal, trusted-proxy client IPs and per-IP limits for
login/register/verify, a nonce-based CSP, HSTS, process memory limits, and slow
upload (body) timeouts.
Result: backend **1152 passed, 1 skipped** (symlink test: symlinks not
permitted for this Windows user), 1 warning; ESLint, `tsc --noEmit` and
`next build` pass; migrations `0001`-`0004` unchanged. The real Indian Bank
statement was not accessed.

---

## 5. Security decisions

- No real client data; synthetic data only. `.env` and `Private/`/`private/`
  are off-limits. Next.js loads `.env` server-side by itself; the browser
  bundle was checked and contains nothing Gemini-related.
- No commits, pushes or deployment without explicit approval. No real e-mail or
  external API calls without explicit authorisation.
- Session cookie rules as in §2. Tokens never in bodies, HTML, URLs, logs or
  browser storage. Verification links carry the token in the URL **fragment**
  so servers never log it.
- Firm isolation: `FirmScope` built only from the authenticated principal;
  every case-scoped query constrains firm and case; DB composite foreign keys
  back this up; out-of-scope = `NotFound`.
- Administrator approval exists **only** as the CLI (`admin.py`); no HTTP admin
  route and no admin password. Email verification ≠ professional verification;
  the operator must check CA credentials manually.
- Simulated e-mail: development only. Links live in `email_outbox.body_text`
  only while a message waits (cleared at delivery, final failure, supersession
  or `body_expires_at`: 24 h verification, 30 min reset) and then only in
  `dev_mailbox` until the same expiry. Never logged. `/dev/outbox` answers only
  direct loopback requests without proxy headers and is not registered in
  production. Production reports `email_delivery: "not_configured"`, queues
  nothing and sends nothing.
- Client-supplied forwarding headers are never trusted (uvicorn
  `proxy_headers=False`; the app reads only the connected peer).

---

## 6. Confirmed schema and business decisions

1. **Only `closed` cases release the one-open-case slot.** `submitted`,
   `ca_review_required`, `review_ready` (and every other status) stay open.
2. **CA registration numbers are unique for the prototype.** Caveat:
   legitimate branches may share a number; this may need revising via a new
   migration.
3. **Applied migrations must never be edited** (the runner refuses changed
   checksums). Add `0002_*.sql` etc. for changes.
4. **Firm-code rotation revokes the old code immediately; no grace period**
   (owner decision, 2026-10-22). Do not add one without a new explicit decision.
5. Other settled choices: scrypt (no new dependency); stdlib `sqlite3`, no
   ORM; Next.js `/api` proxy to FastAPI; CLI-only approval; CA sessions 30 min
   idle / 12 h absolute; one open case per client per firm per FY; findings are
   re-derived, not stored; only structured confirmations can resolve findings.

---

## 7. Known issues and limitations

- **No IP rate limiting** on login, registration, resend or reset. Anyone who
  knows a CA's e-mail can lock that account for 15 minutes. Must add
  trusted-proxy-aware IP limiting (never trust client `X-Forwarded-For`).
- **No Content-Security-Policy** on the Next.js pages (the dev outbox has one).
- **No "resend verification" button** in the UI (the API endpoint exists). A
  verification or reset link that was already used stays visible in the dev
  inbox until its normal expiry (development only).
- **E-mail worker must run** for any simulated mail to appear (extra terminal).
  A sensitive message whose link expires while retrying is abandoned (dead,
  `body_expired`), by design.
- **Rate limits are partial**: only the reset routes are limited. Register,
  resend-verification and login have no IP limiting. Behind the Next.js proxy
  the connected peer is the proxy, so the per-peer bucket is a site-wide
  ceiling; real per-IP limiting needs a trusted-proxy setting. The per-e-mail
  limit lets someone suppress a victim's reset e-mails for an hour.
- A walkthrough account (`walk-ca@example.test`, synthetic, approved) now also
  exists in `backend/var/itr_intake.db` next to `demo-ca@example.test`.
- **No production e-mail delivery**: production mode cannot complete
  verification or password reset until Stage 5.4+.
- **Firm codes: no grace period.** The brief mentioned a seven-day grace on
  rotation, but nothing in the schema or code supported one (`firm_codes.status`
  is only `active`/`revoked`, one active per firm, and the onboarding lookup
  accepts only `active`). Rotation therefore revokes the old code immediately.
  The owner confirmed this on 2026-10-22: no grace period (see §6).
- **Firm codes: other notes.** No firm-code generator existed before 5.5 (added
  in `ids.py`). Management is owner-only. Code changes are limited per firm and
  per peer; viewing is not limited. Brute-force protection for the future
  client-side code lookup is not built (onboarding is not built). Rotating or
  revoking does not notify anyone. The walkthrough firm's two codes are revoked.
- **Client onboarding (5.6) limits and risks:**
  - Production cannot onboard clients: no e-mail provider, so `/api/client/start`
    answers `not_configured` and issues nothing.
  - Behind the Next.js proxy the "peer" is the proxy, so per-peer limits are
    site-wide: someone submitting 30 bad codes in an hour stops sign-in e-mails
    for every client for the rest of that hour (the answer stays the same, so
    clients just see no e-mail). Real per-IP limits need a trusted-proxy setting.
  - The answer to `/api/client/start` is identical, but whether an e-mail
    arrives still reveals whether a code was valid to someone who controls the
    inbox; 60-bit codes plus the limits make guessing impractical.
  - Masked recipients (`w***@example.test`) still appear in e-mail worker logs
    (existing Stage 5.4 behaviour); full addresses, codes and tokens do not.
  - Clients must open the link on any device; the link is not bound to the
    browser that asked for it. Anyone who can read the client's inbox can
    sign in as that client (inherent to e-mail links).
  - A case's first name is free text and is the only client detail collected;
    there is no PAN, phone or profile yet (deliberately). Cases stay `draft`.
  - Client sessions are not revoked when a firm code is rotated or revoked
    (existing cases stay reachable); they only lose the ability to open new
    cases. There is no CA control to revoke a client's sessions.
  - Expired client sessions are revoked lazily, as for CA sessions.
- **Statement upload (5.7) limits and risks:**
  - **The real Indian Bank layout has not been validated.** The PDF parser was
    tested only on synthetic PDFs drawn with Courier text in an A4-landscape
    table: Date | Particulars | Withdrawals | Deposits | Balance, right-aligned
    amounts with Indian grouping, opening/closing balance lines and a page
    footer. A real statement may use other labels, two date columns, a
    cheque/reference column, multi-line headers, a single Amount + Dr/Cr column
    (unsupported), password protection or copy restriction (rejected by xpdf),
    or image-only pages (manual review). Expect `manual_review_required` until a
    redacted copy is tested locally with the owner's approval.
  - Mixed-content pages are detected only through text quantity and missing
    rows; a page whose readable text is a different table could still be read
    as rows (the balance chain is the safeguard and needs balances on every row).
  - No OCR; scanned pages are only flagged.
  - Depends on the Git-for-Windows xpdf binary; its absence or a Poppler binary
    turns PDF processing into manual review. It runs with a 30 s timeout, an 8 MB
    output cap enforced while it runs, and at most 2 at once (5.7.1), but no
    memory limit (Windows has no rlimit here).
  - File permissions: 0600 is requested, but Windows ignores POSIX modes; the
    folder relies on the user profile's ACLs. Files are not encrypted at rest.
  - Deleting a case cascades its database rows but does not delete its files
    (no cleanup job for orphaned files).
  - Processing is synchronous inside the request (up to about 30 s for a PDF);
    the `processing` state and a background worker are not implemented.
  - The client/CA never see transactions yet; no case detail view or download.
  - Only the masked first letter and domain of e-mails appear in worker logs
    (unchanged from 5.4); statement logs carry upload IDs, types, statuses and
    counts only.
- **Security proposals awaiting approval (Stage 5.7.1 review):**
  1. *Orphaned files.* Problem: deleting a case (no route does this today; only
     direct SQL) cascades its rows but leaves its files; nothing reconciles
     storage with `documents`. Proposal: first a read-only
     `admin storage-audit` listing files with no document and documents with no
     file (counts and keys only); later, on approval, a `--quarantine` option
     that moves orphans (never a file whose key matches a document) into
     `storage/.quarantine/` instead of deleting, and case deletion that removes
     files only after the database commit. Risk: a wrong database or storage root
     could flag live files, hence quarantine before deletion. Tests: temporary
     storage with synthetic orphans and missing files.
  2. *Trusted proxy and per-IP limits.* Problem: behind the Next.js proxy every
     request's peer is 127.0.0.1, so per-peer limits are site-wide (one abuser
     can exhaust them for everyone) and login, register and verify-email have no
     per-IP limit (login has the per-account lockout only). Proposal: an
     `ITR_TRUSTED_PROXIES` setting (exact addresses); only when the direct peer is
     listed, use the right-most `X-Forwarded-For` entry the proxy appended
     (Next.js behaviour must be verified first), then add per-IP limits to login,
     register and verify-email. Risk: misconfiguration lets clients spoof their IP
     or locks users out. Tests: forged headers from untrusted peers ignored,
     limits per forwarded IP from a trusted peer.
  3. *Content-Security-Policy.* Proposed production policy: `default-src 'self';
     script-src 'self' 'nonce-<per request>' 'strict-dynamic'; style-src 'self';
     img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none';
     base-uri 'self'; form-action 'self'; frame-ancestors 'none'`. Needs a Next.js
     16 `proxy.ts` that issues nonces (all pages dynamic) and a relaxed dev
     variant (`'unsafe-eval'` for React refresh). Roll out as
     `Content-Security-Policy-Report-Only` first.
  4. *HSTS* (`Strict-Transport-Security`) in production, set by the HTTPS front
     end or the API when `environment == "production"`.
  5. *Process limits.* pdftotext memory is unbounded on Windows (a Job Object or
     a separate worker would be needed); uploads are limited per client (20/h) but
     not per firm or globally.
  6. *Slow uploads.* uvicorn has no request-body timeout; a slow client can hold
     a connection and a worker thread. A reverse proxy with body timeouts is the
     usual fix.
  7. *Symlink refusal* remains untested on this machine (junction refusal is tested).
- **Still not built**: classifier and workbook runs on uploaded statements,
  persisted Gemini workflow, workbook download, document checklist, case detail
  views, OCR.
- Login timing is not perfectly uniform (wrong passwords also write a counter);
  reset requests differ in timing for known vs unknown e-mails.
- Expired sessions are revoked lazily; no cleanup job. Each authenticated
  request writes a new idle expiry.
- scrypt parameters are fixed; no rehash-on-login.
- Superseded challenges are recorded by shortening their expiry (no explicit
  state). Reset/verification secrets use unsalted SHA-256 (fine for 256-bit
  secrets; short client OTPs will need a keyed hash).
- Conflict codes depend on SQLite's error wording.
- `next dev` listens on the LAN by default; start it with `--hostname 127.0.0.1`.
- Starlette 1.9's test client warns about `httpx`; that one message is
  silenced at import in `test_server_app.py` (no `httpx2` installed).
- `lib/demo-cases.ts` is unused leftover code.
- Gemini questioning has only been smoke-tested live once with synthetic data;
  its pattern-based safeguards (names, amounts, tax wording) can miss
  paraphrases. Persisted workflow integration is not built.

---

## 8. How to run locally (Windows PowerShell)

The commands below follow the verified run (which was driven via the preview
tooling and Git Bash); the exact PowerShell spelling is an **assumption**.

Terminal 1 — API (development mode, loopback only, simulated e-mail):
```powershell
cd "C:\Users\Devansh Vora\Desktop\ITR Intake\backend"
..\.venv\Scripts\python.exe -m itr_intake_server --dev
```
Listens on http://127.0.0.1:8000. Database: `backend\var\itr_intake.db`.

Terminal 2 — e-mail worker (nothing appears in the dev inbox until it runs):
```powershell
cd "C:\Users\Devansh Vora\Desktop\ITR Intake\backend"
..\.venv\Scripts\python.exe -m itr_intake_server.email_worker --dev        # or add --once
```

Terminal 3 — website:
```powershell
cd "C:\Users\Devansh Vora\Desktop\ITR Intake"
npx next dev --hostname 127.0.0.1
```
(`npm run dev` also works but binds to the LAN as well.)

Sequence:
1. Open http://localhost:3000/ca/register and register with synthetic details.
2. Make sure the worker has run, then open http://127.0.0.1:8000/dev/outbox
   (this computer only) and click "Open the link in this message". The page
   says no e-mail was sent.
3. Approve from another terminal:
   ```powershell
   cd "C:\Users\Devansh Vora\Desktop\ITR Intake\backend"
   ..\.venv\Scripts\python.exe -m itr_intake_server.admin list-pending
   ..\.venv\Scripts\python.exe -m itr_intake_server.admin approve --email <email> --approved-by "<your name>"
   ```
4. Sign in at http://localhost:3000/ca/login → dashboard at http://localhost:3000/ca.
5. "Sign out" revokes the session.
6. Password reset: http://localhost:3000/ca/forgot-password, run the worker,
   follow the link in the dev inbox, choose a new password.

Stop the servers with **Ctrl+C** in each terminal. To reset local data (after
stopping the API): `Remove-Item "backend\var\itr_intake.db*"`.

Other useful commands:
```powershell
..\.venv\Scripts\python.exe backend\scripts\generate_demo_workbook.py   # from project root: synthetic workbook to %TEMP%
```

---

## 9. Testing

Commands (from the project root):
```powershell
.\.venv\Scripts\python.exe -m pytest backend
npm run lint
npm run typecheck
npm run build
```

Last known results (**verified** after the Stage 5.7 walkthrough, 2026-10-22):
- Backend: **1152 passed, 1 skipped (symlinks not permitted for this Windows user), 1 warning** (after Stage 5.7.1) (`DeprecationWarning` from
  `google/genai/types.py` about `_UnionGenericAlias` in Python 3.17 — third
  party, harmless).
- ESLint: pass. TypeScript: pass. `next build`: pass (`/ca`, `/ca/login`
  dynamic; others static).
- Tests are offline: Gemini mocked, temporary databases, and a session-wide
  guard in `backend/tests/conftest.py` fails the run if any test changes
  `backend/var/`.
- Mutation checks were run during development (in memory only) to confirm key
  tests fail when safeguards are removed.
- There are no automated frontend/browser tests; the browser flow was verified
  manually.

---

## 10. Stage 5.4 browser walkthrough (verified 2026-10-22) and next work

Exercised against the real three processes (API, separate worker, Next dev
site) on localhost with a synthetic account; secrets are omitted here:
register (UI says simulated and names the worker), inbox empty and shows
"waiting for the worker", worker run, message appears, verification link,
pending approval, login refused, CLI approval, login, dashboard,
forgot-password (same answer for known and unknown), worker, inbox, reset
page (weak password and mismatch refused, link survives), new password,
old session revoked (200 to 401), old password refused, new password works,
sign out, `/ca` and `/api/ca/*` protected. Retry/dead-letter behaviour was
run with a synthetic failing sender on a temporary database (60 s, 300 s,
1800 s, 7200 s, then dead; body cleared). Security probes: inbox 404 through
the Next proxy, with forged `X-Forwarded-For`, `Forwarded`, `X-Real-IP` and a
non-loopback Host; absent in a real production-mode server; worker exits 2
without `--dev`; both reset routes return 403 without origin/CSRF header,
with an evil origin, and through the proxy; no tokens, passwords or SQL
errors in API access logs, worker output or the Next dev log; stored tokens
exist only in `dev_mailbox`; rate-limit buckets hold hashes only.

**Stages 5.5 and 5.6 are approved. Stage 5.7 (client profile and PDF/CSV
statement upload) is implemented, verified with synthetic files and approved;
see §4. Next stage: not yet chosen.** Stage 5.8 and AI workflow integration must
not start without explicit approval.

**Testing the real Indian Bank statement (not done; needs explicit approval).**
Safest local-only procedure: (1) the owner, not the assistant, works on a copy
outside the repository and redacts names, account numbers and narrations if
desired (keeping dates, amounts and column layout); (2) the owner runs the API,
worker and site locally (or uses a throwaway database with `ITR_DB_PATH`), signs
in as a synthetic client and uploads the copy at `/client`; (3) only the
aggregate result is shared: status, counts, reason codes, page numbers and, if
needed, the column header labels and date/amount formats - never transaction
lines; (4) afterwards the stored copy under `backend/var/storage/` (or the
throwaway database and its `storage/` folder) is deleted by the owner. Nothing is
sent to any external service, and the statement never enters Git, fixtures or
the assistant's context. Real e-mail provider integration, IP rate limiting for the remaining
public routes, a trusted-proxy setting, a CSP and a "resend verification"
button remain open.

---

## 11. Git discipline

- **Do not stage, commit, push or deploy** until the owner explicitly approves.
- Current state (verified): `master` at `29634e6`, equal to `origin/master`;
  nothing staged; 5 modified tracked files plus the untracked files listed in §3
  (now including the Stage 5.4 files and this `HANDOFF.md`).
- When a commit is approved: stage only the intended files explicitly (never
  `git add .` / `-A`), show `git diff --cached --name-only` for confirmation,
  keep `.env`, `Private/`, `backend/var/`, `test_gemini.py` and
  `.claude/launch.json` out, and end commit messages with the attribution line
  the environment specifies.
