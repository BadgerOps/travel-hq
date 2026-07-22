# Travel HQ Data Entry and Import Implementation Plan — Part A

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every screen writable — add and edit people, create trips, add bookings, attach travellers — and then ingest forwarded confirmation emails into a reviewable draft queue.

**Architecture:** Part A closes the write path through the UI: two small server additions (person update, booking status), the API client's write methods, then the People card grid, the trip form, the add-booking dialog (exploration 1g), and the two panels plans 2 and 3 deferred here. Part B adds inbound email: a Cloudflare Worker shim, an Access **service token** auth path deliberately separate from the human one, and a swappable extraction chain — `.ics` first, a **local** OpenAI-compatible model second, Claude only as a manual per-message escalation — feeding a draft-approval queue.

**Tech Stack:** Node 22, Hono, SQLite (`node:sqlite`), Zod 4, React 19, TypeScript 5.7 (strict + `noUncheckedIndexedAccess` + `verbatimModuleSyntax`), Vite 6, `wouter`, `@phosphor-icons/react`, Vitest + Testing Library.

## This plan is split across two files

It is too large for one document. Task numbering is continuous and no dependency points backwards across the split.

| File | Tasks | Covers |
| --- | --- | --- |
| **`2026-07-21-data-entry-and-import.md`** (this file) | **1–8** | Manual data entry: person update endpoint, booking status endpoint, API client writes, shared people components, People page, trip form, add-booking dialog, Home "Next best actions" |
| **`2026-07-21-data-entry-and-import-part-b.md`** | **9–15** | Inbound email: service-token auth and the `machine` role, the `inbound_email` table, the extractor interface, `.ics` + local-LLM extraction, the ingest route, the `/import` draft queue, the Worker |

Execute Part A first, in order. Part B Task 14 (the `/import` page) consumes Task 3's API client and Task 7's `TravelerToggles`; nothing in Part A consumes anything from Part B.

## Blocked on an unresolved decision — read before planning your week

**The Cloudflare zone/hostname is open question 4 in `docs/HANDOFF.md`.** The spec assumes `badgerops.foo`; nobody has confirmed it. Therefore:

- **Every hostname, email address, and Access AUD in this plan is read from configuration.** Nothing hardcodes a guess. The forward address the UI displays comes from `TRAVEL_HQ_INBOUND_ADDRESS`, read by the **server** at boot and served to the UI from `GET /api/inbound-email/address` (Part B Task 13); the Worker's target origin comes from its own `APP_ORIGIN` var. **There is deliberately no `VITE_INBOUND_ADDRESS`** — the forward address is deployment configuration, not build configuration, and a Vite build-time variable cannot see a value the systemd unit sets at runtime. See Part B Task 13 for the reasoning.
- **Part B Task 15 (Cloudflare Worker + Email Routing) is BLOCKED** on that decision, and is the only blocked task. It is deliberately last.
- **Tasks 1–14 are executable today.** The ingest route and the extractors are tested against raw MIME fixtures over an in-process `app.fetch`, with no Cloudflare involvement at all.

If you reach Task 15 and the hostname is still undecided, stop and ask. Do not guess a zone.

## Global Constraints

Carried forward from plans 1–3 and from the *implemented* code. Every task's requirements implicitly include this section.

- **The implemented backend is the contract, not this document's description of it.** Before writing any server code read `src/server/repos/base.ts`, `src/server/routes/errors.ts`, `src/server/index.ts`, `src/server/auth.ts`, and `src/server/routes/trips.ts`. Where this plan and the code disagree, the code wins — report the discrepancy rather than coding to the plan.
- **All domain access goes through a repository bound to a household.** Queries carry exactly one `{scope}` token, outside comments and string literals. `db` is private to `TenantRepo`; bypassing scope needs `unscoped(reason, …)` / `unscopedRun(reason, …)` with a human-readable reason. **`tests/server/architecture.test.ts` fails the build if a raw `.prepare(` call — or the SQLite statement-runner method, the one spelled e-x-e-c — appears outside `repos/`, `db/`, and `auth.ts`.** Part B adds `src/server/ingest/`, which is *not* on that allowlist and must never touch SQL.
- **Error classes map to status in exactly one place** (`mapError` + `app.onError`):

  | Condition | Throw | Status |
  | --- | --- | --- |
  | Row absent, or present in another household | `NotFoundError` | 404 |
  | Viewer (or machine — Part B Task 9) attempting a write or a reveal | `ForbiddenError` | 403 |
  | Caller passed malformed input a route's Zod schema didn't catch | `ValidationError` | 400 |
  | Missing or invalid credential | `AuthError` | 401 |
  | Authenticated but not a member of the requested household | `HouseholdAccessError` | 403 |
  | **A bug in the repository itself** (missing `{scope}`, bad identifier) | `TenantScopeError` | **500, body `{"error":"Internal error"}`** |

  A cross-household id supplied by a client is an ordinary `NotFoundError`, never a `TenantScopeError`. Routes early-return 400 for exactly two things — a `c.req.json()` parse failure and a Zod `safeParse` failure — and let everything else reach `app.onError`. No local `try`/`catch` around repo calls.
- **IDs are UUIDv7** via `newId()` from `src/server/ids.ts`.
- **Timestamps are UTC ISO-8601 and are always paired with an IANA timezone column, and both are validated.** An unparseable timestamp or an unrecognised zone bricks `ItineraryRepo`'s day view permanently, for every future read of that trip. `BookingRepo.create` already enforces this via `assertTimezonePaired`; anything new that produces a booking — the dialog in Task 7, the extractors in Part B — must produce values that survive it, and must be tested against a bad one.
- **Encrypted values are never returned plaintext from a list endpoint.** Reveal is a separate, logged, single-record request, denied to `viewer`. **A create/edit form must never round-trip a masked value back as if it were plaintext.** Task 1 is the enforcement; Task 5 is the UI built so it never needs to.
- **Any new table carries `household_id`** unless it is a pure join table scoped through its parent.
- **Client tests live in `tests/client/**` under `vitest.client.config.ts`** (jsdom, `globals: true`, `setupFiles: ["./tests/client/setup.ts"]`); **server tests are `tests/**/*.test.ts` under the root `vitest.config.ts`, which excludes `tests/client/**`.** `npm test` runs the server suite, `npm run test:client` the client suite, `npm run test:all` both.
- **Development is opted into with `TRAVEL_HQ_ENV=development`.** Unset means production. Never reintroduce a `NODE_ENV`-based check — it fails open under systemd, where the variable is simply absent.
- **`docs/design/` is the source of truth for visual values.** Exploration 1g is the add-booking form; the Import screen in `Travel HQ Prototype.dc.html` is high-fidelity. When this plan and the bundle disagree on a number, the bundle wins; on architecture, the spec wins.
- **Primary buttons are accent-outlined, never filled. Headings are weight 500. Rules use `.hr`.** Fluid layouts only; verify at 390px.
- **Every fetching `useEffect` gets a `catch` and a rendered error state.** "Nothing here" and "we could not find out" must never render identically. Every component that fetches also gets a test that drives a rejection.
- **TDD throughout.** Every task writes its test first, observes RED, then implements. Tests assert specific error classes — a bare `.toThrow()` passes just as happily on the `TenantScopeError` that would have been a 500.
- Every task ends with a commit.

---

## Decisions this plan records

Two open questions are resolved here. Both are stated once and are not re-litigated later.

**1. The People page is a card grid matching the trip-card visual language.** One `.card` per family member in a `repeat(auto-fit, minmax(300px, 1fr))` grid — the same fluid grid shape the Home trips grid uses. Each card carries the person chip, the display name, masked document numbers with tap-to-reveal, and a passport-expiry warning row. `docs/design/` never covered this page (it is open question 2 in `docs/HANDOFF.md`), and **this is the resolution**: the card is the established idiom in this app, the People page is a small set of peer entities exactly like trips, and inventing a second idiom for four rows would be gratuitous. The empty state is a single card spanning the grid with an "Add the first family member" primary button, because a fresh instance has no people and nothing else in the app works until the family is entered.

**2. People components are shared with plan 3's Travelers tab, not reimplemented.** Plan 3's `TravelersTab` already renders exactly this content — chip, name, masked passport, expiry warning — inside trip detail. Task 4 extracts it into `src/client/components/PersonCard.tsx` plus `src/client/lib/passport.ts`, rewrites `TravelersTab` on top of them, and Task 5's People page uses the same `PersonCard`. There must be exactly one component that knows how to render a person's documents and exactly one function that decides whether a passport is a problem. Duplicating the expiry rule is precisely how the People page and the Travelers tab end up disagreeing about whether Finn's passport is fine.

## Affordances that stop being inert here

Plan 3 removed three controls under its "render the state, not the unavailable action" policy, on the explicit understanding that plan 4 would wire them for real. **This is that moment.** Task 7 adds them connected to real endpoints:

- **`Add booking` in the trip-detail header** (design 1b) — opens the booking dialog, which POSTs to `/api/trips/:tripId/bookings`.
- **`Book →` on a provisional booking row** (design 1b) — calls the booking-status endpoint from Task 2 and flips the row from `planned`/`draft` to `booked`.
- **The header edit (pencil) button** (design 1b) — **deliberately still not built.** There is no trip-update endpoint and this plan does not add one, so building the button would ship a second inert control under the exact policy that removed the first. Recorded under "Not in this plan" rather than shipped broken.

Plan 3 also flagged the expiring-passport warning row for promotion out of the Travelers tab; Task 4 promotes it to a trip-level banner.

---

## File Structure — Part A

```
src/server/
  repos/
    person.ts           ← MODIFIED: update(), UpdatePersonInput, mask-glyph guard
    booking.ts          ← MODIFIED: setStatus(), BOOKING_STATUSES
  routes/
    people.ts           ← MODIFIED: PUT /api/people/:id
    bookings.ts         ← NEW: PUT /api/bookings/:bookingId/status
  index.ts              ← MODIFIED: mount /api/bookings
src/client/
  api/
    types.ts            ← MODIFIED: re-export the input types
    client.ts           ← MODIFIED: the write methods
  lib/
    passport.ts         ← NEW: the one passport-validity rule
  components/
    Dialog.tsx          ← NEW: modal shell (backdrop, Escape, labelled)
    PersonCard.tsx      ← NEW: shared by People and TravelersTab
    PersonForm.tsx      ← NEW: create/edit person dialog
    TravelerToggles.tsx ← NEW: "who's on it" chips, three callers
  trip/
    TravelersTab.tsx    ← MODIFIED: rewritten on PersonCard
    TripWarnings.tsx    ← NEW: trip-level expiring-passport banner
    BookingDialog.tsx   ← NEW: exploration 1g
    OverviewTab.tsx     ← MODIFIED: Book → wired
  pages/
    People.tsx          ← REPLACED: the card grid
    Trips.tsx           ← REPLACED: list + create
    TripDetail.tsx      ← MODIFIED: Add booking, warnings banner, reload
    Home.tsx            ← MODIFIED: Next best actions
  home/
    NextBestActions.tsx ← NEW
```

`Dialog.tsx` exists once rather than three times because the person form, the trip form, and the booking dialog are the same modal with different contents, and a modal that closes on Escape and is announced correctly is not worth writing three times and getting right once.

---

### Task 1: Person update, and the masked-value trap

**Files:**
- Modify: `src/server/crypto/envelope.ts`
- Modify: `src/server/repos/person.ts`
- Modify: `src/server/repos/booking.ts`
- Modify: `src/server/routes/people.ts`
- Test: `tests/server/repos/person-update.test.ts`
- Test: `tests/server/routes/people-update.test.ts`

**Interfaces:**
- Consumes: `TenantRepo`, `NotFoundError`, `ForbiddenError`, `ValidationError` from `src/server/repos/base.js`; `Keyring` from `src/server/crypto/envelope.js`
- Produces:
  - `MASK_GLYPH` and `assertNotMasked(field, value)` exported from `src/server/crypto/envelope.ts`
  - `type UpdatePersonInput` — every field optional; document fields are tri-state
  - `PersonRepo.update(id: string, input: UpdatePersonInput): Person`
  - `BookingRepo.create` guards `confirmationNumber` with the same check
  - `PUT /api/people/:id` → `200` with the updated `Person`

**This is the single most dangerous bug available in this plan. Read this before writing a line.**

`PersonRepo.list()` and `findById()` return `passportNumberMasked: "••••2119"` — never plaintext. A naive edit form loads the person, puts every returned field in an input, and PUTs the whole object back. The passport input then contains `••••2119`, the server encrypts that string, and **a real passport number is destroyed on the first edit**, silently, with a 200 response and a UI that looks correct. There is no undo and no plaintext copy anywhere.

Three layers stop it, and all three are required:

1. **The input type is tri-state.** For each document field: `undefined` (absent) means *leave unchanged*, `null` means *clear it*, and a string means *set it to this new plaintext*. `update()` builds its `SET` list from only the keys that are present and not `undefined`, so a form that omits a field cannot touch it. This is the actual mechanism; the other two are defence in depth.
2. **The repository rejects anything containing the mask glyph.** `mask()` in `src/server/crypto/envelope.ts` builds its output from `"•"` (U+2022), a character that appears in no real passport, KTN, or redress number. A document value containing it is, by construction, a masked value being round-tripped — a `ValidationError` (400), never a write.
3. **The form never has the value to send** (Task 5). Document inputs in edit mode start empty with the placeholder "unchanged", and the component only includes a key in the request body when the operator typed into that input or pressed its Clear button.

Layer 2 is the one that turns this from "we were careful" into "it cannot happen": it fires even if a future component, a script, or Part B's import path reconstructs the request body wrongly.

**Layer 2 lives in `crypto/envelope.ts`, not in `person.ts`, and `BookingRepo.create` calls it too.** `person` is not the only table with a masked round-trip available: `toBooking()` masks `confirmationNumber` with the identical `mask()` helper, so the moment any component reconstructs a booking body from what a list endpoint showed it — Part B Task 14's `DraftCard` is exactly such a component — the same silent destruction is available on a confirmation number. Putting the guard beside `mask()` means the function that *creates* the glyph and the function that *rejects* it sit in one file and cannot drift, and gives every future encrypted column one obvious thing to call.

- [ ] **Step 1: Write the failing repository test**

Create `tests/server/repos/person-update.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { createTestDatabase } from "../../../src/server/db/migrate.js";
import { Keyring } from "../../../src/server/crypto/envelope.js";
import { PersonRepo } from "../../../src/server/repos/person.js";
// Step 5 adds two cases for BookingRepo's matching mask-glyph guard; the
// imports are here from the start so that step edits one block, not three.
import { BookingRepo } from "../../../src/server/repos/booking.js";
import { TripRepo } from "../../../src/server/repos/trip.js";
import {
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from "../../../src/server/repos/base.js";
import type { HouseholdContext } from "../../../src/server/repos/base.js";

const ring = new Keyring("server-v1", { "server-v1": randomBytes(32) });
const ctx: HouseholdContext = { householdId: "hh-a", userId: "u1", role: "owner" };

let db: DatabaseSync;
let repo: PersonRepo;
let personId: string;

beforeEach(() => {
  db = createTestDatabase();
  const now = new Date().toISOString();
  for (const id of ["hh-a", "hh-b"]) {
    db.prepare("INSERT INTO household (id, name, created_at) VALUES (?, ?, ?)").run(id, id, now);
  }
  repo = new PersonRepo(db, ctx, ring);
  personId = repo.create({
    displayName: "Ava",
    passportNumber: "C03X72119",
    knownTravelerNumber: "TT1234567",
    passportExpiry: "2027-01-15",
  }).id;
});

describe("PersonRepo.update", () => {
  it("updates a plain field", () => {
    expect(repo.update(personId, { displayName: "Ava Wright" }).displayName).toBe("Ava Wright");
  });

  it("leaves an omitted document field completely unchanged", () => {
    // The whole point. An edit that touches only the name must not disturb
    // the passport number -- not re-encrypt it, not clear it, not replace it
    // with the masked form the caller was shown.
    repo.update(personId, { displayName: "Ava Wright" });
    expect(repo.revealDocument(personId, "passport_number")).toBe("C03X72119");
    expect(repo.findById(personId)?.passportNumberMasked).toBe("••••2119");
  });

  it("clears a document field when the value is explicitly null", () => {
    repo.update(personId, { knownTravelerNumber: null });
    expect(repo.revealDocument(personId, "known_traveler_number")).toBe(null);
    expect(repo.findById(personId)?.knownTravelerNumberMasked).toBe(null);
    // Clearing one document must not disturb its neighbours.
    expect(repo.revealDocument(personId, "passport_number")).toBe("C03X72119");
  });

  it("replaces a document field with new plaintext", () => {
    repo.update(personId, { passportNumber: "X99Z00042" });
    expect(repo.revealDocument(personId, "passport_number")).toBe("X99Z00042");
    expect(repo.findById(personId)?.passportNumberMasked).toBe("••••0042");
  });

  it("refuses a value containing the mask glyph rather than storing it", () => {
    // The disaster case: an edit form round-tripping what list() showed it.
    // ValidationError specifically -- a bare .toThrow() would also pass if
    // this failed as a TenantScopeError, which mapError() turns into a 500,
    // hiding an ordinary bad request behind a server fault.
    expect(() => repo.update(personId, { passportNumber: "••••2119" })).toThrow(ValidationError);
    // And the stored value is untouched.
    expect(repo.revealDocument(personId, "passport_number")).toBe("C03X72119");
  });

  it("refuses an empty display name", () => {
    expect(() => repo.update(personId, { displayName: "  " })).toThrow(ValidationError);
  });

  it("refuses an unknown person", () => {
    expect(() => repo.update("p-nope", { displayName: "Nope" })).toThrow(NotFoundError);
  });

  it("refuses a person in another household", () => {
    const other = new PersonRepo(db, { householdId: "hh-b", userId: "u2", role: "owner" }, ring);
    expect(() => other.update(personId, { displayName: "Stolen" })).toThrow(NotFoundError);
  });

  it("refuses writes from a viewer", () => {
    const viewer = new PersonRepo(db, { ...ctx, role: "viewer" }, ring);
    expect(() => viewer.update(personId, { displayName: "Nope" })).toThrow(ForbiddenError);
  });

  it("is a no-op for an empty input rather than writing an empty SET clause", () => {
    // `UPDATE person SET  WHERE ...` is a syntax error. An edit form that
    // submits with nothing changed must get the person back, not a 500.
    expect(repo.update(personId, {}).displayName).toBe("Ava");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -- repos/person-update`
Expected: FAIL — `repo.update is not a function`.

- [ ] **Step 3: Lift the mask-glyph guard into `crypto/envelope.ts`**

Append to `src/server/crypto/envelope.ts`, immediately below `mask()`:

```ts
/**
 * The character `mask()` composes its output from: U+2022 BULLET. It appears
 * in no real passport, Known Traveler, redress, or confirmation number.
 */
export const MASK_GLYPH = "•";

/**
 * Refuses a value that is plainly a masked display string being handed back
 * as if it were plaintext. Encrypting `••••2119` over a real passport number
 * destroys it silently, with a 200 response and a UI that looks correct;
 * there is no undo and no plaintext copy anywhere.
 *
 * This lives beside `mask()` rather than in one repository because `person`
 * is not the only table at risk: `BookingRepo`'s `toBooking()` masks
 * `confirmationNumber` with the same helper, so the same round-trip bug is
 * available there the moment a component reconstructs a booking body from a
 * list response. One glyph, one guard, one file — they cannot drift apart.
 *
 * It throws a plain `Error`; the repository layer is what turns it into a
 * `ValidationError` (400), because `crypto/` sits below the repo layer and
 * must not import from it.
 */
export function assertNotMasked(field: string, value: string): void {
  if (value.includes(MASK_GLYPH)) {
    throw new Error(
      `${field} looks like a masked placeholder rather than a real value. ` +
        `Omit the field to leave it unchanged, or send null to clear it.`,
    );
  }
}
```

- [ ] **Step 4: Add the update path to PersonRepo**

In `src/server/repos/person.ts`, extend the error import on line 2:

```ts
import { TenantRepo, TenantScopeError, NotFoundError, ValidationError } from "./base.js";
```

and the crypto import:

```ts
import { assertNotMasked } from "../crypto/envelope.js";
```

Add, after the existing `CreatePersonInput` type:

