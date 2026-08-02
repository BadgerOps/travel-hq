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
  for (const id of ["hh-a", "hh-b"]) {
    await env.DB.prepare("INSERT INTO household (id,name,created_at) VALUES (?,?,?)")
      .bind(id, id, now)
      .run();
  }
});

function appAs(who: Identity = identity) {
  return createApp({ verify: async () => who, ring });
}

function request(app: ReturnType<typeof createApp>, path: string, init?: RequestInit) {
  return app.request(path, init, { DB: env.DB } as unknown as AppBindings);
}

function patchDraft(
  app: ReturnType<typeof createApp>,
  draftId: string,
  body: unknown,
) {
  return request(app, `/api/imports/drafts/${draftId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function seedDraft(householdId = "hh-a") {
  const email = await InboundEmailRepo.forIngest(env.DB, householdId).create({
    from: "receipts@delta.example",
    to: "trips@example.com",
    subject: "Delta.com Trip Information",
    raw: "raw message",
  });
  const [draft] = await DraftBookingRepo.forIngest(env.DB, householdId).createMany([{
    inboundEmailId: email.id,
    ordinal: 0,
    kind: "flight",
    title: "DL 2586",
    location: "DEN → AMS",
    // Extracted a day early — the correction this endpoint exists for.
    startsAt: "2026-10-19T22:00:00.000Z",
    startsAtTz: "America/Denver",
    confirmationNumber: "TRIP90",
    source: "ai",
    extracted: {
      costCents: 42_500,
      details: {
        carrier: "Delta",
        flightNumber: "2586",
        originIata: "DEN",
        destinationIata: "AMS",
      },
    },
  }]);
  return draft!;
}

describe("PATCH /api/imports/drafts/:draftId", () => {
  it("saves a correction and shows it on the next review, suggestion and all", async () => {
    const trip = await new TripRepo(env.DB, ctx).create({
      title: "Europe",
      startsOn: "2026-10-21",
      endsOn: "2026-10-30",
    });
    const draft = await seedDraft();

    // Before: the extracted date falls outside the trip, so nothing matches.
    const before = await (await request(appAs(), "/api/imports/pending")).json() as Array<{
      suggestedTrip: unknown;
    }>;
    expect(before[0]!.suggestedTrip).toBeNull();

    const res = await patchDraft(appAs(), draft.id, {
      title: "Delta 2586",
      startsAt: "2026-10-21T22:00:00.000Z",
      startsAtTz: "America/Denver",
      confirmationNumber: "ABC123",
      costCents: 51_000,
      details: {
        carrier: "Delta",
        flightNumber: "2586",
        originIata: "DEN",
        destinationIata: "AMS",
        seat: "14C",
      },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      id: draft.id,
      title: "Delta 2586",
      status: "pending",
    });

    const after = await (await request(appAs(), "/api/imports/pending")).json() as Array<{
      title: string;
      confirmationNumber: string;
      costCents: number;
      details: Record<string, unknown>;
      suggestedTrip: { id: string } | null;
    }>;
    expect(after[0]).toMatchObject({
      title: "Delta 2586",
      confirmationNumber: "ABC123",
      costCents: 51_000,
      details: { seat: "14C" },
      // The corrected date now lands inside the trip: the queue's suggestion
      // is recomputed from the edit, which is why the route returns the draft
      // and the client reloads the queue rather than patching a row in place.
      suggestedTrip: { id: trip.id },
    });
  });

  it("answers 400 for a value the accept would have had to drop", async () => {
    const draft = await seedDraft();

    const unpaired = await patchDraft(appAs(), draft.id, { startsAtTz: null });
    expect(unpaired.status).toBe(400);
    expect(await unpaired.json()).toEqual({
      error: "startsAt requires startsAtTz (an IANA timezone)",
    });

    expect((await patchDraft(appAs(), draft.id, { costCents: -500 })).status).toBe(400);
    expect((await patchDraft(appAs(), draft.id, { title: "" })).status).toBe(400);
    // Unknown keys are refused at the boundary rather than silently ignored.
    expect((await patchDraft(appAs(), draft.id, { tripId: "trip-1" })).status).toBe(400);

    expect(await DraftBookingRepo.forIngest(env.DB, "hh-a").findById(draft.id))
      .toMatchObject({ title: "DL 2586", startsAtTz: "America/Denver" });
  });

  it("answers 400 once the draft has been resolved", async () => {
    const trip = await new TripRepo(env.DB, ctx).create({ title: "Europe" });
    const draft = await seedDraft();
    const accepted = await request(appAs(), "/api/imports/accept", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ draftIds: [draft.id], tripId: trip.id }),
    });
    expect(accepted.status).toBe(200);

    const res = await patchDraft(appAs(), draft.id, { title: "Too late" });
    expect(res.status).toBe(400);
    // The booking the accept created keeps the title it was committed with.
    expect(await env.DB.prepare("SELECT title FROM booking").first())
      .toEqual({ title: "DL 2586" });
  });

  it("answers 404 for another household's draft and 403 for a viewer", async () => {
    const foreign = await seedDraft("hh-b");
    expect((await patchDraft(appAs(), foreign.id, { title: "Theirs" })).status).toBe(404);
    expect((await patchDraft(appAs(), "no-such-draft", { title: "Nobody's" })).status).toBe(404);
    expect(await DraftBookingRepo.forIngest(env.DB, "hh-b").findById(foreign.id))
      .toMatchObject({ title: "DL 2586" });

    const own = await seedDraft();
    const viewer = appAs({ ...identity, role: "viewer" });
    expect((await patchDraft(viewer, own.id, { title: "Nope" })).status).toBe(403);
  });
});
