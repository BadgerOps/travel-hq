import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { TripRepo } from "../../../src/server/repos/trip.js";
import { NotFoundError, ForbiddenError } from "../../../src/server/repos/base.js";
import type { HouseholdContext } from "../../../src/server/repos/base.js";

const ctxA: HouseholdContext = { householdId: "hh-a", userId: "u1", role: "owner" };

beforeEach(async () => {
  await env.DB.exec("DELETE FROM trip_person");
  await env.DB.exec("DELETE FROM person");
  await env.DB.exec("DELETE FROM trip");
  await env.DB.exec("DELETE FROM household");
  const now = new Date().toISOString();
  await env.DB.prepare("INSERT INTO household (id,name,created_at) VALUES (?,?,?)").bind("hh-a", "A", now).run();
  await env.DB.prepare("INSERT INTO person (id,household_id,display_name,created_at) VALUES (?,?,?,?)").bind("p-ava", "hh-a", "Ava", now).run();
});

describe("TripRepo", () => {
  it("creates a trip with the default planning status", async () => {
    const trip = await new TripRepo(env.DB, ctxA).create({ title: "Guerneville" });
    expect(trip.status).toBe("planning");
    expect(trip.title).toBe("Guerneville");
  });

  it("lists trips scoped to the household, nulls-last by start", async () => {
    const repo = new TripRepo(env.DB, ctxA);
    await repo.create({ title: "Later", startsOn: "2026-10-01" });
    await repo.create({ title: "Undated" });
    const list = await repo.list();
    expect(list.map((t) => t.title)).toEqual(["Later", "Undated"]);
  });

  it("findById returns undefined for a foreign id", async () => {
    expect(await new TripRepo(env.DB, ctxA).findById("nope")).toBeUndefined();
  });

  it("addTraveler links a person and travelers() lists them", async () => {
    const repo = new TripRepo(env.DB, ctxA);
    const trip = await repo.create({ title: "Guerneville" });
    await repo.addTraveler(trip.id, "p-ava");
    expect(await repo.travelers(trip.id)).toEqual(["p-ava"]);
  });

  it("addTraveler 404s for a person outside the household", async () => {
    const repo = new TripRepo(env.DB, ctxA);
    const trip = await repo.create({ title: "Guerneville" });
    await expect(repo.addTraveler(trip.id, "nope")).rejects.toThrow(NotFoundError);
  });

  it("a viewer cannot create a trip", async () => {
    const viewer = new TripRepo(env.DB, { ...ctxA, role: "viewer" });
    await expect(viewer.create({ title: "Nope" })).rejects.toThrow(ForbiddenError);
  });
});
