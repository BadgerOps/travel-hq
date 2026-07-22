# Travel HQ Trip Detail and Day View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the trip detail page and the per-person day-by-day itinerary — the centerpiece feature — along with the three server capabilities they need that the backend foundation deliberately left out.

**Architecture:** Opens with two backend tasks (checklist repository and routes, trip cost rollup), then the trip detail page with its four tabs, then the day view. The day view ships as shape **1c** — a shared agenda with person filter chips — behind a `DayView` component boundary so shape 1d can drop in later as a desktop-only toggle without touching callers.

**Tech Stack:** Node 22, Hono, SQLite, Zod, React 19, `wouter`, `@phosphor-icons/react`, Vitest + Testing Library.

## Prerequisites

**Both prior plans must be complete and green:**
- `2026-07-20-backend-foundation.md` — provides `TenantRepo`, the repos, and the API
- `2026-07-20-frontend-shell-and-home.md` — provides the router, shell, API client, date helpers, `PersonChip`, and `MaskedValue`

Run `npm run test:all` before starting. If it is not green, stop.

## Global Constraints

- **`docs/design/` is the source of truth for visual values.** Exploration 1b is trip detail; 1c is the day view; 1e is the phone layout. When this plan and the bundle disagree on a number, the bundle wins; on architecture, the spec wins.
- **The day view is 1c.** Decided 2026-07-21. Do not build 1d — it is backlogged as a desktop-only toggle. Build the `DayView` boundary so it can be added without changing callers.
- **Grouping by day happens in the event's own timezone**, already handled server-side by `ItineraryRepo`. The client renders what the server groups; it must not re-group by UTC or by the viewer's zone.
- **Both timezones render** when a booking's endpoints differ. Use `formatDualZone` from plan 2.
- **Primary buttons are accent-outlined, never filled.** Headings are weight 500. Rules use `.hr` and fade at both ends.
- **Confirmation numbers render masked** with tap-to-reveal; every reveal is logged server-side.
- **Fluid layouts only.** Verify at 390px.
- **The implemented backend is the contract, not this document's description of it.** Before writing any server code, read `src/server/repos/base.ts`, `src/server/routes/errors.ts`, `src/server/index.ts`, and `src/server/routes/trips.ts`. The error-class → status table is in Task 1; the route conventions (guard `c.req.json()` locally, everything else to `app.onError`) are in Task 1 Step 4. Where this plan and the code disagree, the code wins — report the discrepancy rather than coding to the plan.
- **No dead controls, and no unhandled fetches.** Both policies are stated once, in Task 5 and Task 4 respectively, and apply to every component in this plan.
- **No trip cover photos.** Still deferred.
- Tests use Vitest. Every task ends with a commit.

---

## File Structure

```
src/server/
  repos/
    checklist.ts        ← NEW: checklist_item repository
    rollup.ts           ← NEW: per-trip cost and points totals
  routes/
    checklist.ts        ← NEW
    trips.ts            ← MODIFIED: add the rollup endpoint
src/client/
  api/client.ts         ← MODIFIED: checklist, rollup
  pages/
    TripDetail.tsx      ← NEW: shell, tabs, routing
  trip/
    OverviewTab.tsx     ← NEW: bookings grouped by kind
    TravelersTab.tsx    ← NEW: doc status per person
    ChecklistTab.tsx    ← NEW
    CostRollup.tsx      ← NEW: right rail card
  dayview/
    DayView.tsx         ← NEW: the boundary. Picks a shape; today only 1c.
    SharedAgenda.tsx    ← NEW: shape 1c
    PersonFilter.tsx    ← NEW: filter chips
    DatePager.tsx       ← NEW
```

`DayView.tsx` exists specifically so `SharedAgenda` is swappable. Keep its props free of anything 1c-specific.

---

### Task 1: Checklist repository and routes

**Files:**
- Create: `src/server/repos/checklist.ts`
- Create: `src/server/routes/checklist.ts`
- Modify: `src/server/index.ts`
- Test: `tests/server/repos/checklist.test.ts`

**Interfaces:**
- Consumes: `TenantRepo`, `NotFoundError`, `ForbiddenError` (backend plan Task 5); `newId` (Task 4)

**Error taxonomy — read `src/server/repos/base.ts` before writing a line of this task.** The implemented base class defines four repo errors and `src/server/routes/errors.ts` maps each to exactly one status:

| Condition | Throw | Status |
| --- | --- | --- |
| Row absent, or present in another household | `NotFoundError` | 404 |
| Viewer attempting a write/reveal | `ForbiddenError` | 403 |
| Caller passed malformed input a route's Zod schema didn't catch | `ValidationError` | 400 |
| **A bug in the repository itself** (missing `{scope}`, bad identifier) | `TenantScopeError` | **500, body `{"error":"Internal error"}`** |

`TenantScopeError` is *not* a tenancy-violation signal for request data — a cross-household id is an ordinary `NotFoundError`, exactly as `TripRepo.addTraveler` and `BookingRepo.listByTrip` already do it. Mirror `TripRepo.addTraveler` when writing `ChecklistRepo.create`.
- Produces:
  - `type ChecklistItem = { id, tripId, personId, label, dueOn, doneAt }`
  - `class ChecklistRepo` with `create(input)`, `listByTrip(tripId)`, `listAll()`, `setDone(id, done)`

- [ ] **Step 1: Write the failing test**

Create `tests/server/repos/checklist.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { createTestDatabase } from "../../../src/server/db/migrate.js";
import { ChecklistRepo } from "../../../src/server/repos/checklist.js";
import { ForbiddenError, NotFoundError } from "../../../src/server/repos/base.js";
import type { HouseholdContext } from "../../../src/server/repos/base.js";

const ctx: HouseholdContext = { householdId: "hh-a", userId: "u1", role: "owner" };
let db: DatabaseSync;
let repo: ChecklistRepo;

beforeEach(() => {
  db = createTestDatabase();
  const now = new Date().toISOString();
  db.prepare("INSERT INTO household (id, name, created_at) VALUES (?, ?, ?)").run("hh-a", "Badger", now);
  db.prepare("INSERT INTO trip (id, household_id, title, created_at) VALUES (?, ?, ?, ?)")
    .run("t1", "hh-a", "Guerneville", now);
  db.prepare("INSERT INTO person (id, household_id, display_name, created_at) VALUES (?, ?, ?, ?)")
    .run("p-ava", "hh-a", "Ava", now);
  repo = new ChecklistRepo(db, ctx);
});

describe("ChecklistRepo", () => {
  it("creates a family-wide item with no assignee", () => {
    const item = repo.create({ tripId: "t1", label: "Hold the mail" });
    expect(item.personId).toBe(null);
    expect(item.doneAt).toBe(null);
  });

  it("creates an assigned item", () => {
    const item = repo.create({ tripId: "t1", label: "Renew passport", personId: "p-ava" });
    expect(item.personId).toBe("p-ava");
  });

  it("refuses an assignee from another household", () => {
    const now = new Date().toISOString();
    db.prepare("INSERT INTO household (id, name, created_at) VALUES (?, ?, ?)").run("hh-b", "Other", now);
    db.prepare("INSERT INTO person (id, household_id, display_name, created_at) VALUES (?, ?, ?, ?)")
      .run("p-stranger", "hh-b", "Stranger", now);
    // Asserting the *class*, not merely "something threw": a bare .toThrow()
    // passes just as happily on a TenantScopeError, which mapError() turns
    // into a 500 "Internal error" instead of the 404 this must produce.
    expect(() =>
      repo.create({ tripId: "t1", label: "Nope", personId: "p-stranger" }),
    ).toThrow(NotFoundError);
  });

  it("refuses an unknown trip", () => {
    expect(() => repo.create({ tripId: "t-nope", label: "Nope" })).toThrow(NotFoundError);
  });

  it("marks an item done and undone", () => {
    const item = repo.create({ tripId: "t1", label: "Book car" });
    repo.setDone(item.id, true);
    expect(repo.listByTrip("t1")[0]?.doneAt).not.toBe(null);
    repo.setDone(item.id, false);
    expect(repo.listByTrip("t1")[0]?.doneAt).toBe(null);
  });

  it("refuses to mark an unknown item done", () => {
    // Without an existence check, the UPDATE simply matches zero rows and
    // setDone() returns normally -- so the route answers 204 for an id that
    // does not exist, or belongs to another household. Both must be 404.
    expect(() => repo.setDone("c-nope", true)).toThrow(NotFoundError);
  });

  it("refuses to mark another household's item done", () => {
    const item = repo.create({ tripId: "t1", label: "Mine" });
    const other = new ChecklistRepo(db, { householdId: "hh-b", userId: "u2", role: "owner" });
    expect(() => other.setDone(item.id, true)).toThrow(NotFoundError);
  });

  it("orders undone items before done ones", () => {
    const a = repo.create({ tripId: "t1", label: "First" });
    repo.create({ tripId: "t1", label: "Second" });
    repo.setDone(a.id, true);
    expect(repo.listByTrip("t1").map((i) => i.label)).toEqual(["Second", "First"]);
  });

  it("lists items across every trip", () => {
    const now = new Date().toISOString();
    db.prepare("INSERT INTO trip (id, household_id, title, created_at) VALUES (?, ?, ?, ?)")
      .run("t2", "hh-a", "Other trip", now);
    repo.create({ tripId: "t1", label: "One" });
    repo.create({ tripId: "t2", label: "Two" });
    expect(repo.listAll()).toHaveLength(2);
  });

  it("does not leak another household's checklist", () => {
    repo.create({ tripId: "t1", label: "Mine" });
    const other = new ChecklistRepo(db, { householdId: "hh-b", userId: "u2", role: "owner" });
    expect(other.listByTrip("t1")).toEqual([]);
    expect(other.listAll()).toEqual([]);
  });

  it("refuses writes from a viewer", () => {
    const viewer = new ChecklistRepo(db, { ...ctx, role: "viewer" });
    // ForbiddenError specifically -- a bare .toThrow() would also pass if the
    // write failed for the wrong reason and answered 404 or 500.
    expect(() => viewer.create({ tripId: "t1", label: "Nope" })).toThrow(ForbiddenError);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -- repos/checklist`
