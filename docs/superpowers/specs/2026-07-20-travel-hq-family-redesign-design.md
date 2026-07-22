# Travel HQ — Family Redesign

**Status:** Approved design, not yet implemented
**Date:** 2026-07-20 (design conversation spanned 2026-07-19 to 2026-07-20)

---

## Summary

Travel HQ is being repositioned from a credit-card and points optimizer into a
trips-first travel dashboard for a family. This spec covers phase 1: a real data
model, a backend with persistence, a trips-first UI, and reachability from
outside the house.

Three things drive the design:

- **The day-by-day itinerary, per family member, is the centerpiece.** Not one
  view among many. The model is shaped around making it cheap.
- **The app must work while actually travelling.** The current LAN-only
  deployment means standing at a gate unable to reach your own itinerary. This
  is close to a fatal flaw in a travel app and phase 1 fixes it.
- **The project will be open-sourced and may eventually be hosted for others.**
  Phase 1 is single-tenant in practice but multi-tenant in structure, because
  tenancy is cheap to build in and brutal to retrofit.

Business-spend and business-card material is removed entirely. This is a family
travel tool.

---

## Architecture

```
  family (anywhere) ──▶ Cloudflare Access ──▶ Tunnel ──▶ cloudflared ──▶ app
                         (Google / OTP)                   on guiltyspark   │
                                                                          ▼
                                                            SQLite + agenix key
                                                              (never leaves)

  trips@badgerops.foo ──▶ Email Routing ──▶ Worker shim ──┘
                                            (Access service token)
```

The application and all data stay self-hosted on guiltyspark. `cloudflared`
dials out to Cloudflare, so there are no inbound ports, no port forwarding, and
no public IP. Cloudflare Access authenticates family members at the edge before
traffic reaches the tunnel.

This keeps the data sovereignty that made self-hosting attractive — passport
numbers and the encryption key never leave the house — while making the app
reachable from an airport.

### Why not full Cloudflare (D1 + Workers)

Considered and rejected for phase 1. It would mean passport numbers, DOBs, and
Known Traveler numbers living on third-party infrastructure. The tunnel gets the
same reachability without the custody change. The trade is that guiltyspark
becomes a travel dependency — see *Offline access* below.

### Stack

- **Backend:** Node 22 + Hono + SQLite (`node:sqlite`, built into Node 22).
  TypeScript end to end, types and Zod schemas shared with the frontend. No ORM.
- **Frontend:** React 19 + Vite, restructured into routed pages. The existing
  dark aesthetic and `src/styles.css` are kept.
- **Deploy:** NixOS module + systemd on guiltyspark. SQLite in
  `/var/lib/travel-hq`. Secrets via agenix.
- **Edge:** Cloudflare Tunnel, Access, Email Routing, one small Worker.

---

## Data model

```
household        id, name, created_at              -- THE TENANT

user             id, email, auth_subject, created_at
                 -- an authenticatable identity; global, not per-household

household_member household_id, user_id, role       -- owner | adult | viewer

person           id, household_id, user_id NULL, display_name, dob, notes
                 ├─ passport_number       (encrypted, key_id)
                 ├─ passport_expiry, passport_country
                 ├─ known_traveler_number (encrypted, key_id)
                 └─ redress_number        (encrypted, key_id)

loyalty_account  id, household_id, person_id, program,
                 account_number (encrypted, key_id),
                 status_tier, balance, balance_updated_at

trip             id, household_id, title, destination,
                 starts_on, ends_on, status, notes

trip_person      trip_id, person_id                -- who's on this trip

booking          id, household_id, trip_id, kind, title, location,
                 starts_at, starts_at_tz, ends_at, ends_at_tz,
                 confirmation_number, cost_cents, points_used, points_program,
                 status ('draft' | 'planned' | 'booked' | 'cancelled'),
                 details JSON                      -- kind-specific, Zod-validated

booking_person   booking_id, person_id             -- who this booking covers

checklist_item   id, household_id, trip_id, person_id NULL,
                 label, due_on, done_at            -- NULL person = family-wide
```

### Decisions that matter

**One `booking` table with a `kind` discriminator and a JSON `details` column**,
rather than separate tables per booking kind. The day-by-day itinerary becomes
`SELECT … ORDER BY starts_at` instead of a four-way UNION with column aliasing,
and adding a ferry or a train needs no migration. Type safety is recovered with a
Zod schema per `kind`, validated on write and shared with the frontend.

**`booking_person` is load-bearing.** Not everyone on a trip is on every booking
— a spouse takes a later flight, a child isn't on the rental car, someone has a
solo dinner reservation. Per-member day views are the headline feature, so
travellers attach to bookings, not merely to trips.

**`person` and `user` are separate.** Children are `person` rows with passports
and no login. Adults are `user` rows linked to a `person` row. Conflating them
means either giving a child a password row or having nowhere to store their
passport.

**`user` is global; `person` is tenant-scoped.** The same email may be an adult
in one household and a viewer in another, while a traveller with a passport
belongs to exactly one household.

