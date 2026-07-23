import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { RevealAuditRepo } from "../../../src/server/repos/reveal-audit.js";
import { ForbiddenError, TenantScopeError, ValidationError } from "../../../src/server/repos/base.js";
import type { HouseholdContext } from "../../../src/server/repos/base.js";
import type { DocumentField } from "../../../src/server/repos/person.js";

const ownerA: HouseholdContext = { householdId: "hh-a", userId: "u1", role: "owner" };
const adultA: HouseholdContext = { householdId: "hh-a", userId: "u2", role: "adult" };
const viewerA: HouseholdContext = { householdId: "hh-a", userId: "u3", role: "viewer" };
const ownerB: HouseholdContext = { householdId: "hh-b", userId: "u9", role: "owner" };

beforeEach(async () => {
  await env.DB.exec("DELETE FROM reveal_audit");
  await env.DB.exec("DELETE FROM person");
  await env.DB.exec("DELETE FROM household");
  const now = new Date().toISOString();
  await env.DB.prepare("INSERT INTO household (id,name,created_at) VALUES (?,?,?)").bind("hh-a", "A", now).run();
  await env.DB.prepare("INSERT INTO household (id,name,created_at) VALUES (?,?,?)").bind("hh-b", "B", now).run();
  await env.DB.prepare(
    "INSERT INTO person (id, household_id, display_name, created_at) VALUES (?, ?, ?, ?)",
  )
    .bind("p-ava", "hh-a", "Ava", now)
    .run();
});

function record(repo: RevealAuditRepo, over: Partial<{ userEmail: string; personId: string; field: DocumentField }> = {}) {
  return repo.record({
    userEmail: "badger@example.com",
    personId: "p-ava",
    field: "passport_number",
    ...over,
  });
}

describe("RevealAuditRepo", () => {
  it("records who revealed what and lists it newest-first for the owner", async () => {
    const adultRepo = new RevealAuditRepo(env.DB, adultA);
    await record(adultRepo, { field: "passport_number" });
    await record(adultRepo, { field: "redress_number", userEmail: "other@example.com" });

    const entries = await new RevealAuditRepo(env.DB, ownerA).list();
    expect(entries).toHaveLength(2);
    // Newest first: the redress reveal was recorded second.
    expect(entries[0]).toMatchObject({
      userId: "u2",
      userEmail: "other@example.com",
      personId: "p-ava",
      personName: "Ava",
      field: "redress_number",
    });
    expect(entries[1]).toMatchObject({ field: "passport_number", userEmail: "badger@example.com" });
    expect(entries[0]!.revealedAt >= entries[1]!.revealedAt).toBe(true);
    // The entry records the access, never any revealed value.
    expect(Object.keys(entries[0]!).sort()).toEqual([
      "field",
      "id",
      "personId",
      "personName",
      "revealedAt",
      "userEmail",
      "userId",
    ]);
  });

  it("keeps the trail when the person is gone, with personName null", async () => {
    await record(new RevealAuditRepo(env.DB, adultA));
    await env.DB.prepare("DELETE FROM person WHERE id = ?").bind("p-ava").run();
    const entries = await new RevealAuditRepo(env.DB, ownerA).list();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ personId: "p-ava", personName: null });
  });

  it("denies the list to an adult — the trail reports on the adults themselves", async () => {
    await expect(new RevealAuditRepo(env.DB, adultA).list()).rejects.toThrow(ForbiddenError);
  });

  it("denies the list to a viewer", async () => {
    await expect(new RevealAuditRepo(env.DB, viewerA).list()).rejects.toThrow(ForbiddenError);
  });

  it("denies record() to a viewer — a viewer cannot reveal, so nothing of theirs is recordable", async () => {
    await expect(record(new RevealAuditRepo(env.DB, viewerA))).rejects.toThrow(ForbiddenError);
  });

  it("is tenant-scoped: household B's owner sees none of A's trail", async () => {
    await record(new RevealAuditRepo(env.DB, ownerA));
    expect(await new RevealAuditRepo(env.DB, ownerB).list()).toEqual([]);
  });

  it("rejects a field outside DOCUMENT_FIELDS as a caller bug (TenantScopeError)", async () => {
    await expect(
      record(new RevealAuditRepo(env.DB, ownerA), { field: "display_name" as DocumentField }),
    ).rejects.toThrow(TenantScopeError);
  });

  it("rejects a non-positive or oversized list limit", async () => {
    const repo = new RevealAuditRepo(env.DB, ownerA);
    await expect(repo.list(0)).rejects.toThrow(ValidationError);
    await expect(repo.list(1.5)).rejects.toThrow(ValidationError);
    await expect(repo.list(201)).rejects.toThrow(ValidationError);
  });

  it("applies the limit after newest-first ordering", async () => {
    const repo = new RevealAuditRepo(env.DB, ownerA);
    await record(repo, { field: "passport_number" });
    await record(repo, { field: "known_traveler_number" });
    await record(repo, { field: "redress_number" });
    const entries = await new RevealAuditRepo(env.DB, ownerA).list(2);
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.field)).toEqual(["redress_number", "known_traveler_number"]);
  });
});
