# Travel HQ — Backlog

Deferred ideas and future work. This file stands in for an issue tracker; the
Forgejo instance at `forgejo.badger.lan` has no API token available to Claude,
so items live here until they're either built or promoted to real issues.

Status key: **Deferred** (agreed, not now) · **Idea** (unvalidated) · **Blocked**

---

## Warning for plan 4 (import) — booking lists disagree about an unparseable IANA zone

**Status:** Blocked-in-waiting — noted 2026-07-21 during the plan 3 review-fix
wave, not fixed there on purpose.

`ItineraryRepo.group()` (`src/server/repos/itinerary.ts`) skips a booking row
whose `starts_at`/`starts_at_tz` can't be formatted (unparseable timestamp, or
an IANA zone `Intl.DateTimeFormat` doesn't recognize) — logged, and the row is
dropped from the day view so one poisoned row doesn't 500 the whole page.
`BookingRepo.listByTrip` and `RollupRepo.forTrip`'s SQL have no equivalent
check: they return/count that same row without ever trying to format it. The
three views of "what bookings exist for this trip" (Overview, the day view,
the cost panel) can therefore disagree.

This is unreachable through the API today — `assertTimezonePaired` in
`booking.ts` rejects both cases at write time, so no row in the database
can actually have this shape unless it was hand-inserted. **It stops being
unreachable the moment an import path writes a `booking` row through anything
other than `BookingRepo.create()`** — a bulk/email-ingestion insert is exactly
that path, and plan 4 is expected to build one.

