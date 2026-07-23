# Issue 28 implementation changes

## Files changed

- Added `migrations/0006_agent_config.sql`.
- Extended household settings/repository and inbound-email metadata reads.
- Added provider abstraction and official Anthropic SDK integration in
  `src/server/ingest/providers.ts`.
- Refactored extraction/ingest to use configured providers, household
  instructions, runtime credential fallback, and provider provenance.
- Extended settings routes and added the extraction-test endpoint.
- Added and registered the metadata-only inbound-email route.
- Extended application bindings/overrides for stubbed Anthropic clients.
- Extended the client API/types, rebuilt Settings, and added a reusable
  `DraftBookingCard`.
- Added the Anthropic SDK dependency.
- Bumped package version to `0.3.0` and added the concrete changelog entry.

## Behavior implemented

- Provider/model selection for Workers AI and Anthropic.
- Envelope-encrypted, write-only, tri-state Anthropic API keys with mask-glyph
  protection and save-time Anthropic-without-key rejection.
- Household prompt guidance capped at 2,000 characters and appended after the
  fixed prompt contract in a delimited section.
- Anthropic JSON-schema structured output through the official SDK.
- Soft runtime fallback to Workers AI when Anthropic credentials are missing
  or undecryptable, with the actual provider recorded in AI draft payloads.
- Persist-nothing extraction dry runs for owners/adults.
- Tenant-scoped, newest-first inbound activity containing metadata only.
- Settings controls, dry-run result cards, and live ingest activity/error
  rendering.

## Deviations from spec

- `EmailIngestEnv.ENCRYPTION_KEY` is optional at the narrow handler type for
  compatibility with Workers-only test/runtime callers. The production
  `AppBindings.ENCRYPTION_KEY` remains required. A missing keyring is treated
  exactly like an unavailable Anthropic credential and falls back softly.
- The issue-linked approved design file was absent from `github/master`; the
  issue body supplied the implementation contract.

## Suggested verification

- Update existing settings expectations for the expanded safe response.
- Add repository, provider, route, ingest, client, and UI tests from the
  verification plan in `.pipeline/spec.md`.
- Run focused suites, then `npm run typecheck`, `npm run test:all`, and
  `npm run build` through `nix develop -c`.
