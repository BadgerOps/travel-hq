import { beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { DraftBookingRepo } from "../../../src/server/repos/draft-booking.js";
import { InboundEmailRepo } from "../../../src/server/repos/inbound-email.js";
import { NotFoundError, ValidationError } from "../../../src/server/repos/base.js";

beforeEach(async () => {
  await env.DB.exec("DELETE FROM household");
  const now = new Date().toISOString();
  await env.DB.prepare("INSERT INTO household (id,name,created_at) VALUES (?,?,?)")
    .bind("draft-a", "A", now)
    .run();
  await env.DB.prepare("INSERT INTO household (id,name,created_at) VALUES (?,?,?)")
    .bind("draft-b", "B", now)
    .run();
});

async function email(householdId: string) {
  return InboundEmailRepo.forIngest(env.DB, householdId).create({
    from: "sender@example.com",
    to: "trips@example.com",
    raw: "message",
  });
}

describe("DraftBookingRepo", () => {
  it("creates a complete ordered batch and rejects duplicate ordinals", async () => {
    const source = await email("draft-a");
    const repo = DraftBookingRepo.forIngest(env.DB, "draft-a");
    const common = {
      inboundEmailId: source.id,
      kind: "other" as const,
      title: "Trip",
      source: "ai" as const,
    };

    await repo.createMany([
      { ...common, ordinal: 0, title: "First" },
      { ...common, ordinal: 1, title: "Second" },
    ]);
    expect((await repo.listByEmail(source.id)).map((draft) => draft.title)).toEqual([
      "First",
      "Second",
    ]);

    await expect(repo.createMany([{ ...common, ordinal: 0 }])).rejects.toThrow();
    expect(await repo.listByEmail(source.id)).toHaveLength(2);
  });

  it("validates the whole batch before inserting anything", async () => {
    const source = await email("draft-a");
    const repo = DraftBookingRepo.forIngest(env.DB, "draft-a");

    await expect(repo.createMany([
      {
        inboundEmailId: source.id,
        ordinal: 0,
        kind: "other",
        title: "Valid",
        source: "ics",
      },
      {
        inboundEmailId: source.id,
        ordinal: 1,
        kind: "other",
        title: "Invalid zone pair",
        startsAt: "2026-10-09T15:40:00.000Z",
        source: "ics",
      },
    ])).rejects.toThrow(ValidationError);
    expect(await repo.listByEmail(source.id)).toEqual([]);
  });

  it("cannot reference another household's email", async () => {
    const source = await email("draft-b");
    await expect(DraftBookingRepo.forIngest(env.DB, "draft-a").createMany([{
      inboundEmailId: source.id,
      ordinal: 0,
      kind: "other",
      title: "Cross tenant",
      source: "ai",
    }])).rejects.toThrow(NotFoundError);
  });

  it("accepts only a booking that preserves the draft's source email", async () => {
    const source = await email("draft-a");
    const repo = DraftBookingRepo.forIngest(env.DB, "draft-a");
    const [draft] = await repo.createMany([{
      inboundEmailId: source.id,
      ordinal: 0,
      kind: "other",
      title: "Hotel",
      source: "ai",
    }]);
    const now = new Date().toISOString();
    await env.DB.prepare("INSERT INTO trip (id,household_id,title,created_at) VALUES (?,?,?,?)")
      .bind("draft-trip", "draft-a", "Trip", now)
      .run();
    await env.DB.prepare(
      "INSERT INTO booking (id,household_id,trip_id,kind,title,created_at) VALUES (?,?,?,?,?,?)",
    ).bind("booking-without-source", "draft-a", "draft-trip", "other", "Hotel", now).run();

    await expect(repo.markAccepted(draft!.id, "booking-without-source")).rejects.toThrow(
      "must retain the draft's source",
    );

    await env.DB.prepare("UPDATE booking SET source_inbound_email_id = ? WHERE id = ?")
      .bind(source.id, "booking-without-source")
      .run();
    expect((await repo.markAccepted(draft!.id, "booking-without-source")).status).toBe("accepted");
  });
});