Before that lands, decide (don't default silently):
- **Skip everywhere** — teach `listByTrip` and the rollup SQL to skip/exclude
  the same rows `ItineraryRepo.group()` does, so all three views agree on
  "this row doesn't count."
- **Surface as broken everywhere** — instead of quietly dropping the row from
  the day view, mark it visibly wrong (a "needs attention" state) everywhere
  it would otherwise appear, so a bad import is discoverable rather than
  invisible.

Either is defensible; picking one belongs with the import work, since it's the
import path that will actually produce a row with this shape. See the
`WARNING` comments on `ItineraryRepo.group()` and `BookingRepo.listByTrip`.

---

## External sharing & invitations

**Status:** Deferred — explicitly noted 2026-07-19 as "not now, but note for future."

Let family and friends we're travelling with see (and maybe contribute to) a
trip without giving them an account on the household instance.

Open design questions to answer before building:

- **Read-only link vs. real guest accounts.** A signed, expiring URL is far less
  machinery than a guest account system, but can't attribute edits and can't be
  revoked per-person once shared onward.
- **Scope of a share.** Whole trip, a single day, or just the bookings the
  invitee is actually on? Sharing a trip wholesale leaks the family's
  confirmation numbers and costs to a travel companion.
- **PII is the hard part.** Passport numbers, DOBs, and KTNs must never be
  reachable from a shared view, no matter how the share is scoped. Any sharing
  feature needs an explicit deny-list on the `person` sensitive columns rather
  than relying on the UI not to render them.
- ~~**Exposure.**~~ **Resolved 2026-07-20.** This was the blocker: the app was
  LAN-only, so an external guest couldn't reach it at all. The Cloudflare Tunnel
  + Access architecture removes it. An invitee is now an Access policy — add
  `grandma@gmail.com`, scoped to a path, and she gets email-OTP login. The hard
  part is reduced to deciding what a shared view omits, which is a UI problem.
- **Contribution.** If invitees can add bookings ("we booked our own flights"),
  that's a write path from untrusted users and needs its own authz story.
- **Tenancy interaction.** A travel companion belongs to a *different* household.
  Sharing is therefore cross-tenant read access, and it must go through the same
  repository layer that enforces `household_id` — not around it. This is the
  single most likely place to introduce a cross-tenant leak.

Suggested shape when we get to it: signed expiring link → renders a stripped
trip view (itinerary + lodging, no costs, no documents, no PII), with an
optional "suggest a booking" form that queues items for our approval rather than
writing directly.

---

## Deferred from phase 1

Agreed 2026-07-19 to keep phase 1 lean. Revisit after using the app on one real
trip, so the priority order is driven by what we actually miss.

### Attachments / documents — including trip cover photos

`document` table plus blob storage under `/var/lib/travel-hq/documents`. Attach a
PDF or photo to a booking, trip, or person. Answers "where's the confirmation."

Notes: needs a size cap and a MIME allow-list; scanned passport pages are PII and
belong under the same encryption/masking rules as `person` document numbers.
Backups need to cover the blob dir, not just the SQLite file.

**This blocks trip cover photos.** The design gives every trip card a 150px photo
header with an upload slot (`docs/design/README.md`). Phase 1 renders the card
without it rather than shipping a dead upload affordance — the card reads fine
photoless. Wire the slot when this lands.

### ~~Trip budget rollup~~ — promoted to phase 1 on 2026-07-20

The trip-detail design (exploration 1b) renders a cost panel, and the schema
already carries `cost_cents` and `points_used`, so it is a query and a panel
rather than a migration. See the spec.

**Still deferred:** multi-currency, and budgeting *against a target* (the phase-1
rollup only sums what exists). Capture currency at booking time when an
international trip needs it.

### Packing lists

Per-person, template-driven ("beach trip" vs "ski trip"), reusable across trips.
Deliberately *not* folded into `checklist_item` — different lifecycle, different
granularity, and templates have no equivalent in trip checklists.

---

## Phase 2 — Cards, points & loyalty

The current MVP's card-optimizer content, rebuilt on real data. The `person`,
`loyalty_account`, and `booking.points_used` columns in phase 1 are the
foundation.

- Card portfolio: annual fees, waivers (military fee relief), renewal dates
- Statement credits with expiry tracking and used/remaining amounts
- Points balances per program, with manual update timestamps
- "Which card should I use" recommendations, driven by a rules engine rather
  than the hardcoded map in the MVP
- Award-redemption value calculator (cents per point on a given booking)

Explicitly out of scope, permanently: business cards and business spend. Removed
from the MVP 2026-07-19 — this is a family travel tool.

---

## Phase 3 — Import & sync

Reality check from 2026-07-19: there is **no public API** for the balances we'd
most want. Delta SkyMiles, Amex MR, and Chase UR have no consumer API;
aggregators that offer it are scraping and break regularly. Plaid exposes
*transactions*, not points. Duffel/Amadeus search and book flights — they cannot
read itineraries we booked elsewhere.

What could actually work, roughly in order of value:

1. **Confirmation-email parsing.** We already have Gmail access. Parse airline,
   hotel, and car confirmations into draft `booking` rows for review. Highest
   value, most robust, no vendor dependency.
2. **TripIt API.** A real API that already solves inbox parsing. Worth evaluating
   as a shortcut before writing our own parsers.
3. **Manual balance entry with staleness prompts.** Low-tech and honest: show
   `balance_updated_at` and nag when a balance is over a month old.
4. **Plaid** for card *spend* toward welcome-offer minimums — genuinely useful,
   and unlike points balances it's a supported use case.

Design constraint: anything parsed should land as a *draft* requiring
confirmation. Silent writes from a flaky parser corrupt the trip record.

---

## Day view 1d — column per person

**Status:** Deferred 2026-07-21. 1c (shared agenda + person filter chips) is
phase 1; see the spec for why.

1d is a **desktop-only view toggle**, not a replacement. Four columns do not fit
at 390px, so 1c remains the phone layout regardless. Build it behind the existing
`DayView` component boundary so callers do not change.

Worth building when the family has a trip where travellers genuinely diverge —
different flights, split days. On a trip where most events are shared it renders
as rows spanning every column plus three headers of chrome, which is why it is
not the default.

## Smaller ideas

- **Flight status / delay alerts** on the day of travel
- **Passport expiry warnings** — many countries require 6 months' validity;
  should warn well before expiry, per traveller, per trip destination
- **Per-person mobile itinerary view** — "what am I doing today" on a phone,
  possibly a shareable read-only route for family members without logins
- **Trip templates** — clone a past trip's structure for a repeat destination
- ~~**Offline access**~~ — **promoted to phase 1 on 2026-07-20.** Since the app
  is self-hosted behind a tunnel, a home outage makes it unreachable precisely
  while travelling. Caching the active trip is no longer optional.
- **Multi-currency** on costs, with rate captured at booking time

---

## Hosted multi-tenant offering (SaaS)

**Status:** Deferred deliberately 2026-07-20. Phase 1 is multi-tenant in
*structure* — `household_id` scoping, UUIDv7 IDs, a repository layer that injects
the tenant filter, a thin auth boundary — with exactly one household row.

Open-sourcing for self-hosters delivers most of the "useful to other people"
value at none of the custodial risk, so that comes first.

What running it for strangers would additionally require:

- **Real auth.** Cloudflare Access is built for your own org's users, configured
  per-person, free to 50 seats. Public signup needs OAuth / magic links /
  passkeys, sessions, verification, and password reset.
- **Systematic tenancy defense.** One missed filter in one endpoint cross-serves
  a stranger's passport number. Not a bug class tests catch by accident.
- **A key strategy.** See the encryption note below.
- **Legal posture.** Storing thousands of strangers' passport numbers, DOBs, and
  KTNs makes you a data custodian under GDPR and state privacy law, with breach
  notification duties and a genuinely attractive target.

**Recommendation on record:** a hosted version should probably not store document
*numbers* at all — expiry dates and reminders deliver most of the value at a
fraction of the exposure.

### Encryption tiers, and why phase 1 stops at tier 1

1. **Server-side key (phase 1).** Cloudflare/host sees ciphertext; you hold the
   key. Right for a family on their own box.
2. **Per-household keys, server-side.** Better blast radius, but the server still
   decrypts to serve requests — mostly theater against the threat people imagine.
3. **True end-to-end, key derived from the user's password.** The real thing.

**Tier 3 conflicts with email ingestion and cannot be bolted on later without
dropping features.** A Worker cannot write into a store it cannot decrypt, nor
read a confirmation email to extract a flight. Server-side search, expiry-warning
cron jobs, and LLM parsing all break the same way. E2E pushes all of it into the
browser and leaves inbound email queued in plaintext until the user opens the
app — exactly the exposure it was meant to remove. Forgotten passwords also
become data loss without a recovery-key scheme.

The `key_id` column beside every ciphertext exists so tiers 1→2 can migrate
incrementally. Tier 3 remains a product decision, not a migration.
