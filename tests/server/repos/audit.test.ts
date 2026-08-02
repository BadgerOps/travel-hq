import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { AuditRepo } from "../../../src/server/repos/audit.js";
import { ValidationError, ForbiddenError } from "../../../src/server/repos/base.js";
import type { HouseholdContext } from "../../../src/server/repos/base.js";

/**
 * The audit log's safety argument is that there is nowhere in it to put a
 * secret. migrations/0018 keeps that true structurally (no value column, and
 * `detail` is JSON or nothing); this repo keeps it true at the only door into
 * that column, which is what these tests are about.
 */

const owner: HouseholdContext = { householdId: "hh-a", userId: "u1", role: "owner" };
const viewer: HouseholdContext = { householdId: "hh-a", userId: "u-viewer", role: "viewer" };

beforeEach(async () => {
  await env.DB.exec("DELETE FROM household");
  await env.DB.prepare("INSERT INTO household (id, name, created_at) VALUES (?, ?, ?)")
    .bind("hh-a", "Badger", new Date().toISOString())
    .run();
});

describe("AuditRepo.record", () => {
  it("stores field NAMES, and nothing that looks like a value", async () => {
    const entry = await new AuditRepo(env.DB, owner).record({
      event: "person_updated",
      subjectType: "person",
      subjectId: "p1",
      fields: ["phone", "passport_number"],
    });
    expect(entry.fields).toEqual(["phone", "passport_number"]);
    expect(
      await env.DB.prepare("SELECT detail FROM audit_log WHERE id = ?").bind(entry.id).first(),
    ).toEqual({ detail: '{"fields":["phone","passport_number"]}' });
  });

  /**
   * The guard that matters. `fields: string[]` says "names" in the type
   * system, and nothing in the type system stops a caller from passing a value
   * anyway -- into an append-only, unencrypted, owner-readable column.
   */
  it("refuses anything that is not a bare field identifier", async () => {
    const repo = new AuditRepo(env.DB, owner);
    for (const bad of [
      "passport_number=C03X72119",
      "C03X72119",
      "passport number",
      "passportNumber",
      "",
      "'; DROP TABLE audit_log; --",
    ]) {
      await expect(
        repo.record({ event: "person_updated", subjectType: "person", subjectId: "p1", fields: [bad] }),
      ).rejects.toThrow(ValidationError);
    }
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM audit_log").first()).toEqual({ n: 0 });
  });

  it("does not echo the rejected value into the error message", async () => {
    // The message is logged. Repeating a smuggled passport number in it would
    // leak it to the same place the column would have.
    await expect(
      new AuditRepo(env.DB, owner).record({
        event: "person_updated",
        subjectType: "person",
        subjectId: "p1",
        fields: ["passport_number=C03X72119"],
      }),
    ).rejects.toThrow(/^((?!C03X72119).)*$/);
  });

  it("caps and de-duplicates the field list", async () => {
    const repo = new AuditRepo(env.DB, owner);
    const entry = await repo.record({
      event: "person_updated",
      subjectType: "person",
      subjectId: "p1",
      fields: ["phone", "phone", "notes"],
    });
    expect(entry.fields).toEqual(["phone", "notes"]);

    const many = Array.from({ length: 33 }, (_, i) => `field_${i}`);
    await expect(
      repo.record({ event: "person_updated", subjectType: "person", subjectId: "p1", fields: many }),
    ).rejects.toThrow(ValidationError);
  });

  it("records an empty field list as no fields rather than an empty object", async () => {
    const entry = await new AuditRepo(env.DB, owner).record({
      event: "member_invited",
      subjectType: "household_member",
      subjectId: "u-new",
      fields: [],
    });
    expect(entry.fields).toBeNull();
  });

  it("still refuses an unknown event or subject type", async () => {
    const repo = new AuditRepo(env.DB, owner);
    await expect(
      repo.record({
        event: "person_deleted" as never,
        subjectType: "person",
        subjectId: "p1",
      }),
    ).rejects.toThrow(ValidationError);
    await expect(
      repo.record({ event: "person_updated", subjectType: "trip" as never, subjectId: "t1" }),
    ).rejects.toThrow(ValidationError);
  });

  it("still refuses a booking reveal that cannot name its validated trip", async () => {
    await expect(
      new AuditRepo(env.DB, owner).record({
        event: "confirmation_reveal",
        subjectType: "booking",
        subjectId: "b1",
        field: "confirmation_number",
      }),
    ).rejects.toThrow(ValidationError);
  });

  it("still refuses a reveal that does not name the field it unmasked", async () => {
    await expect(
      new AuditRepo(env.DB, owner).record({
        event: "document_reveal",
        subjectType: "person",
        subjectId: "p1",
      }),
    ).rejects.toThrow(ValidationError);
  });

  /**
   * A viewer may now act on their own record, so the row recording that they
   * did has to be writable by them -- but only that row. Everything else still
   * meets requireWrite().
   */
  it("lets a viewer record an action on their own record, and nothing else", async () => {
    const repo = new AuditRepo(env.DB, viewer);
    const mine = await repo.record({
      event: "person_updated",
      subjectType: "person",
      subjectId: "p-mine",
      selfService: true,
      fields: ["phone"],
    });
    expect(mine.selfService).toBe(true);
    expect(
      await env.DB.prepare("SELECT self_service, household_id FROM audit_log WHERE id = ?")
        .bind(mine.id)
        .first(),
    ).toEqual({ self_service: 1, household_id: "hh-a" });

    await expect(
      repo.record({ event: "person_updated", subjectType: "person", subjectId: "p-theirs" }),
    ).rejects.toThrow(ForbiddenError);
  });

  it("attributes the entry to the authenticated actor, never to an argument", async () => {
    const entry = await new AuditRepo(env.DB, { ...owner, email: "badger@example.com" } as HouseholdContext).record({
      event: "person_created",
      subjectType: "person",
      subjectId: "p1",
    });
    expect(entry).toMatchObject({ actorUserId: "u1", actorEmail: "badger@example.com" });
  });
});

describe("AuditRepo.listActivity", () => {
  async function seed(ctx: HouseholdContext, subjectId: string): Promise<void> {
    await new AuditRepo(env.DB, ctx).record({
      event: "person_updated",
      subjectType: "person",
      subjectId,
      fields: ["notes"],
    });
  }

  it("clamps the page size rather than trusting the caller", async () => {
    for (let i = 0; i < 3; i++) await seed(owner, `p${i}`);
    expect(await new AuditRepo(env.DB, owner).listActivity({ limit: 1 })).toHaveLength(1);
    expect(await new AuditRepo(env.DB, owner).listActivity({ limit: 0 })).toHaveLength(1);
    expect(await new AuditRepo(env.DB, owner).listActivity({ limit: 10_000 })).toHaveLength(3);
    expect(await new AuditRepo(env.DB, owner).listActivity({ limit: Number.NaN })).toHaveLength(3);
  });

  it("never crosses a household boundary, whatever the cursor points at", async () => {
    await env.DB.prepare("INSERT INTO household (id, name, created_at) VALUES (?, ?, ?)")
      .bind("hh-b", "Other", new Date().toISOString())
      .run();
    await seed(owner, "p-a");
    await seed({ householdId: "hh-b", userId: "u9", role: "owner" }, "p-b");

    const mine = await new AuditRepo(env.DB, owner).listActivity();
    expect(mine.map((e) => e.subjectId)).toEqual(["p-a"]);
    expect(
      await new AuditRepo(env.DB, owner).listActivity({
        before: { at: "9999-01-01T00:00:00.000Z", id: "zzz" },
      }),
    ).toHaveLength(1);
  });
});
