import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { BookingRepo } from "../../../src/server/repos/booking.js";
import { InboundEmailRepo } from "../../../src/server/repos/inbound-email.js";
import { HouseholdSettingsRepo } from "../../../src/server/repos/household-settings.js";
import { Keyring } from "../../../src/server/crypto/envelope.js";
import { ValidationError } from "../../../src/server/repos/base.js";
import type { HouseholdContext } from "../../../src/server/repos/base.js";

/**
 * Regression suite for issue #21: multi-row invariants and state transitions
 * that used to be a sequence of independent D1 calls.
 *
 * These tests are deliberately not "does the happy path still work" — the
 * existing per-repo suites cover that. Each one drives a repository through
 * the window between its calls, either by failing a statement mid-batch or by
 * letting a second writer in, and asserts the database is never left in the
 * in-between state and the loser is never told it won.
 */

const ring = new Keyring("test-v1", { "test-v1": crypto.getRandomValues(new Uint8Array(32)) });
const ctxA: HouseholdContext = { householdId: "hh-a", userId: "u1", role: "owner" };
const ctxB: HouseholdContext = { householdId: "hh-b", userId: "u2", role: "owner" };

beforeEach(async () => {
  for (const table of [
    "booking_person",
    "trip_person",
    "booking",
    "person",
    "trip",
    "inbound_email",
    "household_settings",
    "household",
  ]) {
    await env.DB.exec(`DELETE FROM ${table}`);
  }
  const now = new Date().toISOString();
  const household = env.DB.prepare("INSERT INTO household (id,name,created_at) VALUES (?,?,?)");
  await household.bind("hh-a", "A", now).run();
  await household.bind("hh-b", "B", now).run();
  await env.DB.prepare("INSERT INTO trip (id,household_id,title,created_at) VALUES (?,?,?,?)")
    .bind("t1", "hh-a", "Trip", now)
    .run();
  await env.DB.prepare("INSERT INTO person (id,household_id,display_name,created_at) VALUES (?,?,?,?)")
    .bind("p-ava", "hh-a", "Ava", now)
    .run();
});

/**
 * Wraps a D1Database so every prepare() passes through `hook`, which may
 * return a different (or differently behaving) statement for a given SQL
 * string. This is how a failure gets injected into the middle of a batch, and
 * how a competing writer gets to run at an exact instant — neither is
 * reachable by calling the repositories normally, because the whole point of
 * the fix is that nothing else can observe the in-between state.
 *
 * Test-only, and confined to this file: the repositories under test still see
 * an ordinary D1Database and take no test hooks of their own.
 */
type PrepareHook = (sql: string, real: D1PreparedStatement) => D1PreparedStatement;

function hookPrepare(db: D1Database, hook: PrepareHook): D1Database {
  return new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === "prepare") {
        return (sql: string) => hook(sql, target.prepare(sql));
      }
      const value: unknown = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as D1Database;
}

/**
 * A prepared statement that runs `before()` the first time it is executed.
 * bind() returns a fresh statement in the D1 API, so the wrapper has to
 * survive it — otherwise the hook is dropped the moment parameters are bound.
 */