**`household_id` is denormalized onto `booking` and `checklist_item`** even
though it is reachable through `trip`. This makes the tenancy filter a direct
column check on every table rather than a join someone might forget.

**Timezones are stored explicitly and are not optional.** A flight departing 6pm
Boise and arriving 11pm Atlanta is not a five-hour flight. Store UTC instants
plus an IANA zone per endpoint (`starts_at_tz`, `ends_at_tz`) and render in the
local zone of the event, with the traveller's zone as secondary. Naive
timestamps render every cross-timezone itinerary wrong, which is most flights.
This is a correctness requirement, not a feature.

**`key_id` sits beside every encrypted value.** Today every row reads
`key_id = 'server-v1'` and there is a single server key. When key strategy
changes — per-household keys, or user-derived keys — rows can be re-encrypted
incrementally and old and new coexist. Without the column, changing key strategy
is an all-or-nothing migration.

---

## Multi-tenancy

Phase 1 has exactly one `household` row. The structure exists so that a hosted
multi-tenant deployment is possible later without tearing anything out.

Structure alone does not prevent cross-tenant leaks — discipline does, and
discipline fails. Four mechanisms:

1. **Tenancy enforced by construction.** All data access goes through a
   repository layer constructed with a household context, which injects the
   filter itself. No exported function runs a raw query against a domain table.
   The unsafe thing must be hard to write, not merely discouraged.
2. **Non-enumerable IDs.** UUIDv7 rather than autoincrement — time-sortable and
   index-friendly, but `/api/trips/1` → `/api/trips/2` is not an attack.
3. **`key_id` beside every ciphertext**, as above.
4. **A thin auth boundary.** One module, one function:
   request → `{user_id, household_id, role}`. Backed by the Access JWT today;
   OAuth or magic links later touch that file and nothing else.

A migration runner is required from the start. Once anyone else self-hosts,
"just edit the schema" stops being viable.

Explicitly **not** in phase 1: per-household keys, end-to-end encryption, signup
flows, billing, or roles beyond owner/adult/viewer.

---

## Authentication

Cloudflare Access authenticates at the edge and passes a signed JWT in
`Cf-Access-Jwt-Assertion`. The app validates that JWT against the team's public
keys on every request and maps the verified email claim to a `user` row.

This removes password hashing, session management, and the login screen from
phase 1.

Two requirements that are easy to get wrong:

- **Validate the JWT; never trust the header blindly.** An unvalidated header is
  trivially forged by anything that can reach the origin.
- **Bind the app to `127.0.0.1` only.** Otherwise it is reachable at
  `travel-hq.badger.lan` with no authentication *and* through the tunnel with
  Access in front, and the LAN path silently bypasses all authentication.
  `cloudflared` must be the only route in, including from home.

---

## Email ingestion

`trips@badgerops.foo` routes through Cloudflare Email Routing to a small Worker.
The Worker stays deliberately dumb:

1. Verify the sender — DMARC/SPF pass plus a family allowlist. Anyone on the
   internet can email that address and `From:` is trivially spoofed.
2. `POST` the raw MIME to `/api/inbound-email`.

All parsing happens in the internal app, where the Zod schemas already live.
Splitting domain logic across a Worker and the server is what would make this
expensive to maintain.

The Worker authenticates through Access using an **Access Service Token**
(`CF-Access-Client-Id` / `CF-Access-Client-Secret` headers, with a policy
allowing that token on `/api/inbound-email`). This is the purpose-built
machine-to-machine mechanism; a bypass policy with a shared secret is not the
right tool.

Parsing strategy, in order:

1. **Prefer `.ics` attachments.** Most airline and hotel confirmations include
   one. Structured, reliable, and carries real timezone data.
2. **Fall back to LLM extraction** for the long tail of formats — hand the body
   to Claude, get JSON validated against the same Zod schemas. Far more robust
   than per-vendor regex, which is what makes email ingestion viable rather than
   a permanent maintenance sink.

**Everything lands as `status='draft'` and requires approval in the UI.** A
flaky parser must never write directly into the trip record.

**Failed deliveries need somewhere to go.** If guiltyspark is down or the tunnel
is flapping, the Worker's POST fails and the email is lost. The shim falls back
to forwarding to a real mailbox on failure. Cloudflare Queues is the more
thorough answer if retries become necessary.

---

## Frontend

`src/main.tsx` is currently the entire app — roughly 430 lines with all data
hardcoded and a decorative sidebar whose tabs all render the same content. It is
split into routed pages, rebuilt trips-first, behind a real router
(`react-router` or `wouter`).

**A design bundle exists at `docs/design/`** — high-fidelity prototypes for
Home/Today and Import, mid-fidelity explorations for trip detail, both day-view
shapes, phone views, and the add-booking form, plus the full token sheet. It is
the source of truth for visual values. Read its `README.md` first.

The bundle predates the Cloudflare Tunnel pivot and carries three stale
references, corrected here and authoritative in this spec:

