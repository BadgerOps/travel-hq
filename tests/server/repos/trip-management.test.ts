import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { TripRepo } from "../../../src/server/repos/trip.js";
import {
  NotFoundError,
  ForbiddenError,
  ValidationError,
} from "../../../src/server/repos/base.js";
import type { HouseholdContext } from "../../../src/server/repos/base.js";

const ctxA: HouseholdContext = { householdId: "hh-a", userId: "u1", role: "owner" };
const ctxB: HouseholdContext = { householdId: "hh-b", userId: "u2", role: "owner" };

async function count(table: string, where: string, ...params: unknown[]): Promise<number> {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`)
    .bind(...params)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

async function seedBooking(id: string, tripId: string, householdId = "hh-a"): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO booking (id, household_id, trip_id, kind, title, status, details, created_at)
     VALUES (?, ?, ?, 'flight', 'Flight', 'booked', '{}', ?)`,
  )
    .bind(id, householdId, tripId, new Date().toISOString())
    .run();
}

beforeEach(async () => {
  for (const table of [
    "booking_person",
    "checklist_item",
    "booking",
    "trip_person",
    "person",
    "trip",
    "household",
  ]) {
    await env.DB.exec(`DELETE FROM ${table}`);
  }
  const now = new Date().toISOString();
  await env.DB.prepare("INSERT INTO household (id,name,created_at) VALUES (?,?,?)").bind("hh-a", "A", now).run();
  await env.DB.prepare("INSERT INTO household (id,name,created_at) VALUES (?,?,?)").bind("hh-b", "B", now).run();
  await env.DB.prepare("INSERT INTO person (id,household_id,display_name,created_at) VALUES (?,?,?,?)").bind("p-ava", "hh-a", "Ava", now).run();
  await env.DB.prepare("INSERT INTO person (id,household_id,display_name,created_at) VALUES (?,?,?,?)").bind("p-finn", "hh-a", "Finn", now).run();
  await env.DB.prepare("INSERT INTO person (id,household_id,display_name,created_at) VALUES (?,?,?,?)").bind("p-zoe", "hh-b", "Zoe", now).run();
});

