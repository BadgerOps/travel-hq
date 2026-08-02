import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { InboundEmailRepo } from "../../../src/server/repos/inbound-email.js";
import { ForbiddenError } from "../../../src/server/repos/base.js";
import type { HouseholdContext } from "../../../src/server/repos/base.js";
import { Keyring } from "../../../src/server/crypto/envelope.js";
import {
  RAW_RETENTION_EXTRACTED_DAYS,
  RAW_RETENTION_UNRESOLVED_DAYS,
} from "../../../src/shared/email-retention.js";

const ctxA: HouseholdContext = { householdId: "hh-a", userId: "u1", role: "owner" };
const ctxB: HouseholdContext = { householdId: "hh-b", userId: "u2", role: "admin" };

const ring = new Keyring("k1", { k1: crypto.getRandomValues(new Uint8Array(32)) });
/** A ring that shares no key id with `ring` — i.e. a key rotated fully out. */
const strangerRing = new Keyring("k9", { k9: crypto.getRandomValues(new Uint8Array(32)) });

const MESSAGE =
  "From: badger@example.com\r\nSubject: Flight confirmation ABC123\r\n\r\nRecord locator ABC123";

beforeEach(async () => {
  await env.DB.exec("DELETE FROM inbound_email");
  await env.DB.exec("DELETE FROM household");
  const now = new Date().toISOString();
  for (const [id, name] of [["hh-a", "A"], ["hh-b", "B"]]) {
    await env.DB.prepare("INSERT INTO household (id,name,created_at) VALUES (?,?,?)")
      .bind(id, name, now)
      .run();
  }
});

function baseInput(overrides: Record<string, unknown> = {}) {
  return {
    from: "badger@example.com",
    to: "trips@badgerops.foo",
    subject: "Flight confirmation ABC123",
    raw: MESSAGE,
    ...overrides,
  };
}

/** Days ago as an ISO instant, the same shape `received_at` is written in. */
function daysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

/** Backdate a row: the only way to reach a retention boundary in a test. */
async function arrivedDaysAgo(id: string, days: number): Promise<void> {
  await env.DB.prepare("UPDATE inbound_email SET received_at = ? WHERE id = ?")
    .bind(daysAgo(days), id)
    .run();
}

async function storedColumns(id: string) {
  return await env.DB.prepare(
    "SELECT raw, raw_encryption, raw_purged_at FROM inbound_email WHERE id = ?",
  )
    .bind(id)
    .first<{ raw: string; raw_encryption: string; raw_purged_at: string | null }>();
}

describe("inbound email raw encryption at rest", () => {
  it("seals raw with the household key ring and reads it back verbatim", async () => {
    const repo = new InboundEmailRepo(env.DB, ctxA, ring);
    const created = await repo.create(baseInput());

    const row = await storedColumns(created.id);
    expect(row?.raw_encryption).toBe("envelope");
    expect(row?.raw).toMatch(/^v1\.k1\./);
    // The point of the exercise: the record locator is not sitting in D1.
    expect(row?.raw).not.toContain("ABC123");

    expect(created.raw).toBe(MESSAGE);
    expect(created.rawState).toBe("retained");
    expect((await repo.findById(created.id))?.raw).toBe(MESSAGE);
  });

  it("reads a legacy plaintext row as plaintext instead of failing to decrypt it", async () => {
    // Exactly what migration 0015 leaves behind: raw as written before the
    // envelope existed, labelled 'plaintext' by the column default.
    await env.DB.prepare(
      `INSERT INTO inbound_email (id, household_id, from_address, to_address, raw, status, received_at)
       VALUES (?,?,?,?,?,?,?)`,
    )
      .bind("legacy-1", "hh-a", "old@example.com", "trips@badgerops.foo", MESSAGE, "extracted", daysAgo(1))
      .run();

    // Read through a repo that DOES have a ring — the production shape. The
    // legacy row must not be mistaken for ciphertext.
    const legacy = await new InboundEmailRepo(env.DB, ctxA, ring).findById("legacy-1");
    expect(legacy?.raw).toBe(MESSAGE);
    expect(legacy?.rawState).toBe("retained");
    expect(legacy?.rawPurgedAt).toBeNull();
  });

  it("returns a row whose envelope cannot be opened rather than dropping it", async () => {
    const created = await new InboundEmailRepo(env.DB, ctxA, ring).create(baseInput());

    for (const reader of [
      new InboundEmailRepo(env.DB, ctxA, strangerRing), // key rotated out
      new InboundEmailRepo(env.DB, ctxA), // no ring configured at all
    ]) {
      const found = await reader.findById(created.id);
      // The row is still here, with everything that is not the message body.
      expect(found?.id).toBe(created.id);
      expect(found?.subject).toBe("Flight confirmation ABC123");
      expect(found?.rawState).toBe("unreadable");
      expect(found?.raw).toBe("");
      // And it is still counted in the list, so the activity feed cannot
      // silently shrink because of a key problem.
      expect((await reader.list()).map((e) => e.id)).toEqual([created.id]);
    }
  });

  it("stores no envelope for a row that carries no message", async () => {
    const rejected = await new InboundEmailRepo(env.DB, ctxA, ring).create(
      baseInput({ raw: "", status: "rejected", error: "sender is not on the household allowlist" }),
    );
    const row = await storedColumns(rejected.id);
    expect(row?.raw).toBe("");
    expect(row?.raw_encryption).toBe("plaintext");
    expect(rejected.rawState).toBe("never-stored");
    expect(rejected.rawExpiresAt).toBeNull();
  });
});

