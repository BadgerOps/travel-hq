# Tester Handoff

## Tests added or updated

- Added extraction orchestration acceptance tests covering:
  - `.ics` preference with zero AI calls.
  - Calendar-present-but-invalid failure with zero AI calls.
  - Configured Workers AI model and exact JSON schema.
  - Empty, malformed, and partially invalid response failures with no drafts.
  - Missing AI binding queue behavior.
  - Retry after committed drafts without duplication.
  - Mixed valid/invalid calendars produce no partial drafts.
- Added MIME/ICS parser tests for nested multipart, case-sensitive boundaries,
  folded headers/lines, base64, quoted-printable, HTML normalization,
  `message/rfc822` forwards, nesting limits, UTC, floating time, and invalid
  zones.
- Added prompt-size coverage that preserves confirmation content at the tail
  of a large forwarded message.
- Added draft repository tests for batch atomicity, stable ordinals, unique
  retry protection, tenant isolation, and source preservation on acceptance.
- Updated booking tests for source-email provenance and tenant isolation.
- Updated email-handler integration tests for inline AI extraction.
- Updated migrated-schema tests for `draft_booking` and booking provenance.
- Updated Settings UI tests to prove a model change is persisted in-app.

## Commands run and results

- `npm run typecheck` — passed.
- Focused six-file server run — 52 tests passed.
- `npm run test:all` — passed after renaming two regular-expression `.exec`
  calls that triggered the lexical raw-database architecture guard:
  - Server: 354 tests across 27 files passed.
  - Architecture: 1 test passed.
  - Client: 258 tests across 35 files passed.
- `npm run build` — passed; Vite production build completed.
- After PR CI exposed that the deploy-time Workers AI binding caused the
  secret-free Vitest job to attempt a remote Cloudflare proxy, added
  `wrangler.test.toml` and pointed the worker pool at it. The test harness now
  loads only locally emulated D1; deploy configurations still bind AI in
  default, testing, and production.
- Wrangler dry runs with a writable temporary config directory:
  - default — passed, `env.DB` and `env.AI` present.
  - testing — passed, `env.DB` and `env.AI` present.
  - production — passed, `env.DB`, `env.AI`, and Access vars present.
- `git diff --check` — passed.

Vitest does not load the deploy-time AI binding. All model-path tests pass an
explicit fake AI object, and `remoteBindings: false` remains set. No remote
proxy or real inference is requested.

## Changelog verification

- `CHANGELOG.md` contains concrete version `0.2.0` dated `2026-07-23`.
- `package.json` and both root lockfile version fields are `0.2.0`.
- No `Unreleased` section exists.

## Coverage gaps

- No live Workers AI inference was performed; contract behavior is tested with
  fakes as required by issue #6.
- No live Cloudflare Email Routing delivery was performed.
- MIME and iCalendar support is deliberately bounded rather than RFC-complete.
- Inline extraction CPU/wall-time behavior under production-sized messages is
  not load-tested.