describe("TripRepo.update", () => {
  it("applies a partial patch and leaves absent fields untouched", async () => {
    const repo = new TripRepo(env.DB, ctxA);
    const trip = await repo.create({
      title: "Guerneville",
      destination: "Guerneville, CA",
      startsOn: "2026-10-09",
      endsOn: "2026-10-11",
      notes: "bring boots",
    });
    const updated = await repo.update(trip.id, { title: "Wedding weekend" });
    expect(updated.title).toBe("Wedding weekend");
    expect(updated.destination).toBe("Guerneville, CA");
    expect(updated.startsOn).toBe("2026-10-09");
    expect(updated.endsOn).toBe("2026-10-11");
    expect(updated.notes).toBe("bring boots");
    expect(updated.status).toBe("planning");
  });

  it("tri-state: null clears, value sets, absent leaves (regression)", async () => {
    const repo = new TripRepo(env.DB, ctxA);
    const trip = await repo.create({
      title: "Guerneville",
      destination: "Guerneville, CA",
      startsOn: "2026-10-09",
      endsOn: "2026-10-11",
    });
    const updated = await repo.update(trip.id, {
      destination: null,
      endsOn: null,
      startsOn: "2026-10-10",
    });
    expect(updated.destination).toBeNull();
    expect(updated.endsOn).toBeNull();
    expect(updated.startsOn).toBe("2026-10-10");
    expect(updated.title).toBe("Guerneville");
  });

  it("persists a status change", async () => {
    const repo = new TripRepo(env.DB, ctxA);
    const trip = await repo.create({ title: "Guerneville" });
    expect((await repo.update(trip.id, { status: "cancelled" })).status).toBe("cancelled");
    expect((await repo.update(trip.id, { status: "planning" })).status).toBe("planning");
  });

  it("an empty patch is a no-op that returns the trip", async () => {
    const repo = new TripRepo(env.DB, ctxA);
    const trip = await repo.create({ title: "Guerneville" });
    expect(await repo.update(trip.id, {})).toEqual(trip);
  });

  it("rejects an empty title with ValidationError", async () => {
    const repo = new TripRepo(env.DB, ctxA);
    const trip = await repo.create({ title: "Guerneville" });
    await expect(repo.update(trip.id, { title: "  " })).rejects.toThrow(ValidationError);
  });

  it("rejects a malformed date with ValidationError", async () => {
    const repo = new TripRepo(env.DB, ctxA);
    const trip = await repo.create({ title: "Guerneville" });
    await expect(repo.update(trip.id, { startsOn: "10/09/2026" })).rejects.toThrow(ValidationError);
    await expect(repo.update(trip.id, { endsOn: "2026-02-31" })).rejects.toThrow(ValidationError);
  });

  it("rejects an inverted range sent in one patch with ValidationError", async () => {
    const repo = new TripRepo(env.DB, ctxA);
    const trip = await repo.create({ title: "Guerneville" });
    await expect(
      repo.update(trip.id, { startsOn: "2026-10-11", endsOn: "2026-10-09" }),
    ).rejects.toThrow(ValidationError);
  });

  it("rejects a patch that inverts the range against a STORED date (regression)", async () => {
    // The ordering check must see the effective post-patch pair: patching
    // only endsOn below the stored startsOn is just as inverted as sending
    // both.
    const repo = new TripRepo(env.DB, ctxA);
    const trip = await repo.create({ title: "Guerneville", startsOn: "2026-10-09" });
    await expect(repo.update(trip.id, { endsOn: "2026-10-01" })).rejects.toThrow(ValidationError);
    // Clearing the conflicting side instead is fine.
    const cleared = await repo.update(trip.id, { startsOn: null, endsOn: "2026-10-01" });
    expect(cleared.endsOn).toBe("2026-10-01");
  });

  it("throws NotFoundError for an id outside the household", async () => {
    const trip = await new TripRepo(env.DB, ctxA).create({ title: "Guerneville" });
    await expect(new TripRepo(env.DB, ctxB).update(trip.id, { title: "Hijack" })).rejects.toThrow(
      NotFoundError,
    );
  });

  it("throws ForbiddenError for a viewer", async () => {
    const trip = await new TripRepo(env.DB, ctxA).create({ title: "Guerneville" });
    const viewer = new TripRepo(env.DB, { ...ctxA, role: "viewer" });
    await expect(viewer.update(trip.id, { title: "Nope" })).rejects.toThrow(ForbiddenError);
  });
});

describe("TripRepo.delete", () => {
  it("hard-deletes the trip and cascades to bookings, booking_person, checklist, and roster (regression)", async () => {
    const repo = new TripRepo(env.DB, ctxA);
    const trip = await repo.create({ title: "Guerneville" });
    await repo.addTraveler(trip.id, "p-ava");
    await seedBooking("b1", trip.id);
    await env.DB.prepare("INSERT INTO booking_person (booking_id, person_id) VALUES (?, ?)").bind("b1", "p-ava").run();
    await env.DB.prepare(
      "INSERT INTO checklist_item (id, household_id, trip_id, label, created_at) VALUES (?, ?, ?, ?, ?)",
    )
      .bind("c1", "hh-a", trip.id, "Pack", new Date().toISOString())
      .run();

    await repo.delete(trip.id);

    expect(await repo.findById(trip.id)).toBeUndefined();
    expect(await count("booking", "trip_id = ?", trip.id)).toBe(0);
    expect(await count("booking_person", "booking_id = ?", "b1")).toBe(0);
    expect(await count("checklist_item", "trip_id = ?", trip.id)).toBe(0);
    expect(await count("trip_person", "trip_id = ?", trip.id)).toBe(0);
    // The people themselves survive — only the trip subtree goes.
    expect(await count("person", "id = ?", "p-ava")).toBe(1);
  });

  it("throws NotFoundError for an id outside the household", async () => {
    const trip = await new TripRepo(env.DB, ctxA).create({ title: "Guerneville" });
    await expect(new TripRepo(env.DB, ctxB).delete(trip.id)).rejects.toThrow(NotFoundError);
    expect(await new TripRepo(env.DB, ctxA).findById(trip.id)).toBeDefined();
  });

  it("throws ForbiddenError for a viewer", async () => {
    const trip = await new TripRepo(env.DB, ctxA).create({ title: "Guerneville" });
    const viewer = new TripRepo(env.DB, { ...ctxA, role: "viewer" });
    await expect(viewer.delete(trip.id)).rejects.toThrow(ForbiddenError);
  });
});