Expected: FAIL — cannot resolve `src/server/repos/checklist.js`.

- [ ] **Step 3: Write the repository**

Create `src/server/repos/checklist.ts`:

```ts
import { TenantRepo, NotFoundError } from "./base.js";
import { newId } from "../ids.js";

export type ChecklistItem = {
  id: string;
  tripId: string;
  /** NULL means a family-wide task rather than an assigned one. */
  personId: string | null;
  label: string;
  dueOn: string | null;
  doneAt: string | null;
};

export type CreateChecklistInput = {
  tripId: string;
  label: string;
  personId?: string;
  dueOn?: string;
};

type Row = {
  id: string;
  trip_id: string;
  person_id: string | null;
  label: string;
  due_on: string | null;
  done_at: string | null;
};

export class ChecklistRepo extends TenantRepo {
  create(input: CreateChecklistInput): ChecklistItem {
    // Redundant with base.ts's own requireWrite() inside run()/insert() --
    // kept as explicit intent at the top of every mutating method, matching
    // TripRepo/BookingRepo/PersonRepo.
    this.requireWrite();

    // NotFoundError, not TenantScopeError: an id the caller supplied that
    // isn't in this household is a 404, exactly as TripRepo.addTraveler
    // treats it. TenantScopeError means "this repository is written wrong"
    // and mapError() deliberately answers 500 "Internal error" for it, which
    // would hide a perfectly ordinary bad-id request behind a server fault.
    const trip = this.get<{ id: string }>(
      "SELECT id FROM trip WHERE {scope} AND id = ?",
      input.tripId,
    );
    if (!trip) throw new NotFoundError("Trip not found in this household");

    if (input.personId) {
      const person = this.get<{ id: string }>(
        "SELECT id FROM person WHERE {scope} AND id = ?",
        input.personId,
      );
      if (!person) throw new NotFoundError("Person not found in this household");
    }

    const id = newId();
    this.insert("checklist_item", {
      id,
      trip_id: input.tripId,
      person_id: input.personId ?? null,
      label: input.label,
      due_on: input.dueOn ?? null,
      done_at: null,
      created_at: new Date().toISOString(),
    });

    const created = this.findById(id);
    if (!created) throw new Error("Checklist item disappeared immediately after creation");
    return created;
  }

  findById(id: string): ChecklistItem | undefined {
    const row = this.get<Row>("SELECT * FROM checklist_item WHERE {scope} AND id = ?", id);
    return row ? toItem(row) : undefined;
  }

  listByTrip(tripId: string): ChecklistItem[] {
    return this.all<Row>(
      `SELECT * FROM checklist_item
        WHERE {scope} AND trip_id = ?
        ORDER BY done_at IS NOT NULL, due_on IS NULL, due_on, created_at`,
      tripId,
    ).map(toItem);
  }

  /** Every open item across all trips — the cross-trip checklist route. */
  listAll(): ChecklistItem[] {
    return this.all<Row>(
      `SELECT * FROM checklist_item
        WHERE {scope}
        ORDER BY done_at IS NOT NULL, due_on IS NULL, due_on, created_at`,
    ).map(toItem);
  }

  setDone(id: string, done: boolean): void {
    this.requireWrite();
    // Without this, an unknown id (or one belonging to another household)
    // matches zero rows, the UPDATE succeeds vacuously, and the route answers
    // 204 -- telling a client its write landed when nothing happened. Same
    // existence-check-then-act shape as BookingRepo.assignPerson.
    if (!this.findById(id)) {
      throw new NotFoundError("Checklist item not found in this household");
    }
    this.run(
      "UPDATE checklist_item SET done_at = ? WHERE {scope} AND id = ?",
      done ? new Date().toISOString() : null,
      id,
    );
  }
}

function toItem(r: Row): ChecklistItem {
  return {
    id: r.id,
    tripId: r.trip_id,
    personId: r.person_id,
    label: r.label,
    dueOn: r.due_on,
    doneAt: r.done_at,
  };
}
```

`setDone` is the first UPDATE in the codebase with a placeholder *before* the scope token, and that is a non-issue: the implemented `TenantRepo` binds the household id as a **named** parameter (`:__scope_household`, supplied as its own binding object) and splices only SQL *text* at the `{scope}` position. Anonymous `?` placeholders on either side of the token keep their own left-to-right order, so there is no position arithmetic to get wrong. Pass the caller's params in the order they appear in the SQL and nothing else is required.

- [ ] **Step 4: Write the routes**

Create `src/server/routes/checklist.ts`:

```ts
import { Hono } from "hono";
import { z } from "zod";
import { ChecklistRepo } from "../repos/checklist.js";
import type { AppEnv } from "../index.js";

const createSchema = z.object({
  tripId: z.string().min(1),
  label: z.string().min(1),
  personId: z.string().optional(),
  dueOn: z.string().optional(),
});

const doneSchema = z.object({ done: z.boolean() });

export const checklist = new Hono<AppEnv>();

checklist.get("/", (c) =>
  c.json(new ChecklistRepo(c.get("db"), c.get("identity")).listAll()),
);

checklist.post("/", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    // A JSON.parse-level SyntaxError, not a domain error -- mapError() does
    // not recognize it and its generic fallback would answer 500 for what is
    // plainly a malformed request. Handled here, directly, without echoing
    // the parser's own message. This early return is the ONE thing routes
    // handle locally; everything else belongs to app.onError.
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Invalid checklist item", details: parsed.error.issues }, 400);
  }
  // No try/catch. An unknown trip/person (NotFoundError, 404) or a viewer
  // role (ForbiddenError, 403) throws here and createApp's app.onError maps
  // it through mapError() -- the single status-mapping decision in the
  // codebase. A local `catch (err) => c.json({ error: String(err) }, 400)`
  // would forward an internal message over HTTP *and* flatten 403/404 into
  // 400. Match routes/trips.ts exactly.
  const repo = new ChecklistRepo(c.get("db"), c.get("identity"));
  return c.json(repo.create(parsed.data), 201);
});

checklist.put("/:id/done", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const parsed = doneSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: "Expected { done: boolean }" }, 400);
  // An unknown/cross-household item id throws NotFoundError -> 404 via
  // app.onError; a viewer throws ForbiddenError -> 403.
  new ChecklistRepo(c.get("db"), c.get("identity")).setDone(c.req.param("id"), parsed.data.done);
  return c.body(null, 204);
});
```

Both handlers follow the shape every implemented route already uses (`routes/people.ts`, `routes/trips.ts`): guard the body parse locally, `safeParse` the schema locally, then call the repo **bare** and let `app.onError` do the mapping.

- [ ] **Step 5: Mount the routes**

In `src/server/index.ts`, add the import:

```ts
import { checklist } from "./routes/checklist.js";
```

and mount it alongside the others:

```ts
  app.route("/api/checklist", checklist);
```

- [ ] **Step 6: Run the tests**

Run: `npm test -- repos/checklist`
Expected: PASS, 11 tests.

- [ ] **Step 7: Commit**

```bash
git add src/server/repos/checklist.ts src/server/routes/checklist.ts src/server/index.ts tests/server/repos/checklist.test.ts
git commit -m "feat: add checklist repository and routes"
```

---

### Task 2: Trip cost rollup

**Files:**
- Create: `src/server/repos/rollup.ts`
- Modify: `src/server/routes/trips.ts`
- Test: `tests/server/repos/rollup.test.ts`

**Interfaces:**
- Consumes: `TenantRepo` (backend plan Task 5)
- Produces:
  - `type TripRollup = { bookedCents, plannedCents, totalCents, points: { program, used }[] }`
  - `class RollupRepo` with `forTrip(tripId): TripRollup`

- [ ] **Step 1: Write the failing test**

