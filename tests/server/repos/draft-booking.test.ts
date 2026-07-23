import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import {
  DraftBookingRepo,
  DRAFT_BOOKING_STATUSES,
  DRAFT_BOOKING_SOURCES,
} from "../../../src/server/repos/draft-booking.js";
import type { CreateDraftBookingInput } from "../../../src/server/repos/draft-booking.js";
import { InboundEmailRepo } from "../../../src/server/repos/inbound-email.js";
import { ForbiddenError, NotFoundError, ValidationError } from "../../../src/server/repos/base.js";
import type { HouseholdContext } from "../../../src/server/repos/base.js";

const ctxA: HouseholdContext = { householdId: "hh-a", userId: "u1", role: "owner" };
const ctxB: HouseholdContext = { householdId: "hh-b", userId: "u2", role: "adult" };

let emailA: string;
let emailB: string;

beforeEach(async () => {
  await env.DB.exec("DELETE FROM draft_booking");
  await env.DB.exec("DELETE FROM inbound_email");
  await env.DB.exec("DELETE FROM household");
  const now = new Date().toISOString();
  await env.DB.prepare("INSERT INTO household (id,name,created_at) VALUES (?,?,?)").bind("hh-a", "A", now).run();
  await env.DB.prepare("INSERT INTO household (id,name,created_at) VALUES (?,?,?)").bind("hh-b", "B", now).run();
  emailA = (
    await new InboundEmailRepo(env.DB, ctxA).create({
      from: "badger@example.com",
      to: "trips@badgerops.foo",
      raw: "Subject: Trip\r\n\r\nBody",
    })
  ).id;
  emailB = (
    await new InboundEmailRepo(env.DB, ctxB).create({
      from: "badger@example.com",
      to: "trips-b@badgerops.foo",
      raw: "Subject: Trip\r\n\r\nBody",
    })
  ).id;
});

function draftInput(overrides: Partial<CreateDraftBookingInput> = {}): CreateDraftBookingInput {
  return {
    inboundEmailId: emailA,
    kind: "flight",
    title: "Delta 2214 BOI to STS",
    location: "Boise Airport",
    startsAt: "2026-10-09T15:40:00.000Z",
    startsAtTz: "America/Boise",
    endsAt: "2026-10-09T19:55:00.000Z",
    endsAtTz: "America/Los_Angeles",
    confirmationNumber: "D7WN88",
    source: "ai",
    extracted: { costCents: 61240, details: { carrier: "Delta" } },
    ...overrides,
  };
}

async function makeTripBooking(householdId: string): Promise<string> {
  const now = new Date().toISOString();
  await env.DB.prepare("INSERT INTO trip (id, household_id, title, created_at) VALUES (?,?,?,?)")
    .bind(`t-${householdId}`, householdId, "Trip", now)
    .run();
  await env.DB.prepare(
    "INSERT INTO booking (id, household_id, trip_id, kind, title, created_at) VALUES (?,?,?,?,?,?)",
  )
    .bind(`b-${householdId}`, householdId, `t-${householdId}`, "other", "Hotel", now)
    .run();
  return `b-${householdId}`;
}

