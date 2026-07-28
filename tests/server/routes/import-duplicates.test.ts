import { beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { createApp } from "../../../src/server/index.js";
import type { AppBindings } from "../../../src/server/index.js";
import type { Identity } from "../../../src/server/auth.js";
import { Keyring } from "../../../src/server/crypto/envelope.js";
import { DraftBookingRepo } from "../../../src/server/repos/draft-booking.js";
import { InboundEmailRepo } from "../../../src/server/repos/inbound-email.js";
import type { HouseholdContext } from "../../../src/server/repos/base.js";

const identity: Identity = {
  userId: "u1",
  email: "owner@example.com",
  householdId: "hh-a",
  role: "owner",
};
const ctx: HouseholdContext = identity;
const ring = new Keyring("test", { test: crypto.getRandomValues(new Uint8Array(32)) });
const testEnv = { DB: env.DB } as unknown as AppBindings;

const app = () => createApp({ verify: async () => identity, ring });

function send(path: string, method: string, body?: unknown) {
  return app().request(
    path,
    body === undefined
      ? { method }
      : { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
    testEnv,
  );
}

const FLIGHT = {
  kind: "flight" as const,
  title: "Delta 1423 SEA-JFK",
  startsAt: "2026-09-04T14:30:00.000Z",
  startsAtTz: "America/Los_Angeles",
  details: { carrier: "Delta", flightNumber: "1423", originIata: "SEA", destinationIata: "JFK" },
};

async function seedDrafts(count: number, confirmationNumber = "HX7T2Q"): Promise<string[]> {
  const email = await new InboundEmailRepo(env.DB, ctx).create({
    from: "delta@example.com",
    to: "trips@example.com",
    subject: "Your itinerary",
    raw: "raw",
  });
  const created = await new DraftBookingRepo(env.DB, ctx).createMany(
    Array.from({ length: count }, (_, ordinal) => ({
      inboundEmailId: email.id,
      ordinal,
      kind: FLIGHT.kind,
      title: FLIGHT.title,
      startsAt: FLIGHT.startsAt,
      startsAtTz: FLIGHT.startsAtTz,
      confirmationNumber,
      source: "ai" as const,
      extracted: { details: FLIGHT.details },
    })),
  );
  return created.map((draft) => draft.id);
}

async function seedTripWithFlight(): Promise<string> {
  const trip = (await (await send("/api/trips", "POST", { title: "Tokyo" })).json()) as { id: string };
  await send(`/api/trips/${trip.id}/bookings`, "POST", {
    ...FLIGHT,
    confirmationNumber: "HX7T2Q",
  });
  return trip.id;
}

beforeEach(async () => {
  await env.DB.exec("DELETE FROM draft_booking");
  await env.DB.exec("DELETE FROM booking");
  await env.DB.exec("DELETE FROM inbound_email");
  await env.DB.exec("DELETE FROM trip");
  await env.DB.exec("DELETE FROM household");
  await env.DB.prepare("INSERT INTO household (id,name,created_at) VALUES (?,?,?)")
    .bind("hh-a", "A", new Date().toISOString()).run();
});

describe("GET /api/imports/pending duplicate flags", () => {
  it("names the trip a pending import already appears on", async () => {
    await seedTripWithFlight();
    await seedDrafts(1);

    const pending = (await (await send("/api/imports/pending", "GET")).json()) as Array<{
      duplicates: Array<Record<string, unknown>>;
    }>;
    expect(pending[0]?.duplicates).toMatchObject([
      { target: "booking", confidence: "high", tripTitle: "Tokyo" },
    ]);
    // The booking's confirmation number was decrypted to make the match; the
    // flag must not carry it back out. Scoped to `duplicates` on purpose —
    // the draft's own confirmation number is stored in the clear and has
    // always been part of this response.
    expect(JSON.stringify(pending[0]?.duplicates)).not.toContain("HX7T2Q");
  });
});

describe("POST /api/imports/accept duplicate guard", () => {
  it("answers 409 with a sentence the reviewer can act on", async () => {
    const tripId = await seedTripWithFlight();
    const [draftId] = await seedDrafts(1);

    const res = await send("/api/imports/accept", "POST", { draftIds: [draftId], tripId });
    expect(res.status).toBe(409);
    expect((await res.json() as { error: string }).error).toMatch(/already on Tokyo/);

    // Refused means nothing changed: the draft is still pending.
    const pending = (await (await send("/api/imports/pending", "GET")).json()) as unknown[];
    expect(pending).toHaveLength(1);
  });

  it("imports it on the retry that carries allowDuplicates", async () => {
    const tripId = await seedTripWithFlight();
    const [draftId] = await seedDrafts(1);

    const res = await send("/api/imports/accept", "POST", {
      draftIds: [draftId],
      tripId,
      allowDuplicates: true,
    });
    expect(res.status).toBe(200);
    const list = (await (await send(`/api/trips/${tripId}/bookings`, "GET")).json()) as unknown[];
    expect(list).toHaveLength(2);
  });

  it("still accepts an import that repeats nothing", async () => {
    const trip = (await (await send("/api/trips", "POST", { title: "Tokyo" })).json()) as { id: string };
    const [draftId] = await seedDrafts(1);
    expect((await send("/api/imports/accept", "POST", { draftIds: [draftId], tripId: trip.id })).status)
      .toBe(200);
  });

  it("rejects an allowDuplicates that is not a boolean", async () => {
    const tripId = await seedTripWithFlight();
    const [draftId] = await seedDrafts(1);
    const res = await send("/api/imports/accept", "POST", {
      draftIds: [draftId],
      tripId,
      allowDuplicates: "yes",
    });
    expect(res.status).toBe(400);
  });
});

describe("POST /api/imports/create-trip duplicate guard", () => {
  it("answers 409 for a selection that repeats itself, then creates on the retry", async () => {
    const draftIds = await seedDrafts(2);

    const refused = await send("/api/imports/create-trip", "POST", {
      draftIds,
      title: "Tokyo",
    });
    expect(refused.status).toBe(409);
    expect((await refused.json() as { error: string }).error).toMatch(/already in this selection/);

    const created = await send("/api/imports/create-trip", "POST", {
      draftIds,
      title: "Tokyo",
      allowDuplicates: true,
    });
    expect(created.status).toBe(201);
  });
});
