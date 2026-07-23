import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { InboundEmailRepo, INBOUND_EMAIL_STATUSES } from "../../../src/server/repos/inbound-email.js";
import { ForbiddenError, NotFoundError, ValidationError } from "../../../src/server/repos/base.js";
import type { HouseholdContext } from "../../../src/server/repos/base.js";

const ctxA: HouseholdContext = { householdId: "hh-a", userId: "u1", role: "owner" };
const ctxB: HouseholdContext = { householdId: "hh-b", userId: "u2", role: "adult" };

beforeEach(async () => {
  await env.DB.exec("DELETE FROM inbound_email");
  await env.DB.exec("DELETE FROM household");
  const now = new Date().toISOString();
  await env.DB.prepare("INSERT INTO household (id,name,created_at) VALUES (?,?,?)").bind("hh-a", "A", now).run();
  await env.DB.prepare("INSERT INTO household (id,name,created_at) VALUES (?,?,?)").bind("hh-b", "B", now).run();
});

function baseInput() {
  return {
    from: "badger@example.com",
    to: "trips@badgerops.foo",
    subject: "Flight confirmation ABC123",
    messageId: "<abc123@example.com>",
    raw: "From: badger@example.com\r\nSubject: Flight confirmation ABC123\r\n\r\nBody",
  };
}

