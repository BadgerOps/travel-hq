# Trip management — edit, status model, traveller removal, cancel & delete

**Date:** 2026-07-22
**Status:** Approved design, ready for an implementation plan.

> Provenance: this design was approved as commit `c77df1c` on the
> `feat/trip-management` branch, which did not survive the clean-start squash
> onto `master`. The commit is no longer reachable on the remote, so this
> document was re-authored on `master` from the approved design's content
> (carried in issue #1). It is built on the Cloudflare/D1 stack described in
> `2026-07-22-cloudflare-replatform-design.md`, sequenced after Plan B.

## Problem

A trip can be created but never changed. There is no update or delete route,
the trip-detail header's edit pencil is deliberately unbuilt, travellers can
be added but never removed, and `trip.status` is vestigial — only `planning`
is ever written, even though the schema's CHECK constraint already permits
`planning|active|complete|cancelled`.

**No schema change is needed.** The `trip.status` CHECK already permits all
four statuses, and `ON DELETE CASCADE` from `booking` (and through it
`booking_person`), `trip_person`, and `checklist_item` already exists in
`migrations/0001_initial.sql`.

## Status model — "status wins when set, dates fill in"

A single resolver `resolveTripState(trip, today)` in `src/client/lib/dates.ts`
produces one **effective state** that Home's hero, grid ordering, and badges
all read, replacing the ad-hoc `isActiveOn` call sites:

- stored `cancelled` → **cancelled** (hidden from active lists; reversible)
- stored `complete` → **complete** (explicit done, regardless of dates)
- stored `active` → **active** (forced, regardless of dates)
- stored `planning` (the default) → **derived from dates**:
  - today within `[startsOn, endsOn]` → active
  - future start, or no start date → upcoming
  - past end → past

Sort order (ascending): **active, upcoming, past, complete, cancelled**
last/hidden. Cancelled trips are hidden from the Home dashboard entirely and
sort last on the Trips page, where they carry a "Cancelled" badge and remain
reachable so they can be restored.

The edit form's status control offers **Auto (planning) / Active / Complete**
only. `cancelled` is never offered there: it is reached via the explicit
**Cancel** action and reversed via **Restore**.

## Server

All mutations live on `TripRepo`; all pass through `requireWrite()` (403 for a
viewer) and answer 404 for an id outside the caller's household.

- **`UpdateTripInput`** — every field optional, tri-state on the nullables
  (absent = leave unchanged, `null` = clear, value = set), exactly as
  `UpdatePersonInput` established:
  - `title` non-nullable (a trip must keep a title);
  - `destination` / `startsOn` / `endsOn` / `notes` nullable;
  - `status` enum `planning|active|complete|cancelled` (no null).
  - Dates must be well-formed `YYYY-MM-DD`; if both dates are present after
    the patch is applied, `startsOn <= endsOn` — otherwise `ValidationError`
    (400).
- **`update(id, patch): Trip`** — builds the SET clause from the provided keys
  only, column names from a fixed map (never caller-supplied identifiers).
- **`delete(id): void`** — hard delete; the schema's cascades remove the
  trip's bookings (and their `booking_person` rows), checklist items, and
  `trip_person` rows.
- **`removeTraveler(tripId, personId): void`** — one transaction (a D1
  batch): delete the person's `booking_person` rows for this trip's bookings,
  then the `trip_person` row. **Unassigns only** — it never cancels or
  deletes a booking. Idempotent: removing someone who is not on the trip
  succeeds and changes nothing. 404 if the person (or trip) is not in the
  household.
- **Routes:** `PUT /api/trips/:tripId`, `DELETE /api/trips/:tripId`,
  `DELETE /api/trips/:tripId/people/:personId`. The update schema is
  `.strict()` at the HTTP boundary, mirroring `updatePersonSchema`.

## Client

- `api.trips.update` / `api.trips.delete` / `api.trips.removeTraveler`; every
  write affordance gated by `useCanWrite()`; rejected writes handled
  gracefully — never `String(err)`, and entered values are kept on failure.
- The trip-detail header **pencil** opens `TripForm` in edit mode (fields
  seeded from the trip, plus the status control), submitting a partial `PUT`.
- **Cancel** (footer, with confirm) performs the soft cancel
  (`status: "cancelled"`); a cancelled trip shows **Restore** instead, which
  returns it to `planning`. **Delete** (footer, double-confirm) performs the
  hard delete, with a cascade warning ("also removes N bookings").
- A traveller **remove** control on the trip's people list, behind a
  client-side confirm that notes it unassigns the person from this trip's
  bookings.

## Acceptance criteria

- Trip fields editable via the header pencil; partial updates persist.
- Status model implemented via `resolveTripState`; all call sites migrated
  off ad-hoc `isActiveOn`.
- Cancel/Restore and hard Delete work with confirms; the delete cascade is
  verified by a regression test.
- Traveller removal unassigns bookings in one transaction; idempotent.
- The viewer role is offered none of these affordances, and the server
  rejects viewer writes (403).
- Unit + integration tests assert specific error classes (never a bare
  `.toThrow()`); regression tests cover the cascade and the tri-state patch.