```ts
/**
 * Every field is optional, and the document fields are deliberately
 * TRI-STATE:
 *
 *   absent / undefined -> leave the stored value exactly as it is
 *   null               -> clear the stored value
 *   string             -> encrypt this NEW plaintext and store it
 *
 * The middle and last cases are the only ways to touch an encrypted column.
 * An edit form that renders `passportNumberMasked` into an input and PUTs the
 * whole object back would otherwise overwrite a real passport number with
 * `••••2119`; see `rejectMasked` below for the second line of defence.
 */
export type UpdatePersonInput = {
  displayName?: string;
  dob?: string | null;
  notes?: string | null;
  passportExpiry?: string | null;
  passportCountry?: string | null;
  passportNumber?: string | null;
  knownTravelerNumber?: string | null;
  redressNumber?: string | null;
};

/**
 * Input key -> column, for the plaintext columns. The column names come from
 * this fixed map and never from caller-supplied keys, so no request body can
 * reach `insert()`/`run()` with an identifier of its own choosing.
 */
const PLAIN_COLUMNS = {
  displayName: "display_name",
  dob: "dob",
  notes: "notes",
  passportExpiry: "passport_expiry",
  passportCountry: "passport_country",
} as const;

const ENCRYPTED_COLUMNS = {
  passportNumber: "passport_number",
  knownTravelerNumber: "known_traveler_number",
  redressNumber: "redress_number",
} as const;

/**
 * Adapts `crypto/envelope.ts`'s `assertNotMasked` — which throws a plain
 * `Error` because it sits below the repository layer and must not import
 * from it — into this layer's vocabulary.
 *
 * ValidationError (400), not TenantScopeError (500): a masked value arriving
 * as plaintext is a bad request, even though the only way to produce one is a
 * bug in a caller.
 */
function rejectMasked(field: string, value: string): void {
  try {
    assertNotMasked(field, value);
  } catch (err) {
    throw new ValidationError(err instanceof Error ? err.message : String(err));
  }
}
```

Then add the method to `PersonRepo`, after `create()`:

```ts
  update(id: string, input: UpdatePersonInput): Person {
    this.requireWrite();

    // NotFoundError, not TenantScopeError: an id that isn't in this household
    // is an ordinary bad id, exactly as TripRepo.addTraveler treats it.
    const existing = this.get<{ id: string }>(
      "SELECT id FROM person WHERE {scope} AND id = ?",
      id,
    );
    if (!existing) throw new NotFoundError("Person not found in this household");

    const sets: string[] = [];
    const params: unknown[] = [];

    for (const [key, column] of Object.entries(PLAIN_COLUMNS)) {
      const value = input[key as keyof typeof PLAIN_COLUMNS];
      // `undefined` is "not supplied", which is the tri-state's whole point.
      // Reaching for `key in input` instead would treat an explicitly-passed
      // `undefined` as a request to write NULL.
      if (value === undefined) continue;
      if (key === "displayName" && (typeof value !== "string" || value.trim() === "")) {
        throw new ValidationError("displayName must be a non-empty string");
      }
      sets.push(`${column} = ?`);
      params.push(value ?? null);
    }

    for (const [key, column] of Object.entries(ENCRYPTED_COLUMNS)) {
      const value = input[key as keyof typeof ENCRYPTED_COLUMNS];
      if (value === undefined) continue;
      if (value === null) {
        sets.push(`${column} = ?`);
        params.push(null);
        continue;
      }
      rejectMasked(key, value);
      sets.push(`${column} = ?`);
      params.push(this.ring.encrypt(value));
    }

    if (sets.length > 0) {
      // The `?` placeholders precede the `{scope}` token. That is safe because
      // TenantRepo binds the household id as a NAMED parameter
      // (:__scope_household), so it does not consume a positional slot -- see
      // the class docstring in repos/base.ts.
      this.run(
        `UPDATE person SET ${sets.join(", ")} WHERE {scope} AND id = ?`,
        ...params,
        id,
      );
    }

    const updated = this.findById(id);
    if (!updated) throw new Error("Person disappeared immediately after update");
    return updated;
  }
```

`this.ring` is `private readonly` on `PersonRepo` and this method is on the same class, so it is in scope.

- [ ] **Step 5: Guard `BookingRepo.create`'s confirmation number the same way**

In `src/server/repos/booking.ts`, add the import:

```ts
import { assertNotMasked } from "../crypto/envelope.js";
```

and, inside `create()`, immediately before the value is encrypted:

```ts
    if (input.confirmationNumber !== undefined && input.confirmationNumber !== null) {
      // `toBooking()` masks this column with the same `mask()` helper that
      // masks a passport number, so the identical round-trip destruction is
      // available here: a component that reconstructs a booking body from a
      // list response (Part B Task 14's DraftCard is exactly that) would
      // encrypt `••••WN88` over the real code. ValidationError (400), for the
      // same reason as PersonRepo.update.
      try {
        assertNotMasked("confirmationNumber", input.confirmationNumber);
      } catch (err) {
        throw new ValidationError(err instanceof Error ? err.message : String(err));
      }
    }
```

Add `ValidationError` to the existing `./base.js` import if it is not already there.

Append two cases to `tests/server/repos/person-update.test.ts`'s sibling — a new `describe` block in `tests/server/routes/booking-status.test.ts` is the wrong home, so add them to the repository test file created in Step 1, importing `BookingRepo`:

```ts
describe("BookingRepo.create rejects a masked confirmation number", () => {
  it("refuses a value containing the mask glyph", () => {
    const bookings = new BookingRepo(db, ctx, ring);
    const trip = new TripRepo(db, ctx).create({ title: "Guerneville" });
    expect(() =>
      bookings.create({
        tripId: trip.id,
        kind: "lodging",
        title: "Dawn Ranch Lodge",
        confirmationNumber: "••••WN88",
        details: { propertyName: "Dawn Ranch Lodge" },
      }),
    ).toThrow(ValidationError);
  });

  it("accepts an ordinary confirmation number", () => {
    const bookings = new BookingRepo(db, ctx, ring);
    const trip = new TripRepo(db, ctx).create({ title: "Guerneville" });
    expect(
      bookings.create({
        tripId: trip.id,
        kind: "lodging",
        title: "Dawn Ranch Lodge",
        confirmationNumber: "D7WN88",
        details: { propertyName: "Dawn Ranch Lodge" },
      }).confirmationNumberMasked,
    ).toBe("••••WN88");
  });
});
```

- [ ] **Step 6: Run the repository test**

Run: `npm test -- repos/person-update`
Expected: PASS, 12 tests — 10 for `PersonRepo.update`, 2 for the booking guard.

- [ ] **Step 7: Write the failing route test**

