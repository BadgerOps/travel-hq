# Handoff: Travel HQ — trips-first family redesign (phase 1 UI)

## Overview
Repositions Travel HQ from a card-optimizer dashboard to a **trips-first family travel HQ** for a family of four (two parent accounts, two kid `person` rows). This bundle covers the first two implemented screens — **Home/Today** and **Import bookings** — plus exploration mockups for trip detail, two day-view shapes, phone day-of views, and the add-booking form. It builds on the decisions in `docs/HANDOFF.md` (trips-first, booking table with kind discriminator, `booking_person` join, explicit timezones, PII masked until revealed).

## About the Design Files
The files in this bundle are **design references created in HTML** — prototypes showing intended look and behavior, NOT production code to copy directly. The task is to **recreate these designs in the existing codebase**: Vite + React 19 + TypeScript (`src/main.tsx`, `src/styles.css`). Split `main.tsx` into routed pages (add a router — `react-router` or `wouter`), keep the dark aesthetic, and extend `src/styles.css` with the tokens below. The `.dc.html` files use a custom component runtime; ignore the `<x-dc>`/`sc-if`/`{{ }}` mechanics and read them for markup structure, inline style values, and interaction logic (the `class Component` block at the bottom of `Travel HQ Prototype.dc.html` is plain readable JS containing all state + handlers).

## Fidelity
**High-fidelity** for Home/Today and Import (the prototype file): recreate layout, spacing, colors, and typography as specified. **Mid-fidelity** for the exploration canvas screens (trip detail, day views, phone views, booking form): layout and content structure are settled; final build happens after the family picks a day-view shape (1c vs 1d).

## Design Tokens ("Nocturne" system)
Full token sheet in `nocturne-tokens.css` — merge its `:root` block into `src/styles.css` (it replaces the current `--bg/--panel/--accent` palette). Key values:

