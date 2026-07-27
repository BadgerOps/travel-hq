import { beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { createApp } from "../../../src/server/index.js";
import type { AppBindings } from "../../../src/server/index.js";
import type { Identity } from "../../../src/server/auth.js";
import { Keyring } from "../../../src/server/crypto/envelope.js";
import { DraftBookingRepo } from "../../../src/server/repos/draft-booking.js";
import { InboundEmailRepo } from "../../../src/server/repos/inbound-email.js";
import { TripRepo } from "../../../src/server/repos/trip.js";
import type { HouseholdContext } from "../../../src/server/repos/base.js";
import { DELTA_BOOKINGS_90_DAYS } from "../../fixtures/delta-itinerary.js";

const identity: Identity = {
  userId: "u1",
  email: "owner@example.com",
  householdId: "hh-a",
  role: "owner",
};
const ctx: HouseholdContext = identity;
const ring = new Keyring("test", { test: crypto.getRandomValues(new Uint8Array(32)) });

beforeEach(async () => {
  await env.DB.exec("DELETE FROM household");
  const now = new Date().toISOString();
  await env.DB.prepare("INSERT INTO household (id,name,created_at) VALUES (?,?,?)")
    .bind("hh-a", "A", now).run();
  await env.DB.prepare("INSERT INTO household (id,name,created_at) VALUES (?,?,?)")
    .bind("hh-b", "B", now).run();
});

function appAs(who: Identity = identity) {
  return createApp({ verify: async () => who, ring });
}

function request(
  app: ReturnType<typeof createApp>,
  path: string,
  init?: RequestInit,
) {
  return app.request(path, init, { DB: env.DB } as unknown as AppBindings);
}

function postJson(app: ReturnType<typeof createApp>, path: string, body: unknown) {
  return request(app, path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function seedDelta(householdId = "hh-a") {
  const email = await InboundEmailRepo.forIngest(env.DB, householdId).create({
    from: "receipts@delta.example",
    to: "trips@example.com",
    subject: "Delta.com Trip Information",
    raw: "raw message",
  });
  return DraftBookingRepo.forIngest(env.DB, householdId).createMany(
    DELTA_BOOKINGS_90_DAYS.map((booking, ordinal) => ({
      inboundEmailId: email.id,
      ordinal,
      kind: booking.kind,
      title: booking.title,
      location: booking.location,
      startsAt: booking.startsAt,
      startsAtTz: booking.startsAtTz,
      endsAt: booking.endsAt,
      endsAtTz: booking.endsAtTz,
      confirmationNumber: booking.confirmationNumber,
      source: "ai" as const,
      extracted: booking,
    })),
  );
}

describe("import review routes", () => {
  it("suggests the one existing trip that contains each draft's local dates", async () => {
    const trip = await new TripRepo(env.DB, ctx).create({
      title: "Europe",
      startsOn: "2026-10-21",
      endsOn: "2026-10-30",
    });
    await seedDelta();

    const res = await request(appAs(), "/api/imports/pending");
    expect(res.status).toBe(200);
    const pending = await res.json() as Array<Record<string, unknown>>;
    expect(pending).toHaveLength(3);
    expect(pending).toMatchObject(DELTA_BOOKINGS_90_DAYS.map((booking, index) => ({
      title: booking.title,
      // DL 162 departs on Oct 21 local Chicago time even though its UTC
      // instant is already Oct 22.
      localStartsOn: index < 2 ? "2026-10-21" : "2026-10-22",
      suggestedTrip: { id: trip.id, title: "Europe" },
      source: {
        from: "receipts@delta.example",
        subject: "Delta.com Trip Information",
      },
    })));
  });

  it("leaves an ambiguous date match unassigned", async () => {
    await new TripRepo(env.DB, ctx).create({
      title: "Europe",
      startsOn: "2026-10-20",
      endsOn: "2026-10-30",
    });
    await new TripRepo(env.DB, ctx).create({
      title: "Amsterdam",
      startsOn: "2026-10-21",
      endsOn: "2026-10-23",
    });
    await seedDelta();

    const pending = await (await request(appAs(), "/api/imports/pending")).json() as Array<{
      suggestedTrip: unknown;
    }>;
    expect(pending.every((draft) => draft.suggestedTrip === null)).toBe(true);
  });

  it("accepts selected drafts into an existing trip and preserves source provenance", async () => {
    const trip = await new TripRepo(env.DB, ctx).create({
      title: "Europe",
      startsOn: "2026-10-21",
      endsOn: "2026-10-30",
    });
    const drafts = await seedDelta();
    const selected = drafts.slice(0, 2).map((draft) => draft.id);

    const res = await postJson(appAs(), "/api/imports/accept", {
      draftIds: selected,
      tripId: trip.id,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      trip: { id: trip.id },
      acceptedDraftIds: selected,
    });

    const { results: bookings } = await env.DB.prepare(
      `SELECT trip_id, source_inbound_email_id, status, confirmation_number
         FROM booking ORDER BY starts_at`,
    ).all<{
      trip_id: string;
      source_inbound_email_id: string;
      status: string;
      confirmation_number: string;
    }>();
    expect(bookings).toHaveLength(2);
    expect(bookings.every((booking) =>
      booking.trip_id === trip.id &&
      booking.source_inbound_email_id === drafts[0]!.inboundEmailId &&
      booking.status === "planned" &&
      booking.confirmation_number !== "TRIP90"
    )).toBe(true);
    expect(
      (await DraftBookingRepo.forIngest(env.DB, "hh-a").listByStatus("pending"))
        .map((draft) => draft.id),
    ).toEqual([drafts[2]!.id]);
  });

  it("allows a reviewer to manually assign an unmatched import to an existing trip", async () => {
    const selectedTrip = await new TripRepo(env.DB, ctx).create({
      title: "Too early",
      startsOn: "2026-10-01",
      endsOn: "2026-10-10",
    });
    const drafts = await seedDelta();

    const res = await postJson(appAs(), "/api/imports/accept", {
      draftIds: [drafts[0]!.id],
      tripId: selectedTrip.id,
    });
    expect(res.status).toBe(200);
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM booking").first())
      .toEqual({ count: 1 });
    expect(await DraftBookingRepo.forIngest(env.DB, "hh-a").listByStatus("pending"))
      .toHaveLength(2);
  });

  it("does not manually assign imports to a cancelled trip", async () => {
    const selectedTrip = await new TripRepo(env.DB, ctx).create({
      title: "Cancelled trip",
      startsOn: "2026-10-01",
      endsOn: "2026-10-30",
    });
    await new TripRepo(env.DB, ctx).update(selectedTrip.id, { status: "cancelled" });
    const drafts = await seedDelta();

    const res = await postJson(appAs(), "/api/imports/accept", {
      draftIds: [drafts[0]!.id],
      tripId: selectedTrip.id,
    });
    expect(res.status).toBe(400);
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM booking").first())
      .toEqual({ count: 0 });
  });

  it("creates one dated trip and bookings atomically from multiple pending drafts", async () => {
    const drafts = await seedDelta();
    const res = await postJson(appAs(), "/api/imports/create-trip", {
      draftIds: drafts.map((draft) => draft.id),
      title: "Germany trip",
      destination: "Stuttgart",
    });
    expect(res.status).toBe(201);
    const result = await res.json() as {
      trip: { id: string; startsOn: string; endsOn: string };
      acceptedDraftIds: string[];
    };
    expect(result).toMatchObject({
      trip: {
        startsOn: "2026-10-21",
        endsOn: "2026-10-22",
      },
      acceptedDraftIds: drafts.map((draft) => draft.id),
    });
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS count FROM booking WHERE trip_id = ?")
        .bind(result.trip.id).first(),
    ).toEqual({ count: 3 });
    expect(await DraftBookingRepo.forIngest(env.DB, "hh-a").listByStatus("pending"))
      .toEqual([]);
  });

  it("rejects cross-household selections without creating a partial trip", async () => {
    const own = await seedDelta();
    const foreign = await seedDelta("hh-b");
    const res = await postJson(appAs(), "/api/imports/create-trip", {
      draftIds: [own[0]!.id, foreign[0]!.id],
      title: "Must not exist",
    });
    expect(res.status).toBe(404);
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS count FROM trip WHERE household_id = 'hh-a'")
        .first(),
    ).toEqual({ count: 0 });
    expect(await DraftBookingRepo.forIngest(env.DB, "hh-a").listByStatus("pending"))
      .toHaveLength(3);
  });

  it("dismisses pending drafts and blocks viewers from the review queue", async () => {
    const drafts = await seedDelta();
    const dismissed = await postJson(appAs(), "/api/imports/dismiss", {
      draftIds: [drafts[0]!.id],
    });
    expect(dismissed.status).toBe(200);
    expect(await dismissed.json()).toEqual({ dismissedDraftIds: [drafts[0]!.id] });

    const viewer = appAs({ ...identity, role: "viewer" });
    expect((await request(viewer, "/api/imports/pending")).status).toBe(403);
    expect((await postJson(viewer, "/api/imports/accept", {
      draftIds: [drafts[1]!.id],
      tripId: "anything",
    })).status).toBe(403);
  });
});