Create `tests/server/routes/people-update.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { createTestDatabase } from "../../../src/server/db/migrate.js";
import { Keyring } from "../../../src/server/crypto/envelope.js";
import { createApp } from "../../../src/server/index.js";
import type { Identity } from "../../../src/server/auth.js";

const ring = new Keyring("server-v1", { "server-v1": randomBytes(32) });
const owner: Identity = {
  userId: "u1",
  email: "badger@example.com",
  householdId: "hh-a",
  role: "owner",
};

let db: DatabaseSync;
let app: ReturnType<typeof createApp>;

function jsonRequest(path: string, method: string, body: unknown) {
  return app.request(path, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function createAva(): Promise<string> {
  const res = await jsonRequest("/api/people", "POST", {
    displayName: "Ava",
    passportNumber: "C03X72119",
  });
  return ((await res.json()) as { id: string }).id;
}

beforeEach(() => {
  db = createTestDatabase();
  db.prepare("INSERT INTO household (id, name, created_at) VALUES (?, ?, ?)").run(
    "hh-a",
    "Badger",
    new Date().toISOString(),
  );
  app = createApp({ db, ring, verify: async () => owner });
});

describe("PUT /api/people/:id", () => {
  it("updates a name and returns the masked person", async () => {
    const id = await createAva();
    const res = await jsonRequest(`/api/people/${id}`, "PUT", { displayName: "Ava Wright" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { displayName: string; passportNumberMasked: string };
    expect(body.displayName).toBe("Ava Wright");
    expect(body.passportNumberMasked).toBe("••••2119");
  });

  it("does not disturb the passport when the field is omitted", async () => {
    const id = await createAva();
    await jsonRequest(`/api/people/${id}`, "PUT", { displayName: "Ava Wright" });
    const revealed = (await (
      await app.request(`/api/people/${id}/reveal/passport_number`)
    ).json()) as { value: string };
    expect(revealed.value).toBe("C03X72119");
  });

  it("answers 400 for a masked passport value and leaves the stored one intact", async () => {
    const id = await createAva();
    const res = await jsonRequest(`/api/people/${id}`, "PUT", { passportNumber: "••••2119" });
    expect(res.status).toBe(400);
    const revealed = (await (
      await app.request(`/api/people/${id}/reveal/passport_number`)
    ).json()) as { value: string };
    expect(revealed.value).toBe("C03X72119");
  });

  it("clears a document field on an explicit null", async () => {
    const id = await createAva();
    const res = await jsonRequest(`/api/people/${id}`, "PUT", { passportNumber: null });
    expect(res.status).toBe(200);
    expect((await res.json()).passportNumberMasked).toBe(null);
  });

  it("answers 404 for an unknown person", async () => {
    expect((await jsonRequest("/api/people/p-nope", "PUT", { displayName: "X" })).status).toBe(404);
  });

  it("answers 400 for malformed JSON", async () => {
    const id = await createAva();
    const res = await app.request(`/api/people/${id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    expect(res.status).toBe(400);
  });

  it("answers 400 for an empty display name", async () => {
    const id = await createAva();
    expect((await jsonRequest(`/api/people/${id}`, "PUT", { displayName: "" })).status).toBe(400);
  });

  it("answers 403 for a viewer", async () => {
    const id = await createAva();
    const viewerApp = createApp({
      db,
      ring,
      verify: async () => ({ ...owner, role: "viewer" as const }),
    });
    const res = await viewerApp.request(`/api/people/${id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ displayName: "Nope" }),
    });
    expect(res.status).toBe(403);
  });
});
```

- [ ] **Step 8: Run it to verify it fails**

Run: `npm test -- routes/people-update`
Expected: FAIL — every case returns 404, because Hono has no `PUT /api/people/:id` route registered.

- [ ] **Step 9: Add the route**

In `src/server/routes/people.ts`, extend the repo import:

```ts
import { PersonRepo, DOCUMENT_FIELDS } from "../repos/person.js";
import type { DocumentField, UpdatePersonInput } from "../repos/person.js";
```

Add the schema below `createPersonSchema`:

```ts
/**
 * `.nullable().optional()` is the tri-state at the HTTP boundary: the key may
 * be absent (leave unchanged), null (clear), or a string (replace). Zod's
 * `safeParse` on an object schema drops nothing and adds nothing, so an
 * absent key stays absent in `parsed.data` and PersonRepo.update() sees
 * `undefined` -- which is exactly what it treats as "do not touch".
 *
 * `.strict()` matters here in a way it does not on the create schema: an edit
 * form that PUTs back the whole object it was shown would otherwise send
 * `passportNumberMasked`, which a permissive schema would silently drop,
 * leaving the operator believing they had edited a field they had not. A 400
 * naming the unknown key is the honest answer.
 */
const updatePersonSchema = z
  .object({
    displayName: z.string().min(1).optional(),
    dob: z.string().nullable().optional(),
    notes: z.string().nullable().optional(),
    passportExpiry: z.string().nullable().optional(),
    passportCountry: z.string().nullable().optional(),
    passportNumber: z.string().min(1).nullable().optional(),
    knownTravelerNumber: z.string().min(1).nullable().optional(),
    redressNumber: z.string().min(1).nullable().optional(),
  })
  .strict();
```

Add the route, after `people.post("/")` and before the reveal route (so `/:id` never shadows `/:id/reveal/:field` — Hono matches on the full path, but keeping the more specific route last is the convention the rest of this file follows):

```ts
people.put("/:id", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const parsed = updatePersonSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Invalid person", details: parsed.error.issues }, 400);
  }
  const repo = new PersonRepo(c.get("db"), c.get("identity"), c.get("ring"));
  // NotFoundError (404), ForbiddenError (403), and the masked-value
  // ValidationError (400) all reach app.onError, which is the single place
  // that decides status. No local try/catch.
  return c.json(repo.update(c.req.param("id"), parsed.data satisfies UpdatePersonInput));
});
```

- [ ] **Step 10: Run the route test**

Run: `npm test -- routes/people-update`
Expected: PASS, 8 tests.

- [ ] **Step 11: Run the whole server suite**

Run: `npm test`
Expected: all PASS. Nothing existing changes behaviour — `PersonRepo.create()`/`list()` are untouched, and `BookingRepo.create` gains a guard that only fires on input no honest caller produces.

- [ ] **Step 12: Commit**

```bash
git add src/server/crypto/envelope.ts src/server/repos/person.ts src/server/repos/booking.ts src/server/routes/people.ts tests/server/repos/person-update.test.ts tests/server/routes/people-update.test.ts
git commit -m "feat: add person update with tri-state document fields and a shared masked-value guard"
```

---

### Task 2: Booking status endpoint

**Files:**
- Modify: `src/server/repos/booking.ts`
- Create: `src/server/routes/bookings.ts`
- Modify: `src/server/index.ts`
- Test: `tests/server/routes/booking-status.test.ts`

**Interfaces:**
- Consumes: `BookingRepo`, `NotFoundError`, `ForbiddenError`
- Produces:
  - `const BOOKING_STATUSES = ["draft", "planned", "booked", "cancelled"] as const`
  - `BookingRepo.setStatus(bookingId: string, status: BookingStatus): void`
  - `PUT /api/bookings/:bookingId/status` with body `{ "status": "booked" }` → `204`

Two callers need this and neither can be built without it: `Book →` on a provisional row (Task 7) and draft approval (Part B Task 14). It is one column, so it gets one narrow endpoint rather than a general booking-update endpoint — a full `PATCH /api/bookings/:id` would have to re-run `assertTimezonePaired`, re-validate per-kind `details`, and decide what a partial `details` object means, none of which anything in this plan needs.

**Why a new route file.** `PUT /api/bookings/:bookingId/people/:personId` already exists, but it lives in `src/server/routes/itinerary.ts` (mounted at `/api`), which is a poor home for it. Moving it would churn plan 3's passing tests for no behavioural gain, so it stays; the new `/api/bookings` router is mounted alongside and Hono routes both correctly because the paths differ.

- [ ] **Step 1: Write the failing test**

Create `tests/server/routes/booking-status.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { createTestDatabase } from "../../../src/server/db/migrate.js";
import { Keyring } from "../../../src/server/crypto/envelope.js";
import { createApp } from "../../../src/server/index.js";
import type { Identity } from "../../../src/server/auth.js";

const ring = new Keyring("server-v1", { "server-v1": randomBytes(32) });
const owner: Identity = {
  userId: "u1",
  email: "badger@example.com",
  householdId: "hh-a",
  role: "owner",
};

let db: DatabaseSync;
let app: ReturnType<typeof createApp>;

function jsonRequest(path: string, method: string, body: unknown) {
  return app.request(path, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function makeBooking(status: string): Promise<{ tripId: string; bookingId: string }> {
  const trip = (await (
    await jsonRequest("/api/trips", "POST", { title: "Guerneville" })
  ).json()) as { id: string };
  const booking = (await (
    await jsonRequest(`/api/trips/${trip.id}/bookings`, "POST", {
      kind: "lodging",
      title: "Dawn Ranch Lodge",
      status,
      details: { propertyName: "Dawn Ranch Lodge" },
    })
  ).json()) as { id: string };
  return { tripId: trip.id, bookingId: booking.id };
}

beforeEach(() => {
  db = createTestDatabase();
  db.prepare("INSERT INTO household (id, name, created_at) VALUES (?, ?, ?)").run(
    "hh-a",
    "Badger",
    new Date().toISOString(),
  );
  app = createApp({ db, ring, verify: async () => owner });
});

describe("PUT /api/bookings/:bookingId/status", () => {
  it("promotes a planned booking to booked", async () => {
    const { tripId, bookingId } = await makeBooking("planned");
    const res = await jsonRequest(`/api/bookings/${bookingId}/status`, "PUT", {
      status: "booked",
    });
    expect(res.status).toBe(204);

    const bookings = (await (await app.request(`/api/trips/${tripId}/bookings`)).json()) as {
      id: string;
      status: string;
    }[];
    expect(bookings.find((b) => b.id === bookingId)?.status).toBe("booked");
  });

  it("promotes a draft booking out of draft", async () => {
    const { tripId, bookingId } = await makeBooking("draft");
    expect(
      (await jsonRequest(`/api/bookings/${bookingId}/status`, "PUT", { status: "planned" })).status,
    ).toBe(204);
    const bookings = (await (await app.request(`/api/trips/${tripId}/bookings`)).json()) as {
      status: string;
    }[];
    expect(bookings[0]?.status).toBe("planned");
  });

  it("answers 404 for an unknown booking", async () => {
    // Without an existence check the UPDATE matches zero rows and the route
    // answers 204 for an id that does not exist -- indistinguishable from
    // success, so a stale link silently "succeeds".
    const res = await jsonRequest("/api/bookings/b-nope/status", "PUT", { status: "booked" });
    expect(res.status).toBe(404);
  });

  it("answers 404 for another household's booking", async () => {
    const { bookingId } = await makeBooking("planned");
    db.prepare("INSERT INTO household (id, name, created_at) VALUES (?, ?, ?)").run(
      "hh-b",
      "Other",
      new Date().toISOString(),
    );
    const otherApp = createApp({
      db,
      ring,
      verify: async () => ({ ...owner, householdId: "hh-b" }),
    });
    const res = await otherApp.request(`/api/bookings/${bookingId}/status`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "booked" }),
    });
    expect(res.status).toBe(404);
  });

  it("answers 400 for a status outside the enum", async () => {
    const { bookingId } = await makeBooking("planned");
    const res = await jsonRequest(`/api/bookings/${bookingId}/status`, "PUT", {
      status: "confirmed",
    });
    expect(res.status).toBe(400);
  });

  it("answers 400 for malformed JSON", async () => {
    const { bookingId } = await makeBooking("planned");
    const res = await app.request(`/api/bookings/${bookingId}/status`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: "{",
    });
    expect(res.status).toBe(400);
  });

  it("answers 403 for a viewer", async () => {
    const { bookingId } = await makeBooking("planned");
    const viewerApp = createApp({
      db,
      ring,
      verify: async () => ({ ...owner, role: "viewer" as const }),
    });
    const res = await viewerApp.request(`/api/bookings/${bookingId}/status`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "booked" }),
    });
    expect(res.status).toBe(403);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -- routes/booking-status`
Expected: FAIL — every case returns 404; the route does not exist.

- [ ] **Step 3: Export the status list and add setStatus**

In `src/server/repos/booking.ts`, replace the `BookingStatus` type declaration on line 9:

```ts
/**
 * Exported as a value, not only a type: the status route's Zod enum and the
 * booking dialog's segmented control both need the list at runtime, and
 * writing it out a second time is how one of them ends up accepting a status
 * the CHECK constraint on `booking.status` rejects.
 */
export const BOOKING_STATUSES = ["draft", "planned", "booked", "cancelled"] as const;

export type BookingStatus = (typeof BOOKING_STATUSES)[number];
```

Add the method to `BookingRepo`, after `assignPerson()`:

```ts
  setStatus(bookingId: string, status: BookingStatus): void {
    // Redundant with base.ts's own requireWrite() inside run() -- kept as
    // explicit intent at the top of every mutating method, matching
    // create()/assignPerson().
    this.requireWrite();

    // Existence-checked before the UPDATE. Without this the UPDATE simply
    // matches zero rows and the route answers 204 for an id that does not
    // exist, or belongs to another household. Both must be 404.
    const booking = this.get<{ id: string }>(
      "SELECT id FROM booking WHERE {scope} AND id = ?",
      bookingId,
    );
    if (!booking) throw new NotFoundError("Booking not found in this household");

    this.run("UPDATE booking SET status = ? WHERE {scope} AND id = ?", status, bookingId);
  }
```

- [ ] **Step 4: Add the route file**

Create `src/server/routes/bookings.ts`:

```ts
import { Hono } from "hono";
import { z } from "zod";
import { BookingRepo, BOOKING_STATUSES } from "../repos/booking.js";
import type { AppEnv } from "../index.js";

const setStatusSchema = z.object({ status: z.enum(BOOKING_STATUSES) });

export const bookings = new Hono<AppEnv>();

bookings.put("/:bookingId/status", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const parsed = setStatusSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Invalid status", details: parsed.error.issues }, 400);
  }
  // Unknown/cross-household booking (NotFoundError, 404) and a viewer role
  // (ForbiddenError, 403) both reach app.onError.
  new BookingRepo(c.get("db"), c.get("identity"), c.get("ring")).setStatus(
    c.req.param("bookingId"),
    parsed.data.status,
  );
  return c.body(null, 204);
});
```

- [ ] **Step 5: Mount it**

In `src/server/index.ts`, add the import beside the other route imports:

```ts
import { bookings } from "./routes/bookings.js";
```

and the mount beside the others:

```ts
  app.route("/api/bookings", bookings);
```

The existing `app.route("/api", itinerary)` also serves a `/api/bookings/...` path; the two coexist because the paths below the prefix differ (`/:bookingId/status` versus `/bookings/:bookingId/people/:personId`).

- [ ] **Step 6: Run the tests**

Run: `npm test -- routes/booking-status`
Expected: PASS, 7 tests.

- [ ] **Step 7: Run the whole server suite and typecheck**

Run: `npm test && npm run typecheck`
Expected: all PASS, typecheck exits 0. `BookingStatus` is now derived from `BOOKING_STATUSES` rather than written out, which is structurally identical — nothing that consumed the type changes.

- [ ] **Step 8: Commit**

```bash
git add src/server/repos/booking.ts src/server/routes/bookings.ts src/server/index.ts tests/server/routes/booking-status.test.ts
git commit -m "feat: add booking status endpoint"
```

---

### Task 3: API client write methods

**Files:**
- Modify: `src/client/api/types.ts`
- Modify: `src/client/api/client.ts`
- Test: `tests/client/api/client-write.test.ts`

**Interfaces:**
- Consumes: `createApi` / `request` / `seg` from plan 2 Task 3
- Produces:
  - `api.people.create(input)`, `api.people.update(id, input)`
  - `api.trips.create(input)`, `api.trips.addTraveler(tripId, personId)`, `api.trips.createBooking(tripId, input)`
  - `api.bookings.assignPerson(bookingId, personId)`, `api.bookings.setStatus(bookingId, status)`

Every endpoint here already exists on the server. `POST /api/people`, `POST /api/trips`, `POST /api/trips/:tripId/bookings`, `PUT /api/trips/:tripId/people/:personId`, and `PUT /api/bookings/:bookingId/people/:personId` were verified present in `src/server/routes/` before this plan was written — note that the last of those lives in `src/server/routes/itinerary.ts`, not in `bookings.ts` or `trips.ts`, which is surprising but correct. `PUT /api/people/:id` and `PUT /api/bookings/:bookingId/status` come from Tasks 1 and 2.

**The shared `request()` helper sets no `content-type` and does no serialisation** — it spreads `init` over `{ credentials: "same-origin" }` and nothing else. Every write below therefore supplies `method`, `headers`, and `JSON.stringify` itself, exactly as plan 3's `checklist.create` does. Do not "fix" `request()` to add a default content-type: the two `PUT`s with no body must not claim to be sending JSON.

- [ ] **Step 1: Write the failing test**

Create `tests/client/api/client-write.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { createApi } from "../../../src/client/api/client.js";

function mockFetch(body: unknown, status = 200) {
  return vi.fn(async () =>
    new Response(status === 204 ? null : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  );
}

describe("api client writes", () => {
  it("creates a person", async () => {
    const fetchMock = mockFetch({ id: "p1", displayName: "Ava" });
    const api = createApi({ fetch: fetchMock, baseUrl: "" });
    expect(await api.people.create({ displayName: "Ava" })).toMatchObject({ id: "p1" });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/people",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ displayName: "Ava" }),
      }),
    );
  });

  it("updates a person without inventing keys it was not given", async () => {
    // The masked-value trap in reverse: the client must send exactly the keys
    // the caller supplied. A body that filled in `passportNumber: undefined`
    // is fine (JSON.stringify drops it); a body that filled in the masked
    // string would destroy a passport number.
    const fetchMock = mockFetch({ id: "p1", displayName: "Ava Wright" });
    const api = createApi({ fetch: fetchMock, baseUrl: "" });
    await api.people.update("p1", { displayName: "Ava Wright" });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/people/p1",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({ displayName: "Ava Wright" }),
      }),
    );
  });

  it("sends an explicit null through as a clear instruction", async () => {
    const fetchMock = mockFetch({ id: "p1" });
    const api = createApi({ fetch: fetchMock, baseUrl: "" });
    await api.people.update("p1", { passportNumber: null });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/people/p1",
      expect.objectContaining({ body: JSON.stringify({ passportNumber: null }) }),
    );
  });

  it("creates a trip", async () => {
    const fetchMock = mockFetch({ id: "t1", title: "Guerneville" });
    const api = createApi({ fetch: fetchMock, baseUrl: "" });
    expect(await api.trips.create({ title: "Guerneville" })).toMatchObject({ id: "t1" });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/trips",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("attaches a traveller to a trip and tolerates the 204", async () => {
    const fetchMock = mockFetch(null, 204);
    const api = createApi({ fetch: fetchMock, baseUrl: "" });
    await expect(api.trips.addTraveler("t1", "p1")).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/trips/t1/people/p1",
      expect.objectContaining({ method: "PUT" }),
    );
  });

  it("creates a booking on a trip", async () => {
    const fetchMock = mockFetch({ id: "b1" });
    const api = createApi({ fetch: fetchMock, baseUrl: "" });
    await api.trips.createBooking("t1", {
      kind: "lodging",
      title: "Dawn Ranch Lodge",
      details: { propertyName: "Dawn Ranch Lodge" },
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/trips/t1/bookings",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("assigns a person to a booking", async () => {
    const fetchMock = mockFetch(null, 204);
    const api = createApi({ fetch: fetchMock, baseUrl: "" });
    await api.bookings.assignPerson("b1", "p1");
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/bookings/b1/people/p1",
      expect.objectContaining({ method: "PUT" }),
    );
  });

  it("sets a booking status", async () => {
    const fetchMock = mockFetch(null, 204);
    const api = createApi({ fetch: fetchMock, baseUrl: "" });
    await api.bookings.setStatus("b1", "booked");
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/bookings/b1/status",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({ status: "booked" }),
      }),
    );
  });

  it("url-encodes ids in write paths", async () => {
    // Ids reach these methods from server data and, in the import flow, from
    // a form. An unencoded slash would reshape the request path.
    const fetchMock = mockFetch(null, 204);
    const api = createApi({ fetch: fetchMock, baseUrl: "" });
    await api.trips.addTraveler("a/../b", "p1");
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/trips/a%2F..%2Fb/people/p1",
      expect.anything(),
    );
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run test:client -- client-write`
Expected: FAIL — `api.people.create is not a function`.

- [ ] **Step 3: Re-export the input types**

In `src/client/api/types.ts`, append:

```ts
export type { CreatePersonInput, UpdatePersonInput } from "../../server/repos/person.js";
export type { CreateTripInput } from "../../server/repos/trip.js";
export type { CreateBookingInput } from "../../server/repos/booking.js";
```

These are type-only re-exports like every other line in the file, erased at build. Sharing the *input* types matters as much as sharing the output ones: `UpdatePersonInput`'s tri-state is expressed in the type, so a form that tries to assign a `string | undefined` where `string | null | undefined` is meant fails at typecheck rather than at runtime.

- [ ] **Step 4: Add a JSON body helper and the write methods**

In `src/client/api/client.ts`, extend the type import:

```ts
import type {
  Booking,
  BookingStatus,
  CreateBookingInput,
  CreatePersonInput,
  CreateTripInput,
  DocumentField,
  Identity,
  ItineraryDay,
  Person,
  Trip,
  UpdatePersonInput,
} from "./types.js";
```

Inside `createApi`, below `const seg = ...`, add:

```ts
  /**
   * Every write in this client sends the same three things. Writing them out
   * per method is how one of them ends up missing its content-type and being
   * parsed as an empty body by Hono.
   */
  const jsonBody = (method: "POST" | "PUT", body: unknown): RequestInit => ({
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
```

Add to the `people` object:

```ts
      create: (input: CreatePersonInput) =>
        request<Person>("/api/people", jsonBody("POST", input)),
      update: (id: string, input: UpdatePersonInput) =>
        request<Person>(`/api/people/${seg(id)}`, jsonBody("PUT", input)),
```

Add to the `trips` object:

```ts
      create: (input: CreateTripInput) => request<Trip>("/api/trips", jsonBody("POST", input)),
      addTraveler: (tripId: string, personId: string) =>
        // No body: the route reads both ids from the path and never calls
        // c.req.json(). Sending a content-type here would be a lie.
        request<void>(`/api/trips/${seg(tripId)}/people/${seg(personId)}`, { method: "PUT" }),
      createBooking: (tripId: string, input: Omit<CreateBookingInput, "tripId">) =>
        request<Booking>(`/api/trips/${seg(tripId)}/bookings`, jsonBody("POST", input)),
```

`Omit<CreateBookingInput, "tripId">` is deliberate: the trip id is already the first argument, and letting a caller pass a second, different one in the body is a bug waiting to happen — the server would use the path parameter and silently ignore the body's.

And add a new `bookings` object alongside `people`, `trips`, and `checklist`:

```ts
    bookings: {
      assignPerson: (bookingId: string, personId: string) =>
        request<void>(
          `/api/bookings/${seg(bookingId)}/people/${seg(personId)}`,
          { method: "PUT" },
        ),
      setStatus: (bookingId: string, status: BookingStatus) =>
        request<void>(`/api/bookings/${seg(bookingId)}/status`, jsonBody("PUT", { status })),
    },
```

- [ ] **Step 5: Run the tests**

Run: `npm run test:client -- client-write`
Expected: PASS, 9 tests.

- [ ] **Step 6: Run the whole client suite and typecheck**

Run: `npm run test:client && npm run typecheck`
Expected: all PASS, typecheck exits 0.

- [ ] **Step 7: Commit**

```bash
git add src/client/api tests/client/api/client-write.test.ts
git commit -m "feat: add write methods to the API client"
```

---

### Task 4: The one passport rule, PersonCard, and the trip warning banner

**Files:**
- Create: `src/client/lib/passport.ts`
- Create: `src/client/components/PersonCard.tsx`
- Create: `src/client/trip/TripWarnings.tsx`
- Modify: `src/client/trip/TravelersTab.tsx`
- Modify: `src/client/pages/TripDetail.tsx`
- Test: `tests/client/lib/passport.test.ts`
- Test: `tests/client/components/PersonCard.test.tsx`
- Test: `tests/client/trip/TripWarnings.test.tsx`

**Interfaces:**
- Consumes: `daysUntil` (plan 2 Task 4), `PersonChip`, `MaskedValue`, `Person`
- Produces:
  - `type PassportStatus = { kind: "none" | "ok" | "short" | "expired"; expiry: string | null }`
  - `passportStatus(person, arrivalOn, today): PassportStatus`
  - `passportWarningText(person, status): string | null`
  - `PersonCard({ person, arrivalOn, today, api, onEdit? })`
  - `TripWarnings({ people, arrivalOn, today })`

**This task is the "share components rather than reimplementing" decision, executed.** Plan 3's `TravelersTab` currently owns both the expiry rule (`REQUIRED_VALIDITY_DAYS`, the `expired`/`tooShort` branch) and the per-person markup. Task 5's People page needs exactly the same two things. Rather than copy them, this task lifts the rule into `lib/passport.ts` and the markup into `components/PersonCard.tsx`, then rewrites `TravelersTab` as a thin map over `PersonCard`. **`tests/client/trip/TravelersTab.test.tsx` from plan 3 must continue to pass unchanged** — it asserts on rendered text, not on structure, so a faithful extraction keeps it green. If it goes red, the extraction changed behaviour and the extraction is wrong, not the test.

The rule itself is unchanged from plan 3 and is not re-derived here: many countries require roughly six months' validity **beyond the date of arrival**, not beyond today, so validity is measured from the trip's start date and falls back to today only when the trip has no dates. "Already expired" is a different question with a different reference date — today — and gets its own branch.

`TripWarnings` is plan 3's flagged promotion: the expiring-passport row was the one piece of design 1b's right-rail Travelers card with value outside its own tab, since otherwise nobody sees it unless they open the Travelers tab.

- [ ] **Step 1: Write the failing passport test**

Create `tests/client/lib/passport.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { passportStatus, passportWarningText } from "../../../src/client/lib/passport.js";

function person(expiry: string | null) {
  return { id: "p1", displayName: "Finn", passportExpiry: expiry };
}

describe("passportStatus", () => {
  it("reports none when there is no expiry on file", () => {
    expect(passportStatus(person(null), "2026-10-09", "2026-07-21").kind).toBe("none");
  });

  it("reports ok with comfortable validity at arrival", () => {
    expect(passportStatus(person("2027-06-01"), "2026-10-09", "2026-07-21").kind).toBe("ok");
  });

  it("reports short when validity runs out within six months of arrival", () => {
    // 2027-01-15 is 98 days after the 2026-10-09 arrival — well under the
    // 183-day threshold. Measured from *today* it is 178 days away, which is
    // also under 183, but the gap is the point: an arrival two months later
    // would flip the answer while "days from today" stayed the same. That is
    // the bug the arrival-relative rule exists to prevent.
    expect(passportStatus(person("2027-01-15"), "2026-10-09", "2026-07-21").kind).toBe("short");
  });

  it("reports expired rather than short for a passport already dead today", () => {
    expect(passportStatus(person("2026-01-01"), "2026-10-09", "2026-07-21").kind).toBe("expired");
  });

  it("measures from today when the trip has no start date", () => {
    expect(passportStatus(person("2026-08-01"), null, "2026-07-21").kind).toBe("short");
  });

  it("returns no warning text for ok or none", () => {
    expect(
      passportWarningText(person("2027-06-01"), passportStatus(person("2027-06-01"), "2026-10-09", "2026-07-21")),
    ).toBe(null);
    expect(
      passportWarningText(person(null), passportStatus(person(null), "2026-10-09", "2026-07-21")),
    ).toBe(null);
  });

  it("names the person and the date in a short warning", () => {
    const p = person("2027-01-15");
    const text = passportWarningText(p, passportStatus(p, "2026-10-09", "2026-07-21"));
    expect(text).toContain("Finn");
    expect(text).toContain("2027-01-15");
    expect(text).toMatch(/under six months' validity at arrival/i);
  });

  it("names an expired passport as expired", () => {
    const p = person("2026-01-01");
    expect(passportWarningText(p, passportStatus(p, "2026-10-09", "2026-07-21"))).toMatch(
      /expired 2026-01-01/,
    );
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run test:client -- lib/passport`
Expected: FAIL — cannot resolve `src/client/lib/passport.js`.

- [ ] **Step 3: Write the passport rule**

Create `src/client/lib/passport.ts`:

```ts
import { daysUntil } from "./dates.js";

/**
 * Many countries require roughly six months' passport validity **beyond the
 * date of arrival** — not beyond today. Measuring from today warns about a
 * passport that is perfectly valid for a trip eight months out and, worse,
 * stays quiet about one that expires two weeks into a trip fourteen months
 * out.
 *
 * This constant and the branch below are the ONLY place in the client that
 * decides whether a passport is a problem. The People page, the Travelers
 * tab, and the trip warning banner all call through here, so they cannot
 * disagree about whether Finn's passport is fine.
 */
const REQUIRED_VALIDITY_DAYS = 183;

export type PassportHolder = {
  id: string;
  displayName: string;
  passportExpiry: string | null;
};

export type PassportStatus = {
  kind: "none" | "ok" | "short" | "expired";
  expiry: string | null;
};

export function passportStatus(
  person: PassportHolder,
  arrivalOn: string | null,
  today: string,
): PassportStatus {
  const expiry = person.passportExpiry;
  if (expiry === null) return { kind: "none", expiry: null };

  // Two different questions, two different reference dates: "is this document
  // already dead?" is measured from today; "will it still be valid long
  // enough when we land?" is measured from arrival.
  if (daysUntil(expiry, today) < 0) return { kind: "expired", expiry };

  const measureFrom = arrivalOn ?? today;
  if (daysUntil(expiry, measureFrom) < REQUIRED_VALIDITY_DAYS) {
    return { kind: "short", expiry };
  }
  return { kind: "ok", expiry };
}

/** The sentence a person can act on, or null when there is nothing to say. */
export function passportWarningText(
  person: PassportHolder,
  status: PassportStatus,
): string | null {
  switch (status.kind) {
    case "expired":
      return `${person.displayName}'s passport expired ${status.expiry}.`;
    case "short":
      return `${person.displayName}'s passport expires ${status.expiry} — under six months' validity at arrival.`;
    default:
      return null;
  }
}
```

- [ ] **Step 4: Run the passport test**

Run: `npm run test:client -- lib/passport`
Expected: PASS, 8 tests.

- [ ] **Step 5: Write the failing PersonCard test**

Create `tests/client/components/PersonCard.test.tsx`:

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PersonCard } from "../../../src/client/components/PersonCard.js";

function person(over: Record<string, unknown> = {}) {
  return {
    id: "p1",
    displayName: "Badger",
    dob: null,
    notes: null,
    passportExpiry: "2027-06-01",
    passportCountry: "US",
    passportNumberMasked: "••••1234",
    knownTravelerNumberMasked: null,
    redressNumberMasked: null,
    ...over,
  };
}

const api = { people: { reveal: vi.fn(async () => ({ value: "C03X71234" })) } };

function renderCard(over: Record<string, unknown> = {}, props: Record<string, unknown> = {}) {
  return render(
    <PersonCard
      person={person(over) as never}
      arrivalOn="2026-10-09"
      today="2026-07-21"
      api={api as never}
      {...props}
    />,
  );
}

describe("PersonCard", () => {
  it("renders the name and the masked passport", () => {
    renderCard();
    expect(screen.getByText("Badger")).toBeInTheDocument();
    expect(screen.getByText("••••1234")).toBeInTheDocument();
  });

  it("never renders a plaintext document number before a reveal", () => {
    const { container } = renderCard();
    expect(container.textContent).not.toContain("C03X71234");
  });

  it("shows a warning row for a passport short of validity at arrival", () => {
    renderCard({ passportExpiry: "2027-01-15" });
    expect(screen.getByText(/under six months' validity at arrival/i)).toBeInTheDocument();
  });

  it("shows no warning row for a comfortable passport", () => {
    renderCard();
    expect(screen.queryByText(/under six months/i)).not.toBeInTheDocument();
  });

  it("says so when there is no passport on file at all", () => {
    renderCard({ passportExpiry: null, passportNumberMasked: null });
    expect(screen.getByText(/no passport on file/i)).toBeInTheDocument();
  });

  it("omits an unset optional document rather than rendering a blank row", () => {
    renderCard();
    expect(screen.queryByText(/Known Traveler/i)).not.toBeInTheDocument();
  });

  it("renders a Known Traveler row when one is stored", () => {
    renderCard({ knownTravelerNumberMasked: "••••4567" });
    expect(screen.getByText(/Known Traveler/i)).toBeInTheDocument();
    expect(screen.getByText("••••4567")).toBeInTheDocument();
  });

  it("offers no edit control unless a handler is supplied", () => {
    renderCard();
    expect(screen.queryByRole("button", { name: /edit/i })).not.toBeInTheDocument();
  });

  it("calls onEdit with the person when the edit control is used", async () => {
    const onEdit = vi.fn();
    renderCard({}, { onEdit });
    await userEvent.click(screen.getByRole("button", { name: /edit badger/i }));
    expect(onEdit).toHaveBeenCalledWith(expect.objectContaining({ id: "p1" }));
  });
});
```

The eighth test is the "no dead controls" rule applied to this component: `TravelersTab` renders `PersonCard` without an `onEdit`, because editing a person from inside a trip is not a flow this plan builds, and a pencil that does nothing there would be exactly the inert affordance plan 3 removed.

- [ ] **Step 6: Run it to verify it fails**

Run: `npm run test:client -- PersonCard`
Expected: FAIL — cannot resolve `src/client/components/PersonCard.js`.

- [ ] **Step 7: Write PersonCard**

Create `src/client/components/PersonCard.tsx`:

```tsx
import { PencilSimple, WarningCircle } from "@phosphor-icons/react";
import type { api as defaultApi } from "../api/client.js";
import type { Person } from "../api/types.js";
import { PersonChip } from "./PersonChip.js";
import { MaskedValue } from "./MaskedValue.js";
import { passportStatus, passportWarningText } from "../lib/passport.js";

/**
 * The single rendering of a person's travel documents, shared by the People
 * page and the trip-detail Travelers tab. There is deliberately no second
 * component that knows how to draw a masked passport.
 *
 * `onEdit` is optional: the People page supplies it, the Travelers tab does
 * not, because editing a person is not a trip-detail flow and a pencil that
 * does nothing is worse than no pencil.
 */
export function PersonCard({
  person,
  arrivalOn,
  today,
  api,
  onEdit,
}: {
  person: Person;
  /** The trip's start date, or null on the People page where there is no trip. */
  arrivalOn: string | null;
  today: string;
  api: typeof defaultApi;
  onEdit?: (person: Person) => void;
}) {
  const status = passportStatus(person, arrivalOn, today);
  const warning = passportWarningText(person, status);

  return (
    <div className="card">
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <PersonChip person={person} />
        <span style={{ fontSize: 15, fontWeight: 500 }}>{person.displayName}</span>
        {onEdit && (
          <button
            type="button"
            className="btn btn-secondary btn-icon"
            style={{ marginLeft: "auto" }}
            aria-label={`Edit ${person.displayName}`}
            onClick={() => onEdit(person)}
          >
            <PencilSimple size={14} />
          </button>
        )}
      </div>

      {person.passportNumberMasked === null && person.passportExpiry === null ? (
        <div className="card-meta">No passport on file</div>
      ) : (
        <div className="card-meta">
          <span>Passport</span>
          <MaskedValue
            masked={person.passportNumberMasked}
            onReveal={async () => (await api.people.reveal(person.id, "passport_number")).value}
          />
          {person.passportCountry && <span>{person.passportCountry}</span>}
          {status.expiry && <span>expires {status.expiry}</span>}
        </div>
      )}

      {person.knownTravelerNumberMasked && (
        <div className="card-meta">
          <span>Known Traveler</span>
          <MaskedValue
            masked={person.knownTravelerNumberMasked}
            onReveal={async () =>
              (await api.people.reveal(person.id, "known_traveler_number")).value
            }
          />
        </div>
      )}

      {person.redressNumberMasked && (
        <div className="card-meta">
          <span>Redress</span>
          <MaskedValue
            masked={person.redressNumberMasked}
            onReveal={async () => (await api.people.reveal(person.id, "redress_number")).value}
          />
        </div>
      )}

      {warning && (
        <div className="card-meta warning">
          <WarningCircle size={12} /> {warning}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 8: Rewrite TravelersTab on top of it**

Replace `src/client/trip/TravelersTab.tsx` entirely:

```tsx
import type { api as defaultApi } from "../api/client.js";
import type { Person } from "../api/types.js";
import { PersonCard } from "../components/PersonCard.js";

/**
 * A thin map over PersonCard. The expiry rule this used to own now lives in
 * `lib/passport.ts` and the markup in `components/PersonCard.tsx`, so this
 * tab and the People page cannot drift apart.
 *
 * No `onEdit`: editing a person from inside a trip is not a flow this app
 * builds, and design 1b does not show one.
 */
export function TravelersTab({
  people,
  arrivalOn,
  api,
  today = new Intl.DateTimeFormat("en-CA").format(new Date()),
}: {
  people: Person[];
  arrivalOn: string | null;
  api: typeof defaultApi;
  today?: string;
}) {
  if (people.length === 0) {
    return <p className="text-muted">No travellers on this trip yet.</p>;
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {people.map((p) => (
        <PersonCard key={p.id} person={p} arrivalOn={arrivalOn} today={today} api={api} />
      ))}
    </div>
  );
}
```

- [ ] **Step 9: Verify plan 3's TravelersTab test still passes untouched**

Run: `npm run test:client -- TravelersTab && npm run typecheck`
Expected: PASS, 4 tests — **with no edits to `tests/client/trip/TravelersTab.test.tsx`.** That file asserts on rendered text (`/under six months' validity at arrival/i`, `/expired 2026-01-01/`), which the extraction preserves verbatim. If it fails, the extraction changed behaviour; fix the extraction, not the test.

**The `api` prop was checked, not assumed.** The rewrite above keeps `api` required, so a caller that omitted it would compile-error even though it would render fine. Plan 3's component signature (`docs/superpowers/plans/2026-07-21-trip-detail-and-day-view.md`, Task 5 Step 8) already declares `api: typeof defaultApi` as required, its test's `renderTab` helper already passes `api={api as never}`, and `TripDetail` already renders `<TravelersTab … api={api} />`. So there is nothing to reconcile — but run `npm run typecheck` here rather than only the test, because that is the check that would have caught it.

- [ ] **Step 10: Write the failing TripWarnings test**

Create `tests/client/trip/TripWarnings.test.tsx`:

```tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { TripWarnings } from "../../../src/client/trip/TripWarnings.js";

function person(id: string, name: string, expiry: string | null) {
  return { id, displayName: name, passportExpiry: expiry };
}

function renderWarnings(people: unknown[], arrivalOn: string | null = "2026-10-09") {
  return render(
    <TripWarnings people={people as never} arrivalOn={arrivalOn} today="2026-07-21" />,
  );
}

describe("TripWarnings", () => {
  it("renders nothing when every passport is comfortable", () => {
    const { container } = renderWarnings([person("p1", "Badger", "2028-01-01")]);
    expect(container).toBeEmptyDOMElement();
  });

  it("warns about a passport short of validity at arrival", () => {
    renderWarnings([person("p1", "Finn", "2027-01-15")]);
    expect(screen.getByRole("status")).toHaveTextContent(/Finn/);
    expect(screen.getByRole("status")).toHaveTextContent(/under six months/i);
  });

  it("lists every affected traveller, not just the first", () => {
    renderWarnings([
      person("p1", "Finn", "2027-01-15"),
      person("p2", "Maya", "2026-01-01"),
      person("p3", "Badger", "2028-01-01"),
    ]);
    const banner = screen.getByRole("status");
    expect(banner).toHaveTextContent(/Finn/);
    expect(banner).toHaveTextContent(/Maya/);
    expect(banner).not.toHaveTextContent(/Badger/);
  });

  it("renders nothing for a trip with no travellers", () => {
    const { container } = renderWarnings([]);
    expect(container).toBeEmptyDOMElement();
  });
});
```

- [ ] **Step 11: Run it to verify it fails**

Run: `npm run test:client -- TripWarnings`
Expected: FAIL — cannot resolve `src/client/trip/TripWarnings.js`.

- [ ] **Step 12: Write TripWarnings**

Create `src/client/trip/TripWarnings.tsx`:

```tsx
import { WarningCircle } from "@phosphor-icons/react";
import type { Person } from "../api/types.js";
import { passportStatus, passportWarningText } from "../lib/passport.js";

/**
 * Plan 3's flagged promotion. Design 1b puts an expiring-passport row inside
 * the right rail's Travelers card; plan 3 shipped only CostRollup in the rail
 * and moved travellers into a tab, which left this warning visible only to
 * someone who happened to open that tab. A passport that will be too short at
 * arrival is trip-level news, so it renders above the tabs.
 *
 * `role="status"` rather than `role="alert"`: this is a standing condition
 * present on first render, not an event. `alert` would interrupt a screen
 * reader on every page load.
 */
export function TripWarnings({
  people,
  arrivalOn,
  today,
}: {
  people: Person[];
  arrivalOn: string | null;
  today: string;
}) {
  const warnings = people
    .map((p) => passportWarningText(p, passportStatus(p, arrivalOn, today)))
    .filter((text): text is string => text !== null);

  if (warnings.length === 0) return null;

  return (
    <div
      role="status"
      className="card"
      style={{ border: "1px solid #8a6d3b", marginBottom: 20 }}
    >
      {warnings.map((text) => (
        <div key={text} className="card-meta warning">
          <WarningCircle size={13} /> {text}
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 13: Render it on trip detail**

In `src/client/pages/TripDetail.tsx`, add the import:

```tsx
import { TripWarnings } from "../trip/TripWarnings.js";
```

and render it immediately after the `<header>` block and before the `<div className="seg" ...>` tab group:

```tsx
      <TripWarnings people={travelers} arrivalOn={trip.startsOn} today={today} />
```

`travelers` (trip membership from `trip_person`), not `people` (the whole household): a warning about a passport belonging to someone who is not on this trip is noise.

- [ ] **Step 14: Run the client suite**

Run: `npm run test:client`
Expected: all PASS. New this task: 8 passport, 9 PersonCard, 4 TripWarnings. Plan 3's `TravelersTab.test.tsx` (4) and `TripDetail.test.tsx` (9) both still pass unmodified.

- [ ] **Step 15: Commit**

```bash
git add src/client/lib/passport.ts src/client/components/PersonCard.tsx src/client/trip/TripWarnings.tsx src/client/trip/TravelersTab.tsx src/client/pages/TripDetail.tsx tests/client/lib/passport.test.ts tests/client/components/PersonCard.test.tsx tests/client/trip/TripWarnings.test.tsx
git commit -m "feat: extract the passport rule and PersonCard, add a trip warning banner"
```

---

### Task 5: The dialog shell and the person form

**Files:**
- Create: `src/client/components/Dialog.tsx`
- Create: `src/client/components/PersonForm.tsx`
- Test: `tests/client/components/Dialog.test.tsx`
- Test: `tests/client/components/PersonForm.test.tsx`

**Interfaces:**
- Consumes: `api.people.create` / `api.people.update` (Task 3), `errorMessage` (plan 2 Task 5), `CreatePersonInput` / `UpdatePersonInput` / `Person`
- Produces:
  - `Dialog({ title, subtitle?, onClose, children })`
  - `PersonForm({ person?, api, onSaved, onClose })` — create when `person` is absent, edit when present

**The edit form is where the masked-value trap would actually fire, so this is where it is designed out.**

Task 1 made the server reject a masked value. This component makes it impossible for the client to send one. The rule is: **a document input is never pre-filled, in either mode.** In edit mode each document field renders as an empty input with the placeholder "unchanged", next to a "Clear" toggle. The request body is then assembled by *including only the keys the operator actually touched*:

| Operator did | Body contains | Server does |
| --- | --- | --- |
| nothing | key absent | leaves the stored value alone |
| typed a new number | `"C03X72119"` | encrypts and replaces |
| pressed Clear | `null` | clears the column |

The component never holds a masked string in form state, so there is nothing to accidentally submit. The masked value is still *displayed*, read-only, above the input — the operator needs to see which passport they are replacing — but it lives in `props`, not in the field's value.

Plain fields (name, DOB, country, expiry, notes) are pre-filled normally. They are not encrypted and the API returns them verbatim, so round-tripping them is correct.

- [ ] **Step 1: Write the failing Dialog test**

Create `tests/client/components/Dialog.test.tsx`:

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Dialog } from "../../../src/client/components/Dialog.js";

function renderDialog(onClose = vi.fn()) {
  render(
    <Dialog title="Add person" subtitle="Badger household" onClose={onClose}>
      <p>body content</p>
    </Dialog>,
  );
  return onClose;
}

describe("Dialog", () => {
  it("renders as a labelled modal dialog", () => {
    renderDialog();
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveAccessibleName("Add person");
  });

  it("renders its children", () => {
    renderDialog();
    expect(screen.getByText("body content")).toBeInTheDocument();
  });

  it("closes on Escape", async () => {
    const onClose = renderDialog();
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes on a click of the backdrop", async () => {
    const onClose = renderDialog();
    await userEvent.click(screen.getByTestId("dialog-backdrop"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does not close on a click inside the dialog", async () => {
    // A click that starts on a form control and lands on the panel must not
    // discard a half-filled passport form.
    const onClose = renderDialog();
    await userEvent.click(screen.getByText("body content"));
    expect(onClose).not.toHaveBeenCalled();
  });

  it("closes on the explicit close control", async () => {
    const onClose = renderDialog();
    await userEvent.click(screen.getByRole("button", { name: /close/i }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run test:client -- components/Dialog`
Expected: FAIL — cannot resolve `src/client/components/Dialog.js`.

- [ ] **Step 3: Write Dialog**

Create `src/client/components/Dialog.tsx`:

```tsx
import { useEffect, useId, useRef } from "react";
import type { ReactNode } from "react";
import { X } from "@phosphor-icons/react";

/**
 * One modal shell for all three forms in this plan. The token sheet already
 * provides `.dialog-backdrop`, `.dialog`, `.dialog-title`, and
 * `.dialog-actions`; this supplies the behaviour those classes imply —
 * Escape to close, backdrop-click to close, an accessible name, and initial
 * focus inside the panel so a keyboard user is not left on the page behind.
 */
export function Dialog({
  title,
  subtitle,
  onClose,
  children,
}: {
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const titleId = useId();
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    // Focus the panel itself rather than hunting for the first input: the
    // three forms have different first fields, and `tabIndex={-1}` makes the
    // panel focusable without putting it in the tab order.
    panel.current?.focus();
  }, []);

  return (
    <div
      className="dialog-backdrop"
      data-testid="dialog-backdrop"
      // Fires only when the backdrop itself is the target, so a click that
      // began inside the panel never closes the dialog.
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={panel}
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
          <h4 id={titleId} className="dialog-title" style={{ margin: 0 }}>
            {title}
          </h4>
          {subtitle && <span className="text-muted" style={{ fontSize: 12 }}>{subtitle}</span>}
          <button
            type="button"
            className="btn btn-ghost"
            style={{ marginLeft: "auto" }}
            aria-label="Close"
            onClick={onClose}
          >
            <X size={16} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run the Dialog test**

Run: `npm run test:client -- components/Dialog`
Expected: PASS, 6 tests.

- [ ] **Step 5: Write the failing PersonForm test**

Create `tests/client/components/PersonForm.test.tsx`:

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PersonForm } from "../../../src/client/components/PersonForm.js";

const AVA = {
  id: "p1",
  displayName: "Ava",
  dob: "2018-04-02",
  notes: null,
  passportExpiry: "2027-01-15",
  passportCountry: "US",
  passportNumberMasked: "••••2119",
  knownTravelerNumberMasked: null,
  redressNumberMasked: null,
};

function makeApi() {
  return {
    people: {
      create: vi.fn(async () => ({ ...AVA, id: "p-new" })),
      update: vi.fn(async () => AVA),
    },
  };
}

function renderForm(person?: unknown, api = makeApi(), onSaved = vi.fn()) {
  render(
    <PersonForm
      person={person as never}
      api={api as never}
      onSaved={onSaved}
      onClose={vi.fn()}
    />,
  );
  return { api, onSaved };
}

describe("PersonForm — create", () => {
  it("sends the typed name and passport number", async () => {
    const { api } = renderForm();
    await userEvent.type(screen.getByLabelText("Name"), "Ava");
    await userEvent.type(screen.getByLabelText(/Passport number/), "C03X72119");
    await userEvent.click(screen.getByRole("button", { name: /save/i }));
    expect(api.people.create).toHaveBeenCalledWith(
      expect.objectContaining({ displayName: "Ava", passportNumber: "C03X72119" }),
    );
  });

  it("omits document fields the operator left blank", async () => {
    const { api } = renderForm();
    await userEvent.type(screen.getByLabelText("Name"), "Finn");
    await userEvent.click(screen.getByRole("button", { name: /save/i }));
    const body = api.people.create.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(body).not.toHaveProperty("passportNumber");
    expect(body).not.toHaveProperty("knownTravelerNumber");
  });

  it("refuses to submit without a name", async () => {
    const { api } = renderForm();
    await userEvent.click(screen.getByRole("button", { name: /save/i }));
    expect(api.people.create).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent(/name/i);
  });

  it("reports a rejected save instead of closing silently", async () => {
    const api = makeApi();
    api.people.create = vi.fn(async () => {
      throw new Error("403");
    });
    const { onSaved } = renderForm(undefined, api);
    await userEvent.type(screen.getByLabelText("Name"), "Ava");
    await userEvent.click(screen.getByRole("button", { name: /save/i }));
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(onSaved).not.toHaveBeenCalled();
  });
});

describe("PersonForm — edit", () => {
  it("pre-fills the plain fields", () => {
    renderForm(AVA);
    expect(screen.getByLabelText("Name")).toHaveValue("Ava");
    expect(screen.getByLabelText(/Passport expiry/)).toHaveValue("2027-01-15");
  });

  it("NEVER pre-fills a document input with the masked value", () => {
    // The disaster case. If this input carried "••••2119", saving would
    // encrypt that string over a real passport number, silently, with a 200.
    renderForm(AVA);
    expect(screen.getByLabelText(/Passport number/)).toHaveValue("");
  });

  it("shows the stored masked value read-only, outside the input", () => {
    renderForm(AVA);
    // Visible so the operator knows which passport they are replacing, but
    // it is not the field's value and cannot be submitted.
    expect(screen.getByText("••••2119")).toBeInTheDocument();
  });

  it("omits an untouched document field from the update body entirely", async () => {
    const { api } = renderForm(AVA);
    await userEvent.clear(screen.getByLabelText("Name"));
    await userEvent.type(screen.getByLabelText("Name"), "Ava Wright");
    await userEvent.click(screen.getByRole("button", { name: /save/i }));
    const body = api.people.update.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body.displayName).toBe("Ava Wright");
    // Absent, not null and not the masked string. `in` rather than a
    // truthiness check, because `null` here would mean "clear it".
    expect("passportNumber" in body).toBe(false);
  });

  it("sends an explicit null when the operator clears a document", async () => {
    const { api } = renderForm(AVA);
    await userEvent.click(screen.getByRole("button", { name: /clear stored passport number/i }));
    await userEvent.click(screen.getByRole("button", { name: /save/i }));
    const body = api.people.update.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body.passportNumber).toBe(null);
  });

  it("sends new plaintext when the operator types a replacement", async () => {
    const { api } = renderForm(AVA);
    await userEvent.type(screen.getByLabelText(/Passport number/), "X99Z00042");
    await userEvent.click(screen.getByRole("button", { name: /save/i }));
    const body = api.people.update.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body.passportNumber).toBe("X99Z00042");
  });

  it("calls onSaved with the saved person", async () => {
    const { api, onSaved } = renderForm(AVA);
    await userEvent.clear(screen.getByLabelText("Name"));
    await userEvent.type(screen.getByLabelText("Name"), "Ava W");
    await userEvent.click(screen.getByRole("button", { name: /save/i }));
    expect(api.people.update).toHaveBeenCalled();
    expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ id: "p1" }));
  });
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `npm run test:client -- PersonForm`
Expected: FAIL — cannot resolve `src/client/components/PersonForm.js`.

- [ ] **Step 7: Write PersonForm**

Create `src/client/components/PersonForm.tsx`:

```tsx
import { useState } from "react";
import type { api as defaultApi } from "../api/client.js";
import type { CreatePersonInput, Person, UpdatePersonInput } from "../api/types.js";
import { errorMessage } from "../lib/errors.js";
import { Dialog } from "./Dialog.js";

/**
 * The three encrypted columns, in the order they appear on the form. Keyed by
 * the API's input-field name so the request body is assembled from this list
 * rather than from three near-identical hand-written branches.
 */
const DOCUMENTS = [
  { key: "passportNumber", label: "Passport number", masked: "passportNumberMasked" },
  { key: "knownTravelerNumber", label: "Known Traveler number", masked: "knownTravelerNumberMasked" },
  { key: "redressNumber", label: "Redress number", masked: "redressNumberMasked" },
] as const;

type DocumentKey = (typeof DOCUMENTS)[number]["key"];

/**
 * Create when `person` is absent, edit when present.
 *
 * The document inputs start EMPTY in both modes and are never seeded from
 * `person`. `PersonRepo.list()` returns document numbers masked
 * (`••••2119`), so seeding an input from the loaded person and submitting the
 * whole object would encrypt the mask over the real passport number — a
 * silent, unrecoverable data loss with a 200 response. Instead:
 *
 *   typed nothing  -> the key is omitted     -> server leaves it alone
 *   pressed Clear  -> the key is null        -> server clears it
 *   typed a value  -> the key is that string -> server replaces it
 *
 * The server also rejects any document value containing the mask glyph
 * (`PersonRepo.update`), so this is belt and braces rather than the sole
 * defence — but it is the layer that means the bad request is never made.
 */
export function PersonForm({
  person,
  api = defaultApi,
  onSaved,
  onClose,
}: {
  person?: Person;
  api?: typeof defaultApi;
  onSaved: (person: Person) => void;
  onClose: () => void;
}) {
  const editing = person !== undefined;

  const [displayName, setDisplayName] = useState(person?.displayName ?? "");
  const [dob, setDob] = useState(person?.dob ?? "");
  const [passportExpiry, setPassportExpiry] = useState(person?.passportExpiry ?? "");
  const [passportCountry, setPassportCountry] = useState(person?.passportCountry ?? "");
  const [notes, setNotes] = useState(person?.notes ?? "");

  // Typed replacements, keyed by document. Empty string means "untouched".
  const [documents, setDocuments] = useState<Record<DocumentKey, string>>({
    passportNumber: "",
    knownTravelerNumber: "",
    redressNumber: "",
  });
  // Documents the operator explicitly asked to clear.
  const [cleared, setCleared] = useState<Record<DocumentKey, boolean>>({
    passportNumber: false,
    knownTravelerNumber: false,
    redressNumber: false,
  });

  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /**
   * The document keys to send, as the tri-state: absent (untouched), a string
   * (replace), or — edit mode only — `null` (clear).
   *
   * The mode parameter is not cosmetic, it is what makes this typecheck.
   * `CreatePersonInput`'s document fields are `string | undefined`;
   * `UpdatePersonInput`'s are `string | null | undefined`. Spreading one
   * `string | null`-valued patch into both object literals fails
   * `satisfies CreatePersonInput` with TS1360 ("Type 'string | null |
   * undefined' is not assignable to type 'string | undefined'"). Two return
   * types, selected by the caller, keeps both branches honest.
   *
   * Runtime never hit this: the Clear button renders only when
   * `stored !== null`, which is never true in create mode. But `npm run
   * typecheck` would have.
   */
  function documentPatch(mode: "create"): Partial<Record<DocumentKey, string>>;
  function documentPatch(mode: "edit"): Partial<Record<DocumentKey, string | null>>;
  function documentPatch(
    mode: "create" | "edit",
  ): Partial<Record<DocumentKey, string | null>> {
    const patch: Partial<Record<DocumentKey, string | null>> = {};
    for (const { key } of DOCUMENTS) {
      const typed = documents[key].trim();
      // Order matters: a typed value wins over a stale Clear press, and an
      // untouched field contributes NO key at all rather than `undefined`.
      if (typed !== "") patch[key] = typed;
      // A clear is only expressible against a stored value, which only exists
      // in edit mode. In create mode the key is simply omitted.
      else if (mode === "edit" && cleared[key]) patch[key] = null;
    }
    return patch;
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (displayName.trim() === "") {
      setError("A name is required.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const saved = editing
        ? await api.people.update(person.id, {
            displayName: displayName.trim(),
            dob: dob === "" ? null : dob,
            passportExpiry: passportExpiry === "" ? null : passportExpiry,
            passportCountry: passportCountry === "" ? null : passportCountry,
            notes: notes === "" ? null : notes,
            ...documentPatch("edit"),
          } satisfies UpdatePersonInput)
        : await api.people.create({
            displayName: displayName.trim(),
            ...(dob === "" ? {} : { dob }),
            ...(passportExpiry === "" ? {} : { passportExpiry }),
            ...(passportCountry === "" ? {} : { passportCountry }),
            ...(notes === "" ? {} : { notes }),
            ...documentPatch("create"),
          } satisfies CreatePersonInput);
      onSaved(saved);
    } catch (err) {
      // Never close on failure: a 403 (viewer) or the server's masked-value
      // 400 must leave the typed values on screen, not discard them behind a
      // dialog that vanished as if it had worked.
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      title={editing ? `Edit ${person.displayName}` : "Add person"}
      onClose={onClose}
    >
      <form onSubmit={submit} style={{ display: "grid", gap: 14 }}>
        {error && (
          <p className="warning" role="alert" style={{ margin: 0 }}>
            {error}
          </p>
        )}

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <div className="field">
            <label htmlFor="pf-name">Name</label>
            <input
              id="pf-name"
              className="input"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="pf-dob">Date of birth</label>
            <input
              id="pf-dob"
              className="input"
              type="date"
              value={dob}
              onChange={(e) => setDob(e.target.value)}
            />
          </div>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <div className="field">
            <label htmlFor="pf-expiry">Passport expiry</label>
            <input
              id="pf-expiry"
              className="input"
              type="date"
              value={passportExpiry}
              onChange={(e) => setPassportExpiry(e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="pf-country">Passport country</label>
            <input
              id="pf-country"
              className="input"
              value={passportCountry}
              onChange={(e) => setPassportCountry(e.target.value)}
            />
          </div>
        </div>

        {DOCUMENTS.map(({ key, label, masked }) => {
          const stored = person?.[masked] ?? null;
          return (
            <div className="field" key={key}>
              <label htmlFor={`pf-${key}`}>
                {label}{" "}
                <span className="text-muted" style={{ fontSize: 11 }}>
                  · stored encrypted
                </span>
              </label>
              {stored !== null && (
                <div className="card-meta" style={{ marginBottom: 5 }}>
                  <span>currently {stored}</span>
                  <button
                    type="button"
                    className="btn btn-ghost"
                    style={{ fontSize: 11 }}
                    aria-label={`Clear stored ${label.toLowerCase()}`}
                    aria-pressed={cleared[key]}
                    onClick={() => setCleared((c) => ({ ...c, [key]: !c[key] }))}
                  >
                    {cleared[key] ? "Will be cleared — undo" : "Clear"}
                  </button>
                </div>
              )}
              <input
                id={`pf-${key}`}
                className="input"
                autoComplete="off"
                // Never seeded from `person`. See the component docstring.
                value={documents[key]}
                placeholder={stored === null ? "" : "unchanged"}
                onChange={(e) => setDocuments((d) => ({ ...d, [key]: e.target.value }))}
              />
            </div>
          );
        })}

        <div className="field">
          <label htmlFor="pf-notes">Notes</label>
          <textarea
            id="pf-notes"
            className="input"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </div>

        <div className="dialog-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            Save
          </button>
        </div>
      </form>
    </Dialog>
  );
}
```

The `<label htmlFor>` / `id` pairing on every input is what makes `getByLabelText("Name")` work in the tests and what makes the form usable at all; do not replace it with a wrapping label, because `.field > label` in the token sheet styles the label as a block and expects it to be a sibling.

- [ ] **Step 8: Run the tests**

Run: `npm run test:client -- PersonForm`
Expected: PASS, 11 tests — 4 create, 7 edit.

- [ ] **Step 9: Run the client suite and typecheck**

Run: `npm run test:client && npm run typecheck`
Expected: all PASS, typecheck exits 0.

- [ ] **Step 10: Commit**

```bash
git add src/client/components/Dialog.tsx src/client/components/PersonForm.tsx tests/client/components/Dialog.test.tsx tests/client/components/PersonForm.test.tsx
git commit -m "feat: add dialog shell and person form that cannot round-trip a masked document"
```

---

### Task 6: The People page and the Trips page

**Files:**
- Create: `src/client/components/TravelerToggles.tsx`
- Create: `src/client/components/TripForm.tsx`
- Replace: `src/client/pages/People.tsx`
- Replace: `src/client/pages/Trips.tsx`
- Test: `tests/client/components/TravelerToggles.test.tsx`
- Test: `tests/client/pages/People.test.tsx`
- Test: `tests/client/pages/Trips.test.tsx`

**Interfaces:**
- Consumes: `PersonCard` (Task 4), `Dialog` / `PersonForm` (Task 5), `api.people.*` / `api.trips.create` / `api.trips.addTraveler` (Task 3), `TripCard` (plan 2 Task 6), `errorMessage`
- Produces:
  - `TravelerToggles({ people, selected, onToggle })` — the "who's on it" chips, consumed here, by Task 7's booking dialog, and by Part B's draft review
  - `TripForm({ people, api, onSaved, onClose })`
  - `People()` — the card grid decided above
  - `Trips()` — the trip list plus create

Both pages replace stubs plan 2 shipped (`"Not built yet — see plan 3."`). After this task the app satisfies spec success criterion 1 — the family can be entered once — through the UI rather than through curl.

**`TravelerToggles` is extracted here rather than inlined** because three screens need the identical control: the trip form ("who's coming"), the booking dialog ("who's on it" — design 1g), and the import draft card ("Who's on it — tap to toggle" — the Import prototype). The design bundle draws it the same way in all three: a chip per person, accent-outlined with a check when on, `--color-divider`-bordered and muted when off.

- [ ] **Step 1: Write the failing TravelerToggles test**

Create `tests/client/components/TravelerToggles.test.tsx`:

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TravelerToggles } from "../../../src/client/components/TravelerToggles.js";

const PEOPLE = [
  { id: "p1", displayName: "Badger" },
  { id: "p2", displayName: "Ava" },
];

function renderToggles(selected: string[] = [], onToggle = vi.fn()) {
  render(
    <TravelerToggles people={PEOPLE as never} selected={selected} onToggle={onToggle} />,
  );
  return onToggle;
}

describe("TravelerToggles", () => {
  it("renders a toggle per person", () => {
    renderToggles();
    expect(screen.getByRole("button", { name: /Badger/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Ava/ })).toBeInTheDocument();
  });

  it("reflects selection with aria-pressed rather than colour alone", () => {
    renderToggles(["p1"]);
    expect(screen.getByRole("button", { name: /Badger/ })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /Ava/ })).toHaveAttribute("aria-pressed", "false");
  });

  it("reports the person id on click", async () => {
    const onToggle = renderToggles();
    await userEvent.click(screen.getByRole("button", { name: /Ava/ }));
    expect(onToggle).toHaveBeenCalledWith("p2");
  });

  it("says so when the household has no people yet", () => {
    render(<TravelerToggles people={[]} selected={[]} onToggle={vi.fn()} />);
    expect(screen.getByText(/no people yet/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run test:client -- TravelerToggles`
Expected: FAIL — cannot resolve the module.

- [ ] **Step 3: Write TravelerToggles**

Create `src/client/components/TravelerToggles.tsx`:

```tsx
import { Check } from "@phosphor-icons/react";
import type { Person } from "../api/types.js";
import { PersonChip } from "./PersonChip.js";

/**
 * The "who's on it" control from design 1g and the Import prototype. A real
 * <button> with `aria-pressed`, not a styled <span>: the design draws
 * selection as an accent outline plus a check, and colour alone is not a
 * state a screen reader or a colour-blind user can read.
 */
export function TravelerToggles({
  people,
  selected,
  onToggle,
}: {
  people: Pick<Person, "id" | "displayName">[];
  selected: string[];
  onToggle: (personId: string) => void;
}) {
  if (people.length === 0) {
    return <p className="text-muted" style={{ margin: 0 }}>No people yet — add the family first.</p>;
  }

  return (
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
      {people.map((p) => {
        const on = selected.includes(p.id);
        return (
          <button
            key={p.id}
            type="button"
            className={on ? "tag tag-outline" : "tag"}
            aria-pressed={on}
            onClick={() => onToggle(p.id)}
            style={{
              gap: 6,
              padding: "5px 11px",
              cursor: "pointer",
              border: on ? undefined : "1px solid var(--color-divider)",
              color: on ? undefined : "var(--color-neutral-400)",
              background: "none",
            }}
          >
            <PersonChip person={p} />
            {p.displayName}
            {on && <Check size={11} />}
          </button>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 4: Write the failing People test**

Create `tests/client/pages/People.test.tsx`:

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { People } from "../../../src/client/pages/People.js";

const BADGER = {
  id: "p1",
  displayName: "Badger",
  dob: null,
  notes: null,
  passportExpiry: "2028-01-01",
  passportCountry: "US",
  passportNumberMasked: "••••1234",
  knownTravelerNumberMasked: null,
  redressNumberMasked: null,
};

function makeApi(people = [BADGER]) {
  return {
    people: {
      list: vi.fn(async () => people),
      reveal: vi.fn(async () => ({ value: "X" })),
      create: vi.fn(async () => ({ ...BADGER, id: "p2", displayName: "Ava" })),
      update: vi.fn(async () => ({ ...BADGER, displayName: "Badger Wright" })),
    },
  };
}

function renderPeople(api = makeApi()) {
  render(<People api={api as never} today="2026-07-21" />);
  return api;
}

describe("People", () => {
  it("renders a card per family member", async () => {
    renderPeople();
    expect(await screen.findByText("Badger")).toBeInTheDocument();
    expect(screen.getByText("••••1234")).toBeInTheDocument();
  });

  it("offers a first-run empty state rather than a blank page", async () => {
    renderPeople(makeApi([]));
    expect(await screen.findByText(/no one here yet/i)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /add the first family member/i }),
    ).toBeInTheDocument();
  });

  it("reports a failed load rather than looking like an empty household", async () => {
    // "Nobody has been entered" and "we could not find out" must not render
    // identically -- the first invites you to add people, the second is a
    // fault. Without a catch this page also sits on "Loading…" forever and
    // logs an unhandled rejection.
    const api = makeApi();
    api.people.list = vi.fn(async () => {
      throw new Error("500");
    });
    renderPeople(api);
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.queryByText(/Loading/)).not.toBeInTheDocument();
    expect(screen.queryByText(/no one here yet/i)).not.toBeInTheDocument();
  });

  it("opens the add dialog from the header control", async () => {
    renderPeople();
    await userEvent.click(await screen.findByRole("button", { name: /add person/i }));
    expect(screen.getByRole("dialog")).toHaveAccessibleName("Add person");
  });

  it("opens the add dialog from the empty state", async () => {
    renderPeople(makeApi([]));
    await userEvent.click(
      await screen.findByRole("button", { name: /add the first family member/i }),
    );
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("shows a newly created person without a reload", async () => {
    const api = renderPeople();
    await userEvent.click(await screen.findByRole("button", { name: /add person/i }));
    await userEvent.type(screen.getByLabelText("Name"), "Ava");
    await userEvent.click(screen.getByRole("button", { name: /save/i }));
    expect(await screen.findByText("Ava")).toBeInTheDocument();
    expect(api.people.create).toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("opens the edit dialog from a card and replaces the person on save", async () => {
    renderPeople();
    await userEvent.click(await screen.findByRole("button", { name: /edit badger/i }));
    expect(screen.getByRole("dialog")).toHaveAccessibleName(/Edit Badger/);
    const name = screen.getByLabelText("Name");
    await userEvent.clear(name);
    await userEvent.type(name, "Badger Wright");
    await userEvent.click(screen.getByRole("button", { name: /save/i }));
    expect(await screen.findByText("Badger Wright")).toBeInTheDocument();
  });
});
```

- [ ] **Step 5: Run it to verify it fails**

Run: `npm run test:client -- pages/People`
Expected: FAIL — the stub renders only "People" and "Not built yet".

- [ ] **Step 6: Write the People page**

Replace `src/client/pages/People.tsx`:

```tsx
import { useEffect, useState } from "react";
import { Plus } from "@phosphor-icons/react";
import { api as defaultApi } from "../api/client.js";
import type { Person } from "../api/types.js";
import { errorMessage } from "../lib/errors.js";
import { PersonCard } from "../components/PersonCard.js";
import { PersonForm } from "../components/PersonForm.js";

/**
 * Decided in this plan: a card grid in the trip-card idiom, one card per
 * family member, masked document numbers, and a passport-expiry warning row.
 * The design bundle never covered this page.
 *
 * `arrivalOn={null}` on every card: there is no trip here, so passport
 * validity is measured from today. `PersonCard` handles that fallback.
 */
export function People({
  api = defaultApi,
  today = new Intl.DateTimeFormat("en-CA").format(new Date()),
}: {
  api?: typeof defaultApi;
  today?: string;
}) {
  const [people, setPeople] = useState<Person[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Person | null>(null);
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api.people
      .list()
      .then((rows) => {
        if (!cancelled) setPeople(rows);
      })
      // Without this the page sits on "Loading…" forever on any failure and
      // the rejection goes unhandled. An empty household and a failed fetch
      // must never look the same.
      .catch((err) => {
        if (!cancelled) setError(errorMessage(err));
      });
    return () => {
      cancelled = true;
    };
  }, [api]);

  function onSaved(saved: Person) {
    setPeople((prev) => {
      const rows = prev ?? [];
      const exists = rows.some((p) => p.id === saved.id);
      const next = exists ? rows.map((p) => (p.id === saved.id ? saved : p)) : [...rows, saved];
      return [...next].sort((a, b) => a.displayName.localeCompare(b.displayName));
    });
    setEditing(null);
    setAdding(false);
  }

  return (
    <>
      <header style={{ display: "flex", alignItems: "baseline", gap: 12, marginBottom: 20 }}>
        <div>
          <h3 style={{ marginBottom: 4 }}>People</h3>
          <p className="text-muted" style={{ margin: 0 }}>
            Travel documents for everyone in the household. Numbers are stored encrypted and
            shown masked; revealing one is logged.
          </p>
        </div>
        <button
          type="button"
          className="btn btn-primary"
          style={{ marginLeft: "auto" }}
          onClick={() => setAdding(true)}
        >
          <Plus size={14} /> Add person
        </button>
      </header>

      {error && (
        <p className="warning" role="alert">
          {error}
        </p>
      )}

      {!error && people === null && <p className="text-muted">Loading…</p>}

      {!error && people !== null && people.length === 0 && (
        <div className="card" style={{ alignItems: "flex-start", gap: 10 }}>
          <span className="card-title">No one here yet</span>
          <p className="card-body" style={{ margin: 0 }}>
            Nothing else in Travel HQ works until the family is entered — trips need travellers
            and bookings need people to be on them. Start with one person; passports and Known
            Traveler numbers can be filled in later.
          </p>
          <button type="button" className="btn btn-primary" onClick={() => setAdding(true)}>
            <Plus size={14} /> Add the first family member
          </button>
        </div>
      )}

      {!error && people !== null && people.length > 0 && (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))",
            gap: 14,
          }}
        >
          {people.map((p) => (
            <PersonCard
              key={p.id}
              person={p}
              arrivalOn={null}
              today={today}
              api={api}
              onEdit={setEditing}
            />
          ))}
        </div>
      )}

      {adding && (
        <PersonForm api={api} onSaved={onSaved} onClose={() => setAdding(false)} />
      )}
      {editing && (
        <PersonForm
          // Remount per person: PersonForm seeds its state from props once,
          // so reusing one instance across two different people would show
          // the first person's values in the second person's form.
          key={editing.id}
          person={editing}
          api={api}
          onSaved={onSaved}
          onClose={() => setEditing(null)}
        />
      )}
    </>
  );
}
```

- [ ] **Step 7: Run the People tests**

Run: `npm run test:client -- pages/People`
Expected: PASS, 7 tests.

- [ ] **Step 8: Write the failing Trips test**

Create `tests/client/pages/Trips.test.tsx`:

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import { Trips } from "../../../src/client/pages/Trips.js";

const TRIP = {
  id: "t1",
  title: "Mary & Winter Wedding",
  destination: "Guerneville, CA",
  startsOn: "2026-10-09",
  endsOn: "2026-10-11",
  status: "planning" as const,
  notes: null,
};

const PEOPLE = [
  { id: "p1", displayName: "Badger" },
  { id: "p2", displayName: "Ava" },
];

function makeApi(trips = [TRIP]) {
  return {
    trips: {
      list: vi.fn(async () => trips),
      create: vi.fn(async () => ({ ...TRIP, id: "t2", title: "Kauai" })),
      addTraveler: vi.fn(async () => undefined),
    },
    people: { list: vi.fn(async () => PEOPLE) },
  };
}

function renderTrips(api = makeApi()) {
  const { hook } = memoryLocation({ path: "/trips" });
  render(
    <Router hook={hook}>
      <Trips api={api as never} today="2026-07-21" />
    </Router>,
  );
  return api;
}

describe("Trips", () => {
  it("lists trips", async () => {
    renderTrips();
    expect(await screen.findByText("Mary & Winter Wedding")).toBeInTheDocument();
  });

  it("offers an empty state rather than a blank page", async () => {
    renderTrips(makeApi([]));
    expect(await screen.findByText(/no trips yet/i)).toBeInTheDocument();
  });

  it("reports a failed load rather than spinning forever", async () => {
    const api = makeApi();
    api.trips.list = vi.fn(async () => {
      throw new Error("500");
    });
    renderTrips(api);
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.queryByText(/Loading/)).not.toBeInTheDocument();
  });

  it("creates a trip and attaches the selected travellers", async () => {
    const api = renderTrips();
    await userEvent.click(await screen.findByRole("button", { name: /new trip/i }));
    await userEvent.type(screen.getByLabelText("Title"), "Kauai");
    await userEvent.click(screen.getByRole("button", { name: /Badger/ }));
    await userEvent.click(screen.getByRole("button", { name: /save trip/i }));

    expect(api.trips.create).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Kauai" }),
    );
    // The trip and its roster are two calls; the second is what makes the
    // day view able to filter by person at all.
    expect(api.trips.addTraveler).toHaveBeenCalledWith("t2", "p1");
    expect(api.trips.addTraveler).not.toHaveBeenCalledWith("t2", "p2");
    expect(await screen.findByText("Kauai")).toBeInTheDocument();
  });

  it("refuses to submit a trip with no title", async () => {
    const api = renderTrips();
    await userEvent.click(await screen.findByRole("button", { name: /new trip/i }));
    await userEvent.click(screen.getByRole("button", { name: /save trip/i }));
    expect(api.trips.create).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent(/title/i);
  });

  it("keeps the dialog open and reports a rejected create", async () => {
    const api = makeApi();
    api.trips.create = vi.fn(async () => {
      throw new Error("403");
    });
    renderTrips(api);
    await userEvent.click(await screen.findByRole("button", { name: /new trip/i }));
    await userEvent.type(screen.getByLabelText("Title"), "Kauai");
    await userEvent.click(screen.getByRole("button", { name: /save trip/i }));
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("still shows the trip when attaching a traveller fails", async () => {
    // The trip exists at this point -- the POST succeeded. Hiding it because
    // a follow-up PUT failed would leave a real trip invisible until reload
    // and invite the operator to create it twice.
    const api = makeApi();
    api.trips.addTraveler = vi.fn(async () => {
      throw new Error("500");
    });
    renderTrips(api);
    await userEvent.click(await screen.findByRole("button", { name: /new trip/i }));
    await userEvent.type(screen.getByLabelText("Title"), "Kauai");
    await userEvent.click(screen.getByRole("button", { name: /Badger/ }));
    await userEvent.click(screen.getByRole("button", { name: /save trip/i }));
    expect(await screen.findByText("Kauai")).toBeInTheDocument();
    expect(await screen.findByRole("alert")).toHaveTextContent(/travellers/i);
  });
});
```

- [ ] **Step 9: Run it to verify it fails**

Run: `npm run test:client -- pages/Trips`
Expected: FAIL — the stub renders only "Trips" and "Not built yet".

- [ ] **Step 10: Write TripForm**

Create `src/client/components/TripForm.tsx`:

```tsx
import { useState } from "react";
import { api as defaultApi } from "../api/client.js";
import type { Person, Trip } from "../api/types.js";
import { errorMessage } from "../lib/errors.js";
import { Dialog } from "./Dialog.js";
import { TravelerToggles } from "./TravelerToggles.js";

/**
 * Creating a trip is two API calls: POST /api/trips, then one
 * PUT /api/trips/:tripId/people/:personId per selected traveller. There is no
 * bulk-roster endpoint and this plan does not add one — four PUTs for a
 * family of four is not worth an endpoint.
 *
 * `onSaved` is called with the created trip even if the roster calls fail,
 * and `onRosterError` reports the failure separately: the trip genuinely
 * exists once the POST returns, and hiding it would invite the operator to
 * create it a second time.
 */
export function TripForm({
  people,
  api = defaultApi,
  onSaved,
  onRosterError,
  onClose,
}: {
  people: Person[];
  api?: typeof defaultApi;
  onSaved: (trip: Trip) => void;
  onRosterError: (message: string) => void;
  onClose: () => void;
}) {
  const [title, setTitle] = useState("");
  const [destination, setDestination] = useState("");
  const [startsOn, setStartsOn] = useState("");
  const [endsOn, setEndsOn] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function toggle(personId: string) {
    setSelected((prev) =>
      prev.includes(personId) ? prev.filter((id) => id !== personId) : [...prev, personId],
    );
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (title.trim() === "") {
      setError("A title is required.");
      return;
    }
    if (startsOn !== "" && endsOn !== "" && endsOn < startsOn) {
      setError("The end date cannot be before the start date.");
      return;
    }
    setBusy(true);
    setError(null);

    let trip: Trip;
    try {
      trip = await api.trips.create({
        title: title.trim(),
        ...(destination === "" ? {} : { destination }),
        ...(startsOn === "" ? {} : { startsOn }),
        ...(endsOn === "" ? {} : { endsOn }),
      });
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
      return;
    }

    // The trip now exists. Roster failures are reported but never undo it.
    try {
      for (const personId of selected) {
        await api.trips.addTraveler(trip.id, personId);
      }
    } catch (err) {
      onRosterError(
        `${trip.title} was created, but its travellers could not be attached. ${errorMessage(err)}`,
      );
    }

    setBusy(false);
    onSaved(trip);
  }

  return (
    <Dialog title="New trip" onClose={onClose}>
      <form onSubmit={submit} style={{ display: "grid", gap: 14 }}>
        {error && (
          <p className="warning" role="alert" style={{ margin: 0 }}>
            {error}
          </p>
        )}

        <div className="field">
          <label htmlFor="tf-title">Title</label>
          <input
            id="tf-title"
            className="input"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </div>

        <div className="field">
          <label htmlFor="tf-destination">Destination</label>
          <input
            id="tf-destination"
            className="input"
            value={destination}
            onChange={(e) => setDestination(e.target.value)}
          />
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <div className="field">
            <label htmlFor="tf-starts">Starts on</label>
            <input
              id="tf-starts"
              className="input"
              type="date"
              value={startsOn}
              onChange={(e) => setStartsOn(e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="tf-ends">Ends on</label>
            <input
              id="tf-ends"
              className="input"
              type="date"
              value={endsOn}
              onChange={(e) => setEndsOn(e.target.value)}
            />
          </div>
        </div>

        <div className="field">
          <label htmlFor="tf-travellers">Who's coming</label>
          <div id="tf-travellers">
            <TravelerToggles people={people} selected={selected} onToggle={toggle} />
          </div>
        </div>

        <div className="dialog-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            Save trip
          </button>
        </div>
      </form>
    </Dialog>
  );
}
```

- [ ] **Step 11: Write the Trips page**

Replace `src/client/pages/Trips.tsx`:

```tsx
import { useEffect, useState } from "react";
import { Plus } from "@phosphor-icons/react";
import { api as defaultApi } from "../api/client.js";
import type { Person, Trip } from "../api/types.js";
import { errorMessage } from "../lib/errors.js";
import { TripCard } from "../home/TripCard.js";
import { TripForm } from "../components/TripForm.js";

export function Trips({
  api = defaultApi,
  today = new Intl.DateTimeFormat("en-CA").format(new Date()),
}: {
  api?: typeof defaultApi;
  today?: string;
}) {
  const [trips, setTrips] = useState<Trip[] | null>(null);
  const [people, setPeople] = useState<Person[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [t, p] = await Promise.all([api.trips.list(), api.people.list()]);
        if (cancelled) return;
        setTrips(t);
        setPeople(p);
      } catch (err) {
        // Same rule as every other fetching component in this app: no silent
        // "Loading…" forever, and no unhandled rejection.
        if (!cancelled) setError(errorMessage(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api]);

  // Soonest first; undated trips last. Matches the API's own ordering and the
  // Home grid's.
  const ordered = (trips ?? []).slice().sort((a, b) => {
    if (a.startsOn === null) return b.startsOn === null ? 0 : 1;
    if (b.startsOn === null) return -1;
    return a.startsOn.localeCompare(b.startsOn);
  });

  return (
    <>
      <header style={{ display: "flex", alignItems: "baseline", gap: 12, marginBottom: 20 }}>
        <div>
          <h3 style={{ marginBottom: 4 }}>Trips</h3>
          <p className="text-muted" style={{ margin: 0 }}>
            Everything upcoming and past.
          </p>
        </div>
        <button
          type="button"
          className="btn btn-primary"
          style={{ marginLeft: "auto" }}
          onClick={() => setCreating(true)}
        >
          <Plus size={14} /> New trip
        </button>
      </header>

      {error && (
        <p className="warning" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="warning" role="alert">
          {notice}
        </p>
      )}

      {!error && trips === null && <p className="text-muted">Loading…</p>}

      {!error && trips !== null && ordered.length === 0 && (
        <div className="card" style={{ alignItems: "flex-start", gap: 10 }}>
          <span className="card-title">No trips yet</span>
          <p className="card-body" style={{ margin: 0 }}>
            Create one and add flights, lodging, and a car to it. Add the family under People
            first if you have not — a trip with no travellers has no day view.
          </p>
          <button type="button" className="btn btn-primary" onClick={() => setCreating(true)}>
            <Plus size={14} /> New trip
          </button>
        </div>
      )}

      {!error && ordered.length > 0 && (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(380px, 1fr))",
            gap: 14,
          }}
        >
          {ordered.map((t) => (
            <TripCard key={t.id} trip={t} bookings={[]} people={[]} today={today} />
          ))}
        </div>
      )}

      {creating && (
        <TripForm
          people={people}
          api={api}
          onSaved={(trip) => {
            setTrips((prev) => [...(prev ?? []), trip]);
            setCreating(false);
          }}
          onRosterError={setNotice}
          onClose={() => setCreating(false)}
        />
      )}
    </>
  );
}
```

`TripCard` is passed `bookings={[]}` and `people={[]}` deliberately: there is no per-trip booking-count endpoint (plan 2 deferred it, plan 3 deferred it again), so the card renders "0 booked · 0 to go" rather than issuing one request per trip. Listed again under "Not in this plan".

- [ ] **Step 12: Run the tests**

Run: `npm run test:client -- "pages/(People|Trips)"`
Expected: PASS — 7 People, 7 Trips.

- [ ] **Step 13: Run the client suite, typecheck, and build**

Run: `npm run test:client && npm run typecheck && npm run build`
Expected: all PASS, both exit 0. New this task: 4 TravelerToggles, 7 People, 7 Trips.

- [ ] **Step 14: Verify against a real server at 390px**

Run: `npm run seed`, then `npm run dev:server` and `npm run dev` in two terminals, with `TRAVEL_HQ_ENV=development` and `TRAVEL_HQ_DEV_EMAIL` set as plan 2 Task 0 describes.
Expected: `/people` shows the seeded person as a card; "Add person" creates a second one and it appears without a reload; `/trips` creates a trip with travellers attached; the grid reflows to one column at 390px with no horizontal scroll.

- [ ] **Step 15: Commit**

```bash
git add src/client/components/TravelerToggles.tsx src/client/components/TripForm.tsx src/client/pages/People.tsx src/client/pages/Trips.tsx tests/client/components/TravelerToggles.test.tsx tests/client/pages/People.test.tsx tests/client/pages/Trips.test.tsx
git commit -m "feat: add the People card grid and the Trips page with trip creation"
```

---

### Task 7: The add-booking dialog, and turning on the inert affordances

**Files:**
- Modify: `src/client/lib/dates.ts`
- Create: `src/client/trip/BookingDialog.tsx`
- Modify: `src/client/trip/OverviewTab.tsx`
- Modify: `src/client/pages/TripDetail.tsx`
- Test: `tests/client/lib/zoned.test.ts`
- Test: `tests/client/trip/BookingDialog.test.tsx`
- Test: `tests/client/trip/OverviewTab-book.test.tsx`
- Test: `tests/client/pages/TripDetail-add.test.tsx`

**Interfaces:**
- Consumes: `Dialog` (Task 5), `TravelerToggles` (Task 6), `api.trips.createBooking` / `api.bookings.assignPerson` / `api.bookings.setStatus` (Tasks 2–3), `BOOKING_STATUSES`
- Produces:
  - `zonedToUtc(localDateTime: string, timeZone: string): string` in `lib/dates.ts`
  - `BookingDialog({ trip, people, api, onSaved, onClose })` — exploration 1g
  - `OverviewTab` gains an optional `onStatusChanged?: (bookingId, status) => void` prop and renders `Book →`
  - `TripDetail` renders `Add booking` and reloads its bookings and rollup after a save

**This is the task plan 3 pointed at.** Its "no dead controls" policy removed three affordances on the explicit promise that plan 4 would wire them; two of them land here, connected to real endpoints. The third — the header edit pencil — stays absent, because there is still no trip-update endpoint and shipping it would recreate the exact problem plan 3 solved.

**The timezone conversion is the correctness risk, not the layout.** Design 1g's fields are "Departs · MDT, from airport" and "Arrives · PDT" — a wall-clock time plus a zone. The API needs a UTC instant plus an IANA zone, validated by `assertTimezonePaired`, and an unparseable value bricks that trip's day view permanently. So the dialog collects `<input type="datetime-local">` plus a zone `<select>`, and converts. `new Date("2026-10-09T09:40")` parses as *the browser's* local time, which is wrong whenever the traveller is not already in the departure zone — which, for a flight, is most of the time.

- [ ] **Step 1: Write the failing conversion test**

Create `tests/client/lib/zoned.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { zonedToUtc } from "../../../src/client/lib/dates.js";

describe("zonedToUtc", () => {
  it("converts a wall-clock time in a named zone to a UTC instant", () => {
    // 9:40 AM MDT (UTC-6) on 2026-10-09 is 15:40 UTC.
    expect(zonedToUtc("2026-10-09T09:40", "America/Boise")).toBe("2026-10-09T15:40:00.000Z");
  });

  it("uses the zone's offset, not the machine's", () => {
    // The same wall clock in a different zone must not produce the same
    // instant. This is the whole reason the helper exists: `new Date(local)`
    // would answer identically for both.
    const boise = zonedToUtc("2026-10-09T09:40", "America/Boise");
    const newYork = zonedToUtc("2026-10-09T09:40", "America/New_York");
    expect(boise).not.toBe(newYork);
    expect(newYork).toBe("2026-10-09T13:40:00.000Z");
  });

  it("applies the offset in force on that date, not today's", () => {
    // January is MST (UTC-7), October is MDT (UTC-6). A fixed offset would
    // get one of these wrong.
    expect(zonedToUtc("2026-01-09T09:40", "America/Boise")).toBe("2026-01-09T16:40:00.000Z");
  });

  it("round-trips through formatTimeInZone", async () => {
    const { formatTimeInZone } = await import("../../../src/client/lib/dates.js");
    expect(formatTimeInZone(zonedToUtc("2026-10-09T09:40", "America/Boise"), "America/Boise"))
      .toBe("9:40 AM");
  });

  it("throws on an unparseable local value rather than producing Invalid Date", () => {
    // A booking whose starts_at is "Invalid Date" passes a non-empty-string
    // check, is stored, and then throws inside ItineraryRepo.localDateOf on
    // every future read of that trip's day view. Fail here instead.
    expect(() => zonedToUtc("not a date", "America/Boise")).toThrow(RangeError);
  });

  it("throws on an unknown timezone", () => {
    expect(() => zonedToUtc("2026-10-09T09:40", "Mars/Olympus")).toThrow(RangeError);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run test:client -- lib/zoned`
Expected: FAIL — `zonedToUtc` is not exported from `lib/dates.js`.

- [ ] **Step 3: Add the conversion to lib/dates.ts**

Append to `src/client/lib/dates.ts`:

```ts
/**
 * The offset, in milliseconds, that `timeZone` was on at `instant`.
 * Computed by formatting the instant in that zone and reading the result back
 * as if it were UTC; the difference is the offset. This is the portable way —
 * there is no API that hands you a zone's offset for a date directly.
 */
function offsetAt(instant: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(instant));

  const read = (type: string): number =>
    Number(parts.find((p) => p.type === type)?.value ?? "0");

  const asUtc = Date.UTC(
    read("year"),
    read("month") - 1,
    read("day"),
    // Some engines render midnight as hour 24 under hour12:false.
    read("hour") % 24,
    read("minute"),
    read("second"),
  );
  return asUtc - instant;
}

/**
 * Convert a wall-clock local time (`"2026-10-09T09:40"`, as produced by
 * `<input type="datetime-local">`) in a named IANA zone into a UTC ISO
 * instant.
 *
 * `new Date("2026-10-09T09:40")` interprets the string in the *browser's*
 * zone, which is wrong for every flight that does not depart from where the
 * person filling in the form happens to be sitting. Storing that value would
 * put the booking on the wrong day in the itinerary.
 *
 * Throws `RangeError` rather than returning an "Invalid Date" — a booking
 * with an unparseable `starts_at` passes a non-empty-string check, is stored,
 * and then throws inside `ItineraryRepo.localDateOf()` on every future read
 * of that trip's day view, with no API route to repair it.
 */
export function zonedToUtc(localDateTime: string, timeZone: string): string {
  // Reject the zone first, so a bad zone is never blamed on the date.
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
  } catch {
    throw new RangeError(`${timeZone} is not a recognised IANA timezone`);
  }

  // Read the wall clock as though it were UTC; the true instant differs from
  // this by exactly the zone's offset.
  const naive = Date.parse(`${localDateTime}:00.000Z`);
  if (Number.isNaN(naive)) {
    throw new RangeError(`${localDateTime} is not a parseable local date-time`);
  }

  // Two passes: the first guess can land on the wrong side of a DST
  // transition, and re-deriving the offset at the guessed instant settles it.
  let instant = naive - offsetAt(naive, timeZone);
  instant = naive - offsetAt(instant, timeZone);
  return new Date(instant).toISOString();
}
```

- [ ] **Step 4: Run the conversion test**

Run: `npm run test:client -- lib/zoned`
Expected: PASS, 6 tests.

- [ ] **Step 5: Write the failing BookingDialog test**

Create `tests/client/trip/BookingDialog.test.tsx`:

```tsx
import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BookingDialog } from "../../../src/client/trip/BookingDialog.js";

/**
 * `userEvent.type()` into `<input type="datetime-local">` is unreliable under
 * jsdom — it types character by character against a control jsdom does not
 * implement segment editing for, and frequently leaves the value empty, which
 * would make the two timezone assertions below pass or fail for reasons
 * unrelated to what they test. `fireEvent.change` sets the value the way the
 * browser would have and fires the one React `onChange` the component reads.
 *
 * Do not "modernise" this back to userEvent.type.
 */
function setDateTime(label: string, value: string): void {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

const TRIP = {
  id: "t1",
  title: "Mary & Winter Wedding",
  destination: "Guerneville, CA",
  startsOn: "2026-10-09",
  endsOn: "2026-10-11",
  status: "planning" as const,
  notes: null,
};

const PEOPLE = [
  { id: "p1", displayName: "Badger" },
  { id: "p2", displayName: "Ava" },
];

function makeApi() {
  return {
    trips: { createBooking: vi.fn(async () => ({ id: "b1" })) },
    bookings: { assignPerson: vi.fn(async () => undefined) },
  };
}

function renderDialog(api = makeApi(), onSaved = vi.fn()) {
  render(
    <BookingDialog
      trip={TRIP}
      people={PEOPLE as never}
      api={api as never}
      onSaved={onSaved}
      onClose={vi.fn()}
    />,
  );
  return { api, onSaved };
}

describe("BookingDialog", () => {
  it("opens on Flight with the flight fieldset", () => {
    renderDialog();
    expect(screen.getByRole("radio", { name: "Flight" })).toBeChecked();
    expect(screen.getByLabelText(/Airline/)).toBeInTheDocument();
    expect(screen.getByLabelText("From")).toBeInTheDocument();
  });

  it("morphs the middle fieldset when the kind changes", async () => {
    renderDialog();
    await userEvent.click(screen.getByRole("radio", { name: "Stay" }));
    expect(screen.getByLabelText(/Property/)).toBeInTheDocument();
    expect(screen.queryByLabelText("From")).not.toBeInTheDocument();
  });

  it("switches kinds from the keyboard", async () => {
    // A native radio group, as in plan 3's tab strip — arrow keys come from
    // the platform, and a test that only clicks would pass against a broken
    // custom widget.
    renderDialog();
    const flight = screen.getByRole("radio", { name: "Flight" });
    flight.focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(screen.getByRole("radio", { name: "Stay" })).toBeChecked();
  });

  it("sends a UTC instant and its zone, not the raw wall clock", async () => {
    const { api } = renderDialog();
    await userEvent.type(screen.getByLabelText("Title"), "DL2214 BOI → STS");
    await userEvent.type(screen.getByLabelText(/Airline/), "Delta");
    await userEvent.type(screen.getByLabelText(/Flight number/), "2214");
    await userEvent.type(screen.getByLabelText("From"), "BOI");
    await userEvent.type(screen.getByLabelText("To"), "STS");
    // Exact strings, not /^Departs/: the dialog has BOTH "Departs / starts"
    // and "Departs timezone", and Testing Library throws on a multiple match.
    setDateTime("Departs / starts", "2026-10-09T09:40");
    await userEvent.selectOptions(screen.getByLabelText("Departs timezone"), "America/Boise");
    await userEvent.click(screen.getByRole("button", { name: /save booking/i }));

    expect(api.trips.createBooking).toHaveBeenCalledWith(
      "t1",
      expect.objectContaining({
        kind: "flight",
        startsAt: "2026-10-09T15:40:00.000Z",
        startsAtTz: "America/Boise",
      }),
    );
  });

  it("never sends a timestamp without its zone", async () => {
    // assertTimezonePaired rejects this server-side with a 400, but a form
    // that can compose the invalid request will do it to a real operator at
    // the worst moment. Refuse locally and say why.
    const { api } = renderDialog();
    await userEvent.type(screen.getByLabelText("Title"), "DL2214");
    await userEvent.type(screen.getByLabelText(/Airline/), "Delta");
    await userEvent.type(screen.getByLabelText(/Flight number/), "2214");
    await userEvent.type(screen.getByLabelText("From"), "BOI");
    await userEvent.type(screen.getByLabelText("To"), "STS");
    setDateTime("Departs / starts", "2026-10-09T09:40");
    await userEvent.selectOptions(screen.getByLabelText("Departs timezone"), "");
    await userEvent.click(screen.getByRole("button", { name: /save booking/i }));
    expect(api.trips.createBooking).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent(/timezone/i);
  });

  it("attaches every toggled traveller to the created booking", async () => {
    const { api } = renderDialog();
    await userEvent.click(screen.getByRole("radio", { name: "Activity" }));
    await userEvent.type(screen.getByLabelText("Title"), "Rehearsal dinner");
    await userEvent.click(screen.getByRole("button", { name: /Badger/ }));
    await userEvent.click(screen.getByRole("button", { name: /Ava/ }));
    await userEvent.click(screen.getByRole("button", { name: /save booking/i }));
    expect(api.bookings.assignPerson).toHaveBeenCalledWith("b1", "p1");
    expect(api.bookings.assignPerson).toHaveBeenCalledWith("b1", "p2");
  });

  it("defaults the status to Booked and sends the chosen one", async () => {
    const { api } = renderDialog();
    expect(screen.getByRole("radio", { name: "Booked" })).toBeChecked();
    await userEvent.click(screen.getByRole("radio", { name: "Planned" }));
    await userEvent.click(screen.getByRole("radio", { name: "Activity" }));
    await userEvent.type(screen.getByLabelText("Title"), "Rehearsal dinner");
    await userEvent.click(screen.getByRole("button", { name: /save booking/i }));
    expect(api.trips.createBooking).toHaveBeenCalledWith(
      "t1",
      expect.objectContaining({ status: "planned" }),
    );
  });

  it("sends cost as integer cents", async () => {
    const { api } = renderDialog();
    await userEvent.click(screen.getByRole("radio", { name: "Activity" }));
    await userEvent.type(screen.getByLabelText("Title"), "Rehearsal dinner");
    await userEvent.type(screen.getByLabelText("Cost"), "684.30");
    await userEvent.click(screen.getByRole("button", { name: /save booking/i }));
    expect(api.trips.createBooking).toHaveBeenCalledWith(
      "t1",
      expect.objectContaining({ costCents: 68430 }),
    );
  });

  it("refuses to submit without a title", async () => {
    const { api } = renderDialog();
    await userEvent.click(screen.getByRole("button", { name: /save booking/i }));
    expect(api.trips.createBooking).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent(/title/i);
  });

  it("keeps the dialog open and reports a rejected save", async () => {
    const api = makeApi();
    api.trips.createBooking = vi.fn(async () => {
      throw new Error("400");
    });
    const { onSaved } = renderDialog(api);
    await userEvent.click(screen.getByRole("radio", { name: "Activity" }));
    await userEvent.type(screen.getByLabelText("Title"), "Rehearsal dinner");
    await userEvent.click(screen.getByRole("button", { name: /save booking/i }));
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(onSaved).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `npm run test:client -- BookingDialog`
Expected: FAIL — cannot resolve `src/client/trip/BookingDialog.js`.

- [ ] **Step 7: Write BookingDialog**

Create `src/client/trip/BookingDialog.tsx`:

```tsx
import { useState } from "react";
import { AirplaneTakeoff, Bed, Car, Ticket } from "@phosphor-icons/react";
import { api as defaultApi } from "../api/client.js";
import type { BookingStatus, Person, Trip } from "../api/types.js";
import { zonedToUtc } from "../lib/dates.js";
import { errorMessage } from "../lib/errors.js";
import { Dialog } from "../components/Dialog.js";
import { TravelerToggles } from "../components/TravelerToggles.js";

/**
 * Exploration 1g: one dialog, a kind segmented control that morphs the middle
 * fieldset, "who's on it" per booking (not per trip), cost, and a
 * Planned/Booked status control.
 *
 * The kind list matches BOOKING_KINDS on the server minus "other", which is
 * the freeform escape hatch and has no fields of its own to draw.
 */
const KINDS = [
  { id: "flight", label: "Flight", Icon: AirplaneTakeoff },
  { id: "lodging", label: "Stay", Icon: Bed },
  { id: "car", label: "Car", Icon: Car },
  { id: "activity", label: "Activity", Icon: Ticket },
] as const;

type Kind = (typeof KINDS)[number]["id"];

/**
 * A short, curated zone list rather than `Intl.supportedValuesOf("timeZone")`
 * — that returns ~600 entries, which is an unusable <select>, and it is not
 * available on every runtime (the server code avoids it for the same reason).
 * The viewer's own zone is prepended so the common case is one click.
 */
const COMMON_ZONES = [
  "America/Los_Angeles",
  "America/Denver",
  "America/Boise",
  "America/Chicago",
  "America/New_York",
  "Europe/London",
  "Europe/Paris",
  "Asia/Tokyo",
  "Australia/Sydney",
  "Pacific/Honolulu",
  "UTC",
];

function zoneOptions(): string[] {
  const local = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return [local, ...COMMON_ZONES.filter((z) => z !== local)];
}

/** "684.30" -> 68430. Returns undefined for blank, null for unparseable. */
function toCents(raw: string): number | null | undefined {
  const trimmed = raw.trim();
  if (trimmed === "") return undefined;
  const value = Number(trimmed.replace(/[$,]/g, ""));
  if (!Number.isFinite(value)) return null;
  return Math.round(value * 100);
}

export function BookingDialog({
  trip,
  people,
  api = defaultApi,
  onSaved,
  onClose,
}: {
  trip: Trip;
  /** The trip's travellers, so the toggles list who is actually on this trip. */
  people: Person[];
  api?: typeof defaultApi;
  onSaved: () => void;
  onClose: () => void;
}) {
  const [kind, setKind] = useState<Kind>("flight");
  const [title, setTitle] = useState("");
  const [confirmationNumber, setConfirmationNumber] = useState("");
  const [location, setLocation] = useState("");

  // Per-kind detail fields. Held flat and assembled per kind at submit time,
  // so switching kinds does not discard what was typed.
  const [carrier, setCarrier] = useState("");
  const [flightNumber, setFlightNumber] = useState("");
  const [originIata, setOriginIata] = useState("");
  const [destinationIata, setDestinationIata] = useState("");
  const [propertyName, setPropertyName] = useState("");
  const [vendor, setVendor] = useState("");
  const [venue, setVenue] = useState("");

  const [startsAt, setStartsAt] = useState("");
  const [startsAtTz, setStartsAtTz] = useState("");
  const [endsAt, setEndsAt] = useState("");
  const [endsAtTz, setEndsAtTz] = useState("");

  const [selected, setSelected] = useState<string[]>([]);
  const [cost, setCost] = useState("");
  const [status, setStatus] = useState<BookingStatus>("booked");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const zones = zoneOptions();

  function toggle(personId: string) {
    setSelected((prev) =>
      prev.includes(personId) ? prev.filter((id) => id !== personId) : [...prev, personId],
    );
  }

  /**
   * Per-kind `details`, validated server-side by the matching Zod schema in
   * `src/server/schemas/booking-kinds.ts`. Required fields there (carrier,
   * flightNumber, the two IATA codes, propertyName, vendor) are required
   * here too, because a ZodError from the server surfaces as a bare
   * "Invalid request" the operator cannot act on.
   */
  function details(): Record<string, unknown> {
    switch (kind) {
      case "flight":
        return {
          carrier: carrier.trim(),
          flightNumber: flightNumber.trim(),
          originIata: originIata.trim(),
          destinationIata: destinationIata.trim(),
        };
      case "lodging":
        return { propertyName: propertyName.trim() };
      case "car":
        return { vendor: vendor.trim() };
      case "activity":
        return venue.trim() === "" ? {} : { venue: venue.trim() };
    }
  }

  function detailsProblem(): string | null {
    if (kind === "flight") {
      if (carrier.trim() === "" || flightNumber.trim() === "") {
        return "A flight needs an airline and a flight number.";
      }
      if (originIata.trim().length !== 3 || destinationIata.trim().length !== 3) {
        return "From and To must each be a three-letter airport code.";
      }
    }
    if (kind === "lodging" && propertyName.trim() === "") return "A stay needs a property name.";
    if (kind === "car" && vendor.trim() === "") return "A car needs a rental company.";
    return null;
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (title.trim() === "") {
      setError("A title is required.");
      return;
    }
    const problem = detailsProblem();
    if (problem !== null) {
      setError(problem);
      return;
    }
    // A timestamp without its zone renders every cross-timezone itinerary
    // wrong, so the server rejects the pair outright. Catch it here, where
    // the message can name the field.
    if (startsAt !== "" && startsAtTz === "") {
      setError("Pick a timezone for the start time.");
      return;
    }
    if (endsAt !== "" && endsAtTz === "") {
      setError("Pick a timezone for the end time.");
      return;
    }
    const cents = toCents(cost);
    if (cents === null) {
      setError("Cost must be a number.");
      return;
    }

    let startsUtc: string | undefined;
    let endsUtc: string | undefined;
    try {
      if (startsAt !== "") startsUtc = zonedToUtc(startsAt, startsAtTz);
      if (endsAt !== "") endsUtc = zonedToUtc(endsAt, endsAtTz);
    } catch (err) {
      setError(err instanceof RangeError ? err.message : errorMessage(err));
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const booking = await api.trips.createBooking(trip.id, {
        kind,
        title: title.trim(),
        status,
        details: details(),
        ...(location.trim() === "" ? {} : { location: location.trim() }),
        ...(confirmationNumber.trim() === ""
          ? {}
          : { confirmationNumber: confirmationNumber.trim() }),
        ...(startsUtc ? { startsAt: startsUtc, startsAtTz } : {}),
        ...(endsUtc ? { endsAt: endsUtc, endsAtTz } : {}),
        ...(cents === undefined ? {} : { costCents: cents }),
      });
      for (const personId of selected) {
        await api.bookings.assignPerson(booking.id, personId);
      }
      onSaved();
    } catch (err) {
      // Never close on failure. A 400 from a per-kind schema or a 403 for a
      // viewer must leave the typed booking on screen.
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog title="Add booking" subtitle={trip.title} onClose={onClose}>
      <form onSubmit={submit} style={{ display: "grid", gap: 14 }}>
        {error && (
          <p className="warning" role="alert" style={{ margin: 0 }}>
            {error}
          </p>
        )}

        <div className="seg" role="radiogroup" aria-label="Booking kind" style={{ width: "100%" }}>
          {KINDS.map(({ id, label, Icon }) => (
            <label key={id} className="seg-opt" style={{ flex: 1, justifyContent: "center" }}>
              <input
                type="radio"
                name="booking-kind"
                value={id}
                checked={kind === id}
                onChange={() => setKind(id)}
              />
              <Icon size={14} /> {label}
            </label>
          ))}
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <div className="field">
            <label htmlFor="bd-title">Title</label>
            <input
              id="bd-title"
              className="input"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="bd-conf">Confirmation #</label>
            <input
              id="bd-conf"
              className="input"
              autoComplete="off"
              placeholder="ABC123"
              value={confirmationNumber}
              onChange={(e) => setConfirmationNumber(e.target.value)}
            />
          </div>
        </div>

        {kind === "flight" && (
          <>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <div className="field">
                <label htmlFor="bd-carrier">Airline</label>
                <input
                  id="bd-carrier"
                  className="input"
                  value={carrier}
                  onChange={(e) => setCarrier(e.target.value)}
                />
              </div>
              <div className="field">
                <label htmlFor="bd-flightno">Flight number</label>
                <input
                  id="bd-flightno"
                  className="input"
                  value={flightNumber}
                  onChange={(e) => setFlightNumber(e.target.value)}
                />
              </div>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <div className="field">
                <label htmlFor="bd-from">From</label>
                <input
                  id="bd-from"
                  className="input"
                  maxLength={3}
                  placeholder="BOI"
                  value={originIata}
                  onChange={(e) => setOriginIata(e.target.value)}
                />
              </div>
              <div className="field">
                <label htmlFor="bd-to">To</label>
                <input
                  id="bd-to"
                  className="input"
                  maxLength={3}
                  placeholder="STS"
                  value={destinationIata}
                  onChange={(e) => setDestinationIata(e.target.value)}
                />
              </div>
            </div>
          </>
        )}

        {kind === "lodging" && (
          <div className="field">
            <label htmlFor="bd-property">Property name</label>
            <input
              id="bd-property"
              className="input"
              value={propertyName}
              onChange={(e) => setPropertyName(e.target.value)}
            />
          </div>
        )}

        {kind === "car" && (
          <div className="field">
            <label htmlFor="bd-vendor">Rental company</label>
            <input
              id="bd-vendor"
              className="input"
              value={vendor}
              onChange={(e) => setVendor(e.target.value)}
            />
          </div>
        )}

        {kind === "activity" && (
          <div className="field">
            <label htmlFor="bd-venue">Venue</label>
            <input
              id="bd-venue"
              className="input"
              value={venue}
              onChange={(e) => setVenue(e.target.value)}
            />
          </div>
        )}

        <div className="field">
          <label htmlFor="bd-location">Location</label>
          <input
            id="bd-location"
            className="input"
            value={location}
            onChange={(e) => setLocation(e.target.value)}
          />
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <div className="field">
            <label htmlFor="bd-starts">Departs / starts</label>
            <input
              id="bd-starts"
              className="input"
              type="datetime-local"
              value={startsAt}
              onChange={(e) => setStartsAt(e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="bd-starts-tz">Departs timezone</label>
            <select
              id="bd-starts-tz"
              className="input"
              value={startsAtTz}
              onChange={(e) => setStartsAtTz(e.target.value)}
            >
              <option value="">Pick a timezone…</option>
              {zones.map((z) => (
                <option key={z} value={z}>
                  {z}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <div className="field">
            <label htmlFor="bd-ends">Arrives / ends</label>
            <input
              id="bd-ends"
              className="input"
              type="datetime-local"
              value={endsAt}
              onChange={(e) => setEndsAt(e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="bd-ends-tz">Arrives timezone</label>
            <select
              id="bd-ends-tz"
              className="input"
              value={endsAtTz}
              onChange={(e) => setEndsAtTz(e.target.value)}
            >
              <option value="">Pick a timezone…</option>
              {zones.map((z) => (
                <option key={z} value={z}>
                  {z}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="field">
          <label htmlFor="bd-who">Who's on it</label>
          <div id="bd-who">
            <TravelerToggles people={people} selected={selected} onToggle={toggle} />
          </div>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <div className="field">
            <label htmlFor="bd-cost">Cost</label>
            <input
              id="bd-cost"
              className="input"
              inputMode="decimal"
              placeholder="684.30"
              value={cost}
              onChange={(e) => setCost(e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="bd-status">Status</label>
            <div className="seg" role="radiogroup" aria-label="Status" style={{ width: "100%" }}>
              {(["planned", "booked"] as const).map((s) => (
                <label key={s} className="seg-opt" style={{ flex: 1, justifyContent: "center" }}>
                  <input
                    type="radio"
                    name="booking-status"
                    value={s}
                    checked={status === s}
                    onChange={() => setStatus(s)}
                  />
                  {s === "planned" ? "Planned" : "Booked"}
                </label>
              ))}
            </div>
          </div>
        </div>

        <div className="dialog-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            Save booking
          </button>
        </div>
      </form>
    </Dialog>
  );
}
```

The status control offers only Planned and Booked, matching design 1g. `draft` is reachable only through the import flow, and `cancelled` needs a delete-or-cancel affordance this plan does not build.

- [ ] **Step 8: Run the BookingDialog test**

Run: `npm run test:client -- BookingDialog`
Expected: PASS, 10 tests.

- [ ] **Step 9: Write the failing Book → test**

Create `tests/client/trip/OverviewTab-book.test.tsx`:

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { OverviewTab } from "../../../src/client/trip/OverviewTab.js";

const TRIP = {
  id: "t1", title: "Wedding", destination: "Guerneville, CA",
  startsOn: "2026-10-09", endsOn: "2026-10-11",
  status: "planning" as const, notes: null,
};

function booking(over: Record<string, unknown> = {}) {
  return {
    id: "b1", tripId: "t1", kind: "lodging", title: "Dawn Ranch Lodge",
    location: null, startsAt: null, startsAtTz: null, endsAt: null, endsAtTz: null,
    confirmationNumberMasked: null, costCents: null,
    pointsUsed: null, pointsProgram: null,
    status: "planned" as const, details: {}, personIds: [],
    ...over,
  };
}

const ZERO = { bookedCents: 0, plannedCents: 0, totalCents: 0, points: [] };

function makeApi() {
  return {
    trips: { revealConfirmation: vi.fn() },
    bookings: { setStatus: vi.fn(async () => undefined) },
  };
}

function renderTab(bookings: unknown[], api = makeApi(), onStatusChanged = vi.fn()) {
  render(
    <OverviewTab
      trip={TRIP}
      bookings={bookings as never}
      people={[] as never}
      rollup={ZERO}
      api={api as never}
      onStatusChanged={onStatusChanged}
    />,
  );
  return { api, onStatusChanged };
}

describe("OverviewTab — Book →", () => {
  it("offers Book → on a provisional row", () => {
    renderTab([booking()]);
    expect(screen.getByRole("button", { name: /book dawn ranch lodge/i })).toBeInTheDocument();
  });

  it("offers no Book → on an already-booked row", () => {
    renderTab([booking({ status: "booked" })]);
    expect(screen.queryByRole("button", { name: /^book /i })).not.toBeInTheDocument();
  });

  it("promotes the booking and reports the change", async () => {
    const { api, onStatusChanged } = renderTab([booking()]);
    await userEvent.click(screen.getByRole("button", { name: /book dawn ranch lodge/i }));
    expect(api.bookings.setStatus).toHaveBeenCalledWith("b1", "booked");
    expect(onStatusChanged).toHaveBeenCalled();
  });

  it("reports a rejected promotion rather than silently doing nothing", async () => {
    const api = makeApi();
    api.bookings.setStatus = vi.fn(async () => {
      throw new Error("403");
    });
    const { onStatusChanged } = renderTab([booking()], api);
    await userEvent.click(screen.getByRole("button", { name: /book dawn ranch lodge/i }));
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(onStatusChanged).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 10: Wire Book → into OverviewTab**

In `src/client/trip/OverviewTab.tsx`, add `useState` and `errorMessage` to the imports:

```tsx
import { useState } from "react";
import { errorMessage } from "../lib/errors.js";
```

Add `onStatusChanged` to the props type and destructuring:

```tsx
  onStatusChanged,
```
```tsx
  /**
   * Optional so plan 3's existing OverviewTab tests, which do not supply it,
   * keep passing unchanged. When absent, Book → is not rendered — the same
   * "no dead controls" rule, applied to a component used in two places.
   */
  onStatusChanged?: () => void;
```

Add local state just above `const visible = ...`:

```tsx
  const [failed, setFailed] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  async function book(bookingId: string) {
    setBusyId(bookingId);
    try {
      await api.bookings.setStatus(bookingId, "booked");
      setFailed(null);
      onStatusChanged?.();
    } catch (err) {
      // A 403 (viewer) or 404 (deleted in another tab) must say so. Silently
      // re-enabling the button is the failure mode this plan exists to avoid.
      setFailed(errorMessage(err));
    } finally {
      setBusyId(null);
    }
  }
```

Render the error above the two-column layout, immediately inside the returned fragment's outer `<div>`:

```tsx
        {failed && (
          <p className="warning" role="alert" style={{ flexBasis: "100%" }}>
            {failed}
          </p>
        )}
```

And inside the booking row's `card-meta`, after the cost span, add:

```tsx
                        {provisional && onStatusChanged && (
                          <button
                            type="button"
                            className="btn btn-ghost"
                            style={{ fontSize: 11 }}
                            aria-label={`Book ${b.title}`}
                            disabled={busyId === b.id}
                            onClick={() => void book(b.id)}
                          >
                            Book →
                          </button>
                        )}
```

`provisional` (draft or planned) is already computed in the row body by plan 3.

- [ ] **Step 11: Run the Book → test**

Run: `npm run test:client -- OverviewTab`
Expected: PASS — 7 from plan 3's `OverviewTab.test.tsx` (unmodified) and 4 from `OverviewTab-book.test.tsx`.

- [ ] **Step 12: Write the failing TripDetail wiring test**

Create `tests/client/pages/TripDetail-add.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import { TripDetail } from "../../../src/client/pages/TripDetail.js";

const TRIP = {
  id: "t1", title: "Mary & Winter Wedding", destination: "Guerneville, CA",
  startsOn: "2026-10-09", endsOn: "2026-10-11",
  status: "planning" as const, notes: null,
};
const PEOPLE = [{ id: "p1", displayName: "Badger" }];
const ZERO = { bookedCents: 0, plannedCents: 0, totalCents: 0, points: [] };

function makeApi() {
  return {
    trips: {
      list: vi.fn(async () => [TRIP]),
      bookings: vi.fn(async () => []),
      travelers: vi.fn(async () => PEOPLE),
      itinerary: vi.fn(async () => []),
      rollup: vi.fn(async () => ZERO),
      revealConfirmation: vi.fn(),
      createBooking: vi.fn(async () => ({ id: "b1" })),
    },
    people: { list: vi.fn(async () => PEOPLE), reveal: vi.fn() },
    bookings: { assignPerson: vi.fn(), setStatus: vi.fn() },
    checklist: { list: vi.fn(async () => []), create: vi.fn(), setDone: vi.fn() },
  };
}

function renderDetail(api = makeApi()) {
  const { hook } = memoryLocation({ path: "/trips/t1" });
  render(
    <Router hook={hook}>
      <TripDetail id="t1" api={api as never} today="2026-07-21" />
    </Router>,
  );
  return api;
}

beforeEach(() => {
  window.history.replaceState(null, "", "/trips/t1");
});

describe("TripDetail — add booking", () => {
  it("offers Add booking in the header", async () => {
    renderDetail();
    expect(await screen.findByRole("button", { name: /add booking/i })).toBeInTheDocument();
  });

  it("opens the booking dialog", async () => {
    renderDetail();
    await userEvent.click(await screen.findByRole("button", { name: /add booking/i }));
    expect(screen.getByRole("dialog")).toHaveAccessibleName("Add booking");
  });

  it("still offers no trip-edit control", async () => {
    // Deliberate: there is no trip-update endpoint, so design 1b's pencil
    // stays absent rather than becoming a second inert affordance.
    renderDetail();
    await screen.findByRole("button", { name: /add booking/i });
    expect(screen.queryByRole("button", { name: /edit trip/i })).not.toBeInTheDocument();
  });

  it("reloads bookings and the rollup after a booking is saved", async () => {
    const api = renderDetail();
    await userEvent.click(await screen.findByRole("button", { name: /add booking/i }));
    await userEvent.click(screen.getByRole("radio", { name: "Activity" }));
    await userEvent.type(screen.getByLabelText("Title"), "Rehearsal dinner");
    await userEvent.click(screen.getByRole("button", { name: /save booking/i }));
    // Once on mount, once after the save. Without the reload the new booking
    // is invisible until a manual refresh and the cost panel disagrees with
    // the list beside it.
    await vi.waitFor(() => expect(api.trips.bookings).toHaveBeenCalledTimes(2));
    expect(api.trips.rollup).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 13: Wire TripDetail**

In `src/client/pages/TripDetail.tsx`, add the imports:

```tsx
import { Plus } from "@phosphor-icons/react";
import { BookingDialog } from "../trip/BookingDialog.js";
```

Add state beside the existing state hooks:

```tsx
  const [addingBooking, setAddingBooking] = useState(false);
  // Bumped after any write, to re-run the load effect. Simpler and less
  // error-prone than threading a refetch callback through four tab
  // components, and it reloads the rollup and the booking list together —
  // they are rendered side by side and must not disagree.
  const [reloadKey, setReloadKey] = useState(0);
```

Add `reloadKey` to the load effect's dependency array:

```tsx
  }, [api, id, reloadKey]);
```

Add the button to the header, after `<PersonChips people={travelers} />`:

```tsx
        <button
          type="button"
          className="btn btn-primary"
          style={{ marginLeft: "auto" }}
          onClick={() => setAddingBooking(true)}
        >
          <Plus size={14} /> Add booking
        </button>
```

Pass the reload callback to `OverviewTab`:

```tsx
          onStatusChanged={() => setReloadKey((n) => n + 1)}
```

And render the dialog just before the closing `</>`:

```tsx
      {addingBooking && (
        <BookingDialog
          trip={trip}
          people={travelers}
          api={api}
          onSaved={() => {
            setAddingBooking(false);
            setReloadKey((n) => n + 1);
          }}
          onClose={() => setAddingBooking(false)}
        />
      )}
```

`people={travelers}` and not the whole household: "who's on it" should offer the people on this trip. Someone not yet on the trip is added through the trip form, not here.

- [ ] **Step 14: Run the tests**

Run: `npm run test:client -- TripDetail`
Expected: PASS — 9 from plan 3's `TripDetail.test.tsx` (unmodified) and 4 from `TripDetail-add.test.tsx`.

- [ ] **Step 15: Run everything**

Run: `npm run test:all && npm run typecheck && npm run build`
Expected: all PASS, both exit 0.

- [ ] **Step 16: Verify end to end against a real server**

With the dev server and seed from plan 2 Task 0 running: create a trip, add a flight with a departure in `America/Boise` and an arrival in `America/New_York`, and open the Day by day tab.
Expected: the flight appears on the correct local day, the time gutter shows both zones, the confirmation renders masked, and `Book →` on a planned row flips it to booked and updates the cost rollup beside it. This exercises spec success criterion 2 through the UI for the first time.

- [ ] **Step 17: Commit**

```bash
git add src/client/lib/dates.ts src/client/trip/BookingDialog.tsx src/client/trip/OverviewTab.tsx src/client/pages/TripDetail.tsx tests/client/lib/zoned.test.ts tests/client/trip/BookingDialog.test.tsx tests/client/trip/OverviewTab-book.test.tsx tests/client/pages/TripDetail-add.test.tsx
git commit -m "feat: add the booking dialog and wire Add booking and Book"
```

---

### Task 8: "Next best actions" on Home

**Files:**
- Create: `src/client/home/NextBestActions.tsx`
- Modify: `src/client/pages/Home.tsx`
- Test: `tests/client/home/NextBestActions.test.tsx`

**Interfaces:**
- Consumes: `api.checklist.list()` / `api.checklist.setDone()` (plan 3 Task 1 and Task 3), `daysUntil` (plan 2 Task 4), `errorMessage`
- Produces: `NextBestActions({ api })`

This card was deferred twice — plan 2 deferred it to plan 3 because it needed `checklist_item` repositories, and plan 3 built `ChecklistRepo`, `GET/POST /api/checklist`, and `api.checklist.*` but deferred the card itself to plan 4 to avoid two plans editing `Home.tsx` concurrently. **Both blockers are gone: the repository and the client method exist, and plan 2 is complete.** No backend work is required.

Ranking, per plan 3's note: undone items first, then by `dueOn` ascending with undated items last.

**One disclosed deviation from the design.** The prototype colours row urgency three ways, including amber for "132 days" on *Renew Finn's passport*, because that row is a passport blocker rather than because 132 days is a threshold. A generic checklist item carries no such signal, so this card uses a rule it can actually evaluate: **overdue is amber, due today is accent, everything else is muted.** Passport-specific amber already exists where the data supports it — `TripWarnings` and `PersonCard`, from Task 4.

- [ ] **Step 1: Write the failing test**

Create `tests/client/home/NextBestActions.test.tsx`:

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import { NextBestActions } from "../../../src/client/home/NextBestActions.js";

function item(over: Record<string, unknown> = {}) {
  return {
    id: "c1",
    tripId: "t1",
    personId: null,
    label: "Check in for DL 2214",
    dueOn: "2026-07-25",
    doneAt: null,
    ...over,
  };
}

function makeApi(items = [item()]) {
  return {
    checklist: {
      list: vi.fn(async () => items),
      setDone: vi.fn(async () => undefined),
    },
  };
}

function renderCard(api = makeApi()) {
  const { hook } = memoryLocation({ path: "/" });
  render(
    <Router hook={hook}>
      <NextBestActions api={api as never} today="2026-07-21" />
    </Router>,
  );
  return api;
}

describe("NextBestActions", () => {
  it("lists open items", async () => {
    renderCard();
    expect(await screen.findByText("Check in for DL 2214")).toBeInTheDocument();
  });

  it("puts undone items above done ones", async () => {
    renderCard(
      makeApi([
        item({ id: "c1", label: "Already done", doneAt: "2026-07-20T00:00:00Z", dueOn: null }),
        item({ id: "c2", label: "Still open", dueOn: null }),
      ]),
    );
    const labels = (await screen.findAllByTestId("action-label")).map((el) => el.textContent);
    expect(labels).toEqual(["Still open", "Already done"]);
  });

  it("orders undone items by due date with undated ones last", async () => {
    renderCard(
      makeApi([
        item({ id: "c1", label: "No date", dueOn: null }),
        item({ id: "c2", label: "Later", dueOn: "2026-08-01" }),
        item({ id: "c3", label: "Sooner", dueOn: "2026-07-22" }),
      ]),
    );
    const labels = (await screen.findAllByTestId("action-label")).map((el) => el.textContent);
    expect(labels).toEqual(["Sooner", "Later", "No date"]);
  });

  it("shows how long is left, and flags an overdue item", async () => {
    renderCard(
      makeApi([
        item({ id: "c1", label: "Overdue", dueOn: "2026-07-19" }),
        item({ id: "c2", label: "Due today", dueOn: "2026-07-21" }),
        item({ id: "c3", label: "Later", dueOn: "2026-07-25" }),
      ]),
    );
    expect(await screen.findByText("overdue")).toBeInTheDocument();
    expect(screen.getByText("today")).toBeInTheDocument();
    expect(screen.getByText("4 days")).toBeInTheDocument();
  });

  it("toggles an item done on click", async () => {
    const api = renderCard();
    await userEvent.click(await screen.findByRole("button", { name: /Check in for DL 2214/ }));
    expect(api.checklist.setDone).toHaveBeenCalledWith("c1", true);
    expect(await screen.findByTestId("action-row-c1")).toHaveAttribute("data-done", "true");
  });

  it("leaves the row as it was when the write is rejected", async () => {
    // Optimistically showing a state the server refused is worse than showing
    // nothing: the operator believes the passport renewal is ticked off.
    const api = makeApi();
    api.checklist.setDone = vi.fn(async () => {
      throw new Error("403");
    });
    renderCard(api);
    await userEvent.click(await screen.findByRole("button", { name: /Check in for DL 2214/ }));
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.getByTestId("action-row-c1")).toHaveAttribute("data-done", "false");
  });

  it("renders nothing at all when there are no checklist items", async () => {
    const { container } = render(
      <Router hook={memoryLocation({ path: "/" }).hook}>
        <NextBestActions api={makeApi([]) as never} today="2026-07-21" />
      </Router>,
    );
    await vi.waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  it("reports a failed load rather than looking like an empty checklist", async () => {
    const api = makeApi();
    api.checklist.list = vi.fn(async () => {
      throw new Error("500");
    });
    renderCard(api);
    expect(await screen.findByRole("alert")).toHaveTextContent(/couldn't load|could not load/i);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run test:client -- NextBestActions`
Expected: FAIL — cannot resolve `src/client/home/NextBestActions.js`.

- [ ] **Step 3: Write NextBestActions**

Create `src/client/home/NextBestActions.tsx`:

```tsx
import { useEffect, useState } from "react";
import { Link } from "wouter";
import { Check } from "@phosphor-icons/react";
import { api as defaultApi } from "../api/client.js";
import type { ChecklistItem } from "../api/types.js";
import { daysUntil } from "../lib/dates.js";
import { errorMessage } from "../lib/errors.js";

/** Undone first, then soonest due, with undated items last. */
function rank(a: ChecklistItem, b: ChecklistItem): number {
  const aDone = a.doneAt !== null;
  const bDone = b.doneAt !== null;
  if (aDone !== bDone) return aDone ? 1 : -1;
  if (a.dueOn === null) return b.dueOn === null ? 0 : 1;
  if (b.dueOn === null) return -1;
  return a.dueOn.localeCompare(b.dueOn);
}

/**
 * Urgency from data this card actually has. The prototype paints "132 days"
 * amber because that row is a passport blocker, not because 132 days is a
 * threshold; a generic checklist item carries no such signal. Passport amber
 * lives in TripWarnings and PersonCard, where the expiry date is in hand.
 */
function urgency(dueOn: string | null, today: string): { text: string; tone: string } | null {
  if (dueOn === null) return null;
  const days = daysUntil(dueOn, today);
  if (days < 0) return { text: "overdue", tone: "#d9b98a" };
  if (days === 0) return { text: "today", tone: "var(--color-accent-300)" };
  return { text: `${days} day${days === 1 ? "" : "s"}`, tone: "var(--color-neutral-500)" };
}

export function NextBestActions({
  api = defaultApi,
  today = new Intl.DateTimeFormat("en-CA").format(new Date()),
  limit = 4,
}: {
  api?: typeof defaultApi;
  today?: string;
  limit?: number;
}) {
  const [items, setItems] = useState<ChecklistItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.checklist
      .list()
      .then((all) => {
        if (!cancelled) setItems(all);
      })
      // Without this the card renders as "no actions", which reads as "you
      // are all caught up" -- the most misleading thing it could say.
      .catch((err) => {
        if (!cancelled) setError(errorMessage(err));
      });
    return () => {
      cancelled = true;
    };
  }, [api]);

  async function toggle(item: ChecklistItem) {
    const done = item.doneAt === null;
    try {
      await api.checklist.setDone(item.id, done);
    } catch (err) {
      setError(errorMessage(err));
      return;
    }
    setItems((prev) =>
      (prev ?? []).map((i) =>
        i.id === item.id ? { ...i, doneAt: done ? new Date().toISOString() : null } : i,
      ),
    );
  }

  if (error) {
    return (
      <section className="card" style={{ flex: "1 1 340px" }}>
        <h6 className="card-kicker">Next best actions</h6>
        <p className="warning" role="alert" style={{ margin: 0, fontSize: 12 }}>
          Couldn't load the checklist. {error}
        </p>
      </section>
    );
  }

  // Still loading, or genuinely nothing to do: render nothing rather than an
  // empty panel taking up a third of the hero row.
  if (items === null || items.length === 0) return null;

  const ranked = items.slice().sort(rank).slice(0, limit);

  return (
    <section className="card" style={{ flex: "1 1 340px" }}>
      <h6 className="card-kicker">Next best actions</h6>

      {ranked.map((item, index) => {
        const done = item.doneAt !== null;
        const due = urgency(item.dueOn, today);
        return (
          <div key={item.id}>
            <button
              type="button"
              data-testid={`action-row-${item.id}`}
              data-done={String(done)}
              onClick={() => void toggle(item)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                width: "100%",
                padding: 0,
                background: "none",
                border: 0,
                color: "inherit",
                font: "inherit",
                textAlign: "left",
                cursor: "pointer",
                opacity: done ? 0.45 : 1,
              }}
            >
              <span
                aria-hidden="true"
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  width: 22,
                  height: 22,
                  flex: "none",
                  borderRadius: "var(--radius-sm)",
                  fontSize: 11,
                  background:
                    done || index === 0
                      ? "var(--color-accent-800)"
                      : "var(--color-neutral-800)",
                  color:
                    done || index === 0
                      ? "var(--color-accent-200)"
                      : "var(--color-neutral-200)",
                }}
              >
                {done ? <Check size={12} /> : index + 1}
              </span>
              <span
                data-testid="action-label"
                style={{
                  fontSize: 13,
                  fontWeight: 500,
                  textDecoration: done ? "line-through" : "none",
                }}
              >
                {item.label}
              </span>
              {due && (
                <span style={{ marginLeft: "auto", fontSize: 11, color: due.tone }}>
                  {due.text}
                </span>
              )}
            </button>
            {index < ranked.length - 1 && <hr className="hr" style={{ margin: "10px 0" }} />}
          </div>
        );
      })}

      <Link href="/checklist" className="btn btn-ghost" style={{ alignSelf: "flex-start" }}>
        Full checklist →
      </Link>
    </section>
  );
}
```

- [ ] **Step 4: Run the test**

Run: `npm run test:client -- NextBestActions`
Expected: PASS, 8 tests.

- [ ] **Step 5: Render it in the hero row**

In `src/client/pages/Home.tsx`, add the import:

```tsx
import { NextBestActions } from "../home/NextBestActions.js";
```

and add it inside the existing hero-row flex container, after the `ActiveTripHero` / `IdleTripHero` branch:

```tsx
        <NextBestActions api={api} today={today} />
```

The design puts it at `flex: 1 1 340px` beside a `flex: 1.5 1 480px` hero, which the component already sets on itself; the row is `flex-wrap`, so it drops below the hero at narrow widths with no breakpoint.

- [ ] **Step 6: Run everything**

Run: `npm run test:all && npm run typecheck && npm run build`
Expected: all PASS, both exit 0. Plan 2's `Home.test.tsx` (7 tests) still passes unmodified — its fake `api` has no `checklist` key, so `api.checklist.list()` throws synchronously inside the effect... **if that happens, it is a real defect, not a test to edit.** Guard it by reading the method defensively is *not* the fix; instead add `checklist: { list: vi.fn(async () => []), setDone: vi.fn() }` to plan 2's `Home.test.tsx` helper, which is the same change plan 3 already made to its own fixtures. Note this as the one edit to an earlier plan's test file that this plan makes, and why.

- [ ] **Step 7: Commit**

```bash
git add src/client/home/NextBestActions.tsx src/client/pages/Home.tsx tests/client/home/NextBestActions.test.tsx tests/client/pages/Home.test.tsx
git commit -m "feat: add the next best actions card to Home"
```

---

## Not in this plan (Part A)

Carried forward or newly deferred. Part B's own list is in its file.

1. **Trip editing.** There is no `PUT`/`PATCH` on `/api/trips/:id`, so design 1b's header pencil is deliberately not built. Adding it means a trip-update endpoint, a `TripRepo.update`, and an edit mode on `TripForm` — a coherent unit of work, and a small one, but not one this plan needs to satisfy any success criterion.
2. **Deleting or cancelling a booking.** `BookingRepo.setStatus` can already write `cancelled` and `listByTrip` already filters it out, but no UI offers it and no test covers it here.
3. **Per-trip booking counts.** Deferred by plan 2 and again by plan 3; the Trips page renders `TripCard` with empty bookings rather than issuing one request per trip.
4. **The cross-trip checklist page** (`/checklist`). `api.checklist.list()` returns every trip's items and `NextBestActions` links to the route, but the page is still plan 2's stub. This is now the most visible remaining stub in the nav.
5. **Trip cover photos.** Still blocked on attachments.
6. **Loyalty accounts.** The `loyalty_account` table exists and nothing reads or writes it. Phase 2.
7. **Offline caching** of the active trip.
8. **Day view shape 1d.**

## Self-review notes (Part A)

- **Spec coverage.** Success criterion 1 ("the family can be entered once") is met by Tasks 5–6; criterion 2 ("a trip can be created with flights, lodging, and a car, each with confirmation numbers and correct timezones") by Tasks 6–7. Criteria 3 and 4 were met by plans 2–3 and plan 1. Criterion 5 (a forwarded email produces a draft) is Part B. Criteria 6 (offline) and 7 (no business-spend content) are outside both parts — 7 was done in plan 1 Task 1, 6 remains backlogged.
- **Endpoints were verified against `src/server/routes/`, not assumed.** All five endpoints the brief listed exist. One was in a surprising place: `PUT /api/bookings/:bookingId/people/:personId` lives in `routes/itinerary.ts`, mounted via `app.route("/api", itinerary)`, not in a bookings router. Two endpoints this plan needed did **not** exist and are built here: `PUT /api/people/:id` (Task 1) and `PUT /api/bookings/:bookingId/status` (Task 2).
- **The masked-value trap has three independent defences** (Task 1): a tri-state input type, a server-side mask-glyph rejection, and a form that never holds the masked string in state. Tests cover all three, including one asserting the stored plaintext is *unchanged* after a rejected update — a test that would pass trivially if it only checked the status code.
- **The mask-glyph guard lives beside `mask()`, and covers bookings too.** `assertNotMasked` is exported from `src/server/crypto/envelope.ts` rather than hidden in `person.ts`, and `BookingRepo.create` calls it on `confirmationNumber`. `toBooking()` masks that column with the identical helper, so the same silent round-trip destruction was available there the moment any component reconstructed a booking body from a list response — which Part B Task 14's `DraftCard` does. One glyph, one guard, one file.
- **`documentPatch` is overloaded by mode** (Task 5). Its `null` branch is expressible only in edit mode, and `CreatePersonInput`'s document fields are `string | undefined` where `UpdatePersonInput`'s are `string | null | undefined`. A single return type spread into both literals fails `satisfies CreatePersonInput` at typecheck (TS1360) even though it is correct at runtime.
- **Error classes, not bare throws.** Every server test asserts `NotFoundError` / `ForbiddenError` / `ValidationError` by class. `TenantScopeError` is never thrown for a caller-supplied id.
- **No unhandled fetches.** `People`, `Trips`, and `NextBestActions` each `catch` their load and render a distinct error state, and each has a test that drives a rejection. `OverviewTab`'s `Book →` and every form's submit path do the same for writes.
- **No dead controls, still.** `Book →` and `Add booking` are wired to real endpoints; the trip-edit pencil is *not* built, because the endpoint does not exist. `PersonCard`'s edit control renders only when an `onEdit` handler is supplied, which the Travelers tab does not supply.
- **Sharing, not duplicating.** The passport rule lives in one function and the person card in one component, used by both the People page and the Travelers tab. Plan 3's `TravelersTab.test.tsx` passes unmodified against the rewritten component, which is the evidence the extraction preserved behaviour.
- **Timezones.** `zonedToUtc` converts wall clock plus zone to a UTC instant using the offset in force *on that date*, and throws `RangeError` rather than producing an "Invalid Date" that would brick a trip's day view permanently. Both failure modes are tested.
- **One edit to an earlier plan's test file**, disclosed in Task 8 Step 6: plan 2's `Home.test.tsx` fake `api` gains a `checklist` key, because `Home` now renders a component that calls it.
- **Type consistency.** `CreatePersonInput`, `UpdatePersonInput`, `CreateTripInput`, and `CreateBookingInput` are re-exported through `src/client/api/types.ts` alongside the output types, so a server-side change to any of them fails the client at typecheck rather than at runtime.