function runAfter(stmt: D1PreparedStatement, before: () => Promise<void>): D1PreparedStatement {
  let fired = false;
  const wrap = (inner: D1PreparedStatement): D1PreparedStatement =>
    new Proxy(inner, {
      get(target, prop, receiver) {
        if (prop === "bind") {
          return (...args: unknown[]) => wrap(target.bind(...(args as never[])));
        }
        if (prop === "run") {
          return async () => {
            if (!fired) {
              fired = true;
              await before();
            }
            return target.run();
          };
        }
        const value: unknown = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as D1PreparedStatement;
  return wrap(stmt);
}

async function joinRows(): Promise<{ bookingPeople: number; tripPeople: number }> {
  const bookingPeople = await env.DB.prepare("SELECT COUNT(*) AS n FROM booking_person").first<{ n: number }>();
  const tripPeople = await env.DB.prepare("SELECT COUNT(*) AS n FROM trip_person").first<{ n: number }>();
  return { bookingPeople: bookingPeople?.n ?? 0, tripPeople: tripPeople?.n ?? 0 };
}

async function newBooking(): Promise<string> {
  const booking = await new BookingRepo(env.DB, ctxA, ring).create({
    tripId: "t1",
    kind: "other",
    title: "Hotel",
    details: {},
  });
  return booking.id;
}

describe("BookingRepo.assignPerson is atomic across booking_person and trip_person", () => {
  it("writes both join rows on the happy path", async () => {
    const bookingId = await newBooking();
    await new BookingRepo(env.DB, ctxA, ring).assignPerson(bookingId, "p-ava");
    expect(await joinRows()).toEqual({ bookingPeople: 1, tripPeople: 1 });
  });

  it("rolls the booking_person row back when the trip_person insert fails", async () => {
    const bookingId = await newBooking();
    // Rewrite ONLY the trip_person statement into one that violates NOT NULL
    // at execution time (not at bind time — it keeps both placeholders — so
    // the booking_person insert ahead of it in the batch has definitely
    // already run when the failure lands). Before the fix these were two
    // separate unscopedRun() calls and the first one survived.
    const db = hookPrepare(env.DB, (sql, real) =>
      sql.includes("INTO trip_person")
        ? env.DB.prepare(
            "INSERT INTO trip_person (trip_id, person_id) SELECT ?, NULL WHERE ? IS NOT NULL",
          )
        : real,
    );

    await expect(new BookingRepo(db, ctxA, ring).assignPerson(bookingId, "p-ava")).rejects.toThrow();

    // The invariant "on a booking for a trip means on that trip" holds by
    // holding vacuously: neither row exists.
    expect(await joinRows()).toEqual({ bookingPeople: 0, tripPeople: 0 });
  });

  it("leaves an already-assigned person intact when a later statement fails", async () => {
    const bookingId = await newBooking();
    await new BookingRepo(env.DB, ctxA, ring).assignPerson(bookingId, "p-ava");

    const second = await newBooking();
    const db = hookPrepare(env.DB, (sql, real) =>
      sql.includes("INTO trip_person")
        ? env.DB.prepare(
            "INSERT INTO trip_person (trip_id, person_id) SELECT ?, NULL WHERE ? IS NOT NULL",
          )
        : real,
    );
    await expect(new BookingRepo(db, ctxA, ring).assignPerson(second, "p-ava")).rejects.toThrow();

    // The rollback is scoped to the failed batch: the earlier assignment is
    // untouched, and the failed one left nothing behind.
    const rows = await env.DB.prepare("SELECT booking_id FROM booking_person").all<{ booking_id: string }>();
    expect(rows.results).toEqual([{ booking_id: bookingId }]);
    expect((await joinRows()).tripPeople).toBe(1);
  });
});

describe("InboundEmailRepo transitions are compare-and-set", () => {
  async function receivedEmail(): Promise<string> {
    const created = await new InboundEmailRepo(env.DB, ctxA).create({
      from: "badger@example.com",
      to: "trips@badgerops.foo",
      raw: "raw",
    });
    return created.id;
  }

  it("returns the persisted row, not a synthesized one", async () => {
    const repo = new InboundEmailRepo(env.DB, ctxA);
    const id = await receivedEmail();
    const returned = await repo.markFailed(id, "extractor returned no JSON");
    expect(returned).toEqual(await repo.findById(id));
  });

  it("lets exactly one of two concurrent transitions win", async () => {
    const repo = new InboundEmailRepo(env.DB, ctxA);
    const id = await receivedEmail();

    // Both calls read `received` before either writes — the interleaving the
    // old code reported as two successes.
    const outcomes = await Promise.allSettled([
      repo.markExtracted(id),
      repo.markFailed(id, "extractor returned no JSON"),
    ]);

    const won = outcomes.filter((o) => o.status === "fulfilled");
    const lost = outcomes.filter((o) => o.status === "rejected");
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect((lost[0] as PromiseRejectedResult).reason).toBeInstanceOf(ValidationError);

    // And the winner described the row the database actually holds.
    const persisted = await repo.findById(id);
    expect(persisted).toEqual((won[0] as PromiseFulfilledResult<unknown>).value);
  });

  it("refuses when another writer takes the row between the read and the update", async () => {
    const id = await receivedEmail();
    // Deterministic version of the race above: the competing write lands in
    // the exact gap, after the pre-check has seen `received` and before the
    // conditional UPDATE executes.
    const db = hookPrepare(env.DB, (sql, real) =>
      sql.startsWith("UPDATE inbound_email SET status")
        ? runAfter(real, async () => {
            await env.DB.prepare("UPDATE inbound_email SET status = 'failed', error = ? WHERE id = ?")
              .bind("won by another worker", id)
              .run();
          })
        : real,
    );

    const raced = new InboundEmailRepo(db, ctxA).markExtracted(id);
    await expect(raced).rejects.toThrow(ValidationError);
    // Named as a race, not as the ordinary "already terminal" rejection: this
    // caller DID see `received` and still lost.
    await expect(raced).rejects.toThrow(/transitioned concurrently/);

    // The row still holds the winner's state — the loser neither overwrote it
    // nor reported `extracted` back to its caller.
    const row = await new InboundEmailRepo(env.DB, ctxA).findById(id);
    expect(row?.status).toBe("failed");
    expect(row?.error).toBe("won by another worker");
  });
});

describe("HouseholdSettingsRepo forward-address conflicts", () => {
  const TAKEN = "That forward address is already in use by another household";

  it("rejects a clash the pre-check catches", async () => {
    await new HouseholdSettingsRepo(env.DB, ctxA, ring).updateSettings({
      forwardAddress: "trips@badgerops.foo",
    });
    await expect(
      new HouseholdSettingsRepo(env.DB, ctxB, ring).updateSettings({
        forwardAddress: "trips@badgerops.foo",
      }),
    ).rejects.toThrow(TAKEN);
  });

  it("gives the loser of a race the same ValidationError as the pre-check", async () => {
    await new HouseholdSettingsRepo(env.DB, ctxA, ring).updateSettings({
      forwardAddress: "trips@badgerops.foo",
    });
    // Blind the cross-household pre-check so the write runs against a column
    // that is already claimed — exactly the state a household reaches by
    // losing the race between the check and the INSERT. Previously the raw
    // UNIQUE failure escaped as a 500.
    const db = hookPrepare(env.DB, (sql, real) =>
      sql.includes("FROM household_settings WHERE forward_address")
        ? ({ bind: () => ({ all: async () => ({ results: [] }) }) } as unknown as D1PreparedStatement)
        : real,
    );

    const raced = new HouseholdSettingsRepo(db, ctxB, ring).updateSettings({
      forwardAddress: "trips@badgerops.foo",
    });
    await expect(raced).rejects.toThrow(ValidationError);
    await expect(raced).rejects.toThrow(TAKEN);

    // The winner keeps the address and the loser stored nothing.
    const rows = await env.DB.prepare(
      "SELECT household_id FROM household_settings WHERE forward_address = ?",
    )
      .bind("trips@badgerops.foo")
      .all<{ household_id: string }>();
    expect(rows.results).toEqual([{ household_id: "hh-a" }]);
  });

  it("lets exactly one of two households claim an address concurrently", async () => {
    const outcomes = await Promise.allSettled([
      new HouseholdSettingsRepo(env.DB, ctxA, ring).updateSettings({ forwardAddress: "shared@badgerops.foo" }),
      new HouseholdSettingsRepo(env.DB, ctxB, ring).updateSettings({ forwardAddress: "shared@badgerops.foo" }),
    ]);

    expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(1);
    const lost = outcomes.find((o) => o.status === "rejected") as PromiseRejectedResult;
    // Whichever side caught it — the pre-check or the constraint — the caller
    // sees one 400 with one wording.
    expect(lost.reason).toBeInstanceOf(ValidationError);
    expect((lost.reason as Error).message).toBe(TAKEN);

    const rows = await env.DB.prepare(
      "SELECT household_id FROM household_settings WHERE forward_address = ?",
    )
      .bind("shared@badgerops.foo")
      .all<{ household_id: string }>();
    expect(rows.results).toHaveLength(1);
  });
});
