# Travel HQ — UI redesign to design-exploration fidelity

**Date:** 2026-07-27 · **Branch:** `claude/travel-hq-ui-redesign-cabb52`
**Sources of truth:** `docs/design/README.md` (Nocturne handoff), `docs/design/Travel HQ Design Explorations.dc.html` (screens 1a–1g, 2a–2b), the user's approved 2a dashboard screenshot.

## Problem

The shipped UI implements the right structure (routes, heroes, cards) but reads
cramped and sterile next to the design explorations: no photo headers, dense
unpadded rows, inline-styled one-offs instead of the system's card/kicker/rule
vocabulary, and layouts that don't breathe between 390px and 1280px+.

## Goals

1. **Home/Today matches exploration 2a** (the screenshot): greeting header with
   date subline and countdown tag; "Next up" hero with mini-itinerary and
   time gutter; ranked Next-best-actions card; Trips grid of **photo-header
   cards** with a 3-line day-by-day teaser (drafts show blocker lines instead).
2. **Photo headers everywhere trips appear.** A trip has an optional cover
   photo (`photo_url`); cards show a 150px cover, trip detail opens with a
   full-width photo banner. Without a photo, a deterministic Nocturne-styled
   fallback (per-trip gradient + route-line SVG, hue derived from the trip id)
   keeps the slot looking intentional — never a gray void.
3. **Trip Overview gains a daily breakdown**: a per-day strip (Fri 9 / Sat 10 /
   Sun 11 …) showing where each booking/event fits, unbooked gaps in warning
   amber — the "where things fit" view, above the grouped-bookings hub (1b).
4. **Every screen speaks the design language**: bookings grouped under h6
   kickers as icon rows with dual timezones and status tags; 1c timeline day
   view with accent line + dots; Import as the 2b two-pane review; Checklist /
   People rebuilt from cards, chips, and fading rules.
5. **Responsive, mobile → desktop.** Fluid grids (`auto-fit/minmax`),
   `flex-wrap`, `clamp()` padding; the day view collapses to the 1e phone
   layout; existing bottom-tab bar retained. Verify at 390px and 1280px.

## Non-goals

- No photo **uploads** (no R2 bucket; D1-only). Cover photos are URLs pasted in
  the trip form. Upload support is future work, noted in BACKLOG.
- No new features beyond the cover-photo field: no kid-view route, no map
  integration, no 1d column-per-person day view (family still hasn't picked;
  DayView stays one component boundary).
- No light theme, no token retuning — Nocturne values stay as shipped.

## Design system rules (restated, binding)

From `docs/design/README.md`: primary buttons are accent-**outlined**, never
filled; rules fade at both ends (`.hr`/`.frule`); the hero gradient
(`135deg, #262a60 → #1a1c33 55% → bg`) is the only saturated fill; masked
confirmations keep tap-to-reveal + logged reveal; Phosphor icons; headings
weight 500, never bolder; warning amber `#d9b98a` is the only off-token color.
Photos get `mix-blend-mode: lighten` treatment only when a real photo is
present — never on the fallback slot.

## Architecture

- **CSS:** shared primitives land once in `src/client/styles.css` (photo
  cover, booking row, timeline, day-teaser, ranked-action row, cost rollup,
  detail banner). Page-specific styles live in per-area CSS files imported by
  the page component (`home.css`, `trip.css`, `dayview.css`, …) so parallel
  work never collides in one file. Inline styles remain only for true
  one-offs.
- **Cover photo data:** migration `0009` adds `photo_url TEXT NULL` to `trip`;
  zod accepts an `https?://` URL or null; repo/routes/types pass it through;
  `TripForm` gets a "Cover photo URL" field. The fallback art is client-only.
- **Component boundaries:** `TripCoverPhoto` (photo-or-fallback, used by
  TripCard and the detail banner), `DayBreakdown` (overview strip),
  `BookingRow` (kicker-grouped rows), existing `DayView` boundary unchanged.

## Screen-by-screen

- **Home** (2a): hero row `flex: 1.5/1` panels wrapping at ~900px; trips grid
  `repeat(auto-fit, minmax(min(380px,100%),1fr))`. Teaser rows: 44px muted day
  gutter + one-line summary, warning amber for unbooked. Draft cards show
  blocker lines (cert deadlines, passport) instead of the teaser.
- **Trips**: same photo cards, all states (active/upcoming/past/cancelled
  last, with badges).
- **Trip detail** (1b + banner): breadcrumb → photo banner (≤220px, title,
  dates, location, state tag, traveler chips overlaid on a bottom gradient
  scrim) → segmented tabs. Overview = daily breakdown strip, then bookings
  grouped Flights / Stay & car / Events with icon rows (dual-tz, masked conf,
  chips, cost, status), unbooked = dashed row + "Book →"; right rail:
  Travelers (doc status), Checklist (n of m), Trip cost rollup.
- **Day by day** (1c): pager + segmented day control; person filter chips;
  timeline: 150px right-aligned time gutter with dual-tz sublines, accent-800
  vertical line, solid accent dots (hollow for gaps), surface cards max 760px;
  gaps dashed. At ≤760px the gutter collapses into the card (1e's list shape).
- **Import** (2b): three method chips (Paste active, Forward, Upload);
  two-pane `auto-fit minmax(420px,1fr)`; parsed draft card with uppercase
  field labels, matched-traveler toggle chips, attach-to-trip tag,
  Discard / Add-to-trip; waiting-queue dashed hint row.
- **Checklist / People**: card-based, kickers, fading rules between rows,
  avatar chips, due-date tags; People cards show doc status lines with the
  amber warning treatment.

## Implementation plan

Order of work (each item an isolated task with a disjoint file set):
1. Foundation — shared primitives in `styles.css` (`.page-header`, `.photo-card`/`.cover`, `.booking-row`, `.timeline`, `.action-row`, `.chip-toggle`, `.detail-banner`, `.split-main-rail`), `TripCoverPhoto` component, `.card` padding bump, nav gap fix, `.seg` overflow.
2. Backend `photoUrl` (migration 0009, repo/routes/zod, client type, TripForm) — parallel with 1.
3. Parallel page tasks on the foundation: Home+Trips (2a), TripDetail+Overview (1b + daily breakdown), DayView (1c/1e), Checklist+People, Import (2b), Settings+Cards polish.
4. Browser QA at 1280px and 390px on every screen; fix findings.
5. `typecheck` + `test:all`, commit, PR.

Known test touchpoints: `TripCard.test.tsx` "renders no photo header" is
superseded by this spec (update test + BACKLOG note); keep aria-labels,
`data-testid`s (`action-row-*`, `pending-import-card`, `nav-user-menu`,
`dialog-backdrop`), `role`/name queries, and `PersonChip` `title` attributes.

## Testing

Existing Vitest client suites must stay green; markup-dependent queries update
with the new structure (roles/labels preserved). New coverage: trip photo_url
round-trip (server), TripCoverPhoto fallback rendering, DayBreakdown grouping.
Manual QA pass in a browser at 390px and 1280px on every screen before ship.
