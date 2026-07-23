import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { Keyring } from "../../../src/server/crypto/envelope.js";
import { createApp } from "../../../src/server/index.js";
import type { AppBindings } from "../../../src/server/index.js";
import { AuthError } from "../../../src/server/auth.js";
import type { Identity } from "../../../src/server/auth.js";

const ring = new Keyring("server-v1", { "server-v1": crypto.getRandomValues(new Uint8Array(32)) });
const identity: Identity = { userId: "u1", email: "badger@example.com", householdId: "hh-a", role: "owner" };
const testEnv = { DB: env.DB } as unknown as AppBindings;

function appAs(who: Identity | (() => Promise<never>)) {
  const verify = typeof who === "function" ? who : async () => who;
  return createApp({ verify: verify as (req: Request, e: AppBindings) => Promise<Identity>, ring });
}

let app: ReturnType<typeof createApp>;

function request(a: ReturnType<typeof createApp>, path: string, init?: RequestInit) {
  return a.request(path, init, testEnv);
}
function postJson(path: string, body: unknown) {
  return request(app, path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}
const revealInit: RequestInit = {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: "{}",
};

beforeEach(async () => {
  await env.DB.exec("DELETE FROM booking_person");
  await env.DB.exec("DELETE FROM booking");
  await env.DB.exec("DELETE FROM trip_person");
  await env.DB.exec("DELETE FROM checklist_item");
  await env.DB.exec("DELETE FROM person");
  await env.DB.exec("DELETE FROM trip");
  await env.DB.exec("DELETE FROM household");
  await env.DB.prepare("INSERT INTO household (id, name, created_at) VALUES (?, ?, ?)").bind("hh-a", "Badger", new Date().toISOString()).run();
  await env.DB.prepare("INSERT INTO household (id, name, created_at) VALUES (?, ?, ?)").bind("hh-b", "Other", new Date().toISOString()).run();
  app = appAs(identity);
});

describe("API", () => {
  it("creates and lists people with masked documents", async () => {
    expect((await postJson("/api/people", { displayName: "Ava", passportNumber: "C03X72119" })).status).toBe(201);
    const body = (await (await request(app, "/api/people")).json()) as { passportNumberMasked: string }[];
    expect(body[0]?.passportNumberMasked).toBe("••••2119");
    expect(JSON.stringify(body)).not.toContain("C03X72119");
  });

  it("rejects an invalid person payload", async () => {
    expect((await postJson("/api/people", { dob: "2018-04-02" })).status).toBe(400);
  });

  it("returns a per-person itinerary", async () => {
    const person = (await (await postJson("/api/people", { displayName: "Ava" })).json()) as { id: string };
    const trip = (await (await postJson("/api/trips", { title: "Guerneville" })).json()) as { id: string };
    const booking = (await (await postJson(`/api/trips/${trip.id}/bookings`, {
      kind: "other", title: "Rehearsal dinner", startsAt: "2026-10-10T02:00:00Z", startsAtTz: "America/Los_Angeles", details: {},
    })).json()) as { id: string };
    expect((await request(app, `/api/bookings/${booking.id}/people/${person.id}`, { method: "PUT" })).status).toBe(204);
    const days = (await (await request(app, `/api/trips/${trip.id}/itinerary?personId=${person.id}`)).json()) as { date: string }[];
    expect(days).toHaveLength(1);
    expect(days[0]?.date).toBe("2026-10-09");
  });

  it("returns 401 when authentication fails", async () => {
    const unauthed = appAs(async () => { throw new AuthError("nope"); });
    expect((await request(unauthed, "/api/people")).status).toBe(401);
  });

  it("returns 403 when a viewer attempts a write", async () => {
    const viewerApp = appAs({ ...identity, role: "viewer" });
    const res = await request(viewerApp, "/api/trips", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "Nope" }) });
    expect(res.status).toBe(403);
  });

  it("returns 404 for a resource outside the caller's household", async () => {
    const trip = (await (await postJson("/api/trips", { title: "Trip" })).json()) as { id: string };
    const res = await request(app, `/api/trips/${trip.id}/people/does-not-exist`, { method: "PUT" });
    expect(res.status).toBe(404);
  });

  it("returns 400 for a malformed request body", async () => {
    expect((await postJson("/api/trips", { title: "" })).status).toBe(400);
  });

  it("reveals a document only on the explicit endpoint", async () => {
    const person = (await (await postJson("/api/people", { displayName: "Ava", passportNumber: "C03X72119" })).json()) as { id: string };
    const res = await request(app, `/api/people/${person.id}/reveal/passport_number`, revealInit);
    expect(await res.json()).toEqual({ value: "C03X72119" });
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect((await request(app, `/api/people/${person.id}/reveal/passport_number`)).status).toBe(404);
  });

  it("rejects a simple form-style POST to a reveal endpoint", async () => {
    const person = (await (
      await postJson("/api/people", {
        displayName: "Ava",
        passportNumber: "C03X72119",
      })
    ).json()) as { id: string };
    const res = await request(app, `/api/people/${person.id}/reveal/passport_number`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "reveal=1",
    });
    expect(res.status).toBe(415);
  });

  it("rejects revealing a field that is not a document", async () => {
    expect(
      (
        await request(app, "/api/people/whatever/reveal/display_name", {
          ...revealInit,
        })
      ).status,
    ).toBe(400);
  });

  it("rejects a booking with an unpaired timezone", async () => {
    const trip = (await (await postJson("/api/trips", { title: "Trip" })).json()) as { id: string };
    const res = await postJson(`/api/trips/${trip.id}/bookings`, { kind: "other", title: "No tz", startsAt: "2026-10-10T02:00:00Z", details: {} });
    expect(res.status).toBe(400);
  });

  it("masks booking confirmations in lists and reveals them on request", async () => {
    const trip = (await (await postJson("/api/trips", { title: "Trip" })).json()) as { id: string };
    const booking = (await (await postJson(`/api/trips/${trip.id}/bookings`, { kind: "other", title: "Hotel", confirmationNumber: "ABCDX4T2", details: {} })).json()) as { id: string };
    const listed = await (await request(app, `/api/trips/${trip.id}/bookings`)).json();
    expect(JSON.stringify(listed)).not.toContain("ABCDX4T2");
    expect(JSON.stringify(listed)).toContain("••••X4T2");
    const revealResponse = await request(
      app,
      `/api/trips/${trip.id}/bookings/${booking.id}/reveal`,
      revealInit,
    );
    const revealed = await revealResponse.json();
    expect(revealed).toEqual({ value: "ABCDX4T2" });
    expect(revealResponse.headers.get("cache-control")).toBe("no-store");
    expect(
      (await request(app, `/api/trips/${trip.id}/bookings/${booking.id}/reveal`)).status,
    ).toBe(404);
  });

  it("marks every API response, including errors, as non-cacheable", async () => {
    const ok = await request(app, "/api/me");
    expect(ok.headers.get("cache-control")).toBe("no-store");

    const missing = await request(app, "/api/trips/does-not-exist/bookings");
    expect(missing.status).toBe(404);
    expect(missing.headers.get("cache-control")).toBe("no-store");
  });

  describe("C1: booking timestamp/timezone validation", () => {
    it("rejects an unparseable startsAt with 400", async () => {
      const trip = (await (await postJson("/api/trips", { title: "Trip" })).json()) as { id: string };
      const res = await postJson(`/api/trips/${trip.id}/bookings`, { kind: "other", title: "Bad ts", startsAt: "garbage", startsAtTz: "America/Boise", details: {} });
      expect(res.status).toBe(400);
    });
    it("rejects an unrecognized startsAtTz with 400", async () => {
      const trip = (await (await postJson("/api/trips", { title: "Trip" })).json()) as { id: string };
      const res = await postJson(`/api/trips/${trip.id}/bookings`, { kind: "other", title: "Bad tz", startsAt: "2026-10-10T02:00:00Z", startsAtTz: "Not/AZone", details: {} });
      expect(res.status).toBe(400);
    });
  });

  it("rejects a booking with an unrecognized kind", async () => {
    const trip = (await (await postJson("/api/trips", { title: "Trip" })).json()) as { id: string };
    const res = await postJson(`/api/trips/${trip.id}/bookings`, { kind: "banana", title: "Bad kind", details: {} });
    expect(res.status).toBe(400);
  });

  describe("I2: every route's errors are JSON-mapped", () => {
    it("GET /api/trips/:tripId/bookings for an unknown trip is a JSON 404", async () => {
      const res = await request(app, "/api/trips/does-not-exist/bookings");
      expect(res.status).toBe(404);
      expect(res.headers.get("content-type")).toContain("application/json");
      expect(await res.json()).toEqual({ error: "Not found" });
    });
    it("POST /api/people/:id/reveal/:field for an unknown person is a JSON 404", async () => {
      const res = await request(app, "/api/people/does-not-exist/reveal/passport_number", {
        ...revealInit,
      });
      expect(res.status).toBe(404);
      expect(res.headers.get("content-type")).toContain("application/json");
      expect(await res.json()).toEqual({ error: "Not found" });
    });
  });

  describe("I3: reveal endpoints reject a viewer", () => {
    it("rejects a viewer revealing a document with 403", async () => {
      const person = (await (await postJson("/api/people", { displayName: "Ava", passportNumber: "C03X72119" })).json()) as { id: string };
      const viewerApp = appAs({ ...identity, role: "viewer" });
      expect(
        (
          await request(viewerApp, `/api/people/${person.id}/reveal/passport_number`, {
            ...revealInit,
          })
        ).status,
      ).toBe(403);
    });
    it("rejects a viewer revealing a booking confirmation with 403", async () => {
      const trip = (await (await postJson("/api/trips", { title: "Trip" })).json()) as { id: string };
      const booking = (await (await postJson(`/api/trips/${trip.id}/bookings`, { kind: "other", title: "Hotel", confirmationNumber: "ABCDX4T2", details: {} })).json()) as { id: string };
      const viewerApp = appAs({ ...identity, role: "viewer" });
      expect(
        (
          await request(viewerApp, `/api/trips/${trip.id}/bookings/${booking.id}/reveal`, {
            ...revealInit,
          })
        ).status,
      ).toBe(403);
    });
  });

  describe("I5: reveal and list distinguish missing from empty", () => {
    it("404s revealing a document for a person that does not exist", async () => {
      expect(
        (
          await request(app, "/api/people/does-not-exist/reveal/passport_number", {
            ...revealInit,
          })
        ).status,
      ).toBe(404);
    });
    it("404s revealing a confirmation for a booking that does not exist", async () => {
      const trip = (await (await postJson("/api/trips", { title: "Trip" })).json()) as { id: string };
      expect(
        (
          await request(app, `/api/trips/${trip.id}/bookings/does-not-exist/reveal`, {
            ...revealInit,
          })
        ).status,
      ).toBe(404);
    });
    it("404s listing bookings for a trip that does not exist", async () => {
      expect((await request(app, "/api/trips/does-not-exist/bookings")).status).toBe(404);
    });
  });

  it("returns the caller's identity from /api/me", async () => {
    const body = (await (await request(app, "/api/me")).json()) as typeof identity;
    expect(body).toEqual({ userId: "u1", email: "badger@example.com", householdId: "hh-a", role: "owner" });
  });

  describe("GET /api/trips/:tripId/rollup", () => {
    it("wires bookings and drafts through to the rollup", async () => {
      const trip = (await (await postJson("/api/trips", { title: "Trip" })).json()) as { id: string };
      await postJson(`/api/trips/${trip.id}/bookings`, { kind: "other", title: "Booked", costCents: 20000, status: "booked", details: {} });
      await postJson(`/api/trips/${trip.id}/bookings`, { kind: "other", title: "Draft", costCents: 50000, status: "draft", details: {} });
      const res = await request(app, `/api/trips/${trip.id}/rollup`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { totalCents: number; draftCount: number };
      expect(body.totalCents).toBe(20000);
      expect(body.draftCount).toBe(1);
    });
    it("404s for a trip that does not exist", async () => {
      const res = await request(app, "/api/trips/does-not-exist/rollup");
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "Not found" });
    });
    it("404s for a trip belonging to another household", async () => {
      const trip = (await (await postJson("/api/trips", { title: "Trip" })).json()) as { id: string };
      const otherApp = appAs({ ...identity, householdId: "hh-b" });
      expect((await request(otherApp, `/api/trips/${trip.id}/rollup`)).status).toBe(404);
    });
  });

  describe("/api/checklist", () => {
    it("wires creation and cross-trip listing", async () => {
      const trip = (await (await postJson("/api/trips", { title: "Trip" })).json()) as { id: string };
      const createRes = await postJson("/api/checklist", { tripId: trip.id, label: "Pack passports" });
      expect(createRes.status).toBe(201);
      const created = (await createRes.json()) as { id: string; label: string };
      expect(created.label).toBe("Pack passports");
      const listed = (await (await request(app, "/api/checklist")).json()) as { id: string }[];
      expect(listed.map((i) => i.id)).toContain(created.id);
    });
    it("rejects a malformed JSON body on create with 400", async () => {
      const res = await request(app, "/api/checklist", { method: "POST", headers: { "content-type": "application/json" }, body: "{ not json" });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: expect.any(String) });
    });
    it("rejects a checklist item for a trip that does not exist with 404", async () => {
      expect((await postJson("/api/checklist", { tripId: "does-not-exist", label: "Pack passports" })).status).toBe(404);
    });
    it("rejects a viewer creating a checklist item with 403", async () => {
      const trip = (await (await postJson("/api/trips", { title: "Trip" })).json()) as { id: string };
      const viewerApp = appAs({ ...identity, role: "viewer" });
      const res = await request(viewerApp, "/api/checklist", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tripId: trip.id, label: "Pack passports" }) });
      expect(res.status).toBe(403);
    });
    it("rejects an invalid create payload with 400", async () => {
      expect((await postJson("/api/checklist", { tripId: "t1" })).status).toBe(400);
    });
    it("wires setDone through to the item", async () => {
      const trip = (await (await postJson("/api/trips", { title: "Trip" })).json()) as { id: string };
      const created = (await (await postJson("/api/checklist", { tripId: trip.id, label: "Pack passports" })).json()) as { id: string };
      const res = await request(app, `/api/checklist/${created.id}/done`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ done: true }) });
      expect(res.status).toBe(204);
      const listed = (await (await request(app, "/api/checklist")).json()) as { id: string; doneAt: string | null }[];
      expect(listed.find((i) => i.id === created.id)?.doneAt).not.toBeNull();
    });
    it("rejects a malformed JSON body on setDone with 400", async () => {
      const res = await request(app, "/api/checklist/whatever/done", { method: "PUT", headers: { "content-type": "application/json" }, body: "{ not json" });
      expect(res.status).toBe(400);
    });
    it("rejects a setDone body that is not { done: boolean } with 400", async () => {
      const res = await request(app, "/api/checklist/whatever/done", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ done: "yes" }) });
      expect(res.status).toBe(400);
    });
    it("404s setDone for an item that does not exist", async () => {
      const res = await request(app, "/api/checklist/does-not-exist/done", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ done: true }) });
      expect(res.status).toBe(404);
    });
    it("rejects a viewer toggling a checklist item with 403", async () => {
      const trip = (await (await postJson("/api/trips", { title: "Trip" })).json()) as { id: string };
      const created = (await (await postJson("/api/checklist", { tripId: trip.id, label: "Pack passports" })).json()) as { id: string };
      const viewerApp = appAs({ ...identity, role: "viewer" });
      const res = await request(viewerApp, `/api/checklist/${created.id}/done`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ done: true }) });
      expect(res.status).toBe(403);
    });
  });

  it("lists a trip's travelers with documents still masked", async () => {
    const person = (await (await postJson("/api/people", { displayName: "Ava", passportNumber: "C03X72119" })).json()) as { id: string };
    const trip = (await (await postJson("/api/trips", { title: "Guerneville" })).json()) as { id: string };
    expect((await request(app, `/api/trips/${trip.id}/people/${person.id}`, { method: "PUT" })).status).toBe(204);
    const res = await request(app, `/api/trips/${trip.id}/travelers`);
    const body = (await res.json()) as { id: string; displayName: string }[];
    expect(body.map((p) => p.displayName)).toEqual(["Ava"]);
    expect(JSON.stringify(body)).not.toContain("C03X72119");
  });

  describe("F2: a raw D1 error never leaks table/column names over HTTP", () => {
    // Simulates a raw D1/SQLite failure -- exactly the shape a botched
    // migration or a schema drift produces (e.g. a missing column on a
    // renamed table). Such a throwable is NOT a RepoError subclass, so it
    // must fall through mapError()'s final branch: a generic 500 that
    // echoes nothing about the underlying query, table, or column. This is
    // a security property (F2 from the adversarial review), not incidental
    // behavior -- forwarding err.message here would leak schema internals
    // to any authenticated caller who can trigger a repo error, and to an
    // attacker probing for exactly that.
    it("returns a generic 500 with no schema detail when a repo call throws a raw D1 error", async () => {
      const rawError = new Error(
        "D1_ERROR: table trip_person has no column named household_id: SQLITE_ERROR",
      );
      const brokenStatement = {
        bind: () => brokenStatement,
        first: async () => {
          throw rawError;
        },
        all: async () => {
          throw rawError;
        },
        run: async () => {
          throw rawError;
        },
      };
      const brokenDb = { prepare: () => brokenStatement } as unknown as D1Database;
      const brokenEnv = { DB: brokenDb } as unknown as AppBindings;

      const res = await app.request("/api/people", undefined, brokenEnv);
      expect(res.status).toBe(500);

      const text = await res.text();
      expect(JSON.parse(text)).toEqual({ error: "Internal error" });
      expect(text).not.toContain("household_id");
      expect(text).not.toContain("trip_person");
      expect(text).not.toMatch(/sqlite_error/i);
      expect(text).not.toMatch(/no such column|no column named/i);
    });
  });
});
