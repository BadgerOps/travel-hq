import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { ChecklistRepo } from "../../../src/server/repos/checklist.js";
import { NotFoundError, ForbiddenError } from "../../../src/server/repos/base.js";
import type { HouseholdContext } from "../../../src/server/repos/base.js";

const ctxA: HouseholdContext = { householdId: "hh-a", userId: "u1", role: "owner" };

beforeEach(async () => {
  await env.DB.exec("DELETE FROM checklist_item");
  await env.DB.exec("DELETE FROM person");
  await env.DB.exec("DELETE FROM trip");
  await env.DB.exec("DELETE FROM household");
  const now = new Date().toISOString();
  await env.DB.prepare("INSERT INTO household (id,name,created_at) VALUES (?,?,?)").bind("hh-a", "A", now).run();
  await env.DB.prepare("INSERT INTO trip (id,household_id,title,created_at) VALUES (?,?,?,?)").bind("t1", "hh-a", "Trip", now).run();
  await env.DB.prepare("INSERT INTO person (id,household_id,display_name,created_at) VALUES (?,?,?,?)").bind("p-ava", "hh-a", "Ava", now).run();
});

describe("ChecklistRepo", () => {
  it("creates a family-wide item with a null personId", async () => {
    const item = await new ChecklistRepo(env.DB, ctxA).create({ tripId: "t1", label: "Pack passports" });
    expect(item.personId).toBeNull();
  });

  it("creates a person-assigned item", async () => {
    const item = await new ChecklistRepo(env.DB, ctxA).create({ tripId: "t1", label: "Pack", personId: "p-ava" });
    expect(item.personId).toBe("p-ava");
  });

  it("404s for a trip that does not exist", async () => {
    await expect(new ChecklistRepo(env.DB, ctxA).create({ tripId: "nope", label: "X" })).rejects.toThrow(NotFoundError);
  });

  it("listAll returns items across trips", async () => {
    const repo = new ChecklistRepo(env.DB, ctxA);
    await repo.create({ tripId: "t1", label: "One" });
    expect((await repo.listAll()).map((i) => i.label)).toContain("One");
  });

  it("setDone marks an item done and 404s for an unknown id", async () => {
    const repo = new ChecklistRepo(env.DB, ctxA);
    const item = await repo.create({ tripId: "t1", label: "One" });
    await repo.setDone(item.id, true);
    expect((await repo.findById(item.id))?.doneAt).not.toBeNull();
    await expect(repo.setDone("nope", true)).rejects.toThrow(NotFoundError);
  });

  it("a viewer cannot create an item", async () => {
    const viewer = new ChecklistRepo(env.DB, { ...ctxA, role: "viewer" });
    await expect(viewer.create({ tripId: "t1", label: "X" })).rejects.toThrow(ForbiddenError);
  });
});
