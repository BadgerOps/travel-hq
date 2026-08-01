# Raw inbound email: encryption and retention

What Travel HQ does with the RFC 5322 message behind a forwarded confirmation,
and why. Issue #22.

## What is stored

`inbound_email.raw` holds the full message — headers and body — as it arrived,
truncated at `MAX_RAW_BYTES` (1 MB) while streaming. It is the densest piece of
personal data in the product: one confirmation typically carries the
traveller's name, contact details, the whole itinerary, a loyalty number and
sometimes payment metadata.

Everything else on the row is metadata (sender, recipient, subject,
Message-ID, status, error, arrival time) and is retained indefinitely, because
it is what the activity feed and every booking's provenance link are made of.

## Encryption

Raw is sealed at rest with the same envelope crypto that already protects
passport, Known Traveler, redress and booking confirmation numbers:
`src/server/crypto/envelope.ts`, AES-GCM, `v1.<key id>.<iv>.<ciphertext>`,
keyed by the rotatable key ring the Worker loads from the `ENCRYPTION_KEY`
secret. Reusing it rather than inventing anything means raw inherits key
rotation for free: re-sealing under a new active key is the same operation it
is everywhere else.

Two properties are worth stating explicitly:

- **Sealed before it is bound.** `InboundEmailRepo.create()` encrypts, then
  inserts. There is no window in which plaintext exists in D1.
- **Only paths that store a message need the key.** The ring is an optional
  constructor argument. The email ingest handler, the file import and the
  read paths (activity detail, booking source artifact) all pass it; the
  extractor and the import-review repository, which only move statuses, do
  not. A repository built without a ring writes `raw_encryption = 'plaintext'`
  — the pre-0015 behaviour — rather than failing, so a Worker deployed without
  the secret still stores mail instead of losing it.

### Legacy rows

Every row written before migration `0015_inbound_email_retention.sql` holds
plaintext. `raw_encryption` defaults to `'plaintext'`, so those rows are
labelled correctly without a backfill (a migration has no access to the key
ring) and are read back as plaintext. The label is trusted rather than the
value sniffed: a real message can contain any bytes at all, including bytes
that resemble an envelope, and guessing wrong makes mail unreadable.

If an envelope *cannot* be opened — the key was rotated fully out, or no ring
is configured — the row is still returned, with `rawState: "unreadable"` and
an empty `raw`. It is never skipped. Silently dropping rows whose ciphertext
will not open is what makes a UI look like it lost the user's data.

## Retention

Raw is kept for exactly one reason: extraction is fallible, and a bad
extraction has to be retryable and diagnosable against the original message.
Nothing else reads raw — drafts, bookings and the activity feed are derived
data that outlive it. The windows are sized to that reason and live in
`src/shared/email-retention.ts`, imported by both the sweep and the Settings
copy so the promise and the behaviour cannot drift apart.

| Row state | Window | Why |
| --- | --- | --- |
| `extracted` | **7 days** from arrival | Long enough to review the drafts it produced, accept them, and glance at the source afterwards. |
| `failed`, `received`, `rejected` | **30 days** from arrival | The debugging loop is human: notice, report, reproduce. Also the outer bound — no raw message survives 30 days in any state. |

Measured from `received_at`, not from when the row reached its status: it is
the only timestamp the row has, and it is the one the owner is shown.

`rejected` rows and ingest failures were already born with `raw = ''` (see
`handleInboundEmail`), so in practice the 30-day window applies to failed and
still-queued extractions.

## Purging

The sweep **redacts**, it does not delete: `raw` becomes `''`,
`raw_encryption` returns to `'plaintext'`, and `raw_purged_at` is stamped. The
row, its metadata, its status and its drafts all survive.

`raw_purged_at` exists so that "we kept this and then deleted it on schedule"
can be told apart from "no copy was ever stored". Both look like `raw = ''`,
and only one of them is something the user should be reassured about.

### Where it runs

There is **no cron trigger** configured for this Worker, so purging is
opportunistic — it rides on paths that already run and already write:

- `handleInboundEmail` — after the message is stored and extraction returns.
- `POST /api/imports/file` — the other way mail enters.
- `POST /api/imports/accept`, `/dismiss`, `/create-trip` — the review paths,
  which are exactly when the reviewer is finished with the message.

Every trigger is a write by a member of the household being swept, so the
sweep is scoped to that household. A household that stops using Travel HQ also
stops accumulating mail, so it is owed no sweep. Failures are logged and
swallowed: a housekeeping chore must never fail a real user action, and an
expired row that survives one more day is a triviality.

`InboundEmailRepo.purgeExpiredRawEverywhere(db)` is the cross-household
version — deliberately unscoped and static, because a cron has no household
context to bind. **Follow-up:** wire it to a `scheduled()` handler once a
`[triggers]` block is added to `wrangler.toml`. Deploy configuration was out
of scope for this change.

## Re-extraction after a purge

`POST /api/imports/:inboundEmailId/reextract` re-runs extraction over a stored
message — the retry the retention window exists to serve. Once the window has
passed it answers **410 Gone** with the reason in plain words, rather than
extracting an empty string and reporting "no bookings found". The latter reads
as a model failure and invites the user to keep pressing a button that can
never succeed.

## What the user is told

- **Settings → Email ingest** states both windows, that mail is stored
  encrypted, and that bookings survive the purge. The day counts are rendered
  from the same constants the sweep enforces.
- **The ingest activity detail dialog** shows, per message, either the date
  its copy is due to be deleted or the reason it is already gone.