- It cites `user`/`session` tables. Access owns identity; those tables do not exist.
- It gives the forward address as `trips@hq.badger.lan`. Cloudflare Email Routing
  cannot deliver to a `.lan` hostname — the address is `trips@badgerops.foo`.
- It points at a spec path dated `2026-07-19`. This file is the spec.

The design **replaces** the current palette rather than extending it. The
"Nocturne" `:root` block in `docs/design/nocturne-tokens.css` supersedes the
existing `--bg`/`--panel`/`--accent` values in `src/styles.css`, and
`lucide-react` is swapped for `@phosphor-icons/react`. The aesthetic stays dark;
the specific tokens do not survive.

Screens:

- **Trip list / home** — upcoming and past trips
- **Trip detail** — the hub: bookings, travellers, checklist
- **Day-by-day itinerary** — per-trip agenda, filterable by family member. The
  centerpiece. Needs a phone layout as well as desktop; the day-of-travel case
  is a phone case.
- **People / travel documents** — passports, KTNs, expiry warnings, with masking
- **Cards & points** — stub in phase 1, built in phase 2
- **Empty state** — a new instance has zero trips and zero people, and someone
  must enter the family before anything works

Resolved by the design bundle:

- **Booking creation** is one dialog with a kind segmented control that morphs
  the middle fieldset (exploration 1g), not a picker leading to per-kind forms.
- **The checklist** gets both a trip-detail tab and a top-level cross-trip route.
- **The trip list** uses photo covers, not a map.

- **The day view is 1c** — a shared agenda with person filter chips (decided
  2026-07-21). 1d, the column-per-person grid, becomes a desktop-only view toggle
  later, dropped in behind the `DayView` component boundary without touching
  callers.

  The deciding argument is that 1d cannot replace 1c. Exploration 1e is the day
  view at 390px, and four columns do not fit on a phone — 1d's mobile fallback
  would have to be a single merged timeline with person chips, which is 1c.
  Building 1d first means building 1c anyway, then adding a desktop-only layout
  on top. Secondarily, for a family of four most events are shared, so in 1d the
  common case renders as a row spanning every column plus three headers of
  chrome; columns earn their space only when travellers diverge, which is the
  exception. 1c's filter chips already answer "what is Ava doing today"; what
  columns uniquely provide is comparison at a glance, a narrower need.

Still open:

- **The empty state.** A fresh instance has no trips and no people, and the
  design bundle does not cover it. Someone must be able to enter the family
  before any screen has content.

### Trip cover photos

The design gives every trip card a 150px photo header with an upload slot.
Photo *upload* is deferred with the rest of the attachments work — it needs blob
storage, size caps, a MIME allow-list, and backups covering a blob directory.
Phase 1 trip cards render without the photo header; the card reads fine without
it. Do not build the upload slot as dead UI.

### Trip cost rollup

**In scope for phase 1**, promoted from the backlog on 2026-07-20 because the
trip-detail design (exploration 1b) leans on it. `booking.cost_cents` and
`booking.points_used` already exist, so this is a query and a panel — no
migration. Sum cost and points per trip, split booked versus planned, and render
as the design shows ("$1,484 + 18,500 SkyMiles").

Multi-currency stays deferred. Capture it when an international trip needs it.

### Offline access

Because the app is self-hosted, a home internet or power outage makes it
unreachable *while travelling* — precisely when it is needed. The active trip is
cached client-side (service worker / PWA) so a dead tunnel is an inconvenience
rather than a stranding. This was originally backlog material; the tunnel
architecture promotes it into phase 1.

---

## PII handling

Document numbers — passport, Known Traveler, redress — and loyalty account
numbers are encrypted at rest with AES-256-GCM. The key is read from a file path
supplied by agenix and never lives in the repository.

Encrypted values are returned masked (`••••1234`) by default. Revealing
plaintext requires an explicit single-record request and is logged.

Note for any future hosted offering: a multi-tenant deployment should probably
not store document *numbers* at all — expiry dates and reminders deliver most of
the value at a fraction of the exposure. Storing thousands of strangers' passport
numbers carries custodial obligations under GDPR and state privacy law that a
hobby project should not casually take on.

---

## Out of scope for phase 1

Tracked in `docs/BACKLOG.md`:

- Attachments and document storage, including trip cover photos
- Packing lists
- Cards, points, and loyalty features (phase 2)
- External sharing and invitations for travel companions
- Automated balance sync — no public API exists for Delta SkyMiles, Amex MR, or
  Chase UR; email parsing is the viable path

Removed permanently: business cards and business spend.

---

## Success criteria

Phase 1 is done when:

1. The family can be entered once — people, passports, expiry dates.
2. A trip can be created with flights, lodging, and a car, each with
   confirmation numbers and correct timezones.
3. Each family member has a day-by-day view showing only what they are on.
4. The app is reachable from outside the house, authenticated by Access, and the
   LAN path does not bypass authentication.
5. A forwarded confirmation email produces a draft booking awaiting approval.
6. The active trip remains viewable when the tunnel is down.
7. No business-spend or business-card content remains in the app or README.
