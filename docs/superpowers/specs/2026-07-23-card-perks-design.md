# Travel-card points & perks — per-card credits and perks

**Date:** 2026-07-23
**Status:** Proposed design, awaiting owner approval. Implemented behind this
spec so the owner reviews code and spec together; the deferred items below do
not proceed without a separate decision.
**Issue:** #2 — "Travel-card points & perks tracking (per-card credits/perks)".

## Scope decision (the YAGNI pass the issue asked for)

The issue flags itself as the least-specified of the remaining work and asks
for a scope-locking pass before a plan. The lock, applied here:

**In scope**

- A `card` entity — the household's card portfolio — and a `card_perk` entity:
  name, kind (statement credit / free night / lounge / multiplier / fee
  offset), value, cadence (annual / monthly / one-time), and an annual reset
  date.
- Credit tracking: mark a perk used/unused for the **current period**, with
  the period derived from the cadence so a credit automatically reads as
  unspent again when its period rolls over. Nothing is written at rollover —
  "used" is a timestamp interpreted against the current period, not a flag a
  cron job has to reset.
- Unspent-credit surfacing: a real **Cards** page (replacing the phase-1
  "Cards · soon" nav stub) showing each card, its perks, per-card and total
  unspent credit value, and a used/unused toggle.
- Points balances: a card records the program it earns and a manually-entered
  balance. The existing trip rollup (`RollupRepo.forTrip`) is extended so each
  per-program points row also carries the household's available balance in
  that program.
- Multipliers, minimally: a perk of kind `multiplier` stores a per-category
  multiplier (e.g. 3× travel) and the UI **displays** it. No engine consumes
  it.

**Out of scope — deliberately deferred, not forgotten**

- **The "best card for this purchase/trip" suggestion engine.** The issue
  itself marks the suggestion/multiplier engine as the YAGNI candidate. The
  data model stores what an engine would need (kind, category, multiplier,
  program) so building one later is additive, but no recommendation logic
  ships now. Follow-up once the owner approves the scope.
