# Issue #6 Shipping Specification

## Goal

Ship GitHub issue #6 on top of the current `master`: extract structured travel
bookings from verified, stored inbound email into pending drafts, preferring
`text/calendar` attachments and using a household-configured Workers AI model
for ordinary forwarded airline, hotel, car, and activity confirmations,
including plain-text, HTML-only, and attached forwarded messages.

The earlier PR #15 is useful implementation material, but it was merged into a
stacked feature branch rather than `master`. GitHub reports that PR as merged
even though its migration and source files are absent from the production
branch. This change will port and harden that implementation.

## Assumptions and open questions

- A draft cannot be represented by the existing `booking` table because
  `booking.trip_id` is required. A dedicated `draft_booking` table is therefore
  the correct pending-review representation.
- The explicit issue requirement for `booking.source_inbound_email_id` will
  still be honored so a later accepted booking can retain provenance.
- Extraction runs inline at the end of successful ingest. This is acceptable
  for issue #6; queue/cron processing remains a possible later scalability
  improvement.
- A message containing any `text/calendar` part is authoritative. If its
  calendar parts contain no valid VEVENT, extraction fails without invoking AI.
- If the AI binding is unavailable, a non-calendar email remains `received` so
  it can be retried after deployment configuration is fixed.
- Wrangler provides only the Workers AI capability. Model selection is
  configured and persisted per household in the existing in-app Settings page
  and `/api/settings`; the shipped UI must keep that control explicit.
- No user input is needed to resolve these choices because they follow the
  issue acceptance criteria and existing repository design.

## Non-goals

- Building the review/accept/dismiss UI from issue #7.
- Automatically assigning drafts to trips.
- Guessing a booking kind from `.ics` summary text; calendar events use
  `kind: "other"` for human review.
- Calling external model providers or a real AI model in tests.
- Activating the Cloudflare Email Routing dashboard rule.
- Building a general-purpose MIME or iCalendar implementation.
- Extracting text from binary attachments such as PDFs or images.

## User-facing behavior

- A verified email with a `text/calendar` attachment creates one pending draft
  per VEVENT and never calls Workers AI.
- A verified email without a calendar attachment collects readable content
  from `text/plain`, safely text-normalized `text/html`, and nested
  `message/rfc822` forwarded messages, then calls the household's in-app
  configured Workers AI model using strict JSON-schema output.
- Drafts retain their source inbound email and extraction source (`ics` or
  `ai`); eventual accepted bookings can retain the same inbound-email
  provenance.
- Successful extraction transitions the inbound email from `received` to
  `extracted`.
- Parser, model, validation, or draft-write failures transition the email to
  `failed` with a bounded readable error and create no partial draft set.
- Missing AI configuration leaves the email `received` rather than treating a
  deployment problem as a malformed message.
- A retry after drafts were committed but the status transition failed detects
  the existing complete draft set and finishes the status transition without
  creating duplicates.

## Technical approach

1. Add migration `0005_draft_booking.sql`:
   - Add nullable `booking.source_inbound_email_id` referencing
     `inbound_email(id)` with `ON DELETE SET NULL`, plus an index.
   - Create `draft_booking` with household scope, source inbound email,
     normalized booking fields, extraction source/payload, review status,
     optional accepted booking, and timestamps.
   - Add an extraction ordinal and unique `(inbound_email_id, ordinal)`
     constraint so one source email cannot acquire duplicate drafts on retry.
2. Add a tenant-scoped `DraftBookingRepo`:
   - Synthetic `forIngest` context.
   - Validate every input and source-email scope before writing.
   - Create all drafts in one transactional D1 batch.
   - Expose scoped reads and review-state transitions needed by issue #7.
3. Add focused MIME and iCalendar parsing modules:
   - Decode relevant `text/plain`, `text/html`, `text/calendar`, and
     `message/rfc822` parts.
   - Convert HTML to readable text without executing or rendering it, removing
     script/style/head content and decoding common/numeric entities.
   - Recurse into attached forwarded messages and include their subject,
     sender, body, and calendar parts.
   - Support folded headers, nested multipart messages, base64, and
     quoted-printable content.
   - Parse VEVENT dates with UTC or valid IANA TZID values and unfold ICS
     continuation lines.