describe("DraftBookingRepo", () => {
  it("creates pending drafts and round-trips every field", async () => {
    const repo = new DraftBookingRepo(env.DB, ctxA);
    const [draft] = await repo.createMany([draftInput()]);

    expect(draft?.id).toBeTruthy();
    expect(draft?.inboundEmailId).toBe(emailA);
    expect(draft?.kind).toBe("flight");
    expect(draft?.title).toBe("Delta 2214 BOI to STS");
    expect(draft?.location).toBe("Boise Airport");
    expect(draft?.startsAt).toBe("2026-10-09T15:40:00.000Z");
    expect(draft?.startsAtTz).toBe("America/Boise");
    expect(draft?.endsAt).toBe("2026-10-09T19:55:00.000Z");
    expect(draft?.endsAtTz).toBe("America/Los_Angeles");
    expect(draft?.confirmationNumber).toBe("D7WN88");
    expect(draft?.source).toBe("ai");
    expect(draft?.extracted).toEqual({ costCents: 61240, details: { carrier: "Delta" } });
    expect(draft?.status).toBe("pending");
    expect(draft?.bookingId).toBeNull();
    expect(draft?.createdAt).toBeTruthy();
    expect(draft?.resolvedAt).toBeNull();
    expect(await repo.findById(draft!.id)).toEqual(draft);
  });

  it("defaults optional fields to null/{} and returns [] for an empty batch", async () => {
    const repo = new DraftBookingRepo(env.DB, ctxA);
    expect(await repo.createMany([])).toEqual([]);
    const [draft] = await repo.createMany([
      { inboundEmailId: emailA, kind: "other", title: "Something", source: "ics" },
    ]);
    expect(draft?.location).toBeNull();
    expect(draft?.startsAt).toBeNull();
    expect(draft?.confirmationNumber).toBeNull();
    expect(draft?.extracted).toEqual({});
  });

  it("writes NOTHING when any input in the batch is invalid — all-or-nothing", async () => {
    const repo = new DraftBookingRepo(env.DB, ctxA);
    await expect(
      repo.createMany([draftInput(), draftInput({ title: "  " })]),
    ).rejects.toThrow(ValidationError);
    await expect(
      repo.createMany([draftInput(), draftInput({ kind: "spaceship" as never })]),
    ).rejects.toThrow(ValidationError);
    await expect(
      repo.createMany([draftInput(), draftInput({ source: "guess" as never })]),
    ).rejects.toThrow(ValidationError);
    expect(await repo.list()).toEqual([]);
  });

  it("rejects a timestamp without its zone, an unparseable timestamp, and a bad zone", async () => {
    const repo = new DraftBookingRepo(env.DB, ctxA);
    await expect(
      repo.createMany([draftInput({ startsAtTz: null })]),
    ).rejects.toThrow(ValidationError);
    await expect(
      repo.createMany([draftInput({ startsAt: "whenever" })]),
    ).rejects.toThrow(ValidationError);
    await expect(
      repo.createMany([draftInput({ endsAtTz: "Mars/Olympus" })]),
    ).rejects.toThrow(ValidationError);
    // A zone without its timestamp is as unpaired as the reverse.
    await expect(
      repo.createMany([draftInput({ startsAt: null })]),
    ).rejects.toThrow(ValidationError);
    expect(await repo.list()).toEqual([]);
  });

  it("refuses a source email that does not exist in this household", async () => {
    const repo = new DraftBookingRepo(env.DB, ctxA);
    await expect(
      repo.createMany([draftInput({ inboundEmailId: emailB })]),
    ).rejects.toThrow(NotFoundError);
    await expect(
      repo.createMany([draftInput({ inboundEmailId: "nope" })]),
    ).rejects.toThrow(NotFoundError);
    expect(await repo.list()).toEqual([]);
  });

  it("is tenant-scoped: household B never sees A's drafts", async () => {
    const [draft] = await new DraftBookingRepo(env.DB, ctxA).createMany([draftInput()]);
    const repoB = new DraftBookingRepo(env.DB, ctxB);
    expect(await repoB.findById(draft!.id)).toBeUndefined();
    expect(await repoB.list()).toEqual([]);
    expect(await repoB.listByStatus("pending")).toEqual([]);
    expect(await repoB.listByEmail(emailA)).toEqual([]);
  });

  it("forIngest writes scoped to the resolved household with a synthetic context", async () => {
    const [draft] = await DraftBookingRepo.forIngest(env.DB, "hh-a").createMany([draftInput()]);
    const rows = await env.DB.prepare("SELECT household_id FROM draft_booking WHERE id = ?")
      .bind(draft!.id)
      .all<{ household_id: string }>();
    expect(rows.results).toEqual([{ household_id: "hh-a" }]);
    expect(await new DraftBookingRepo(env.DB, ctxB).findById(draft!.id)).toBeUndefined();
  });

  it("blocks a viewer from creating, editing, and transitioning drafts", async () => {
    const [draft] = await new DraftBookingRepo(env.DB, ctxA).createMany([draftInput()]);
    const viewer = new DraftBookingRepo(env.DB, { ...ctxA, role: "viewer" });
    await expect(viewer.createMany([draftInput()])).rejects.toThrow(ForbiddenError);
    await expect(viewer.update(draft!.id, { title: "X" })).rejects.toThrow(ForbiddenError);
    await expect(viewer.markDismissed(draft!.id)).rejects.toThrow(ForbiddenError);
  });

  it("lists newest first; listByStatus and listByEmail return queue (oldest-first) order", async () => {
    const repo = new DraftBookingRepo(env.DB, ctxA);
    const [first] = await repo.createMany([draftInput({ title: "first" })]);
    const [second] = await repo.createMany([draftInput({ title: "second" })]);
    await repo.markDismissed(second!.id);

    expect((await repo.list()).map((d) => d.title)).toEqual(["second", "first"]);
    expect((await repo.listByStatus("pending")).map((d) => d.id)).toEqual([first!.id]);
    expect((await repo.listByStatus("dismissed")).map((d) => d.id)).toEqual([second!.id]);
    expect(await repo.listByStatus("accepted")).toEqual([]);
    expect((await repo.listByEmail(emailA)).map((d) => d.id)).toEqual([first!.id, second!.id]);
  });

  it("rejects an unknown status in listByStatus", async () => {
    const repo = new DraftBookingRepo(env.DB, ctxA);
    await expect(repo.listByStatus("bogus" as never)).rejects.toThrow(ValidationError);
  });

  it("edits a pending draft's reviewable fields with tri-state semantics", async () => {
    const repo = new DraftBookingRepo(env.DB, ctxA);
    const [draft] = await repo.createMany([draftInput()]);

    const updated = await repo.update(draft!.id, {
      kind: "lodging",
      title: "Dawn Ranch Lodge",
      location: null,
      confirmationNumber: "XYZ999",
    });
    expect(updated.kind).toBe("lodging");
    expect(updated.title).toBe("Dawn Ranch Lodge");
    expect(updated.location).toBeNull();
    expect(updated.confirmationNumber).toBe("XYZ999");
    // Untouched fields keep their stored values.
    expect(updated.startsAt).toBe("2026-10-09T15:40:00.000Z");
    expect(await repo.findById(draft!.id)).toEqual(updated);
  });

  it("validates the MERGED result of an edit — no blank title, no unpaired timestamp", async () => {
    const repo = new DraftBookingRepo(env.DB, ctxA);
    const [draft] = await repo.createMany([draftInput()]);
    await expect(repo.update(draft!.id, { title: " " })).rejects.toThrow(ValidationError);
    await expect(repo.update(draft!.id, { startsAtTz: null })).rejects.toThrow(ValidationError);
    await expect(repo.update(draft!.id, { kind: "spaceship" as never })).rejects.toThrow(ValidationError);
    // And nothing was changed by the failed attempts.
    expect((await repo.findById(draft!.id))?.title).toBe("Delta 2214 BOI to STS");
  });

  it("accepts a pending draft onto a booking in this household", async () => {
    const repo = new DraftBookingRepo(env.DB, ctxA);
    const [draft] = await repo.createMany([draftInput()]);
    const bookingId = await makeTripBooking("hh-a");

    const accepted = await repo.markAccepted(draft!.id, bookingId);
    expect(accepted.status).toBe("accepted");
    expect(accepted.bookingId).toBe(bookingId);
    expect(accepted.resolvedAt).toBeTruthy();
    expect((await repo.findById(draft!.id))?.status).toBe("accepted");
  });

  it("refuses to accept onto a booking outside this household", async () => {
    const repo = new DraftBookingRepo(env.DB, ctxA);
    const [draft] = await repo.createMany([draftInput()]);
    const foreignBooking = await makeTripBooking("hh-b");
    await expect(repo.markAccepted(draft!.id, foreignBooking)).rejects.toThrow(NotFoundError);
    expect((await repo.findById(draft!.id))?.status).toBe("pending");
  });

  it("dismisses a pending draft and KEEPS the row for audit", async () => {
    const repo = new DraftBookingRepo(env.DB, ctxA);
    const [draft] = await repo.createMany([draftInput()]);
    const dismissed = await repo.markDismissed(draft!.id);
    expect(dismissed.status).toBe("dismissed");
    expect(dismissed.resolvedAt).toBeTruthy();
    // Dismissal is a status change, not a delete — the audit row survives.
    expect((await repo.findById(draft!.id))?.status).toBe("dismissed");
    expect((await repo.list()).map((d) => d.id)).toEqual([draft!.id]);
  });

  it("only transitions and edits out of pending — terminal states are immutable", async () => {
    const repo = new DraftBookingRepo(env.DB, ctxA);
    const bookingId = await makeTripBooking("hh-a");
    const [accepted] = await repo.createMany([draftInput()]);
    await repo.markAccepted(accepted!.id, bookingId);
    await expect(repo.markDismissed(accepted!.id)).rejects.toThrow(ValidationError);
    await expect(repo.markAccepted(accepted!.id, bookingId)).rejects.toThrow(ValidationError);
    await expect(repo.update(accepted!.id, { title: "X" })).rejects.toThrow(ValidationError);

    const [dismissed] = await repo.createMany([draftInput()]);
    await repo.markDismissed(dismissed!.id);
    await expect(repo.markAccepted(dismissed!.id, bookingId)).rejects.toThrow(ValidationError);
    await expect(repo.update(dismissed!.id, { title: "X" })).rejects.toThrow(ValidationError);
  });

  it("throws NotFoundError when touching a draft that is not in this household", async () => {
    const [draft] = await new DraftBookingRepo(env.DB, ctxA).createMany([draftInput()]);
    const repoB = new DraftBookingRepo(env.DB, ctxB);
    await expect(repoB.update(draft!.id, { title: "X" })).rejects.toThrow(NotFoundError);
    await expect(repoB.markDismissed(draft!.id)).rejects.toThrow(NotFoundError);
    expect((await new DraftBookingRepo(env.DB, ctxA).findById(draft!.id))?.status).toBe("pending");
  });

  it("keeps the exported vocabularies in sync with the schema CHECKs", async () => {
    expect(DRAFT_BOOKING_STATUSES).toEqual(["pending", "accepted", "dismissed"]);
    expect(DRAFT_BOOKING_SOURCES).toEqual(["ics", "ai"]);
    const now = new Date().toISOString();
    await expect(
      env.DB.prepare(
        "INSERT INTO draft_booking (id, household_id, inbound_email_id, kind, title, source, status, created_at) VALUES (?,?,?,?,?,?,?,?)",
      )
        .bind("bad1", "hh-a", emailA, "other", "T", "ai", "bogus", now)
        .run(),
    ).rejects.toThrow(/CHECK/i);
    await expect(
      env.DB.prepare(
        "INSERT INTO draft_booking (id, household_id, inbound_email_id, kind, title, source, created_at) VALUES (?,?,?,?,?,?,?)",
      )
        .bind("bad2", "hh-a", emailA, "other", "T", "telepathy", now)
        .run(),
    ).rejects.toThrow(/CHECK/i);
  });
});