- **Trip integration** ("when building a trip, suggest which card's
  perks/credits apply") — explicitly "optional, later" in the issue; same
  follow-up.
- Annual fees, fee waivers, and renewal dates (BACKLOG phase-2 items the
  issue does not ask for), award-redemption value calculations, and any
  automated balance sync (no public API exists; see BACKLOG phase 3).
- Linking cards to `loyalty_account`. That dormant phase-1 table remains the
  eventual per-person program-account record (encrypted account number,
  status tier); the card portfolio is household-level and does not reference
  it. Reconciling the two is a later decision.

## Data model — migration `0002_card_perks.sql`

```
card       id, household_id, name, issuer,
           points_program, points_balance, balance_updated_at, created_at

card_perk  id, household_id, card_id → card ON DELETE CASCADE,
           name, kind, value_cents, multiplier, category,
           cadence, reset_month_day, used_at, created_at
```

- Both tables carry `household_id` with `ON DELETE CASCADE` from `household`
  and are reached only through a `TenantRepo` subclass (`CardRepo`), so every
  query is tenant-bound at `?1` like every other repository.
- `card_perk.card_id` cascades from `card`: deleting a card deletes its perks.
- CHECK constraints pin `kind` to
  `statement_credit | free_night | lounge | multiplier | fee_offset` and
  `cadence` to `annual | monthly | one_time`, mirroring how `booking.status`
  and `household_member.role` are pinned in `0001_initial.sql`.

### No sensitive card data — deliberate

The existing encryption/masking conventions (person documents,
`loyalty_account.account_number`, booking confirmation numbers) apply to
secret numbers. This feature stores **none**: no PAN, no last4, no account or
member numbers — a card is identified by its display name ("Sapphire
Reserve") and referenced everywhere else by its opaque `card.id` only. Perk
names, values, cadences, and points balances are not secrets, so nothing here
is encrypted or masked and the reveal/audit machinery is not involved. If a
later feature wants a stored card number, it must go through the
`loyalty_account`-style encrypted-envelope path, not this table.

## Credit periods — the reset-cadence rule

A perk row stores `used_at` (ISO timestamp, nullable). Whether the perk is
"used this period" is **derived at read time** against the period the current
date falls in:

- `one_time` — one period forever: used iff `used_at` is set.
- `monthly` — the period starts on the 1st of the current month.
- `annual` — the period starts on the most recent occurrence of
  `reset_month_day` (`MM-DD`, default `01-01` when unset — calendar-year
  credits; an anniversary-reset card stores its own day). `02-29` clamps to
  `02-28` in non-leap years.

`usedThisPeriod = used_at != null && date(used_at) >= periodStart`. Marking a
perk used stamps `used_at = now`; marking it unused clears it. When a period
rolls over, an old `used_at` simply falls outside the new period and the
credit reads as unspent again — no scheduled job, no state transition to
miss. A perk of kind `multiplier` has no credit to spend, so marking it used
is rejected as a `ValidationError` (400).

Dates are evaluated in UTC (the server has no per-user timezone). For
month/year-granularity credits the worst case is a few hours' skew at the
boundary, accepted for a family tool; the pure helpers take an explicit
`today` so tests pin the boundaries exactly.

### Unspent credits

Per card: the sum of `value_cents` over perks that are not used this period,
excluding `multiplier` perks (a multiplier is not a credit; `lounge` /
`free_night` perks count only when the household chose to give them a
`value_cents`). Surfaced per card and as a page-level total so nothing
expires unused — the issue's stated motivation.

## Validation (repo-level, `ValidationError` → 400)

- `statement_credit` and `fee_offset` require a positive `value_cents`.
- `multiplier` requires `multiplier > 0` and a non-empty `category`, and
  forbids `value_cents`.
- Non-`multiplier` kinds forbid `multiplier`/`category`.
- `reset_month_day` is only meaningful for `annual` cadence and must be a
  real `MM-DD`.
- Updates validate the **merged** row (existing + patch) so a kind change
  cannot smuggle an invalid combination through a partial update.

## API

All routes tenant-scoped through `CardRepo`, viewer writes rejected with
`ForbiddenError` (403) via `requireWrite()`, unknown/cross-household ids
`NotFoundError` (404), statuses mapped only by `mapError`:

```
GET    /api/cards                              → CardWithPerks[] (perks nested,
                                                 usedThisPeriod + unspentCents derived)
POST   /api/cards                              → 201 Card
PUT    /api/cards/:cardId                      → Card (partial; nullables tri-state)
DELETE /api/cards/:cardId                      → 204 (cascades perks)
POST   /api/cards/:cardId/perks                → 201 CardPerk
PUT    /api/cards/:cardId/perks/:perkId        → CardPerk (partial, merged-validation)
DELETE /api/cards/:cardId/perks/:perkId        → 204
PUT    /api/cards/:cardId/perks/:perkId/used   → 204  body {used: boolean}
```

Setting `pointsBalance` stamps `balance_updated_at` server-side (the BACKLOG's
"manual balance entry" note: honest staleness data for a later nag).

## Rollup integration

`RollupRepo.forTrip`'s `points` rows gain `balance` — the household's summed
`card.points_balance` for that program, `null` when no card carries it:

```
points: [{ program: "UR", used: 12500, balance: 85000 }]
```

Program-level, not per-card: a booking records `points_program`, not which
card paid, so per-card attribution would be invented data. The client's
`CostRollup` shows "of N available" when a balance is known. The field is
optional in the shared type so existing client fixtures stay valid.

## Client

- **Cards** becomes a real nav entry and `/cards` route; the "Cards · soon"
  stub span is deleted (its Shell test updated to assert the link).
- The page lists cards in the People-page card-grid idiom: program balance,
  perks with kind/value/cadence, a checkbox to mark a credit used this
  period, and an "unspent" line per card plus a page-level unspent total.
- Add/edit card and add/edit perk are `Dialog`-based forms (PersonForm
  pattern); delete has a confirm. Every write affordance is gated by
  `useCanWrite()` — a viewer sees the data, no controls.
- Failed writes keep entered values and show the server's message
  (`errorMessage(err)`), matching every existing form.

## Tests

- `repos/card.test.ts` — CRUD, tenancy isolation (cross-household 404s),
  viewer `ForbiddenError`, validation matrix (specific error classes, never
  bare `.toThrow()`), and the period logic: monthly rollover, annual
  reset-day boundary (before/on/after), `02-29` clamp, `one_time`
  permanence — via the exported pure helpers with pinned `today` values.
- `routes/cards.test.ts` — status codes end-to-end: 201/200/204, 400
  (malformed JSON, bad enum, multiplier-with-value, marking a multiplier
  used), 403 viewer, 404 cross-household, and unspent/usedThisPeriod
  surfaced in `GET /api/cards`.
- `repos/rollup.test.ts` — extended: balance joined per program, `null`
  when no card matches, cards from another household never counted.
- `db/schema.test.ts` — table list gains `card`/`card_perk`; cascade
  household → card → perk verified.
- Client: `pages/Cards.test.tsx` (render, unspent totals, used-toggle calls
  the API, viewer sees no writes, failed-load alert) and a `CostRollup`
  balance-rendering case.