Create `tests/server/repos/rollup.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { createTestDatabase } from "../../../src/server/db/migrate.js";
import { Keyring } from "../../../src/server/crypto/envelope.js";
import { BookingRepo } from "../../../src/server/repos/booking.js";
import { RollupRepo } from "../../../src/server/repos/rollup.js";
import { NotFoundError } from "../../../src/server/repos/base.js";
import type { HouseholdContext } from "../../../src/server/repos/base.js";

const ring = new Keyring("server-v1", { "server-v1": randomBytes(32) });
const ctx: HouseholdContext = { householdId: "hh-a", userId: "u1", role: "owner" };
let db: DatabaseSync;
let bookings: BookingRepo;
let rollup: RollupRepo;

beforeEach(() => {
  db = createTestDatabase();
  const now = new Date().toISOString();
  db.prepare("INSERT INTO household (id, name, created_at) VALUES (?, ?, ?)").run("hh-a", "Badger", now);
  db.prepare("INSERT INTO trip (id, household_id, title, created_at) VALUES (?, ?, ?, ?)")
    .run("t1", "hh-a", "Guerneville", now);
  bookings = new BookingRepo(db, ctx, ring);
  rollup = new RollupRepo(db, ctx);
});

describe("RollupRepo", () => {
  it("returns zeros for a trip with no bookings", () => {
    expect(rollup.forTrip("t1")).toEqual({
      bookedCents: 0,
      plannedCents: 0,
      totalCents: 0,
      points: [],
    });
  });

  it("separates booked from planned spend", () => {
    bookings.create({ tripId: "t1", kind: "other", title: "A", costCents: 100_000, status: "booked", details: {} });
    bookings.create({ tripId: "t1", kind: "other", title: "B", costCents: 48_400, status: "planned", details: {} });
    const r = rollup.forTrip("t1");
    expect(r.bookedCents).toBe(100_000);
    expect(r.plannedCents).toBe(48_400);
    expect(r.totalCents).toBe(148_400);
  });

  it("groups points by program", () => {
    bookings.create({ tripId: "t1", kind: "other", title: "A", pointsUsed: 12_000, pointsProgram: "SkyMiles", status: "booked", details: {} });
    bookings.create({ tripId: "t1", kind: "other", title: "B", pointsUsed: 6_500, pointsProgram: "SkyMiles", status: "booked", details: {} });
    bookings.create({ tripId: "t1", kind: "other", title: "C", pointsUsed: 9_000, pointsProgram: "UR", status: "booked", details: {} });
    expect(rollup.forTrip("t1").points).toEqual([
      { program: "SkyMiles", used: 18_500 },
      { program: "UR", used: 9_000 },
    ]);
  });

  it("excludes cancelled and draft bookings", () => {
    bookings.create({ tripId: "t1", kind: "other", title: "Cancelled", costCents: 50_000, status: "cancelled", details: {} });
    bookings.create({ tripId: "t1", kind: "other", title: "Draft", costCents: 50_000, status: "draft", details: {} });
    expect(rollup.forTrip("t1").totalCents).toBe(0);
  });

  it("ignores points with no program", () => {
    bookings.create({ tripId: "t1", kind: "other", title: "A", pointsUsed: 500, status: "booked", details: {} });
    expect(rollup.forTrip("t1").points).toEqual([]);
  });

  it("refuses an unknown trip rather than reporting zeros", () => {
    // A bogus id must 404, matching GET /api/trips/:tripId/bookings on the
    // same id. Answering `200 {totalCents: 0}` makes a stale link look like a
    // real but empty trip.
    expect(() => rollup.forTrip("t-nope")).toThrow(NotFoundError);
  });

  it("does not leak another household's totals", () => {
    bookings.create({ tripId: "t1", kind: "other", title: "A", costCents: 100_000, status: "booked", details: {} });
    const other = new RollupRepo(db, { householdId: "hh-b", userId: "u2", role: "owner" });
    expect(() => other.forTrip("t1")).toThrow(NotFoundError);
  });
});
```

Excluding drafts is deliberate: an unreviewed parsed email must not move the trip's stated cost.

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -- repos/rollup`
Expected: FAIL — cannot resolve `src/server/repos/rollup.js`.

- [ ] **Step 3: Write the repository**

Create `src/server/repos/rollup.ts`:

```ts
import { TenantRepo, NotFoundError } from "./base.js";

export type TripRollup = {
  bookedCents: number;
  plannedCents: number;
  totalCents: number;
  points: { program: string; used: number }[];
};

export class RollupRepo extends TenantRepo {
  /**
   * Cost and points totals for one trip. Draft and cancelled bookings are
   * excluded — an unreviewed parsed email must not move the stated cost.
   *
   * Existence-checks the trip first, the same way BookingRepo.listByTrip
   * does (I5). Without it "this trip does not exist" and "this trip has no
   * bookings" are both `200 {totalCents: 0}`, so a stale or mistyped trip id
   * renders as a real, empty trip — and the sibling /bookings call in
   * TripDetail's Promise.all 404s on the identical id, leaving the page in
   * two contradictory states at once.
   */
  forTrip(tripId: string): TripRollup {
    const trip = this.get<{ id: string }>("SELECT id FROM trip WHERE {scope} AND id = ?", tripId);
    if (!trip) throw new NotFoundError("Trip not found in this household");

    const costs = this.all<{ status: string; total: number }>(
      `SELECT status, COALESCE(SUM(cost_cents), 0) AS total
         FROM booking
        WHERE {scope} AND trip_id = ?
          AND status IN ('booked', 'planned')
        GROUP BY status`,
      tripId,
    );

    const bookedCents = costs.find((c) => c.status === "booked")?.total ?? 0;
    const plannedCents = costs.find((c) => c.status === "planned")?.total ?? 0;

    const points = this.all<{ program: string; used: number }>(
      `SELECT points_program AS program, COALESCE(SUM(points_used), 0) AS used
         FROM booking
        WHERE {scope} AND trip_id = ?
          AND status IN ('booked', 'planned')
          AND points_program IS NOT NULL
          AND points_used IS NOT NULL
        GROUP BY points_program
        ORDER BY points_program`,
      tripId,
    );

    return {
      bookedCents,
      plannedCents,
      totalCents: bookedCents + plannedCents,
      points,
    };
  }
}
```

- [ ] **Step 4: Add the route**

In `src/server/routes/trips.ts`, add the import:

```ts
import { RollupRepo } from "../repos/rollup.js";
```

and the route:

```ts
trips.get("/:tripId/rollup", (c) =>
  // An unknown/cross-household tripId throws NotFoundError, mapped to 404 by
  // app.onError -- same as the sibling /:tripId/bookings route. No local
  // try/catch.
  c.json(new RollupRepo(c.get("db"), c.get("identity")).forTrip(c.req.param("tripId"))),
);
```

- [ ] **Step 5: Run the tests**

Run: `npm test -- repos/rollup`
Expected: PASS, 7 tests.

- [ ] **Step 6: Commit**

```bash
git add src/server/repos/rollup.ts src/server/routes/trips.ts tests/server/repos/rollup.test.ts
git commit -m "feat: add per-trip cost and points rollup"
```

---

### Task 3: API client additions

**Files:**
- Modify: `src/client/api/client.ts`
- Modify: `src/client/api/types.ts`
- Test: `tests/client/api/client-trip.test.ts`

**Interfaces:**
- Produces: `api.trips.rollup(tripId)`, `api.checklist.list()`, `api.checklist.create(input)`, `api.checklist.setDone(id, done)`
- Consumes: `api.trips.travelers(tripId)` — see the note below

`api.trips.revealConfirmation` already exists — the frontend plan added it, and the backend plan provides the endpoint.

**`api.trips.travelers(tripId): Promise<Person[]>`** is required by Task 4. Plan 2's Task 0 adds the `GET /api/trips/:tripId/travelers` endpoint; check whether it also added the client method. If `api.trips.travelers` already exists in `src/client/api/client.ts`, skip it in Step 4 — do not add a second copy.

- [ ] **Step 1: Write the failing test**

Create `tests/client/api/client-trip.test.ts`:

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

describe("trip and checklist api", () => {
  it("fetches a rollup", async () => {
    const fetchMock = mockFetch({ totalCents: 148_400, points: [] });
    const api = createApi({ fetch: fetchMock, baseUrl: "" });
    expect(await api.trips.rollup("t1")).toMatchObject({ totalCents: 148_400 });
    expect(fetchMock).toHaveBeenCalledWith("/api/trips/t1/rollup", expect.anything());
  });

  it("toggles a checklist item", async () => {
    const fetchMock = mockFetch(null, 204);
    const api = createApi({ fetch: fetchMock, baseUrl: "" });
    await api.checklist.setDone("c1", true);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/checklist/c1/done",
      expect.objectContaining({ method: "PUT", body: JSON.stringify({ done: true }) }),
    );
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run test:client -- client-trip`
Expected: FAIL — `api.trips.rollup` is not a function.

- [ ] **Step 3: Extend the types re-export**

In `src/client/api/types.ts`, append:

```ts
export type { ChecklistItem } from "../../server/repos/checklist.js";
export type { TripRollup } from "../../server/repos/rollup.js";
```

- [ ] **Step 4: Extend the client**

In `src/client/api/client.ts`, add to the imports:

```ts
import type { ChecklistItem, Person, TripRollup } from "./types.js";
```

(`Person` may already be imported — do not duplicate it.)

Add to the `trips` object:

```ts
      rollup: (tripId: string) => request<TripRollup>(`/api/trips/${seg(tripId)}/rollup`),
```

and, **only if plan 2's Task 0 did not already add it**:

```ts
      travelers: (tripId: string) => request<Person[]>(`/api/trips/${seg(tripId)}/travelers`),
```

And add a `checklist` object alongside `people` and `trips`:

```ts
    checklist: {
      list: () => request<ChecklistItem[]>("/api/checklist"),
      create: (input: {
        tripId: string;
        label: string;
        personId?: string;
        dueOn?: string;
      }) =>
        request<ChecklistItem>("/api/checklist", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(input),
        }),
      setDone: (id: string, done: boolean) =>
        request<void>(`/api/checklist/${seg(id)}/done`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ done }),
        }),
    },
```

- [ ] **Step 5: Run the tests**

Run: `npm run test:client -- client-trip`
Expected: PASS, 2 tests.

- [ ] **Step 6: Run the whole client suite**

Run: `npm run test:client`
Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add src/client/api tests/client/api
git commit -m "feat: add rollup and checklist to the API client"
```

---

### Task 4: Trip detail shell and tabs

**Files:**
- Create: `src/client/pages/TripDetail.tsx`
- Modify: `src/client/main.tsx`
- Test: `tests/client/pages/TripDetail.test.tsx`

**Interfaces:**
- Produces: route `/trips/:id`, tab state in the URL hash (`#overview`, `#days`, `#travelers`, `#checklist`) — read on mount, written on change, and kept in sync with `hashchange` so the back button works
- Consumes: `api.trips.travelers(tripId)` (Task 3 / plan 2 Task 0) for the header chips and the Travelers tab

**Two decisions this task encodes, both stated once here and not revisited:**

