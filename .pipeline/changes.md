# Coder Handoff

## Files changed

- Added `migrations/0005_draft_booking.sql`.
- Added extraction modules:
  - `src/server/ingest/extract.ts`
  - `src/server/ingest/extracted.ts`
  - `src/server/ingest/ics.ts`
  - `src/server/ingest/mime.ts`
- Added `src/server/repos/draft-booking.ts`.
- Updated `src/server/ingest.ts` to invoke extraction after verified storage.
- Updated `src/server/repos/booking.ts` with source-email provenance.
- Updated Workers AI bindings/types in `wrangler.toml`,
  `src/server/index.ts`, `tests/server/env.d.ts`, and `vitest.config.ts`.
- Updated `docs/cloudflare-github-setup.md`.
- Added/updated focused tests under `tests/server/ingest`,
  `tests/server/repos`, `tests/server/email.test.ts`, and
  `tests/server/db/schema.test.ts`.
- Added `CHANGELOG.md` and bumped package/lockfile versions to `0.2.0`.

## Behavior implemented

- Calendar attachments are parsed authoritatively before any model path.
- Plain confirmation mail calls the household-configured Workers AI model with
  the committed strict JSON schema.
- Complete validated extraction results become an ordered transactional batch
  of pending drafts tied to their inbound email.
- Inbound messages transition `received → extracted|failed` fail-soft.
- Missing AI configuration leaves plain mail queued as `received`.
- Existing drafts are recognized on retry, preventing duplicate model calls or
  draft rows if only the final status transition previously failed.
- Accepted bookings can retain a tenant-validated source inbound-email id.
- Calendar extraction is all-or-nothing across VEVENTs and rejects impossible
  or nonexistent local wall times.
- Draft acceptance requires the real booking to retain the same source email.
- Development, testing, and production declare the `AI` binding.

## Deviations from spec

- None.
- Compared with the earlier stacked PR #15 implementation, this port
  deliberately changes malformed-calendar handling from AI fallback to failure
  and adds retry-safe ordinals/provenance required by the current issue text.

## Suggested verification

- `npm run typecheck`
- `npx vitest run tests/server/ingest/extract.test.ts tests/server/ingest/parsers.test.ts tests/server/repos/draft-booking.test.ts tests/server/repos/booking.test.ts tests/server/email.test.ts tests/server/db/schema.test.ts`
- `npm run test:all`
- `npm run build`
- `npx wrangler deploy --dry-run`
- `npx wrangler deploy --env testing --dry-run`
- `npx wrangler deploy --env production --dry-run`
- Confirm package and changelog versions are exactly `0.2.0` and no
  `Unreleased` section exists.