- Ground `--color-bg: #161826` · surface `--color-surface: #232532` · text `--color-text: #e9e9ed`
- Accent (blurple) `--color-accent: #9184d9`, with a 100–900 ramp (`--color-accent-100…900`); neutral ramp `--color-neutral-100…900`
- Divider: `color-mix(in srgb, #e9e9ed 16%, transparent)`
- Font: Inter 400/500/600/700 (headings weight 500, never bolder)
- Radii: 4 / 8 / 14px (`--radius-sm/md/lg`) · spacing scale `--space-1…8` (2.8–22.4px)
- Shadows `--shadow-sm/md/lg` (hairline edge + ambient darkness — don't stack heavy shadows)
- Warning/amber (passport expiry etc.): `#d9b98a` (only non-token color used)

System rules that matter for fidelity:
- **Primary buttons are accent-OUTLINED, never filled** (`.btn-primary` in the token sheet). Hover = 12% accent tint, active = 22%.
- Horizontal rules **fade to transparent at both ends** (48px ramp) — see `.frule`/`.hr` in the files.
- The only saturated fill is the "hero" panel gradient: `linear-gradient(135deg, #262a60 0%, #1a1c33 55%, var(--color-bg) 100%)` with `1px solid var(--color-accent-800)` border.
- Focus: `outline: 2px solid var(--color-accent); offset 2px`. Selection: 30% accent tint.
- Icons: **Phosphor** (`@phosphor-icons/react` in this codebase — replaces lucide-react). Icon names used are visible in the HTML as `ph ph-<name>` classes (airplane-takeoff, airplane-landing, bed, car, fork-knife, confetti, map-pin, list-checks, users, suitcase, sun, tray-arrow-down, magic-wand, ticket, identification-card, paper-plane-tilt, check-circle, warning-circle, envelope-simple, clipboard-text, file-arrow-up, question, copy, caret-left/right, pencil-simple, plus, x, arrow-right).

Person avatar chips (used everywhere): 22px circle, 10px/600 initial. Badger `bg accent-700 / text accent-100`; Alex `bg accent-2-800 / text accent-2-200`; Maya `bg neutral-700 / text neutral-100`; Finn `bg #4c5397 / text accent-200`. In real code, derive per-person colors from a small palette array on the `person` row.

## Screens / Views

### 1. Home / Today (`Travel HQ Prototype.dc.html`, view = 'home') — route `/`
Purpose: the daily "what's going on" page. Two states, switched by whether a trip is active **today** (compare current date to trip `starts_on/ends_on`):

**Top nav** (all pages): flex row, 14px 28px padding, bottom divider. Brand (paper-plane-tilt icon in accent + "Travel HQ" 16px/500, links home) · right-aligned links 13.5px: Today, Trips, Checklist, People, "Cards · soon" (muted, non-link stub) · Import button (`.btn-secondary`, shows a session count badge after imports; accent border when on the import page) · user avatar chip.

**Greeting header**: "Good morning, {user}" (h3, 25px/500) + one-line subline ("Friday, October 9 · travel day — everyone's in Guerneville by tonight"); right-aligned accent tag ("Wedding trip · today" / "Wedding trip · 12 days").

**Hero row** — `display:flex; gap:24px; flex-wrap:wrap`:
- **Active-trip hero** (`flex:1.5 1 480px`, radius-lg, section gradient above, accent-800 border): kicker "NEXT UP · IN 40 MIN" (h6 uppercase, accent-300); next event as icon 30px + title 18px/500 + detail line 12.5px; **confirmation numbers render masked (`••••X4T2`) with tap-to-reveal, and the reveal is flagged as logged** (dotted underline affordance); avatar chips of who's on it; fading rule; then a compact 3-row "rest of today" list (58px right-aligned time gutter, icon, label, avatar chips); buttons "Open day view" (primary) + "Trip details" (secondary).
- **Idle hero** (trip not today): "Next trip · in {n} days" kicker, trip name + summary, open-items line, single primary button. Neutral border and dimmer gradient (`#1a1c33 → bg`).
- **Next best actions card** (`.card`, `flex:1 1 340px`): ranked rows — 22px numbered square (row 1 accent-tinted, rest neutral), title 13px/500 + sub 11px muted, right-aligned urgency ("now" in accent-300, "132 days" in warning amber). Click toggles done: 45% opacity, line-through, number becomes a check. Fading rules between rows. Ghost button "Full checklist →".

**Trips grid** — `grid-template-columns:repeat(auto-fit,minmax(380px,1fr)); gap:14px`. Each trip card (`.card` padding 0, hover = shadow-sm): 150px photo header (image upload slot; overlay countdown tag top-right: "Today"/accent, "In 162 days"/neutral) then padded body: title row + dates, meta row (pin icon + location, traveler chips, "{n} booked · 1 to go"), and a 3-line **day-by-day teaser** (44px muted day gutter: "Fri 9 / Sat 10 / Sun 11" + one-line summaries; unbooked items in warning amber). Draft trips swap the teaser for blocker lines (companion cert deadline, passport blocker).

### 2. Import bookings (view = 'import') — route `/import`
Purpose: get a confirmation email in with near-zero typing. **Everything lands as a draft for review — nothing writes silently** (constraint from `docs/BACKLOG.md` phase 3).

Header: h3 + subline, right-aligned 3 method chips acting as tabs: Paste email (default), Forward to inbox, Upload .eml/PDF. Active chip = accent outline.

**Paste tab** — 2-col grid `repeat(auto-fit,minmax(420px,1fr))`:
- Left: "Confirmation email" h6 + ghost button "Load waiting email (n)" (simulates forwarded-mail queue); textarea (`.input`, min 280px); "Parse email" primary button + queue hint text.
- Right: empty state (dashed border box with instructions) → after parse, **draft card** (`surface bg, accent-800 border`; low-confidence: `#8a6d3b` border + "Low confidence" neutral tag + amber warning line): icon + title 15px/500 + Draft tag; 2×2 field grid (uppercase 10.5px labels: Departs/Arrives or Check-in/out or Pickup/Drop-off per kind, Confirmation "· stored masked", Cost); fading rule; "Who's on it — tap to toggle" traveler chips (toggleable, accent outline + check when on); "Attach to trip" auto-matched-by-dates tag; Discard / "Add to trip" buttons. Below: "Added this session" list. Adding increments home's booked count and the nav badge.
- Parser behavior in the prototype is canned pattern-matching (see `parse()` in the JS) — real implementation is the phase-3 email parser; until then this same form can front manual entry. Unrecognized text must produce the low-confidence draft (extract 6-char confirmation-code and $-amount candidates, leave the rest blank).

**Forward tab**: card explaining forward-to-address (`trips@hq.badger.lan`) with copy button; note that mail-in is phase 3. **Upload tab**: dashed drop zone, same draft-review flow.

### 3. Exploration screens (`Travel HQ Design Explorations.dc.html` — canvas, ids 1a–1g, 2a–2b)
- **1b Trip detail**: breadcrumb, title + Active tag + traveler chips + "Add booking"/edit; segmented tabs Overview/Day by day/Travelers/Checklist; left column bookings grouped under h6 kickers (Flights, Stay & car, Events) as surface rows (icon, title, datetime **with both timezones**, masked conf, avatar chips, cost, status tag; unbooked = dashed border + "Book →" ghost); right rail cards: Travelers (doc status per person, warning row for expiring passport), Checklist ("3 of 7 done", struck done items, due dates, assignee chips), Trip cost rollup ("$1,484 + 18,500 SkyMiles").
- **1c Day view shape A** (shared agenda): date pager (icon buttons + segmented day control), person filter chips, timeline with 150px right-aligned time gutter (dual-tz sublines), accent-800 vertical line with solid accent dots, surface event cards (max 760px) with avatar chips; free/unbooked slots = dashed cards with hollow dots.
- **1d Day view shape B** (column per person): 4-col grid headed by avatar + name; shared events span columns (`grid-column:1/4` etc.); solo items sit in one column; unbooked/informal = dashed. **The family hasn't picked A vs B yet — build behind one `DayView` component boundary.**
- **1e Parent phone view**: single-column mobile layout — sticky-ish header (date kicker + trip title + avatar), person filter chips, "Next up · in 40 min" hero card, "Then" time-gutter list, bottom tab bar (Today/Trips/Checklist/People). This is the responsive layout of the day view at phone width, not a separate app.
- **1f Kid phone view**: shareable **no-login** route (signed URL, phase: sharing backlog) — big type, friendly copy ("Airplane ride!", progress bar to landing), **no confirmation numbers, no costs, no PII**; footer "Shared by Dad · updates live".
- **1g Add booking form**: one dialog, kind segmented control (Flight/Stay/Car/Activity) morphs the middle fieldset; From/To with tz note on labels; "Who's on it" toggle chips (drives `booking_person`); cost; Planned/Booked status seg.

## Interactions & Behavior
- Nav links route; unbuilt pages in the prototype show a toast (bottom-center, surface bg, accent-800 border, shadow-md, ~2.6s, 180ms ease-in rise) — replace with real routes as pages land.
- Buttons/links: hover tints from the accent ramp (built into the token sheet's `.btn` classes); cards hover to `shadow-sm`.
- Masked sensitive fields: render `••••` + last 4; tap to reveal; **log the reveal** (decision in HANDOFF.md).
- Responsive: fluid grids only (`auto-fit,minmax()` + `flex-wrap`) — no breakpoint-specific layouts needed for these two screens; verify at 390px.
- Home hero switches on `tripActiveToday`; countdown numbers ("in 162 days", "114 days") computed from dates, not stored.

## State Management
Prototype state (see `renderVals()`): `view/tab` (→ router), `emailText`, `draft` (parsed booking draft + per-person `on` map), `qi` (waiting-email queue), `added[]`, `done{}` (action checklist), `confRevealed`, `toast`. Real data model is already agreed in `docs/HANDOFF.md` (person, trip, booking + kind/details JSON, booking_person, checklist_item, user/session).

## Assets
- Phosphor icons (swap lucide-react → `@phosphor-icons/react`).
- Inter via Google Fonts (already the app font).
- Trip photos: user-provided uploads; design reserves a 150px cover slot per trip card with a neutral-900 fallback. (Nocturne treats photos with `mix-blend-mode:lighten` — apply to real photos only, never to the empty slot.)

## Files
- `Travel HQ Prototype.dc.html` — interactive Home/Today + Import (hifi; logic at bottom of file)
- `Travel HQ Design Explorations.dc.html` — canvas with 1a–1g, 2a–2b exploration screens
- `nocturne-tokens.css` — full design-token sheet + component classes (source of truth for values)

## Suggested implementation order
1. Merge tokens into `src/styles.css`; swap icon lib; delete business-spend remnants (list in `docs/HANDOFF.md`).
2. Add router; split `main.tsx` → `pages/Home`, `pages/Import`, shell nav component.
3. Build Home/Today against mock data shaped like the agreed schema.
4. Import screen with manual-entry backend (parser stub returning low-confidence drafts).
5. Then: trip detail (1b) and the chosen day view — pending the 1c-vs-1d decision.

Per repo process notes: commit the design spec to `docs/superpowers/specs/2026-07-19-travel-hq-family-redesign-design.md` before the implementation plan.