describe("InboundEmailRepo", () => {
  it("creates a received row by default and round-trips every field", async () => {
    const repo = new InboundEmailRepo(env.DB, ctxA);
    const created = await repo.create(baseInput());

    expect(created.id).toBeTruthy();
    expect(created.status).toBe("received");
    expect(created.error).toBeNull();
    expect(created.from).toBe("badger@example.com");
    expect(created.to).toBe("trips@badgerops.foo");
    expect(created.subject).toBe("Flight confirmation ABC123");
    expect(created.messageId).toBe("<abc123@example.com>");
    expect(created.raw).toContain("Body");
    expect(created.receivedAt).toBeTruthy();
    expect(await repo.findById(created.id)).toEqual(created);
  });

  it("defaults optional metadata (subject, messageId, error) to null", async () => {
    const repo = new InboundEmailRepo(env.DB, ctxA);
    const created = await repo.create({ from: "a@b.com", to: "trips@badgerops.foo", raw: "raw" });
    expect(created.subject).toBeNull();
    expect(created.messageId).toBeNull();
    expect(created.error).toBeNull();
  });

  it("creates rejected and failed rows with a reason", async () => {
    const repo = new InboundEmailRepo(env.DB, ctxA);
    const rejected = await repo.create({
      ...baseInput(),
      status: "rejected",
      error: "sender is not on the household allowlist",
    });
    expect(rejected.status).toBe("rejected");
    expect(rejected.error).toBe("sender is not on the household allowlist");

    const failed = await repo.create({ ...baseInput(), status: "failed", error: "Ingest failed: boom" });
    expect(failed.status).toBe("failed");
    expect(failed.error).toBe("Ingest failed: boom");
  });

  it("refuses to create a row born extracted — that state is transition-only", async () => {
    const repo = new InboundEmailRepo(env.DB, ctxA);
    await expect(
      repo.create({ ...baseInput(), status: "extracted" as never }),
    ).rejects.toThrow(ValidationError);
  });

  it("is tenant-scoped: household B never sees A's mail", async () => {
    const created = await new InboundEmailRepo(env.DB, ctxA).create(baseInput());
    const repoB = new InboundEmailRepo(env.DB, ctxB);
    expect(await repoB.findById(created.id)).toBeUndefined();
    expect(await repoB.list()).toEqual([]);
    expect(await repoB.listByStatus("received")).toEqual([]);
  });

  it("forIngest writes scoped to the resolved household with a synthetic context", async () => {
    const created = await InboundEmailRepo.forIngest(env.DB, "hh-a").create(baseInput());
    const rows = await env.DB.prepare("SELECT household_id FROM inbound_email WHERE id = ?")
      .bind(created.id)
      .all<{ household_id: string }>();
    expect(rows.results).toEqual([{ household_id: "hh-a" }]);
    expect(await new InboundEmailRepo(env.DB, ctxB).findById(created.id)).toBeUndefined();
  });

  it("blocks a viewer from creating rows", async () => {
    const viewer = new InboundEmailRepo(env.DB, { ...ctxA, role: "viewer" });
    await expect(viewer.create(baseInput())).rejects.toThrow(ForbiddenError);
  });

  it("lists newest first; listByStatus filters and returns queue (oldest-first) order", async () => {
    const repo = new InboundEmailRepo(env.DB, ctxA);
    const first = await repo.create({ ...baseInput(), subject: "first" });
    const second = await repo.create({ ...baseInput(), subject: "second" });
    const rejected = await repo.create({ ...baseInput(), subject: "spam", status: "rejected", error: "nope" });

    expect((await repo.list()).map((e) => e.id)).toEqual([rejected.id, second.id, first.id]);
    expect((await repo.listByStatus("received")).map((e) => e.id)).toEqual([first.id, second.id]);
    expect((await repo.listByStatus("rejected")).map((e) => e.id)).toEqual([rejected.id]);
    expect(await repo.listByStatus("extracted")).toEqual([]);
  });

  it("rejects an unknown status in listByStatus", async () => {
    const repo = new InboundEmailRepo(env.DB, ctxA);
    await expect(repo.listByStatus("bogus" as never)).rejects.toThrow(ValidationError);
  });

  it("marks a received row extracted (the #6 success transition)", async () => {
    const repo = new InboundEmailRepo(env.DB, ctxA);
    const created = await repo.create(baseInput());
    const extracted = await repo.markExtracted(created.id);
    expect(extracted.status).toBe("extracted");
    expect(extracted.error).toBeNull();
    expect((await repo.findById(created.id))?.status).toBe("extracted");
  });

  it("marks a received row failed with a reason (the #6 failure transition)", async () => {
    const repo = new InboundEmailRepo(env.DB, ctxA);
    const created = await repo.create(baseInput());
    const failed = await repo.markFailed(created.id, "extractor returned no JSON");
    expect(failed.status).toBe("failed");
    expect(failed.error).toBe("extractor returned no JSON");
    expect((await repo.findById(created.id))?.error).toBe("extractor returned no JSON");
  });

  it("requires a non-empty reason for markFailed", async () => {
    const repo = new InboundEmailRepo(env.DB, ctxA);
    const created = await repo.create(baseInput());
    await expect(repo.markFailed(created.id, "  ")).rejects.toThrow(ValidationError);
  });

  it("throws NotFoundError when transitioning a row that is not in this household", async () => {
    const created = await new InboundEmailRepo(env.DB, ctxA).create(baseInput());
    const repoB = new InboundEmailRepo(env.DB, ctxB);
    await expect(repoB.markExtracted(created.id)).rejects.toThrow(NotFoundError);
    await expect(repoB.markFailed(created.id, "x")).rejects.toThrow(NotFoundError);
    // And the row in A is untouched.
    expect((await new InboundEmailRepo(env.DB, ctxA).findById(created.id))?.status).toBe("received");
  });

  it("only transitions out of received — terminal states never move again", async () => {
    const repo = new InboundEmailRepo(env.DB, ctxA);
    const extracted = await repo.create(baseInput());
    await repo.markExtracted(extracted.id);
    await expect(repo.markExtracted(extracted.id)).rejects.toThrow(ValidationError);
    await expect(repo.markFailed(extracted.id, "again")).rejects.toThrow(ValidationError);

    const rejected = await repo.create({ ...baseInput(), status: "rejected", error: "nope" });
    await expect(repo.markExtracted(rejected.id)).rejects.toThrow(ValidationError);
  });

  it("blocks a viewer from transitioning rows", async () => {
    const created = await new InboundEmailRepo(env.DB, ctxA).create(baseInput());
    const viewer = new InboundEmailRepo(env.DB, { ...ctxA, role: "viewer" });
    await expect(viewer.markExtracted(created.id)).rejects.toThrow(ForbiddenError);
  });

  it("keeps the exported status vocabulary in sync with the schema CHECK", async () => {
    expect(INBOUND_EMAIL_STATUSES).toEqual(["received", "extracted", "failed", "rejected"]);
    // The CHECK constraint rejects anything outside the vocabulary.
    const now = new Date().toISOString();
    await expect(
      env.DB.prepare(
        "INSERT INTO inbound_email (id, household_id, from_address, to_address, raw, status, received_at) VALUES (?,?,?,?,?,?,?)",
      )
        .bind("bad", "hh-a", "a@b.com", "t@b.foo", "raw", "bogus", now)
        .run(),
    ).rejects.toThrow(/CHECK/i);
  });
});
