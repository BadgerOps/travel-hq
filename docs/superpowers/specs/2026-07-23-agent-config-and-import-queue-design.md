# Agent Configuration & Import Review Queue — Design

**Date:** 2026-07-23
**Status:** Approved (brainstormed with owner; all decisions below were confirmed interactively)
**Covers:** GitHub issue [#7](https://github.com/BadgerOps/travel-hq/issues/7) (import review queue), the
agent-configuration ask, and a minimal slice of [#8](https://github.com/BadgerOps/travel-hq/issues/8)
(ingest activity visibility).

## Goal

Give the household full in-app control over the AI agent that extracts forwarded
booking emails — provider, model, API key, and household-specific prompt
guidance, with a paste-based dry run — and build the `/import` review queue so
extracted draft bookings become real bookings through explicit human approval.
Also surface ingest activity (received / extracted / failed / rejected emails)
so failures stop being invisible.

## Scope decisions (owner-confirmed)

| Question | Decision |
|---|---|
| Config depth | Full agent config: provider + model + prompt guidance + test-run |
| Providers | Workers AI (default) and Anthropic Claude via per-household API key |
| Prompt customization | Household "additional instructions" appended to the fixed base prompt — never a full prompt override |
| Test-run | Paste-a-sample dry run in Settings; nothing is persisted |
| Milestone | Config **and** the `/import` review queue in one spec |
| Accept flow | Review dialog: pre-filled `BookingDialog` + trip picker (date-overlap sorted first) |
| Ingest visibility | Minimal read-only activity list in Settings; full observability stays in #8 |
| Storage | Approach A — extend `household_settings` + an `ExtractionProvider` interface |

## 1. Data model

Migration `migrations/0006_agent_config.sql` adds columns to
`household_settings` (one row per household, unchanged):

| Column | Type | Meaning |
|---|---|---|
| `ai_provider` | `TEXT NOT NULL DEFAULT 'workers-ai'` `CHECK (ai_provider IN ('workers-ai','anthropic'))` | Which provider the extractor runs |
| `anthropic_model` | `TEXT NOT NULL DEFAULT 'claude-opus-4-8'` | Claude model id when the provider is `anthropic` |
| `anthropic_api_key` | `TEXT` (nullable) | Envelope-encrypted (`v1.<keyid>.<iv>.<ct>` via the existing `Keyring`); `NULL` = not configured |
| `extraction_instructions` | `TEXT NOT NULL DEFAULT ''` | Household guidance appended to the fixed base prompt; max 2,000 chars, enforced by the repo |

The existing `ai_model` column keeps its meaning: the Workers AI model id.

Validation (in `HouseholdSettingsRepo`, matching its normalization style):

- `ai_provider` outside the enum → `ValidationError`.
- Saving `ai_provider = 'anthropic'` with no stored key (and none supplied in
  the same PUT) → `ValidationError`.
- `anthropic_api_key` updates are tri-state: absent = keep, `null` = clear,
  string = encrypt with the active key and store. Any supplied value containing
  the mask glyph U+2022 is rejected (the `assertNotMasked` trap from
  `crypto/envelope.ts`, same protection the passport fields have) so a
  round-tripped masked placeholder can never destroy the real key.
- `extraction_instructions` is trimmed; > 2,000 chars → `ValidationError`.

## 2. Provider abstraction

New `src/server/ingest/providers.ts`:

```ts
export interface ExtractionProvider {
  extract(email: ParsedEmail, instructions: string): Promise<ExtractedBooking[]>;
}
```

- **`WorkersAiProvider`** — today's `runModel()` moved behind the interface:
  `ai.run(model, { messages, response_format: { type: "json_schema", ... } })`,
  `modelPayload()` unwrap, `validateExtracted()`.
- **`AnthropicProvider`** — the official `@anthropic-ai/sdk` (fetch-based, runs
  on Workers). `client.messages.create` with `output_config.format`
  (`json_schema`) using a variant of `EXTRACTED_JSON_SCHEMA` with
  `additionalProperties: false` on every object (required by structured
  outputs), `max_tokens: 4096`, model from settings. API errors are caught and
  rethrown as `ExtractionError` with the SDK's typed error name in the message.
- Both providers funnel through the existing `validateExtracted()`; a
  misbehaving model still fails soft to a `failed` inbound email, never a bad
  draft row.
- A factory (`buildExtractionProvider(settings, env, keyring)`) resolves which
  provider to construct. **Runtime fail-soft:** if the provider is `anthropic`
  but the key is missing or fails to decrypt, the factory logs and falls back
  to `WorkersAiProvider` — a config mistake must not lose an email. The
  fallback is visible: the draft's `extracted` payload records which provider
  ran (`provider` field), and a console error is emitted.

`extractInboundEmail`'s context takes a provider (plus the instructions string)
instead of `ai` + `aiModel`. `EmailIngestEnv` gains `ENCRYPTION_KEY`; the
"ingest never touches auth or encryption" comment in `src/server/ingest.ts` is
revised — decrypting the household's own provider key is now legitimately
ingest's business (auth remains out of bounds).

### Prompt assembly

`buildExtractionPrompt` gains an `instructions` parameter. Non-empty
instructions are appended to the **system** prompt under a delimited section:

```
Household notes (may add context, never override the rules above):
<instructions>
```

The base rules and the JSON schema contract always come first and are fixed, so
instructions can bias extraction ("our home airport is BOI") but cannot remove
the schema or safety rules.

## 3. API surface

### `/api/settings` (existing routes, extended)

- **GET** additionally returns `aiProvider`, `anthropicModel`,
  `anthropicKeyConfigured: boolean`, `extractionInstructions`. The key value is
  **never** returned in any response.
- **PUT** additionally accepts `aiProvider`, `anthropicModel`,
  `anthropicApiKey` (tri-state, see §1), `extractionInstructions`. `.strict()`
  schema as today.

### New routes

| Route | Method | Access | Behavior |
|---|---|---|---|
| `/api/settings/extraction-test` | POST | owner/adult | Body `{subject?, from?, text}`; `text` required, capped at `MAX_AI_TEXT_CHARS` (413-style 400 above it). Runs the configured provider + instructions on the pasted content. Returns `{bookings: ExtractedBooking[]}` or `{error: string}` (the same `describeError` truncation the extractor uses). Persists nothing. |
| `/api/inbound-emails` | GET | household member | Metadata only: `id`, `from`, `to`, `subject`, `status`, `error`, `receivedAt` — **never `raw`**. Newest first (repo's `list()` order). |
| `/api/draft-bookings?status=pending` | GET | household member | Pending drafts joined with their source email's `subject`/`from`/`receivedAt`. |
| `/api/draft-bookings/:id/accept` | POST | write roles | Body = booking input incl. `tripId`. Creates the booking via `BookingRepo.create` with `sourceInboundEmailId` = the draft's email, then `DraftBookingRepo.markAccepted`. Returns `{booking, draft}`. |
| `/api/draft-bookings/:id/dismiss` | POST | write roles | `markDismissed`; returns the resolved draft. |

Accept is two steps (create booking → mark accepted). If `markAccepted` fails
after the booking committed, the endpoint **compensates**: it deletes the
just-created booking and returns the error, leaving the draft `pending` and
the household in the same state as before the call — a plain retry is then
safe. Only if the compensating delete *also* fails (double fault) does the
endpoint return a 500 naming the orphaned booking id. Full multi-row atomicity
is issue #21's territory — this design guarantees *no duplicate bookings and a
retryable accept*, not single-transaction semantics. `BookingRepo` has no
delete method today; the compensation path adds a scoped `delete(id)` (rows in
`booking_person` cascade or are removed in the same batch), used only by this
endpoint for now.

Reads of drafts and inbound-email metadata are available to viewers (they
contain no secrets and no raw mail); all mutations go through `requireWrite`
as every other repo mutation does. The settings/test routes stay owner/adult
in both directions, matching `requireOwnerOrAdult`.

## 4. Client

### Settings page (`src/client/pages/Settings.tsx`, split into subcomponents)

1. **Email ingest card** — forward address + sender allowlist (unchanged).
2. **Extraction agent card**
   - Provider toggle: *Workers AI (runs on Cloudflare)* / *Anthropic Claude
     (API key)*.
   - Workers AI: curated model dropdown (`@cf/meta/llama-3.1-8b-instruct`
     default, `@cf/meta/llama-3.3-70b-instruct-fp8-fast`,
     `@cf/qwen/qwen2.5-coder-32b-instruct`) + a "custom model id" escape hatch
     (today's free-text behavior).
   - Anthropic: model dropdown — `claude-opus-4-8` (default), `claude-sonnet-5`,
     `claude-haiku-4-5` — and a **write-only** API key field: with a key stored
     it renders "Configured ••••" with replace/remove affordances, never the
     value. Same visual language as `MaskedValue`; the form never binds the
     stored secret into an input.
   - Household instructions textarea (2,000-char cap, counter, helper text
     with examples).
3. **Test extraction card** — subject + body paste inputs, "Run test" button,
   results rendered with the same draft-card component the Import queue uses,
   errors shown verbatim. Busy state while running; no persistence.
4. **Recent ingest activity** — replaces the placeholder: read-only list of
   inbound emails (subject, sender, status chip for
   received/extracted/failed/rejected, error text, timestamp).

### Import page (`src/client/pages/Import.tsx`, stub replaced)

- Pending drafts **grouped by source email** (subject / from / received), with
  ordinals keeping multi-booking emails (round trips) together.
- Draft card: kind icon, title, times with zones, confirmation number, source
  chip (`ics` / `ai`), **Review** and **Dismiss** actions.
- **Review** opens the existing `BookingDialog` pre-filled from the draft plus
  a trip selector; trips whose date range overlaps the draft's `startsAt` sort
  first. Save → accept endpoint; validation failure keeps the dialog open with
  the server's message (house convention).
- **Dismiss** is an inline one-click confirm; the card leaves the list.
- Empty state explains how mail gets here (forward address + allowlist), with
  a link to Settings.

## 5. Error handling

- **Test-run** failures return structured `{error}`, surfaced verbatim in the
  test card — never a 500 for a model/content problem.
- **Real ingest** with a failing Anthropic call follows the existing fail-soft
  path: the email is marked `failed` with a human-readable reason, visible in
  the activity list; raw mail is retained so re-extraction is possible later.
- **Missing/undecryptable Anthropic key at runtime** → fall back to Workers AI
  (logged, provider recorded in the draft payload). At save time the same
  condition is a hard `ValidationError` — loud where the human is, soft where
  mail would be lost.
- **Accept partial failure** — see §3.

## 6. Testing

Server (vitest workers pool, house style — no live model calls in CI):

- Repo: tri-state key update; mask-glyph rejection leaves the stored key
  **unchanged** (asserted on the ciphertext, matching the passport tests);
  provider enum validation; anthropic-without-key rejection; instruction cap.
- Providers: `AnthropicProvider` against a stubbed transport — success,
  malformed payload → `ExtractionError`, API error → `ExtractionError`;
  prompt-assembly proves instructions land in the delimited system-prompt
  section and the base rules/schema stay first.
- Factory: fail-soft fallback when the key is missing or undecryptable.
- Routes: extraction-test gating + size cap; draft accept/dismiss including
  cross-household (404), already-resolved (400), and the compensating-delete
  path (transition failure leaves no orphaned booking and the draft pending);
  inbound-email list response never contains `raw`.

Client (testing-library):

- Stored key is never rendered; replace/remove flows send the right tri-state
  values.
- Provider toggle shows the matching fields; custom Workers AI model escape
  hatch round-trips.
- Import queue: accept flow pre-fills `BookingDialog`, trip overlap sorting,
  dismiss removes the card, empty state.
- Activity list renders status chips and error text.

## Out of scope (tracked elsewhere)

- Structured logging / audit surface beyond the activity list — issue #8.
- Multi-row transactional atomicity — issue #21.
- Encryption/retention lifecycle for raw inbound mail — issue #22.
- Re-running extraction on a stored email (natural follow-on once the activity
  list exists; pairs with #8).
- OpenAI-compatible providers (deliberately excluded this round).