1. **Tabs are native radios, not ARIA tabs.** The `.seg`/`.seg-opt` token classes render their `<input type="radio">` at `position:absolute; opacity:0; width:0; height:0; pointer-events:none` and drive all visual state from `:has(input:checked)` / `:has(input:focus-visible)`. Putting `role="tab"` on those inputs is the worst of both worlds: it *replaces* the native radio-group semantics (arrow-key roving, group membership via `name`) that already work, while promising a tablist structure — `role="tablist"`, `aria-controls`, `role="tabpanel"`, `id` linkage, managed tabindex — that is not there. It only appears to work under test because jsdom never loads the stylesheet, so `pointer-events:none` is invisible to `user-event`; in a real browser those elements are unclickable and the visible `<label>` is the only hit target. So: **keep the native radio group**, wrap it in `role="radiogroup"` with an accessible name, and rely on the token sheet's existing `.seg-opt:has(input:focus-visible)` outline for a visible focus ring. Arrow keys, group semantics, and label-click all come for free from the platform. Tests assert `role="radio"` and drive at least one switch from the keyboard.
2. **Every fetch has a `catch` and a rendered error state.** A `Promise.all` here spans four endpoints, three of which 404 on an unknown or other-household trip id — i.e. on any stale link. Without a `catch`, `trip` stays `undefined` forever, the page renders "Loading…" indefinitely, and Node/the browser logs an unhandled rejection. The same rule applies to `DayView` and `ChecklistTab` in Tasks 5 and 6.

- [ ] **Step 1: Write the failing test**

Create `tests/client/pages/TripDetail.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import { TripDetail } from "../../../src/client/pages/TripDetail.js";

const TRIP = {
  id: "t1",
  title: "Mary & Winter Wedding",
  destination: "Guerneville, CA",
  startsOn: "2026-10-09",
  endsOn: "2026-10-11",
  status: "planning" as const,
  notes: null,
};

const PEOPLE = [{ id: "p1", displayName: "Badger" }];

function makeApi() {
  return {
    trips: {
      list: vi.fn(async () => [TRIP]),
      bookings: vi.fn(async () => []),
      travelers: vi.fn(async () => PEOPLE),
      itinerary: vi.fn(async () => []),
      rollup: vi.fn(async () => ({
        bookedCents: 0, plannedCents: 0, totalCents: 0, points: [],
      })),
      revealConfirmation: vi.fn(),
    },
    people: { list: vi.fn(async () => PEOPLE), reveal: vi.fn() },
    checklist: { list: vi.fn(async () => []), create: vi.fn(), setDone: vi.fn() },
  };
}

function renderDetail(api = makeApi()) {
  const { hook } = memoryLocation({ path: "/trips/t1" });
  return render(
    <Router hook={hook}>
      <TripDetail id="t1" api={api as never} today="2026-07-21" />
    </Router>,
  );
}

beforeEach(() => {
  // The tab lives in the real `window.location.hash` (wouter's memoryLocation
  // owns the path only), so it leaks between tests unless reset.
  window.history.replaceState(null, "", "/trips/t1");
});

describe("TripDetail", () => {
  it("renders the trip title and destination", async () => {
    renderDetail();
    expect(await screen.findByText("Mary & Winter Wedding")).toBeInTheDocument();
    expect(screen.getByText("Guerneville, CA")).toBeInTheDocument();
  });

  it("renders all four tabs", async () => {
    renderDetail();
    for (const tab of ["Overview", "Day by day", "Travelers", "Checklist"]) {
      expect(await screen.findByRole("radio", { name: tab })).toBeInTheDocument();
    }
  });

  it("opens on Overview", async () => {
    renderDetail();
    expect(await screen.findByRole("radio", { name: "Overview" })).toBeChecked();
  });

  it("switches tabs on click", async () => {
    renderDetail();
    await userEvent.click(await screen.findByRole("radio", { name: "Day by day" }));
    expect(screen.getByRole("radio", { name: "Day by day" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "Overview" })).not.toBeChecked();
  });

  it("switches tabs from the keyboard", async () => {
    // The whole point of keeping the native radio group: arrow keys move
    // between options with no roving-tabindex code of our own. A test that
    // only clicks would pass just as well against a broken custom widget.
    renderDetail();
    const overview = await screen.findByRole("radio", { name: "Overview" });
    overview.focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(screen.getByRole("radio", { name: "Day by day" })).toBeChecked();
    expect(overview).not.toBeChecked();
  });

  it("opens on the tab named in the URL hash", async () => {
    window.history.replaceState(null, "", "/trips/t1#travelers");
    renderDetail();
    expect(await screen.findByRole("radio", { name: "Travelers" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "Overview" })).not.toBeChecked();
  });

  it("writes the selected tab to the URL hash", async () => {
    renderDetail();
    await userEvent.click(await screen.findByRole("radio", { name: "Checklist" }));
    expect(window.location.hash).toBe("#checklist");
  });

  it("reports a missing trip rather than rendering blank", async () => {
    const api = makeApi();
    api.trips.list = vi.fn(async () => []);
    renderDetail(api);
    expect(await screen.findByText(/not found/i)).toBeInTheDocument();
  });

  it("reports a failed load rather than spinning forever", async () => {
    // Drives an actual rejection. The previous version of this suite only
    // ever resolved its mocks, so a component with no `.catch` passed it
    // while, in production, any 404 (stale link, other household's trip)
    // left the page on "Loading…" plus an unhandled promise rejection.
    const api = makeApi();
    api.trips.bookings = vi.fn(async () => {
      throw new Error("404 Not found");
    });
    renderDetail(api);
    expect(await screen.findByRole("alert")).toHaveTextContent(/couldn't load|could not load/i);
    expect(screen.queryByText(/Loading/)).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run test:client -- TripDetail`
Expected: FAIL — cannot resolve `src/client/pages/TripDetail.js`.

- [ ] **Step 3: Write TripDetail**

Create `src/client/pages/TripDetail.tsx`:

```tsx
import { useEffect, useState } from "react";
import { Link } from "wouter";
import { api as defaultApi } from "../api/client.js";
import type { Booking, Person, Trip, TripRollup } from "../api/types.js";
import { countdownLabel } from "../lib/dates.js";
import { PersonChips } from "../components/PersonChip.js";
import { OverviewTab } from "../trip/OverviewTab.js";
import { TravelersTab } from "../trip/TravelersTab.js";
import { ChecklistTab } from "../trip/ChecklistTab.js";
import { DayView } from "../dayview/DayView.js";

type Api = typeof defaultApi;

const TABS = [
  { id: "overview", label: "Overview" },
  { id: "days", label: "Day by day" },
  { id: "travelers", label: "Travelers" },
  { id: "checklist", label: "Checklist" },
] as const;

type TabId = (typeof TABS)[number]["id"];

const DEFAULT_TAB: TabId = "overview";

/**
 * The tab lives in the URL hash so a trip view is linkable ("open the
 * checklist for the wedding"), back-button-able, and survives a reload —
 * TripDetail is exactly the page someone sends a family member.
 */
function tabFromHash(hash: string): TabId {
  const id = hash.replace(/^#/, "");
  const match = TABS.find((t) => t.id === id);
  return match ? match.id : DEFAULT_TAB;
}

export function TripDetail({
  id,
  api = defaultApi,
  today = new Intl.DateTimeFormat("en-CA").format(new Date()),
}: {
  id: string;
  api?: Api;
  today?: string;
}) {
  const [trip, setTrip] = useState<Trip | null | undefined>(undefined);
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [people, setPeople] = useState<Person[]>([]);
  const [travelers, setTravelers] = useState<Person[]>([]);
  const [rollup, setRollup] = useState<TripRollup | null>(null);
  const [failed, setFailed] = useState(false);
  const [tab, setTab] = useState<TabId>(() => tabFromHash(window.location.hash));

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [trips, p, t, b, r] = await Promise.all([
          api.trips.list(),
          api.people.list(),
          // Trip membership, from trip_person. Deriving travelers from
          // `bookings.flatMap(b => b.personIds)` instead would be *booking*
          // membership: a person added to the trip but not yet on any booking
          // would vanish from the header chips and from the Travelers tab —
          // precisely the pre-booking state that tab exists to show.
          api.trips.travelers(id),
          api.trips.bookings(id),
          api.trips.rollup(id),
        ]);
        if (cancelled) return;
        setTrip(trips.find((x) => x.id === id) ?? null);
        setPeople(p);
        setTravelers(t);
        setBookings(b);
        setRollup(r);
      } catch {
        // Three of those five endpoints 404 on an unknown or other-household
        // trip id — i.e. on any stale link. Without this catch the page sits
        // on "Loading…" forever and the rejection goes unhandled.
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api, id]);

  // Back/forward and hand-edited URLs both arrive as `hashchange`.
  useEffect(() => {
    const sync = () => setTab(tabFromHash(window.location.hash));
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, []);

  function selectTab(next: TabId) {
    setTab(next);
    // Assigning to location.hash pushes a history entry, which is what makes
    // the back button walk tabs. Guarded so re-selecting the current tab does
    // not pile up duplicate entries.
    if (tabFromHash(window.location.hash) !== next) window.location.hash = next;
  }

  if (failed) {
    return (
      <p className="text-muted" role="alert">
        Couldn't load this trip. It may have been deleted, or the link may be wrong.
      </p>
    );
  }
  if (trip === undefined) return <p className="text-muted">Loading…</p>;
  if (trip === null) return <p className="text-muted">Trip not found.</p>;

  return (
    <>
      <div className="card-meta" style={{ marginBottom: 8 }}>
        <Link href="/trips" style={{ color: "inherit" }}>
          Trips
        </Link>
        <span>/</span>
        <span>{trip.title}</span>
      </div>

      <header style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 20 }}>
        <h3 style={{ margin: 0 }}>{trip.title}</h3>
        <span className="tag tag-accent">
          {countdownLabel(trip.startsOn, trip.endsOn, today)}
        </span>
        <PersonChips people={travelers} />
      </header>

      {/*
        A native radio group, not an ARIA tablist — see this task's Interfaces
        note. `name="trip-tab"` is what gives arrow-key navigation and group
        semantics; the token sheet styles the visually-hidden input's checked
        and focus-visible states through `.seg-opt:has(...)`, so the visible
        label is both the hit target and the focus ring's host.
      */}
      <div
        className="seg"
        role="radiogroup"
        aria-label="Trip sections"
        style={{ marginBottom: 20 }}
      >
        {TABS.map(({ id: tabId, label }) => (
          <label key={tabId} className="seg-opt">
            <input
              type="radio"
              name="trip-tab"
              value={tabId}
              checked={tab === tabId}
              onChange={() => selectTab(tabId)}
            />
            {label}
          </label>
        ))}
      </div>

      {tab === "overview" && (
        <OverviewTab
          trip={trip}
          bookings={bookings}
          people={people}
          rollup={rollup}
          api={api}
        />
      )}
      {tab === "days" && <DayView tripId={trip.id} people={travelers} api={api} />}
      {tab === "travelers" && (
        <TravelersTab people={travelers} arrivalOn={trip.startsOn} today={today} api={api} />
      )}
      {tab === "checklist" && <ChecklistTab tripId={trip.id} people={people} api={api} />}
    </>
  );
}
```