describe("inbound email raw retention sweep", () => {
  it("purges an extracted row once its success window passes, and spares a fresher one", async () => {
    const repo = new InboundEmailRepo(env.DB, ctxA, ring);
    const old = await repo.create(baseInput({ subject: "old" }));
    const fresh = await repo.create(baseInput({ subject: "fresh" }));
    await repo.markExtracted(old.id);
    await repo.markExtracted(fresh.id);
    await arrivedDaysAgo(old.id, RAW_RETENTION_EXTRACTED_DAYS + 1);
    await arrivedDaysAgo(fresh.id, RAW_RETENTION_EXTRACTED_DAYS - 1);

    expect(await repo.purgeExpiredRaw()).toEqual([old.id]);

    const purged = await repo.findById(old.id);
    expect(purged?.raw).toBe("");
    expect(purged?.rawState).toBe("purged");
    expect(purged?.rawPurgedAt).toEqual(expect.any(String));
    // Nothing else about the row went with it: the feed and every booking's
    // provenance link still resolve.
    expect(purged?.subject).toBe("old");
    expect(purged?.status).toBe("extracted");
    // A message that is already gone must not advertise a deletion date.
    expect(purged?.rawExpiresAt).toBeNull();

    expect((await repo.findById(fresh.id))?.raw).toBe(MESSAGE);
  });

  it("gives failed and still-queued rows the longer debugging window", async () => {
    const repo = new InboundEmailRepo(env.DB, ctxA, ring);
    const failed = await repo.create(baseInput({ subject: "failed" }));
    await repo.markFailed(failed.id, "extractor returned no JSON");
    const queued = await repo.create(baseInput({ subject: "queued" }));
    // Past the success window, well inside the debugging one.
    await arrivedDaysAgo(failed.id, RAW_RETENTION_EXTRACTED_DAYS + 1);
    await arrivedDaysAgo(queued.id, RAW_RETENTION_EXTRACTED_DAYS + 1);

    expect(await repo.purgeExpiredRaw()).toEqual([]);
    expect((await repo.findById(failed.id))?.raw).toBe(MESSAGE);
    expect((await repo.findById(queued.id))?.raw).toBe(MESSAGE);
  });

  it("lets no raw survive the outer window, whatever the row's status", async () => {
    // The headline guarantee of issue #22: a terminal row does not keep its
    // message forever, and neither does one that never got anywhere.
    const repo = new InboundEmailRepo(env.DB, ctxA, ring);
    const extracted = await repo.create(baseInput({ subject: "extracted" }));
    await repo.markExtracted(extracted.id);
    const failed = await repo.create(baseInput({ subject: "failed" }));
    await repo.markFailed(failed.id, "boom");
    const queued = await repo.create(baseInput({ subject: "queued" }));
    for (const id of [extracted.id, failed.id, queued.id]) {
      await arrivedDaysAgo(id, RAW_RETENTION_UNRESOLVED_DAYS + 1);
    }

    expect((await repo.purgeExpiredRaw()).sort()).toEqual(
      [extracted.id, failed.id, queued.id].sort(),
    );
    for (const email of await repo.list()) {
      expect(email.raw).toBe("");
      expect(email.rawState).toBe("purged");
    }
    // Nothing readable is left in the column either — not merely hidden by
    // the mapping layer.
    const { results } = await env.DB.prepare("SELECT raw FROM inbound_email").all<{ raw: string }>();
    expect(results.every((row) => row.raw === "")).toBe(true);
  });

  it("does not stamp a row that never stored a message as purged", async () => {
    const repo = new InboundEmailRepo(env.DB, ctxA, ring);
    const rejected = await repo.create(baseInput({ raw: "", status: "rejected", error: "nope" }));
    await arrivedDaysAgo(rejected.id, RAW_RETENTION_UNRESOLVED_DAYS + 10);

    expect(await repo.purgeExpiredRaw()).toEqual([]);
    // Still "never-stored", so the UI keeps saying "no copy was stored"
    // rather than implying a message was deleted.
    expect((await repo.findById(rejected.id))?.rawState).toBe("never-stored");
    expect((await storedColumns(rejected.id))?.raw_purged_at).toBeNull();
  });

  it("is idempotent and household-scoped", async () => {
    const repoA = new InboundEmailRepo(env.DB, ctxA, ring);
    const repoB = new InboundEmailRepo(env.DB, ctxB, ring);
    const mine = await repoA.create(baseInput());
    const theirs = await repoB.create(baseInput());
    await arrivedDaysAgo(mine.id, RAW_RETENTION_UNRESOLVED_DAYS + 1);
    await arrivedDaysAgo(theirs.id, RAW_RETENTION_UNRESOLVED_DAYS + 1);

    expect(await repoA.purgeExpiredRaw()).toEqual([mine.id]);
    // A sweep triggered by household A cannot touch household B's mail, even
    // though B's is just as expired — B's own next write will handle it.
    expect((await repoB.findById(theirs.id))?.raw).toBe(MESSAGE);
    // And running it again finds nothing left to do.
    expect(await repoA.purgeExpiredRaw()).toEqual([]);
  });

  it("blocks a viewer from sweeping", async () => {
    const viewer = new InboundEmailRepo(env.DB, { ...ctxA, role: "viewer" }, ring);
    await expect(viewer.purgeExpiredRaw()).rejects.toThrow(ForbiddenError);
  });

  it("sweeps every household at once for a future scheduled handler", async () => {
    const repoA = new InboundEmailRepo(env.DB, ctxA, ring);
    const repoB = new InboundEmailRepo(env.DB, ctxB, ring);
    const mine = await repoA.create(baseInput());
    const theirs = await repoB.create(baseInput());
    const recent = await repoA.create(baseInput({ subject: "recent" }));
    await arrivedDaysAgo(mine.id, RAW_RETENTION_UNRESOLVED_DAYS + 1);
    await arrivedDaysAgo(theirs.id, RAW_RETENTION_UNRESOLVED_DAYS + 1);

    expect(await InboundEmailRepo.purgeExpiredRawEverywhere(env.DB)).toBe(2);
    expect((await repoA.findById(mine.id))?.rawState).toBe("purged");
    expect((await repoB.findById(theirs.id))?.rawState).toBe("purged");
    expect((await repoA.findById(recent.id))?.raw).toBe(MESSAGE);
  });

  it("accepts an explicit clock so retention is testable and reproducible", async () => {
    const repo = new InboundEmailRepo(env.DB, ctxA, ring);
    const email = await repo.create(baseInput());
    await repo.markExtracted(email.id);

    // Nothing is due yet …
    expect(await repo.purgeExpiredRaw(new Date())).toEqual([]);
    // … but a caller standing a day past the window sees it as due.
    const later = new Date(Date.now() + (RAW_RETENTION_EXTRACTED_DAYS + 1) * 24 * 60 * 60 * 1000);
    expect(await repo.purgeExpiredRaw(later)).toEqual([email.id]);
  });
});
