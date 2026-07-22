import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { TenantRepo, TenantScopeError, ForbiddenError } from "../../../src/server/repos/base.js";
import type { HouseholdContext } from "../../../src/server/repos/base.js";

class TripProbe extends TenantRepo {
  listTitles(): Promise<{ title: string }[]> {
    return this.all<{ title: string }>("SELECT title FROM trip WHERE {scope}");
  }
  listUnscoped(): Promise<unknown[]> {
    return this.all("SELECT title FROM trip");
  }
  rename(id: string, title: string): Promise<void> {
    // Caller params: title -> ?2, id -> ?3 (household id is ?1).
    return this.run("UPDATE trip SET title = ?2 WHERE {scope} AND id = ?3", title, id);
  }
  scopeOrTautology(): Promise<unknown[]> {
    return this.all("SELECT title FROM trip WHERE {scope} OR 1=1");
  }
  scopeTokenInComment(): Promise<unknown[]> {
    return this.all("SELECT title FROM trip -- {scope}\nWHERE 1=1");
  }
  scopeTokenInString(): Promise<unknown[]> {
    return this.all("SELECT title FROM trip WHERE title != '{scope}'");
  }
  legitimateNestedOr(): Promise<{ title: string }[]> {
    return this.all<{ title: string }>(
      "SELECT title FROM trip WHERE {scope} AND (title = 'Guerneville' OR title = 'nope')",
    );
  }
  writeViaRunWithoutRequireWrite(id: string, title: string): Promise<void> {
    return this.run("UPDATE trip SET title = ?2 WHERE {scope} AND id = ?3", title, id);
  }
  insertViaInsertWithoutRequireWrite(id: string, title: string): Promise<void> {
    return this.insert("trip", { id, title, created_at: new Date().toISOString() });
  }
  insertBadTable(): Promise<void> {
    return this.insert("trip; DROP TABLE trip;--", { id: "bad", title: "x" });
  }
  insertBadColumn(): Promise<void> {
    return this.insert("trip", { "id; DROP TABLE trip;--": "bad" });
  }
  callRequireWrite(): void {
    this.requireWrite();
  }
  callRequireReveal(): void {
    this.requireReveal();
  }
  // Caller writes the RESERVED ?1 (new guard).
  callerWritesReservedIndex(): Promise<unknown[]> {
    return this.all("SELECT title FROM trip WHERE {scope} AND id = ?1");
  }
  // ?1 appears outside the {scope} expansion, in a select position (new guard).
  reservedIndexOutsideScope(): Promise<unknown[]> {
    return this.all("SELECT ?1 AS x FROM trip WHERE {scope}");
  }
  attachTraveler(tripId: string, personId: string): Promise<void> {
    return this.unscopedRun(
      "trip_person carries no household_id; ids proven scoped by the caller",
      "INSERT OR IGNORE INTO trip_person (trip_id, person_id) VALUES (?, ?)",
      tripId,
      personId,
    );
  }
  travelerIds(tripId: string): Promise<{ person_id: string }[]> {
    return this.unscoped<{ person_id: string }>(
      "trip_person carries no household_id; tripId proven scoped by the caller",
      "SELECT person_id FROM trip_person WHERE trip_id = ? ORDER BY person_id",
      tripId,
    );
  }
  unscopedWithoutReason(tripId: string): Promise<unknown[]> {
    return this.unscoped("", "SELECT person_id FROM trip_person WHERE trip_id = ?", tripId);
  }
  unscopedRunWithoutReason(tripId: string, personId: string): Promise<void> {
    return this.unscopedRun(
      "   ",
      "INSERT OR IGNORE INTO trip_person (trip_id, person_id) VALUES (?, ?)",
      tripId,
      personId,
    );
  }
}

const ctxA: HouseholdContext = { householdId: "hh-a", userId: "u1", role: "owner" };
const ctxB: HouseholdContext = { householdId: "hh-b", userId: "u2", role: "owner" };

async function title(id: string): Promise<string | undefined> {
  const row = await env.DB.prepare("SELECT title FROM trip WHERE id = ?").bind(id).first<{ title: string }>();
  return row?.title;
}

beforeEach(async () => {
  await env.DB.exec("DELETE FROM person");
  await env.DB.exec("DELETE FROM trip");
  await env.DB.exec("DELETE FROM household");
  const now = new Date().toISOString();
  for (const id of ["hh-a", "hh-b"]) {
    await env.DB.prepare("INSERT INTO household (id, name, created_at) VALUES (?, ?, ?)").bind(id, id, now).run();
  }
  await env.DB.prepare("INSERT INTO trip (id, household_id, title, created_at) VALUES (?, ?, ?, ?)")
    .bind("t1", "hh-a", "Guerneville", now).run();
  await env.DB.prepare("INSERT INTO trip (id, household_id, title, created_at) VALUES (?, ?, ?, ?)")
    .bind("t2", "hh-b", "Someone Else's Trip", now).run();
  await env.DB.prepare("INSERT INTO person (id, household_id, display_name, created_at) VALUES (?, ?, ?, ?)")
    .bind("p-ava", "hh-a", "Ava", now).run();
});