4. Define `EXTRACTED_JSON_SCHEMA` beside Zod validation/normalization as the
   single model/draft contract.
5. Add the extraction orchestrator:
   - Short-circuit already-created draft sets on retry.
   - If calendar parts exist, parse only those and fail if no VEVENT is usable.
   - Otherwise call `AI.run(model, { messages, response_format })`.
   - Validate the complete result before the transactional draft write.
   - Keep content failures separate from post-write status-transition failures.
6. Wire extraction after verified raw storage while preserving the current
   adversarial ingest hardening: authenticate before reading raw content,
   stream with a byte cap, store rejected messages without attacker-controlled
   bodies, trust only Cloudflare-authored authentication results, forward
   failures best-effort, and never bounce.
7. Add the AI binding to development, testing, and production Wrangler
   environments, update `Cloudflare.Env`/application binding types, disable
   remote bindings in tests, and document the deploy-token permission.
   Preserve and explicitly document the existing in-app per-household model
   setting; add a UI test that changes and saves the model.
8. Add `CHANGELOG.md` section `0.2.0`, bump `package.json` and
   `package-lock.json` from `0.1.0` to `0.2.0`, and do not introduce an
   `Unreleased` section.

## Likely affected files or modules

- `migrations/0005_draft_booking.sql`
- `src/server/ingest.ts`
- `src/server/ingest/{extract,extracted,ics,mime}.ts`
- `src/server/repos/{booking,draft-booking}.ts`
- `src/server/index.ts`
- `wrangler.toml`
- `vitest.config.ts`
- `tests/server/email.test.ts`
- `tests/server/ingest/*.test.ts`
- `tests/server/repos/{booking,draft-booking}.test.ts`
- `tests/server/db/schema.test.ts`
- `tests/server/env.d.ts`
- `docs/cloudflare-github-setup.md`
- `CHANGELOG.md`
- `package.json`
- `package-lock.json`

## Changelog plan

This is new user-visible and operational behavior, so bump the minor version
from `0.1.0` to `0.2.0`. Add a concrete `## 0.2.0 - 2026-07-23` entry describing
`.ics`-first/Workers-AI extraction, pending drafts with source provenance, and
the new Workers AI deployment permission. There is no existing changelog to
extend, so create `CHANGELOG.md`.

## Edge cases

- Uppercase/case-sensitive MIME boundaries and folded MIME/ICS headers.
- Nested multiparts, base64, and quoted-printable bodies.
- HTML-only confirmations with tables, entities, scripts/styles, and no
  `text/plain` alternative.
- Attached `message/rfc822` forwards with their own MIME tree.
- Calendar attachment present but malformed or empty: fail without AI.
- Multiple VEVENTs: create all drafts or none.
- Floating local ICS times without TZID: reject rather than apply the Worker's
  ambient timezone.
- Invalid IANA zones, timestamps, kinds, blank titles, empty model results,
  JSON strings versus decoded model objects, and malformed model wrappers.
- AI binding absent: retain `received`.
- Draft batch succeeds but `markExtracted` fails: retain `received`; next run
  recognizes the existing draft set and completes the transition.
- Cross-household source IDs and accepted-booking IDs must be rejected.
- Existing issue-#4 sender-authentication and raw-size protections must remain
  unchanged.

## Verification plan

- Focused unit tests for MIME, ICS, extraction/schema, draft repo, booking
  provenance, and email-handler integration.
- Required acceptance tests:
  - `.ics` path creates drafts and records zero fake-AI calls.
  - Plain email calls fake AI with the configured model/schema and creates
    drafts.
  - HTML-only airline/hotel confirmation text reaches the fake AI prompt.
  - Nested forwarded-message content reaches the fake AI prompt.
  - Malformed/empty model response marks failed and writes zero drafts.
  - Calendar-present-but-invalid path does not call AI.
  - Retry after existing drafts does not duplicate them.
- Schema migration tests for `draft_booking` and
  `booking.source_inbound_email_id`.
- Client Settings test that edits and persists a household AI model.
- `npm run typecheck`
- Focused Vitest runs while iterating, then `npm run test:all`
- `npm run build`
- Wrangler dry runs for default, testing, and production to confirm `env.AI`.
- Verify `CHANGELOG.md` uses `0.2.0`, package versions match, and no
  `Unreleased` section exists.
