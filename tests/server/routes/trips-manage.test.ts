import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { Keyring } from "../../../src/server/crypto/envelope.js";
import { createApp } from "../../../src/server/index.js";
import type { AppBindings } from "../../../src/server/index.js";
import type { Identity } from "../../../src/server/auth.js";
import type { Trip } from "../../../src/server/repos/trip.js";

const ring = new Keyring("server-v1", { "server-v1": crypto.getRandomValues(new Uint8Array(32)) });
const owner: Identity = { userId: "u1", email: "badger@example.com", householdId: "hh-a", role: "owner" };
const testEnv = { DB: env.DB } as unknown as AppBindings;

function appAs(who: Identity) {
  return createApp({ verify: (async () => who) as (req: Request, e: AppBindings) => Promise<Identity>, ring });
}
let app: ReturnType<typeof createApp>;
function request(a: ReturnType<typeof createApp>, path: string, init?: RequestInit) {
  return a.request(path, init, testEnv);
}
function jsonRequest(path: string, method: string, body: unknown) {
  return request(app, path, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}
async function createTrip(): Promise<string> {
  const res = await jsonRequest("/api/trips", "POST", {
    title: "Guerneville",
    destination: "Guerneville, CA",
    startsOn: "2026-10-09",
    endsOn: "2026-10-11",
  });
  return ((await res.json()) as { id: string }).id;
}

beforeEach(async () => {
  for (const table of ["booking_person", "checklist_item", "booking", "trip_person", "person", "trip", "household"]) {
    await env.DB.exec(`DELETE FROM ${table}`);
  }
  const now = new Date().toISOString();
  await env.DB.prepare("INSERT INTO household (id, name, created_at) VALUES (?, ?, ?)").bind("hh-a", "Badger", now).run();
  await env.DB.prepare("INSERT INTO person (id, household_id, display_name, created_at) VALUES (?, ?, ?, ?)").bind("p-ava", "hh-a", "Ava", now).run();
  app = appAs(owner);
});

describe("GET /api/trips/:tripId", () => {
  it("returns one household-scoped trip", async () => {
    const id = await createTrip();
    const res = await request(app, `/api/trips/${id}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id, title: "Guerneville" });
  });

  it("answers 404 for an unknown trip", async () => {
    expect((await request(app, "/api/trips/t-nope")).status).toBe(404);
  });
});

describe("PUT /api/trips/:tripId", () => {
  it("applies a partial update and returns the trip", async () => {
    const id = await createTrip();
    const res = await jsonRequest(`/api/trips/${id}`, "PUT", { title: "Wedding weekend", notes: "bring boots" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Trip;
    expect(body.title).toBe("Wedding weekend");
    expect(body.notes).toBe("bring boots");
    // Absent keys left the stored values alone.
    expect(body.destination).toBe("Guerneville, CA");
    expect(body.startsOn).toBe("2026-10-09");
  });

  it("clears a nullable field on an explicit null", async () => {
    const id = await createTrip();
    const res = await jsonRequest(`/api/trips/${id}`, "PUT", { destination: null, endsOn: null });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Trip;
    expect(body.destination).toBeNull();
    expect(body.endsOn).toBeNull();
  });

  it("answers 400 for an unknown key (strict schema)", async () => {
    const id = await createTrip();
    expect((await jsonRequest(`/api/trips/${id}`, "PUT", { id: "sneaky" })).status).toBe(400);
  });

  it("answers 400 for a null title and a null status", async () => {
    const id = await createTrip();
    expect((await jsonRequest(`/api/trips/${id}`, "PUT", { title: null })).status).toBe(400);
    expect((await jsonRequest(`/api/trips/${id}`, "PUT", { status: null })).status).toBe(400);
  });

  it("answers 400 for a status outside the enum", async () => {
    const id = await createTrip();
    expect((await jsonRequest(`/api/trips/${id}`, "PUT", { status: "done" })).status).toBe(400);
  });

  it("answers 400 for a malformed date and an inverted range", async () => {
    const id = await createTrip();
    expect((await jsonRequest(`/api/trips/${id}`, "PUT", { startsOn: "next tuesday" })).status).toBe(400);
    expect(
      (await jsonRequest(`/api/trips/${id}`, "PUT", { startsOn: "2026-10-12", endsOn: "2026-10-09" })).status,
    ).toBe(400);
  });

  it("answers 400 for malformed JSON", async () => {
    const id = await createTrip();
    const res = await request(app, `/api/trips/${id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    expect(res.status).toBe(400);
  });

  it("answers 404 for an unknown trip", async () => {
    expect((await jsonRequest("/api/trips/t-nope", "PUT", { title: "X" })).status).toBe(404);
  });

  it("hides an unshared trip from a viewer and leaves it unchanged", async () => {
    const id = await createTrip();
    const viewerApp = appAs({ ...owner, role: "viewer" });
    const res = await request(viewerApp, `/api/trips/${id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Nope" }),
    });
    expect(res.status).toBe(404);
    const list = (await (await request(app, "/api/trips")).json()) as Trip[];
    expect(list[0]!.title).toBe("Guerneville");
  });
});

describe("trip cover photo (photoUrl)", () => {
  it("round-trips photoUrl through create and read", async () => {
    const res = await jsonRequest("/api/trips", "POST", {
      title: "Guerneville",
      photoUrl: "https://img.example/river.jpg",
    });
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as Trip;
    const read = (await (await request(app, `/api/trips/${id}`)).json()) as Trip;
    expect(read.photoUrl).toBe("https://img.example/river.jpg");
  });

  it("sets and clears photoUrl via PUT", async () => {
    const id = await createTrip();
    const set = await jsonRequest(`/api/trips/${id}`, "PUT", {
      photoUrl: "https://img.example/river.jpg",
    });
    expect(((await set.json()) as Trip).photoUrl).toBe("https://img.example/river.jpg");
    const cleared = await jsonRequest(`/api/trips/${id}`, "PUT", { photoUrl: null });
    expect(((await cleared.json()) as Trip).photoUrl).toBeNull();
  });

  it("answers 400 for a non-http(s) scheme on create and update", async () => {
    // javascript:/data: reaching an <img src> is exactly what the schema stops.
    expect(
      (await jsonRequest("/api/trips", "POST", { title: "T", photoUrl: "javascript:alert(1)" }))
        .status,
    ).toBe(400);
    const id = await createTrip();
    expect(
      (await jsonRequest(`/api/trips/${id}`, "PUT", { photoUrl: "javascript:alert(1)" })).status,
    ).toBe(400);
    expect(
      (await jsonRequest(`/api/trips/${id}`, "PUT", { photoUrl: "data:text/html,hi" })).status,
    ).toBe(400);
    expect((await jsonRequest(`/api/trips/${id}`, "PUT", { photoUrl: "not a url" })).status).toBe(
      400,
    );
  });

  it("answers 400 for a photoUrl longer than 2048 characters", async () => {
    const long = `https://img.example/${"a".repeat(2048)}`;
    expect((await jsonRequest("/api/trips", "POST", { title: "T", photoUrl: long })).status).toBe(
      400,
    );
  });
});

describe("DELETE /api/trips/:tripId", () => {
  it("answers 204 and the trip is gone from the list", async () => {
    const id = await createTrip();
    const res = await request(app, `/api/trips/${id}`, { method: "DELETE" });
    expect(res.status).toBe(204);
    expect((await (await request(app, "/api/trips")).json()) as Trip[]).toEqual([]);
  });

  it("answers 404 for an unknown trip", async () => {
    expect((await request(app, "/api/trips/t-nope", { method: "DELETE" })).status).toBe(404);
  });

  it("hides an unshared trip from a viewer and keeps it", async () => {
    const id = await createTrip();
    const viewerApp = appAs({ ...owner, role: "viewer" });
    expect((await request(viewerApp, `/api/trips/${id}`, { method: "DELETE" })).status).toBe(404);
    expect(((await (await request(app, "/api/trips")).json()) as Trip[]).length).toBe(1);
  });
});

describe("DELETE /api/trips/:tripId/people/:personId", () => {
  it("answers 204 and removes the traveller from the roster", async () => {
    const id = await createTrip();
    await request(app, `/api/trips/${id}/people/p-ava`, { method: "PUT" });
    const res = await request(app, `/api/trips/${id}/people/p-ava`, { method: "DELETE" });
    expect(res.status).toBe(204);
    expect((await (await request(app, `/api/trips/${id}/travelers`)).json()) as unknown[]).toEqual([]);
  });

  it("is idempotent: a second DELETE still answers 204", async () => {
    const id = await createTrip();
    await request(app, `/api/trips/${id}/people/p-ava`, { method: "PUT" });
    await request(app, `/api/trips/${id}/people/p-ava`, { method: "DELETE" });
    expect((await request(app, `/api/trips/${id}/people/p-ava`, { method: "DELETE" })).status).toBe(204);
  });

  it("answers 404 for a person outside the household", async () => {
    const id = await createTrip();
    expect((await request(app, `/api/trips/${id}/people/p-nope`, { method: "DELETE" })).status).toBe(404);
  });

  it("hides an unshared trip from a viewer", async () => {
    const id = await createTrip();
    await request(app, `/api/trips/${id}/people/p-ava`, { method: "PUT" });
    const viewerApp = appAs({ ...owner, role: "viewer" });
    expect((await request(viewerApp, `/api/trips/${id}/people/p-ava`, { method: "DELETE" })).status).toBe(404);
  });
});
