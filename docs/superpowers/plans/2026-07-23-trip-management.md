# Trip management — implementation plan

**Date:** 2026-07-23
**Spec:** `docs/superpowers/specs/2026-07-22-trip-management-design.md`
**Stack:** Cloudflare Workers (Hono) + D1, per
`2026-07-22-cloudflare-replatform-design.md`. No migration — the schema
already carries the four-status CHECK and every needed cascade.

## Task 1 — status resolver (`src/client/lib/dates.ts`)

- `TripState = "active" | "upcoming" | "past" | "complete" | "cancelled"`.
- `resolveTripState(trip, today): TripState` — stored `cancelled`/`complete`/
  `active` win outright; `planning` derives from dates via the existing
  `isActiveOn` (within range → active; future or undated → upcoming; past
  end → past). `isActiveOn` stays as the date primitive but stops being
  called ad hoc from pages.
- `tripStateRank(state): number` — active 0, upcoming 1, past 2, complete 3,
  cancelled 4 — and `compareTrips(a, b, today)`, the one comparator both the
  Home grid and the Trips page sort with (rank asc; active/upcoming
  soonest-first with undated last; past/complete/cancelled most-recent-first).
- `tripStateBadge(trip, today): string` — "Cancelled" / "Complete" for those
  states, "Active" for a forced-active trip whose dates do not cover today,
  otherwise the existing `countdownLabel`.
- Tests in `tests/client/lib/dates.test.ts`: one per stored status, each
  planning derivation, and the rank order.

## Task 2 — `TripRepo` (`src/server/repos/trip.ts`)

- Export `TRIP_STATUSES` as a const tuple (the route's Zod enum and the edit
  form's control both need the runtime list — same reasoning as
  `BOOKING_STATUSES`).
- `UpdateTripInput` (tri-state, `title` non-null, `status` enum, dates
  well-formed `YYYY-MM-DD`, effective `startsOn <= endsOn`).
- `update(id, patch)` — scoped existence check → `NotFoundError`; field
  validation → `ValidationError`; SET clause from provided keys only via a
  fixed key→column map (the `PersonRepo.update` pattern); returns the
  reloaded `Trip`.
- `delete(id)` — scoped existence check → `NotFoundError`; single scoped
  `DELETE`; cascades do the rest.
- `removeTraveler(tripId, personId)` — scoped existence checks for trip and
  person → `NotFoundError`; then one atomic D1 batch deleting the person's
  `booking_person` rows for this trip's bookings and their `trip_person`
  row. Requires a new `unscopedBatchRun(reason, statements)` on `TenantRepo`
  (join tables carry no `household_id`; both ids are scope-confirmed first —
  the same justification as the existing `unscopedRun` call sites, plus
  atomicity via `db.batch`).
- Tests (`tests/server/repos/trip-management.test.ts`): tri-state patch
  regression (absent leaves, null clears, value sets), date validation and
  cross-field ordering as `ValidationError`, unknown/foreign ids as
  `NotFoundError`, viewer as `ForbiddenError`, delete-cascade regression
  (booking + booking_person + checklist_item + trip_person all gone),
  removeTraveler unassign-only semantics (booking rows survive; other trips'
  assignments survive), and idempotency.

## Task 3 — routes (`src/server/routes/trips.ts`)

- `updateTripSchema` — `.strict()`, tri-state via `.nullable().optional()`,
  `status: z.enum(TRIP_STATUSES)` with no null.
- `PUT /api/trips/:tripId` → `repo.update`, 200 with the trip.
- `DELETE /api/trips/:tripId` → `repo.delete`, 204.
- `DELETE /api/trips/:tripId/people/:personId` → `repo.removeTraveler`, 204.
- All errors flow through `app.onError`/`mapError` — no local try/catch.
- Tests (`tests/server/routes/trips-manage.test.ts`): 200 partial update,
  400 malformed JSON / unknown key / bad date, 403 viewer on all three
  routes, 404 unknown trip/person, 204 + idempotent traveller removal,
  delete answers 204 and the trip vanishes from GET /api/trips.

## Task 4 — API client (`src/client/api/client.ts`, `types.ts`)

- `trips.update(tripId, input)` (PUT, JSON body), `trips.delete(tripId)`
  (DELETE, no body), `trips.removeTraveler(tripId, personId)` (DELETE, no
  body). Export `UpdateTripInput` from `api/types.ts`.
- Tests: `tests/client/api/client-trip-manage.test.ts` — URL, method, body
  shape, and path-segment encoding.

## Task 5 — `TripForm` edit mode (`src/client/components/TripForm.tsx`)

- `trip?: Trip` prop; edit when present (the `PersonForm` convention,
  remounted per trip via `key`). Seeds title/destination/dates/notes; shows
  the status control (Auto (planning) / Active / Complete) — `cancelled` is
  never offered; a cancelled trip's control seeds to Auto and `status` is
  sent **only when the operator changed it**, so editing a cancelled trip's
  title does not silently restore it.
- Partial `PUT` with tri-state nulls for emptied fields; travellers section
  is create-mode only. Failure keeps the dialog open and the values intact.

## Task 6 — trip detail wiring (`src/client/pages/TripDetail.tsx`,
`src/client/trip/TravelersTab.tsx`)

- Header pencil (gated by `useCanWrite()`) opens `TripForm` in edit mode;
  saved → reload. Header badge reads `tripStateBadge`.
- Footer (write-gated): **Cancel trip** with a confirm step → `status:
  "cancelled"`; a cancelled trip shows a notice and **Restore** →
  `status: "planning"`. **Delete trip** with a double-confirm dialog carrying
  the cascade warning ("also removes N bookings"), then navigates to /trips.
- `TravelersTab` gains optional `tripId`/`onRemoved`; when present and the
  viewer can write, each person row offers **Remove from trip** behind an
  inline confirm that names the booking-unassignment consequence.
- Tests: `tests/client/pages/TripDetail-manage.test.tsx`,
  `tests/client/components/TripForm-edit.test.tsx`, and a viewer-role test
  asserting none of the affordances render.

## Task 7 — migrate the `isActiveOn` call sites

- `Home.tsx`: hero pick, bookings prefetch, and grid rank all read
  `resolveTripState`/`compareTrips`; cancelled trips are excluded from the
  dashboard.
- `Trips.tsx`: sort with `compareTrips`; cancelled trips render last with
  their badge (the page you restore from).
- `TripCard.tsx`: badge reads `tripStateBadge`.
- Fixture touch-up: `Home.test.tsx`'s future-trip fixture carried the
  vestigial `status: "active"`; now that stored `active` forces the active
  state it must say `planning` for the idle-hero case to remain what it
  tests.

## Verification

`npm run typecheck` and `npm run test:all` (server pool-workers suite, arch
suite, client jsdom suite) — all green before the PR.