describe("TenantRepo", () => {
  it("returns only the current household's rows", async () => {
    expect((await new TripProbe(env.DB, ctxA).listTitles()).map((r) => r.title)).toEqual(["Guerneville"]);
  });

  it("isolates a different household", async () => {
    expect((await new TripProbe(env.DB, ctxB).listTitles()).map((r) => r.title)).toEqual(["Someone Else's Trip"]);
  });

  it("refuses a query with no {scope} placeholder", async () => {
    await expect(new TripProbe(env.DB, ctxA).listUnscoped()).rejects.toThrow(TenantScopeError);
  });

  it("rejects an empty household id at construction", () => {
    expect(() => new TripProbe(env.DB, { ...ctxA, householdId: "" })).toThrow(TenantScopeError);
  });

  it("binds correctly with the household id at ?1 and caller params at ?2+", async () => {
    await new TripProbe(env.DB, ctxA).rename("t1", "Renamed");
    expect(await title("t1")).toBe("Renamed");
  });

  it("does not update another household's row", async () => {
    await new TripProbe(env.DB, ctxA).rename("t2", "Hijacked");
    expect(await title("t2")).toBe("Someone Else's Trip");
  });

  it("throws when OR sits at the same nesting level as the scope token", async () => {
    await expect(new TripProbe(env.DB, ctxA).scopeOrTautology()).rejects.toThrow(TenantScopeError);
  });

  it("throws when the scope token is hidden inside a comment", async () => {
    await expect(new TripProbe(env.DB, ctxA).scopeTokenInComment()).rejects.toThrow(TenantScopeError);
  });

  it("throws when the scope token is hidden inside a string literal", async () => {
    await expect(new TripProbe(env.DB, ctxA).scopeTokenInString()).rejects.toThrow(TenantScopeError);
  });

  it("still allows an OR nested strictly deeper than the scope token", async () => {
    expect((await new TripProbe(env.DB, ctxA).legitimateNestedOr()).map((r) => r.title)).toEqual(["Guerneville"]);
  });

  it("a viewer cannot write through run() even if the subclass never calls requireWrite()", async () => {
    const viewer = new TripProbe(env.DB, { ...ctxA, role: "viewer" });
    await expect(viewer.writeViaRunWithoutRequireWrite("t1", "Hijacked")).rejects.toThrow(ForbiddenError);
    expect(await title("t1")).toBe("Guerneville");
  });

  it("a viewer cannot write through insert() even if the subclass never calls requireWrite()", async () => {
    const viewer = new TripProbe(env.DB, { ...ctxA, role: "viewer" });
    await expect(viewer.insertViaInsertWithoutRequireWrite("t-new", "Sneaky")).rejects.toThrow(ForbiddenError);
    expect(await title("t-new")).toBeUndefined();
  });

  // NEW GUARD 1: a caller must not write the reserved ?1.
  it("rejects a query where the caller writes the reserved ?1", async () => {
    await expect(new TripProbe(env.DB, ctxA).callerWritesReservedIndex()).rejects.toThrow(TenantScopeError);
  });

  // NEW GUARD 2: ?1 must never appear outside the {scope} expansion.
  it("rejects a query where ?1 appears outside the {scope} expansion", async () => {
    await expect(new TripProbe(env.DB, ctxA).reservedIndexOutsideScope()).rejects.toThrow(TenantScopeError);
  });

  it("requireWrite() denial throws ForbiddenError, not TenantScopeError", async () => {
    const viewer = new TripProbe(env.DB, { ...ctxA, role: "viewer" });
    let caught: unknown;
    try {
      await viewer.rename("t1", "Nope");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ForbiddenError);
    expect(caught).not.toBeInstanceOf(TenantScopeError);
  });

  it("requireReveal() denies a viewer", () => {
    const viewer = new TripProbe(env.DB, { ...ctxA, role: "viewer" });
    expect(() => viewer.callRequireReveal()).toThrow(ForbiddenError);
  });

  it("unscoped()/unscopedRun() support the join-table shapes", async () => {
    const repo = new TripProbe(env.DB, ctxA);
    await repo.attachTraveler("t1", "p-ava");
    expect((await repo.travelerIds("t1")).map((r) => r.person_id)).toEqual(["p-ava"]);
  });

  it("unscoped() requires a non-empty reason", async () => {
    await expect(new TripProbe(env.DB, ctxA).unscopedWithoutReason("t1")).rejects.toThrow(TenantScopeError);
  });

  it("unscopedRun() requires a non-empty reason", async () => {
    await expect(new TripProbe(env.DB, ctxA).unscopedRunWithoutReason("t1", "p-ava")).rejects.toThrow(TenantScopeError);
  });

  it("rejects an invalid table name passed to insert()", async () => {
    await expect(new TripProbe(env.DB, ctxA).insertBadTable()).rejects.toThrow(TenantScopeError);
  });

  it("rejects an invalid column name passed to insert()", async () => {
    await expect(new TripProbe(env.DB, ctxA).insertBadColumn()).rejects.toThrow(TenantScopeError);
  });

  it("rejects a whitespace-only household id at construction", () => {
    expect(() => new TripProbe(env.DB, { ...ctxA, householdId: "   " })).toThrow(TenantScopeError);
  });

  it("rejects a role outside the three permitted values", () => {
    expect(
      () => new TripProbe(env.DB, { ...ctxA, role: "machine" as unknown as HouseholdContext["role"] }),
    ).toThrow(TenantScopeError);
  });
});