describe("TripRepo.removeTraveler", () => {
  it("unassigns the person from this trip's bookings and roster, never touching the bookings", async () => {
    const repo = new TripRepo(env.DB, ctxA);
    const trip = await repo.create({ title: "Guerneville" });
    await repo.addTraveler(trip.id, "p-ava");
    await repo.addTraveler(trip.id, "p-finn");
    await seedBooking("b1", trip.id);
    await env.DB.prepare("INSERT INTO booking_person (booking_id, person_id) VALUES (?, ?)").bind("b1", "p-ava").run();
    await env.DB.prepare("INSERT INTO booking_person (booking_id, person_id) VALUES (?, ?)").bind("b1", "p-finn").run();

    await repo.removeTraveler(trip.id, "p-ava");

    expect(await repo.travelers(trip.id)).toEqual(["p-finn"]);
    expect(await count("booking_person", "booking_id = ? AND person_id = ?", "b1", "p-ava")).toBe(0);
    // Unassign only: the booking survives, as does Finn's assignment.
    expect(await count("booking", "id = ?", "b1")).toBe(1);
    expect(await count("booking_person", "booking_id = ? AND person_id = ?", "b1", "p-finn")).toBe(1);
  });

  it("touches only THIS trip's bookings (regression)", async () => {
    const repo = new TripRepo(env.DB, ctxA);
    const wedding = await repo.create({ title: "Wedding" });
    const skiing = await repo.create({ title: "Skiing" });
    await repo.addTraveler(wedding.id, "p-ava");
    await repo.addTraveler(skiing.id, "p-ava");
    await seedBooking("b-wed", wedding.id);
    await seedBooking("b-ski", skiing.id);
    await env.DB.prepare("INSERT INTO booking_person (booking_id, person_id) VALUES (?, ?)").bind("b-wed", "p-ava").run();
    await env.DB.prepare("INSERT INTO booking_person (booking_id, person_id) VALUES (?, ?)").bind("b-ski", "p-ava").run();

    await repo.removeTraveler(wedding.id, "p-ava");

    expect(await count("booking_person", "booking_id = ?", "b-wed")).toBe(0);
    expect(await count("booking_person", "booking_id = ?", "b-ski")).toBe(1);
    expect(await repo.travelers(skiing.id)).toEqual(["p-ava"]);
  });

  it("is idempotent: removing someone not on the trip succeeds and changes nothing", async () => {
    const repo = new TripRepo(env.DB, ctxA);
    const trip = await repo.create({ title: "Guerneville" });
    await repo.addTraveler(trip.id, "p-finn");
    await repo.removeTraveler(trip.id, "p-ava");
    await repo.removeTraveler(trip.id, "p-ava");
    expect(await repo.travelers(trip.id)).toEqual(["p-finn"]);
  });

  it("throws NotFoundError for a person outside the household", async () => {
    const repo = new TripRepo(env.DB, ctxA);
    const trip = await repo.create({ title: "Guerneville" });
    await expect(repo.removeTraveler(trip.id, "p-zoe")).rejects.toThrow(NotFoundError);
    await expect(repo.removeTraveler(trip.id, "p-nope")).rejects.toThrow(NotFoundError);
  });

  it("throws NotFoundError for a trip outside the household", async () => {
    const foreign = await new TripRepo(env.DB, ctxB).create({ title: "Elsewhere" });
    await expect(new TripRepo(env.DB, ctxA).removeTraveler(foreign.id, "p-ava")).rejects.toThrow(
      NotFoundError,
    );
  });

  it("throws ForbiddenError for a viewer", async () => {
    const repo = new TripRepo(env.DB, ctxA);
    const trip = await repo.create({ title: "Guerneville" });
    await repo.addTraveler(trip.id, "p-ava");
    const viewer = new TripRepo(env.DB, { ...ctxA, role: "viewer" });
    await expect(viewer.removeTraveler(trip.id, "p-ava")).rejects.toThrow(ForbiddenError);
    expect(await repo.travelers(trip.id)).toEqual(["p-ava"]);
  });
});
