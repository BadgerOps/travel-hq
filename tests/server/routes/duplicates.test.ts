import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { Keyring } from "../../../src/server/crypto/envelope.js";
import { createApp } from "../../../src/server/index.js";
import type { AppBindings } from "../../../src/server/index.js";
import type { Identity } from "../../../src/server/auth.js";

const ring = new Keyring("server-v1", { "server-v1": crypto.getRandomValues(new Uint8Array(32)) });
const owner: Identity = { userId: "u1", email: "badger@example.com", householdId: "hh-a", role: "owner" };
const testEnv = { DB: env.DB } as unknown as AppBindings;

function appAs(who: Identity) {
  return createApp({ verify: (async () => who) as (req: Request, e: AppBindings) => Promise<Identity>, ring });
}
let app: ReturnType<typeof createApp>;

function send(a: ReturnType<typeof createApp>, path: string, method: string, body?: unknown) {
  return a.request(
    path,
    body === undefined
      ? { method }
      : { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
    testEnv,
  );
}
function json(path: string, method: string, body?: unknown) {
  return send(app, path, method, body);
}

type Created = { id: string };

async function makeTrip(): Promise<string> {
  return ((await (await json("/api/trips", "POST", { title: "Tokyo" })).json()) as Created).id;
}

async function makeFlight(tripId: string, over: Record<string, unknown> = {}): Promise<string> {
  const res = await json(`/api/trips/${tripId}/bookings`, "POST", {
    kind: "flight",
    title: "Delta 1423 SEA-JFK",
    startsAt: "2026-09-04T14:30:00.000Z",
    startsAtTz: "America/Los_Angeles",
    details: { carrier: "Delta", flightNumber: "1423", originIata: "SEA", destinationIata: "JFK" },
    ...over,
  });
  return ((await res.json()) as Created).id;
}

type DuplicatesBody = {
  groups: {
    reason: string;
    confidence: string;
    suggestedKeepId: string;
    bookings: { id: string }[];
  }[];
};

beforeEach(async () => {
  await env.DB.exec("DELETE FROM booking_duplicate_dismissal");
  await env.DB.exec("DELETE FROM booking");
  await env.DB.exec("DELETE FROM trip");
  await env.DB.exec("DELETE FROM household");
  const now = new Date().toISOString();
  await env.DB.prepare("INSERT INTO household (id, name, created_at) VALUES (?, ?, ?)").bind("hh-a", "Badger", now).run();
  await env.DB.prepare("INSERT INTO household (id, name, created_at) VALUES (?, ?, ?)").bind("hh-b", "Other", now).run();
  app = appAs(owner);
});

describe("GET /api/trips/:tripId/duplicates", () => {
  it("reports a group for two imports of the same confirmation number", async () => {
    const tripId = await makeTrip();
    const a = await makeFlight(tripId, { confirmationNumber: "HX7T2Q" });
    const b = await makeFlight(tripId, { title: "DL1423", confirmationNumber: "hx7-t2q" });

    const res = await send(app, `/api/trips/${tripId}/duplicates`, "GET");
    expect(res.status).toBe(200);
    const body = (await res.json()) as DuplicatesBody;
    expect(body.groups).toHaveLength(1);
    expect(body.groups[0]?.reason).toBe("confirmation");
    expect(body.groups[0]?.bookings.map((x) => x.id).sort()).toEqual([a, b].sort());
    // The matcher decrypted these to compare them; the response must not.
    expect(JSON.stringify(body)).not.toContain("HX7T2Q");
  });

  it("is empty for a trip with nothing repeated, and 404s for another household's trip", async () => {
    const tripId = await makeTrip();
    await makeFlight(tripId, { confirmationNumber: "HX7T2Q" });
    expect(((await (await send(app, `/api/trips/${tripId}/duplicates`, "GET")).json()) as DuplicatesBody).groups).toEqual([]);

    const otherApp = appAs({ ...owner, householdId: "hh-b" });
    expect((await send(otherApp, `/api/trips/${tripId}/duplicates`, "GET")).status).toBe(404);
  });

  it("is readable by a viewer", async () => {
    const tripId = await makeTrip();
    await makeFlight(tripId, { confirmationNumber: "HX7T2Q" });
    await makeFlight(tripId, { confirmationNumber: "HX7T2Q" });
    const viewerApp = appAs({ ...owner, role: "viewer" });
    const res = await send(viewerApp, `/api/trips/${tripId}/duplicates`, "GET");
    expect(res.status).toBe(200);
    expect(((await res.json()) as DuplicatesBody).groups).toHaveLength(1);
  });
});

describe("POST /api/trips/:tripId/duplicates/merge", () => {
  it("folds the duplicate into the keeper and removes it from the trip", async () => {
    const tripId = await makeTrip();
    const keep = await makeFlight(tripId);
    const dup = await makeFlight(tripId, { confirmationNumber: "HX7T2Q", costCents: 41_200 });

    const res = await json(`/api/trips/${tripId}/duplicates/merge`, "POST", { keepId: keep, mergeIds: [dup] });
    expect(res.status).toBe(200);
    const merged = (await res.json()) as { id: string; costCents: number | null };
    expect(merged.id).toBe(keep);
    expect(merged.costCents).toBe(41_200);

    const list = (await (await send(app, `/api/trips/${tripId}/bookings`, "GET")).json()) as Created[];
    expect(list.map((b) => b.id)).toEqual([keep]);
  });

  it("rejects a malformed body, a foreign booking, and a viewer", async () => {
    const tripId = await makeTrip();
    const keep = await makeFlight(tripId);
    const dup = await makeFlight(tripId, { confirmationNumber: "HX7T2Q" });

    // `bookingIds` is the dismiss payload; .strict() refuses it rather than
    // silently dropping it and complaining about the missing keys.
    expect((await json(`/api/trips/${tripId}/duplicates/merge`, "POST", { bookingIds: [keep, dup] })).status).toBe(400);
    expect((await json(`/api/trips/${tripId}/duplicates/merge`, "POST", { keepId: keep, mergeIds: [] })).status).toBe(400);
    expect((await json(`/api/trips/${tripId}/duplicates/merge`, "POST", { keepId: keep, mergeIds: ["b-nope"] })).status).toBe(404);

    const viewerApp = appAs({ ...owner, role: "viewer" });
    expect(
      (await send(viewerApp, `/api/trips/${tripId}/duplicates/merge`, "POST", { keepId: keep, mergeIds: [dup] })).status,
    ).toBe(403);

    // Every refusal left both bookings standing.
    const list = (await (await send(app, `/api/trips/${tripId}/bookings`, "GET")).json()) as Created[];
    expect(list).toHaveLength(2);
  });
});

describe("POST /api/trips/:tripId/duplicates/dismiss", () => {
  it("silences a pair the household says is not a duplicate", async () => {
    const tripId = await makeTrip();
    const a = await makeFlight(tripId, { confirmationNumber: "HX7T2Q" });
    const b = await makeFlight(tripId, { confirmationNumber: "HX7T2Q" });

    expect((await json(`/api/trips/${tripId}/duplicates/dismiss`, "POST", { bookingIds: [a, b] })).status).toBe(204);
    const body = (await (await send(app, `/api/trips/${tripId}/duplicates`, "GET")).json()) as DuplicatesBody;
    expect(body.groups).toEqual([]);
    // Dismissing is not deleting.
    expect(((await (await send(app, `/api/trips/${tripId}/bookings`, "GET")).json()) as Created[])).toHaveLength(2);
  });

  it("needs at least two ids and refuses a viewer", async () => {
    const tripId = await makeTrip();
    const a = await makeFlight(tripId, { confirmationNumber: "HX7T2Q" });
    const b = await makeFlight(tripId, { confirmationNumber: "HX7T2Q" });
    expect((await json(`/api/trips/${tripId}/duplicates/dismiss`, "POST", { bookingIds: [a] })).status).toBe(400);
    const viewerApp = appAs({ ...owner, role: "viewer" });
    expect(
      (await send(viewerApp, `/api/trips/${tripId}/duplicates/dismiss`, "POST", { bookingIds: [a, b] })).status,
    ).toBe(403);
  });
});

describe("DELETE /api/bookings/:bookingId", () => {
  it("removes one booking and leaves the rest of the trip alone", async () => {
    const tripId = await makeTrip();
    const keep = await makeFlight(tripId);
    const dup = await makeFlight(tripId, { confirmationNumber: "HX7T2Q" });

    expect((await send(app, `/api/bookings/${dup}`, "DELETE")).status).toBe(204);
    const list = (await (await send(app, `/api/trips/${tripId}/bookings`, "GET")).json()) as Created[];
    expect(list.map((b) => b.id)).toEqual([keep]);
  });

  it("404s for an unknown or cross-household booking and 403s for a viewer", async () => {
    const tripId = await makeTrip();
    const bookingId = await makeFlight(tripId);
    expect((await send(app, "/api/bookings/b-nope", "DELETE")).status).toBe(404);
    expect((await send(appAs({ ...owner, householdId: "hh-b" }), `/api/bookings/${bookingId}`, "DELETE")).status).toBe(404);
    expect((await send(appAs({ ...owner, role: "viewer" }), `/api/bookings/${bookingId}`, "DELETE")).status).toBe(403);
    expect(((await (await send(app, `/api/trips/${tripId}/bookings`, "GET")).json()) as Created[])).toHaveLength(1);
  });
});