`DayView` receives `travelers` (trip membership) so its filter chips list the people actually on the trip; `OverviewTab` and `ChecklistTab` receive the full household `people` because they resolve arbitrary `personIds` — a booking's or a checklist item's assignee — to a chip.

- [ ] **Step 4: Add the route**

In `src/client/main.tsx`, add the import and route:

```tsx
import { TripDetail } from "./pages/TripDetail.js";
```

```tsx
        <Route path="/trips/:id">
          {(params) => <TripDetail id={params.id!} />}
        </Route>
```

Place it **after** `<Route path="/trips" component={Trips} />` so the exact path matches first.

- [ ] **Step 5: Run the tests**

Run: `npm run test:client -- TripDetail`
Expected: FAIL — the tab components do not exist yet. This is expected; Task 5 creates them. To keep this task independently verifiable, create the four files now as one-line stubs:

`src/client/trip/OverviewTab.tsx`, `TravelersTab.tsx`, `ChecklistTab.tsx`, and `src/client/dayview/DayView.tsx`, each exporting a named component returning `null` and accepting the props above (including `TravelersTab`'s `arrivalOn` and `today`). Tasks 5 and 6 fill them.

Re-run: `npm run test:client -- TripDetail`
Expected: PASS, 9 tests.

- [ ] **Step 6: Commit**

```bash
git add src/client/pages/TripDetail.tsx src/client/trip src/client/dayview src/client/main.tsx tests/client/pages/TripDetail.test.tsx
git commit -m "feat: add trip detail shell with tabs"
```

---

### Task 5: Overview tab and right rail

**Files:**
- Modify: `src/client/trip/OverviewTab.tsx`
- Create: `src/client/trip/CostRollup.tsx`
- Modify: `src/client/trip/TravelersTab.tsx`
- Modify: `src/client/trip/ChecklistTab.tsx`
- Test: `tests/client/trip/OverviewTab.test.tsx`
- Test: `tests/client/trip/CostRollup.test.tsx`
- Test: `tests/client/trip/TravelersTab.test.tsx`

**Interfaces:**
- Consumes: `MaskedValue`, `PersonChips`, `formatDualZone`
- Produces: `OverviewTab`, `CostRollup`, `TravelersTab`, `ChecklistTab`

- [ ] **Step 1: Write the failing CostRollup test**

Create `tests/client/trip/CostRollup.test.tsx`:

```tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { CostRollup } from "../../../src/client/trip/CostRollup.js";

describe("CostRollup", () => {
  it("formats dollars from cents", () => {
    render(
      <CostRollup
        rollup={{ bookedCents: 148_400, plannedCents: 0, totalCents: 148_400, points: [] }}
      />,
    );
    expect(screen.getByText("$1,484.00")).toBeInTheDocument();
  });

  it("lists points by program", () => {
    render(
      <CostRollup
        rollup={{
          bookedCents: 0, plannedCents: 0, totalCents: 0,
          points: [{ program: "SkyMiles", used: 18_500 }],
        }}
      />,
    );
    expect(screen.getByText("18,500 SkyMiles")).toBeInTheDocument();
  });

  it("separates planned from booked when both exist", () => {
    render(
      <CostRollup
        rollup={{ bookedCents: 100_000, plannedCents: 48_400, totalCents: 148_400, points: [] }}
      />,
    );
    expect(screen.getByText(/\$484\.00 planned/)).toBeInTheDocument();
  });

  it("renders nothing when there is no cost and no points", () => {
    const { container } = render(
      <CostRollup rollup={{ bookedCents: 0, plannedCents: 0, totalCents: 0, points: [] }} />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run test:client -- CostRollup`
Expected: FAIL — cannot resolve the module.

- [ ] **Step 3: Write CostRollup**

Create `src/client/trip/CostRollup.tsx`:

```tsx
import type { TripRollup } from "../api/types.js";

const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const number = new Intl.NumberFormat("en-US");

export function CostRollup({ rollup }: { rollup: TripRollup }) {
  if (rollup.totalCents === 0 && rollup.points.length === 0) return null;

  return (
    <section className="card">
      <h6 className="card-kicker">Trip cost</h6>
      <div style={{ fontSize: 20, fontWeight: 500 }}>
        {money.format(rollup.totalCents / 100)}
      </div>
      {rollup.plannedCents > 0 && (
        <div className="card-meta">
          {money.format(rollup.bookedCents / 100)} booked ·{" "}
          {money.format(rollup.plannedCents / 100)} planned
        </div>
      )}
      {rollup.points.map((p) => (
        <div key={p.program} className="card-meta">
          {number.format(p.used)} {p.program}
        </div>
      ))}
    </section>
  );
}
```

- [ ] **Step 4: Write the failing OverviewTab test**

Create `tests/client/trip/OverviewTab.test.tsx`:

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { OverviewTab } from "../../../src/client/trip/OverviewTab.js";

const TRIP = {
  id: "t1", title: "Wedding", destination: "Guerneville, CA",
  startsOn: "2026-10-09", endsOn: "2026-10-11",
  status: "planning" as const, notes: null,
};

function booking(over: Record<string, unknown> = {}) {
  return {
    id: "b1", tripId: "t1", kind: "flight", title: "DL1422 BOI → ATL",
    location: null,
    startsAt: "2026-10-10T05:30:00Z", startsAtTz: "America/Boise",
    endsAt: "2026-10-10T11:00:00Z", endsAtTz: "America/New_York",
    confirmationNumberMasked: "••••X4T2", costCents: 42_000,
    pointsUsed: null, pointsProgram: null,
    status: "booked" as const, details: {}, personIds: ["p1"],
    ...over,
  };
}

const PEOPLE = [{ id: "p1", displayName: "Badger" }];
const ZERO = { bookedCents: 0, plannedCents: 0, totalCents: 0, points: [] };

function renderTab(bookings: unknown[]) {
  return render(
    <OverviewTab
      trip={TRIP}
      bookings={bookings as never}
      people={PEOPLE as never}
      rollup={ZERO}
      api={{ trips: { revealConfirmation: vi.fn() } } as never}
    />,
  );
}

describe("OverviewTab", () => {
  it("groups bookings under kind headings", () => {
    renderTab([booking(), booking({ id: "b2", kind: "lodging", title: "Highlands Resort" })]);
    expect(screen.getByText("Flights")).toBeInTheDocument();
    expect(screen.getByText("Stay & car")).toBeInTheDocument();
  });

  it("renders both timezones when they differ", () => {
    renderTab([booking()]);
    expect(screen.getByText(/MDT → .*EDT/)).toBeInTheDocument();
  });

  it("masks the confirmation number", () => {
    renderTab([booking()]);
    expect(screen.getByText("••••X4T2")).toBeInTheDocument();
  });

  it("tags a planned booking as needing booking", () => {
    renderTab([booking({ status: "planned" })]);
    expect(screen.getByText("Needs booking")).toBeInTheDocument();
  });

  it("tags a draft booking as a draft rather than as needing booking", () => {
    // A draft is an unreviewed email import, not a decision the family has
    // made. RollupRepo excludes it from the cost panel on this same screen,
    // so presenting it as "needs booking" would have the booking list and the
    // cost panel disagreeing about what exists.
    renderTab([booking({ status: "draft" })]);
    expect(screen.getByText("Draft")).toBeInTheDocument();
    expect(screen.queryByText("Needs booking")).not.toBeInTheDocument();
  });

  it("omits cancelled bookings entirely", () => {
    renderTab([booking({ status: "cancelled", title: "Cancelled hotel" })]);
    expect(screen.queryByText("Cancelled hotel")).not.toBeInTheDocument();
    expect(screen.getByText(/Nothing booked yet/i)).toBeInTheDocument();
  });

  it("renders an empty state with no bookings", () => {
    renderTab([]);
    expect(screen.getByText(/Nothing booked yet/i)).toBeInTheDocument();
  });
});
```

`api.trips.bookings` already filters cancelled server-side (`BookingRepo.listByTrip`), so the client filter is belt-and-braces — but it is what keeps this component honest about its own input, and it is what the third test above pins.

- [ ] **Step 5: Run it to verify it fails**

Run: `npm run test:client -- OverviewTab`
Expected: FAIL — the stub renders `null`.

- [ ] **Step 6: Write OverviewTab**

Replace `src/client/trip/OverviewTab.tsx`:

```tsx
import { AirplaneTakeoff, Bed, Car, Confetti, ForkKnife } from "@phosphor-icons/react";
import type { api as defaultApi } from "../api/client.js";
import type { Booking, Person, Trip, TripRollup } from "../api/types.js";
import { formatDualZone, formatTimeInZone } from "../lib/dates.js";
import { PersonChips } from "../components/PersonChip.js";
import { MaskedValue } from "../components/MaskedValue.js";
import { CostRollup } from "./CostRollup.js";

const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

const GROUPS = [
  { heading: "Flights", kinds: ["flight"] },
  { heading: "Stay & car", kinds: ["lodging", "car"] },
  { heading: "Events", kinds: ["activity", "other"] },
];

const ICONS: Record<string, typeof AirplaneTakeoff> = {
  flight: AirplaneTakeoff,
  lodging: Bed,
  car: Car,
  activity: Confetti,
};

function when(b: Booking): string {
  if (!b.startsAt) return "No date yet";
  if (b.endsAt && b.endsAtTz && b.startsAtTz) {
    return formatDualZone(b.startsAt, b.startsAtTz, b.endsAt, b.endsAtTz);
  }
  return formatTimeInZone(b.startsAt, b.startsAtTz ?? "UTC");
}

export function OverviewTab({
  trip,
  bookings,
  people,
  rollup,
  api,
}: {
  trip: Trip;
  bookings: Booking[];
  people: Person[];
  rollup: TripRollup | null;
  api: typeof defaultApi;
}) {
  // Cancelled bookings are not part of the trip. The server already excludes
  // them from listByTrip and RollupRepo excludes them from the totals; the
  // component agreeing is what stops a cancelled row from rendering as a
  // dashed "still to do" item next to a cost panel that has never heard of it.
  const visible = bookings.filter((b) => b.status !== "cancelled");

  if (visible.length === 0) {
    return <p className="text-muted">Nothing booked yet for this trip.</p>;
  }

  return (
    <div style={{ display: "flex", gap: 24, flexWrap: "wrap", alignItems: "flex-start" }}>
      <div style={{ flex: "2 1 520px", display: "flex", flexDirection: "column", gap: 20 }}>
        {GROUPS.map(({ heading, kinds }) => {
          const group = visible.filter((b) => kinds.includes(b.kind));
          if (group.length === 0) return null;

          return (
            <section key={heading}>
              <h6 className="card-kicker">{heading}</h6>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {group.map((b) => {
                  const Icon = ICONS[b.kind] ?? ForkKnife;
                  // Three distinct states, not two. `planned` is a decision
                  // the family has made but not yet paid for; `draft` is an
                  // unreviewed email import that no one has confirmed is even
                  // real, and which the cost rollup deliberately ignores.
                  const isDraft = b.status === "draft";
                  const needsBooking = b.status === "planned";
                  const provisional = isDraft || needsBooking;
                  return (
                    <div
                      key={b.id}
                      className="card"
                      style={
                        provisional
                          ? { border: "1px dashed var(--color-divider)", background: "none" }
                          : undefined
                      }
                    >
                      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                        <Icon size={18} />
                        <span style={{ fontSize: 15, fontWeight: 500 }}>{b.title}</span>
                        {isDraft && <span className="tag">Draft</span>}
                        {needsBooking && <span className="tag">Needs booking</span>}
                        <span style={{ marginLeft: "auto" }}>
                          <PersonChips
                            people={people.filter((p) => b.personIds.includes(p.id))}
                          />
                        </span>
                      </div>
                      <div className="card-meta">
                        <span>{when(b)}</span>
                        {b.confirmationNumberMasked && (
                          <MaskedValue
                            masked={b.confirmationNumberMasked}
                            onReveal={async () =>
                              (await api.trips.revealConfirmation(trip.id, b.id)).value
                            }
                          />
                        )}
                        {b.costCents !== null && (
                          <span style={{ marginLeft: "auto" }}>
                            {money.format(b.costCents / 100)}
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
          );
        })}
      </div>

      <aside style={{ flex: "1 1 300px", display: "flex", flexDirection: "column", gap: 14 }}>
        {rollup && <CostRollup rollup={rollup} />}
      </aside>
    </div>
  );
}
```

**Two policy notes, applied here and everywhere else in this plan.**

*No dead controls.* Design 1b shows an unbooked row as "dashed border + `Book →` ghost", plus `Add booking`/edit affordances in the header — all of which open the add-booking dialog, which is plan 4. Earlier drafts of this plan kept `Book →` (on the reasoning that the design shows the affordance) while silently dropping the header buttons, which is the same situation resolved two opposite ways. The consistent rule, stated once: **render the state, not the unavailable action.** A provisional booking still reads as provisional — dashed border, `Needs booking`/`Draft` tag — which is the information the row carries; it just does not offer a button that does nothing when pressed. Plan 4 adds the dialog and, with it, `Book →`, `Add booking`, and edit, all wired. A control that looks pressable and isn't is worse than an honest absence, and it is untestable besides.

*Right-rail deviation (disclosed).* Design 1b specifies three right-rail cards — Travelers, Checklist, Trip cost rollup. This plan ships **only `CostRollup`** in the rail, and puts Travelers and Checklist in their own tabs. Rationale: the design has both a Travelers tab *and* a Travelers rail card, and both a Checklist tab *and* a Checklist rail card, so building both is duplicated content and a second fetch of the same data on a page that is already fluid down to 390px, where the rail wraps under the content anyway. The tabs carry the full version. This is a deliberate deviation, not complete coverage of 1b. The one piece of rail content with independent value is the Travelers card's expiring-passport warning row, since it otherwise surfaces only if someone opens the Travelers tab — plan 4 should promote it to a trip-level warning banner. Recorded again under "Not in this plan".

- [ ] **Step 7: Write the failing TravelersTab test**

Create `tests/client/trip/TravelersTab.test.tsx`:

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { TravelersTab } from "../../../src/client/trip/TravelersTab.js";

function person(over: Record<string, unknown> = {}) {
  return {
    id: "p1", displayName: "Badger", dob: null, notes: null,
    passportExpiry: "2027-01-15", passportCountry: "US",
    passportNumberMasked: "••••1234",
    knownTravelerNumberMasked: null, redressNumberMasked: null,
    ...over,
  };
}

const api = { people: { reveal: vi.fn(async () => ({ value: "X" })) } };

function renderTab(people: unknown[], arrivalOn: string | null) {
  return render(
    <TravelersTab
      people={people as never}
      arrivalOn={arrivalOn}
      today="2026-07-21"
      api={api as never}
    />,
  );
}

describe("TravelersTab", () => {
  it("does not warn about a passport with six months' validity at arrival", () => {
    // Arrival 2026-10-09, expiry 2027-06-01 — comfortably clear. Measuring
    // from *today* against the old 190-day threshold would have warned here.
    renderTab([person({ passportExpiry: "2027-06-01" })], "2026-10-09");
    expect(screen.queryByText(/under six months/i)).not.toBeInTheDocument();
  });

  it("warns when validity runs short measured from arrival, not from today", () => {
    // Expiry 2027-01-15 is ~178 days after the 2026-10-09 arrival: short.
    renderTab([person()], "2026-10-09");
    expect(screen.getByText(/under six months' validity at arrival/i)).toBeInTheDocument();
  });

  it("distinguishes an already-expired passport from one expiring soon", () => {
    renderTab([person({ passportExpiry: "2026-01-01" })], "2026-10-09");
    expect(screen.getByText(/expired 2026-01-01/)).toBeInTheDocument();
    expect(screen.queryByText(/under six months/i)).not.toBeInTheDocument();
  });

  it("falls back to today when the trip has no dates", () => {
    renderTab([person({ passportExpiry: "2026-08-01" })], null);
    expect(screen.getByText(/under six months' validity at arrival/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 8: Write TravelersTab and ChecklistTab**

Replace `src/client/trip/TravelersTab.tsx`:

```tsx
import { WarningCircle } from "@phosphor-icons/react";
import type { api as defaultApi } from "../api/client.js";
import type { Person } from "../api/types.js";
import { PersonChip } from "../components/PersonChip.js";
import { MaskedValue } from "../components/MaskedValue.js";
import { daysUntil } from "../lib/dates.js";

/**
 * Many countries require roughly six months' passport validity **beyond the
 * date of arrival** — not beyond today. Measuring from today warns about a
 * passport that is perfectly valid for a trip eight months out, and (worse)
 * stays quiet about one that expires two weeks into a trip fourteen months
 * out. `arrivalOn` is the trip's start date; fall back to `today` only when
 * the trip has no dates yet.
 */
const REQUIRED_VALIDITY_DAYS = 183;

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

  const measureFrom = arrivalOn ?? today;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {people.map((p) => {
        // Two different questions, two different reference dates: "is this
        // document already dead?" is measured from today; "will it still be
        // valid long enough when we land?" is measured from arrival.
        const expired = p.passportExpiry !== null && daysUntil(p.passportExpiry, today) < 0;
        const validityAtArrival = p.passportExpiry
          ? daysUntil(p.passportExpiry, measureFrom)
          : null;
        const tooShort =
          !expired && validityAtArrival !== null && validityAtArrival < REQUIRED_VALIDITY_DAYS;

        return (
          <div key={p.id} className="card">
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <PersonChip person={p} />
              <span style={{ fontSize: 15, fontWeight: 500 }}>{p.displayName}</span>
            </div>
            <div className="card-meta">
              <span>Passport</span>
              <MaskedValue
                masked={p.passportNumberMasked}
                onReveal={async () =>
                  (await api.people.reveal(p.id, "passport_number")).value
                }
              />
              {p.passportExpiry && (
                <span className={expired || tooShort ? "warning" : undefined}>
                  {(expired || tooShort) && <WarningCircle size={12} />}{" "}
                  {expired
                    ? `expired ${p.passportExpiry}`
                    : tooShort
                      ? `expires ${p.passportExpiry} — under six months' validity at arrival`
                      : `expires ${p.passportExpiry}`}
                </span>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
```

Replace `src/client/trip/ChecklistTab.tsx`:

```tsx
import { useEffect, useState } from "react";
import type { api as defaultApi } from "../api/client.js";
import type { ChecklistItem, Person } from "../api/types.js";
import { PersonChip } from "../components/PersonChip.js";

export function ChecklistTab({
  tripId,
  people,
  api,
}: {
  tripId: string;
  people: Person[];
  api: typeof defaultApi;
}) {
  const [items, setItems] = useState<ChecklistItem[]>([]);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api.checklist
      .list()
      .then((all) => {
        if (!cancelled) setItems(all.filter((i) => i.tripId === tripId));
      })
      // Same rule as TripDetail: an unhandled rejection here would leave the
      // tab looking like an empty checklist, which is a lie — "nothing to do"
      // and "we could not find out" must not render identically.
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [api, tripId]);

  async function toggle(item: ChecklistItem) {
    const done = item.doneAt === null;
    try {
      await api.checklist.setDone(item.id, done);
    } catch {
      // The write failed (403 for a viewer, 404 for an item deleted in
      // another tab). Leave the item as it was rather than optimistically
      // showing a state the server rejected.
      setFailed(true);
      return;
    }
    setItems((prev) =>
      prev.map((i) =>
        i.id === item.id ? { ...i, doneAt: done ? new Date().toISOString() : null } : i,
      ),
    );
  }

  const doneCount = items.filter((i) => i.doneAt !== null).length;

  if (failed) {
    return (
      <p className="text-muted" role="alert">
        Couldn't load this trip's checklist.
      </p>
    );
  }

  if (items.length === 0) {
    return <p className="text-muted">No checklist items for this trip yet.</p>;
  }

  return (
    <section>
      <h6 className="card-kicker">
        {doneCount} of {items.length} done
      </h6>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {items.map((item) => {
          const assignee = people.find((p) => p.id === item.personId);
          const done = item.doneAt !== null;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => toggle(item)}
              className="card"
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 10,
                textAlign: "left",
                cursor: "pointer",
                opacity: done ? 0.45 : 1,
                textDecoration: done ? "line-through" : "none",
              }}
            >
              <span style={{ fontSize: 13 }}>{item.label}</span>
              {item.dueOn && <span className="card-meta">due {item.dueOn}</span>}
              <span style={{ marginLeft: "auto" }}>
                {assignee && <PersonChip person={assignee} />}
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
```

- [ ] **Step 9: Run the tests**

Run: `npm run test:client -- "trip/"`
Expected: PASS — 4 CostRollup, 7 OverviewTab, 4 TravelersTab.

- [ ] **Step 10: Commit**

```bash
git add src/client/trip tests/client/trip
git commit -m "feat: add trip detail overview, travelers, checklist, and cost rollup"
```

---

### Task 6: Day view — shape 1c

The centerpiece. Shape 1c is a shared agenda with person filter chips; the `DayView` boundary exists so shape 1d can be added later as a desktop-only toggle without touching callers.

**Files:**
- Modify: `src/client/dayview/DayView.tsx`
- Create: `src/client/dayview/SharedAgenda.tsx`
- Create: `src/client/dayview/PersonFilter.tsx`
- Create: `src/client/dayview/DatePager.tsx`
- Test: `tests/client/dayview/DayView.test.tsx`

**Interfaces:**
- Consumes: `api.trips.itinerary`, `formatDualZone`, `PersonChips`
- Produces: `DayView({ tripId, people, api })` — fetches the itinerary, owns filter and date state, delegates rendering to `SharedAgenda`

- [ ] **Step 1: Write the failing test**

Create `tests/client/dayview/DayView.test.tsx`:

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DayView } from "../../../src/client/dayview/DayView.js";

const PEOPLE = [
  { id: "p-badger", displayName: "Badger" },
  { id: "p-ava", displayName: "Ava" },
];

function booking(id: string, title: string, personIds: string[]) {
  return {
    id, tripId: "t1", kind: "other", title, location: null,
    startsAt: "2026-10-09T15:00:00Z", startsAtTz: "America/Boise",
    endsAt: null, endsAtTz: null, confirmationNumberMasked: null,
    costCents: null, pointsUsed: null, pointsProgram: null,
    status: "booked" as const, details: {}, personIds,
  };
}

const DAYS = [
  {
    date: "2026-10-09",
    bookings: [
      booking("b1", "Shared flight", ["p-badger", "p-ava"]),
      booking("b2", "Badger's solo dinner", ["p-badger"]),
    ],
  },
  { date: "2026-10-10", bookings: [booking("b3", "Wedding", ["p-badger", "p-ava"])] },
];

function makeApi(days = DAYS) {
  return { trips: { itinerary: vi.fn(async () => days) } };
}

function renderDayView(api = makeApi()) {
  return render(<DayView tripId="t1" people={PEOPLE as never} api={api as never} />);
}

describe("DayView", () => {
  it("renders the first day's bookings", async () => {
    renderDayView();
    expect(await screen.findByText("Shared flight")).toBeInTheDocument();
    expect(screen.getByText("Badger's solo dinner")).toBeInTheDocument();
  });

  it("offers a filter chip per traveller", async () => {
    renderDayView();
    for (const name of ["Badger", "Ava"]) {
      expect(await screen.findByRole("button", { name: new RegExp(name) })).toBeInTheDocument();
    }
  });

  it("refetches scoped to one person when a chip is selected", async () => {
    const api = makeApi();
    renderDayView(api);
    await screen.findByText("Shared flight");
    await userEvent.click(screen.getByRole("button", { name: /Ava/ }));
    expect(api.trips.itinerary).toHaveBeenLastCalledWith("t1", "p-ava");
  });

  it("returns to the whole-family view when the chip is deselected", async () => {
    const api = makeApi();
    renderDayView(api);
    await screen.findByText("Shared flight");
    const chip = screen.getByRole("button", { name: /Ava/ });
    await userEvent.click(chip);
    await userEvent.click(chip);
    expect(api.trips.itinerary).toHaveBeenLastCalledWith("t1", undefined);
  });

  it("pages between days", async () => {
    renderDayView();
    await screen.findByText("Shared flight");
    await userEvent.click(screen.getByRole("button", { name: /next day/i }));
    expect(screen.getByText("Wedding")).toBeInTheDocument();
    expect(screen.queryByText("Shared flight")).not.toBeInTheDocument();
  });

  it("renders an empty state when nothing is scheduled", async () => {
    renderDayView(makeApi([]));
    expect(await screen.findByText(/Nothing scheduled/i)).toBeInTheDocument();
  });

  it("reports a failed itinerary load rather than spinning forever", async () => {
    const api = { trips: { itinerary: vi.fn(async () => { throw new Error("404"); }) } };
    renderDayView(api as never);
    expect(await screen.findByRole("alert")).toHaveTextContent(/couldn't load|could not load/i);
    expect(screen.queryByText(/Loading/)).not.toBeInTheDocument();
  });
});
```

The third test encodes an important decision: filtering **refetches from the server** rather than filtering client-side. The server owns the `booking_person` join and the timezone-correct day grouping, and a client-side filter would have to re-derive both — which is exactly where an off-by-one-day bug would appear.

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run test:client -- DayView`
Expected: FAIL — the stub renders `null`.

- [ ] **Step 3: Write PersonFilter**

Create `src/client/dayview/PersonFilter.tsx`:

```tsx
import { Check } from "@phosphor-icons/react";
import type { Person } from "../api/types.js";
import { PersonChip } from "../components/PersonChip.js";

export function PersonFilter({
  people,
  selected,
  onSelect,
}: {
  people: Pick<Person, "id" | "displayName">[];
  selected: string | null;
  onSelect: (personId: string | null) => void;
}) {
  return (
    <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
      {people.map((p) => {
        const on = selected === p.id;
        return (
          <button
            key={p.id}
            type="button"
            className={on ? "btn btn-primary" : "btn btn-secondary"}
            aria-pressed={on}
            onClick={() => onSelect(on ? null : p.id)}
          >
            <PersonChip person={p} />
            {p.displayName}
            {on && <Check size={12} />}
          </button>
        );
      })}
    </div>
  );
}
```

Clicking the selected chip deselects it, returning to the whole-family view. There is no separate "Everyone" chip — the filter is a toggle, not a radio group.

- [ ] **Step 4: Write DatePager**

Create `src/client/dayview/DatePager.tsx`:

```tsx
import { CaretLeft, CaretRight } from "@phosphor-icons/react";

export function DatePager({
  dates,
  index,
  onChange,
}: {
  dates: string[];
  index: number;
  onChange: (index: number) => void;
}) {
  if (dates.length === 0) return null;

  const label = new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${dates[index]}T00:00:00Z`));

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <button
        type="button"
        className="btn btn-secondary btn-icon"
        aria-label="previous day"
        disabled={index === 0}
        onClick={() => onChange(index - 1)}
      >
        <CaretLeft size={14} />
      </button>
      <span style={{ fontSize: 15, fontWeight: 500, minWidth: 200 }}>{label}</span>
      <button
        type="button"
        className="btn btn-secondary btn-icon"
        aria-label="next day"
        disabled={index >= dates.length - 1}
        onClick={() => onChange(index + 1)}
      >
        <CaretRight size={14} />
      </button>
    </div>
  );
}
```

The date label formats in `UTC` deliberately: `dates[index]` is a plain calendar date the server already resolved in the event's own timezone, so re-interpreting it in the viewer's zone would shift it by a day.

- [ ] **Step 5: Write SharedAgenda (shape 1c)**

Create `src/client/dayview/SharedAgenda.tsx`:

```tsx
import type { Booking, Person } from "../api/types.js";
import { formatDualZone, formatTimeInZone } from "../lib/dates.js";
import { PersonChips } from "../components/PersonChip.js";

function when(b: Booking): string {
  if (!b.startsAt) return "";
  if (b.endsAt && b.endsAtTz && b.startsAtTz) {
    return formatDualZone(b.startsAt, b.startsAtTz, b.endsAt, b.endsAtTz);
  }
  return formatTimeInZone(b.startsAt, b.startsAtTz ?? "UTC");
}

/**
 * Day view shape 1c — one shared timeline for the whole family, with a person
 * filter above it. Shape 1d (column per person) is backlogged as a desktop-only
 * toggle; keep this component's props free of anything shape-specific so it
 * stays swappable behind DayView.
 */
export function SharedAgenda({
  bookings,
  people,
}: {
  bookings: Booking[];
  people: Pick<Person, "id" | "displayName">[];
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      {bookings.map((b) => {
        // Same three-state vocabulary as OverviewTab: a hollow dot and a
        // dashed card mean "not confirmed" (planned or draft). The server's
        // itinerary query already excludes cancelled bookings.
        const provisional = b.status !== "booked";
        return (
          <div key={b.id} style={{ display: "flex", gap: 12, alignItems: "stretch" }}>
            <div
              className="time-gutter"
              style={{ width: 150, paddingTop: 14, fontSize: 12.5 }}
            >
              {when(b)}
            </div>

            {/* The timeline spine: a continuous accent rule with a dot per event. */}
            <div
              style={{
                width: 1,
                background: "var(--color-accent-800)",
                position: "relative",
                flex: "none",
              }}
            >
              <span
                style={{
                  position: "absolute",
                  top: 18,
                  left: -4,
                  width: 9,
                  height: 9,
                  borderRadius: "50%",
                  background: provisional ? "transparent" : "var(--color-accent)",
                  border: provisional ? "1px solid var(--color-accent)" : "none",
                }}
              />
            </div>

            <div
              className="card"
              style={{
                flex: 1,
                maxWidth: 760,
                margin: "6px 0",
                ...(provisional
                  ? { border: "1px dashed var(--color-divider)", background: "none" }
                  : {}),
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <span style={{ fontSize: 15, fontWeight: 500 }}>{b.title}</span>
                <span style={{ marginLeft: "auto" }}>
                  <PersonChips people={people.filter((p) => b.personIds.includes(p.id))} />
                </span>
              </div>
              {b.location && <div className="card-meta">{b.location}</div>}
            </div>
          </div>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 6: Write the DayView boundary**

Replace `src/client/dayview/DayView.tsx`:

```tsx
import { useEffect, useState } from "react";
import type { api as defaultApi } from "../api/client.js";
import type { ItineraryDay, Person } from "../api/types.js";
import { PersonFilter } from "./PersonFilter.js";
import { DatePager } from "./DatePager.js";
import { SharedAgenda } from "./SharedAgenda.js";

/**
 * The day-view boundary.
 *
 * Today it always renders shape 1c (SharedAgenda). Shape 1d, the
 * column-per-person grid, is backlogged as a desktop-only toggle — when it
 * lands, it swaps in here and callers do not change. Keep shape-specific
 * concerns out of this component's props.
 */
export function DayView({
  tripId,
  people,
  api,
}: {
  tripId: string;
  people: Person[];
  api: typeof defaultApi;
}) {
  const [days, setDays] = useState<ItineraryDay[] | null>(null);
  const [personId, setPersonId] = useState<string | null>(null);
  const [index, setIndex] = useState(0);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setFailed(false);
    // Filtering refetches rather than filtering client-side: the server owns the
    // booking_person join and the timezone-correct day grouping, and re-deriving
    // either here is exactly where an off-by-one-day bug would appear.
    api.trips
      .itinerary(tripId, personId ?? undefined)
      .then((d) => {
        if (cancelled) return;
        setDays(d);
        setIndex((i) => Math.min(i, Math.max(0, d.length - 1)));
      })
      // Same rule as TripDetail: an unknown trip id (or a person id that is
      // not in this household) 404s, and without this the view is stuck on
      // "Loading…" with an unhandled rejection behind it.
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [api, tripId, personId]);

  if (failed) {
    return (
      <p className="text-muted" role="alert">
        Couldn't load this trip's itinerary.
      </p>
    );
  }
  if (days === null) return <p className="text-muted">Loading…</p>;

  const current = days[index];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ display: "flex", gap: 16, flexWrap: "wrap", alignItems: "center" }}>
        <DatePager
          dates={days.map((d) => d.date)}
          index={index}
          onChange={setIndex}
        />
        <div style={{ marginLeft: "auto" }}>
          <PersonFilter people={people} selected={personId} onSelect={setPersonId} />
        </div>
      </div>

      {current ? (
        <SharedAgenda bookings={current.bookings} people={people} />
      ) : (
        <p className="text-muted">
          Nothing scheduled{personId ? " for this traveller" : ""} on this trip yet.
        </p>
      )}
    </div>
  );
}
```

- [ ] **Step 7: Run the tests**

Run: `npm run test:client -- DayView`
Expected: PASS, 7 tests.

- [ ] **Step 8: Run everything**

Run: `npm run test:all && npm run build && npm run typecheck`
Expected: all PASS, both commands exit 0.

- [ ] **Step 9: Verify at phone width**

Start the dev server, open a trip's Day by day tab at 390px, and confirm: the date pager and filter chips stack rather than overflowing, the 150px time gutter does not force horizontal scroll (reduce it to a stacked label above the card if it does), and event cards fill the width. Fix with the existing fluid rules — do not add breakpoints.

This is exploration 1e's layout. If the time gutter cannot be made to work at 390px, the correct fix is to move the time inside the card on narrow viewports via a container query, not a media breakpoint.

- [ ] **Step 10: Commit**

```bash
git add src/client/dayview tests/client/dayview
git commit -m "feat: add per-person day view (shape 1c) behind a DayView boundary"
```

---

## Not in this plan

Deferred to plan 4 and beyond:

1. **Import screen** (`/import`) — **plan 4 owns this, unambiguously.** Paste/forward/upload tabs, the draft review card, manual entry. Backend already accepts `status: 'draft'`. Plan 2 previously deferred Import "to plan 3" while this plan deferred it "to plan 4", so neither document owned it and plan 2's `Shell` shipped a prominent `Import` nav link routing to "Not found". Plan 2 is being amended to resolve the nav link; **this plan does not build Import in any form, and plan 4 is its owner.**
2. **Add booking dialog** (exploration 1g) — one dialog with a kind segmented control. It also brings the affordances this plan deliberately omits under the "no dead controls" policy in Task 5: `Book →` on a provisional row, and design 1b's header `Add booking` and edit buttons. All three land together, wired, in plan 4.
3. **"Next best actions" card on Home** — the ranked checklist panel from design §1's Home page. Plan 2 deferred it here on the grounds that it needed `checklist_item` repositories; **this plan builds `ChecklistRepo`, `GET/POST /api/checklist`, and `api.checklist.*`, so the blocking dependency is now satisfied and no further backend work is required** — but the card itself is deferred to plan 4. Reason: it lives in `src/client/pages/Home.tsx`, which is plan 2's file (and is being amended concurrently), and this plan's scope is trip detail and the day view; wiring a Home panel here would mean two plans editing the same component. Plan 4 should build it directly on `api.checklist.list()`, ranking by `dueOn` with `doneAt === null` first, and clicking a row calling `api.checklist.setDone`. This is a first-class panel in the design and is being explicitly deferred, not dropped.
4. **Design 1b's right-rail Travelers and Checklist cards** — see the disclosed deviation in Task 5. The rail ships with `CostRollup` only; the tabs carry the full Travelers and Checklist content. The expiring-passport warning row is the one piece with value outside its tab and should become a trip-level warning banner in plan 4.
5. **Trips list page** — still the stub from plan 2.
6. **People page** — still a stub; needs the real empty state, since a fresh instance has no people and nothing else works until the family is entered.
7. **Cross-trip checklist route** (`/checklist`) — `api.checklist.list()` already returns every trip's items; the page is a stub.
8. **Day view shape 1d** — desktop-only toggle, backlogged.
9. **Per-trip booking counts** for the Home trips grid.
10. **Offline caching** of the active trip.

## Self-review notes

- **Spec coverage:** the day view (success criterion 3) and the cost rollup are complete. Criterion 2 — creating a trip with bookings — is still not reachable through the UI; that needs the add-booking dialog in plan 4. Bookings can only be created through the API until then. Coverage of design 1b is **not** complete: the right rail ships `CostRollup` only, with Travelers and Checklist living in tabs instead of being duplicated in the rail, and the header `Add booking`/edit affordances are omitted. Both deviations are stated in Task 5 and listed under "Not in this plan".
- **No dead controls.** Stated once in Task 5 and applied uniformly: a provisional booking renders its *state* (dashed border, `Needs booking` or `Draft` tag) but not a `Book →` button that does nothing, and the header gets no inert `Add booking`/edit either. Plan 4's add-booking dialog turns all of them on together. The previous draft kept `Book →` inert while silently dropping the header buttons — the same situation decided two different ways.
- **Backend contract.** Every server change here follows the *implemented* backend, not this plan's earlier assumptions about it: `NotFoundError` (404) for an id absent from this household — never `TenantScopeError`, which `mapError` deliberately turns into a 500 "Internal error"; no local `try/catch` around repo calls, because `app.onError` is the single status-mapping decision; a local `try/catch` around `c.req.json()` only, returning 400 "Invalid JSON body", which is the one thing routes handle themselves; and existence checks before both `setDone` and `RollupRepo.forTrip` so neither reports success or zeros for an id that does not exist. Repo tests assert the specific error class, since a bare `.toThrow()` is exactly what let the wrong class through review.
- **No unhandled fetches.** `TripDetail`, `DayView`, and `ChecklistTab` each `catch` their loads and render a `role="alert"` error state, and each has a test that drives a rejection — a test whose mocks only ever resolve does not exercise the failure path at all.
- **Trip membership comes from `trip_person`,** via `GET /api/trips/:tripId/travelers` (plan 2, Task 0), not from `bookings.flatMap(b => b.personIds)`. The latter is *booking* membership: a person on the trip but not yet on any booking would be missing from the header chips and from the Travelers tab, which is precisely the pre-booking state that tab exists to show.
- **No breaking changes to earlier plans.** Confirmation encryption and the tenancy-scope hardening both moved into the backend plan on 2026-07-21, so nothing here alters a signature or a behaviour that plans 1 and 2 already established. `ChecklistRepo.setDone` is the first UPDATE with a placeholder before the `{scope}` token, and since the base class binds the household id as a *named* parameter, that ordering needs nothing special.
- **Type consistency:** `ChecklistItem` and `TripRollup` are re-exported through `src/client/api/types.ts` like every other domain type, so client and server cannot drift.
