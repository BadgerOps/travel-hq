# Issue 28 specification: configurable extraction agent

## Goal

Make the household extraction agent fully configurable from Settings:

- choose Workers AI or Anthropic;
- choose the provider-specific model;
- store a write-only Anthropic API key encrypted per household;
- append household extraction guidance to the fixed prompt;
- dry-run extraction against pasted text without persisting anything; and
- show recent inbound-email metadata and failures without exposing raw email.

The implementation follows issue #28. Its linked design document is not
present on the refreshed `github/master`, so the issue body is the available
approved design source.

## Non-goals

- Building the full import/review queue from issue #7.
- Retrying or mutating historical inbound email from Settings.
- Persisting extraction-test inputs or results.
- Exposing, revealing, or masking the stored Anthropic key in API responses.
- Changing `.ics`-first extraction behavior.
- Supporting providers other than Workers AI and Anthropic.

## User-facing behavior

- `GET /api/settings` includes `aiProvider`, `anthropicModel`,
  `anthropicKeyConfigured`, and `extractionInstructions` alongside existing
  settings. It never includes the key or ciphertext.
- `PUT /api/settings` accepts those settings. `anthropicApiKey` is tri-state:
  absent keeps the stored ciphertext, `null` clears it, and a string encrypts
  and replaces it. Any string containing U+2022 BULLET is rejected before the
  stored ciphertext changes.
- Selecting Anthropic is rejected unless a key is already stored or supplied
  in the same request.
- Instructions are limited to 2,000 characters.
- `POST /api/settings/extraction-test` accepts optional `subject`/`from` and
  required `text`, rejects text beyond `MAX_AI_TEXT_CHARS`, uses the configured
  provider and instructions, returns `{ bookings }` on success or `{ error }`
  for extraction/provider failures, and writes no rows.
- `GET /api/inbound-emails` returns only `from`, `to`, `subject`, `status`,
  `error`, and `receivedAt`, newest first. It never returns `raw`, ids, or
  message ids.
- Owners and adults can use all of the above. Viewers receive 403.
- Settings shows provider/model controls, a write-only key control with
  configured/replace/remove states, instructions with a character counter, a
  paste-based test form with draft-style result cards, and recent ingest
  activity with status/error/timestamp.
- At ingest time, a configured Anthropic provider uses the decrypted household
  key. A missing or undecryptable key logs a warning and falls back to Workers
  AI. The AI draft's extracted payload records the provider actually used.

## Technical approach

1. Add migration `0006_agent_config.sql` with `ai_provider`,
   `anthropic_model`, nullable `anthropic_api_key`, and
   `extraction_instructions`, including the provider CHECK constraint and
   defaults from issue #28.
2. Extend `HouseholdSettingsRepo` with public-safe settings fields and an
   internal ingest configuration containing ciphertext. Give write paths a
   `Keyring`, validate the provider/model/instruction constraints, implement
   atomic tri-state key handling, and keep lookup defaults compatible.
3. Add `src/server/ingest/providers.ts` with an `ExtractionProvider` interface,
   `WorkersAiProvider`, `AnthropicProvider` using the official
   `@anthropic-ai/sdk`, and provider resolution helpers. Both providers pass
   results through existing strict extracted-booking validation. Use
   Anthropic structured output with `EXTRACTED_JSON_SCHEMA` and
   `additionalProperties: false`.
4. Refactor prompt/model execution in `extract.ts` behind the provider
   abstraction while retaining `.ics` preference, truncation, atomic draft
   writes, and failure behavior. Append instructions in a clearly delimited
   `Household notes` section after fixed base rules. Record the actual provider
   in AI draft payloads.
5. Pass `ENCRYPTION_KEY` into `EmailIngestEnv`, resolve/decrypt provider
   credentials at runtime, and fall back softly to Workers AI on credential
   failure.
6. Extend the settings route and add the dry-run endpoint, with injectable
   Anthropic transport/client seams so CI never performs live model calls.
7. Add a tenant-scoped metadata-only inbound-email list route and register it
   under `/api/inbound-emails`.
8. Extend client API/types and rebuild Settings around the three cards while
   preserving existing ingest address/allowlist controls.

## Likely affected files or modules

- `migrations/0006_agent_config.sql`
- `src/server/repos/household-settings.ts`
- `src/server/repos/inbound-email.ts`
- `src/server/ingest/providers.ts` (new)
- `src/server/ingest/extract.ts`
- `src/server/ingest.ts`
- `src/server/routes/settings.ts`
- `src/server/routes/inbound-emails.ts` (new)
- `src/server/index.ts`
- `src/client/api/client.ts`
- `src/client/api/types.ts`
- `src/client/pages/Settings.tsx`
- `src/client/components/DraftBookingCard.tsx` (new)
- `src/client/styles.css` if focused styles are needed
- focused server/client tests
- `package.json`, `package-lock.json`, and `CHANGELOG.md`

## Changelog plan

This is new API/UI behavior, so bump the minor version from `0.2.0` to
`0.3.0`. Update `package.json`, the root package version in
`package-lock.json`, and add a concrete `0.3.0 - 2026-07-23` section to
`CHANGELOG.md`. Do not add an `Unreleased` section.

## Edge cases

- A first settings write must apply defaults for all omitted new columns.
- Provider changes and key changes are validated against the final combined
  state, so a single request can supply a key and choose Anthropic.
- Mask-glyph rejection must occur before any database update.
- Clearing the key while Anthropic remains selected is invalid; changing to
  Workers AI and clearing it in one request is valid.
- Corrupt settings rows fail closed to supported provider/default models.
- Missing AI binding during Workers AI ingest retains current soft behavior
  (email remains `received`); Anthropic API/model/schema failures mark email
  `failed`.
- Missing/undecryptable Anthropic credentials at runtime use Workers AI and
  record `workers-ai`, never the requested-but-unused provider.
- Test extraction never writes inbound-email or draft-booking rows.
- Inbound activity serializes no raw/message-id/id fields even if the
  repository's internal entity contains them.
- Key state is displayed only as a boolean-derived “Configured ••••”.

## Verification plan

- Migration/schema tests for columns, defaults, provider CHECK constraint, and
  version ordering.
- Repository tests for provider enum, instruction limit, encrypted tri-state
  key behavior, mask rejection without ciphertext mutation, and
  Anthropic-without-key rejection.
- Provider/extraction tests with fake Workers AI and fake Anthropic transports:
  strict structured-output request, valid output, API/model/schema failures,
  appended instructions, runtime credential fallback, and recorded provider.
- Route tests for safe settings responses, dry-run auth/size/no-write/error
  behavior, and metadata-only tenant-scoped inbound activity.
- Client API and Settings component tests for provider/model controls,
  write-only key states, instructions counter, dry-run rendering/error, and
  activity/error rendering.
- Run focused Vitest suites, typecheck, build, architecture tests, and the full
  test suite if focused checks pass.
- Verify the changelog has `0.3.0`, no `Unreleased`, and package versions match.
