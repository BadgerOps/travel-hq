import { beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { createApp, type AppBindings } from "../../../src/server/index.js";
import { Keyring } from "../../../src/server/crypto/envelope.js";
import type { Identity } from "../../../src/server/auth.js";
import type { Person } from "../../../src/server/repos/person.js";
import type { Trip } from "../../../src/server/repos/trip.js";
import type { TripMember } from "../../../src/server/repos/trip-access.js";

const ring = new Keyring("server-v1", {
  "server-v1": crypto.getRandomValues(new Uint8Array(32)),
});
const owner: Identity = {
  userId: "u-owner",
  email: "sol@example.com",
  householdId: "hh-a",
  role: "owner",
};
const testEnv = { DB: env.DB } as unknown as AppBindings;

function appAs(identity: Identity) {
  return createApp({
    verify: async () => identity,
    ring,
  });
}

function request(
  app: ReturnType<typeof createApp>,
  path: string,
  init?: RequestInit,
) {
  return app.request(path, init, testEnv);
}

function json(
  app: ReturnType<typeof createApp>,
  path: string,
  method: "POST" | "PUT",
  body: unknown,
) {
  return request(app, path, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

let ownerApp: ReturnType<typeof createApp>;

beforeEach(async () => {
  for (const table of [
    "trip_member",
    "booking_person",
    "checklist_item",
    "booking",
    "trip_person",
    "person",
    "trip",
    "household_member",
    "user",
    "household",
  ]) {
    await env.DB.exec(`DELETE FROM ${table}`);
  }
  const now = new Date().toISOString();
  await env.DB.prepare(
    "INSERT INTO household (id, name, created_at) VALUES (?, ?, ?)",
  ).bind("hh-a", "Badger", now).run();
  await env.DB.prepare(
    "INSERT INTO user (id, email, created_at) VALUES (?, ?, ?)",
  ).bind(owner.userId, owner.email, now).run();
  await env.DB.prepare(
    "INSERT INTO household_member (household_id, user_id, role) VALUES (?, ?, 'owner')",
  ).bind(owner.householdId, owner.userId).run();
  ownerApp = appAs(owner);
});

async function createTrip(title: string): Promise<Trip> {
  const response = await json(ownerApp, "/api/trips", "POST", { title });
  expect(response.status).toBe(201);
  return response.json<Trip>();
}

async function invite(
  tripId: string,
  email: string,
  role: "viewer" | "editor",
): Promise<TripMember> {
  const response = await json(
    ownerApp,
    `/api/trips/${tripId}/members`,
    "POST",
    { email, role },
  );
  expect(response.status).toBe(201);
  return response.json<TripMember>();
}

function invitedIdentity(member: TripMember): Identity {
  return {
    userId: member.userId,
    email: member.email,
    householdId: owner.householdId,
    role: "viewer",
  };
}

describe("trip invitations", () => {
  it("provisions an app account and can update or remove its trip role", async () => {
    const trip = await createTrip("Glacier");
    const first = await invite(trip.id, " David@Example.com ", "viewer");
    expect(first).toMatchObject({ email: "david@example.com", role: "viewer" });

    const updated = await invite(trip.id, "david@example.com", "editor");
    expect(updated).toMatchObject({ userId: first.userId, role: "editor" });

    const members = (await (
      await request(ownerApp, `/api/trips/${trip.id}/members`)
    ).json()) as TripMember[];
    expect(members).toHaveLength(1);
    expect(members[0]).toMatchObject({ userId: first.userId, role: "editor" });

    expect(
      (
        await request(
          ownerApp,
          `/api/trips/${trip.id}/members/${first.userId}`,
          { method: "DELETE" },
        )
      ).status,
    ).toBe(204);
  });

  it("rejects malformed email addresses", async () => {
    const trip = await createTrip("Glacier");
    expect((await json(ownerApp, `/api/trips/${trip.id}/members`, "POST", {
      email: "not-an-email",
      role: "viewer",
    })).status).toBe(400);
  });

  it("reuses an existing account regardless of email casing", async () => {
    const trip = await createTrip("Glacier");
    const now = new Date().toISOString();
    await env.DB.prepare(
      "INSERT INTO user (id, email, created_at) VALUES (?, ?, ?)",
    ).bind("u-existing", "David@Example.com", now).run();

    const member = await invite(trip.id, "david@example.com", "viewer");
    expect(member.userId).toBe("u-existing");
    const users = await env.DB.prepare(
      "SELECT id FROM user WHERE lower(email) = 'david@example.com'",
    ).all<{ id: string }>();
    expect(users.results).toHaveLength(1);
  });
});

describe("server-enforced trip scope", () => {
  it("lists only shared trips and hides direct links to every other trip", async () => {
    const glacier = await createTrip("Glacier");
    const privateTrip = await createTrip("Private");
    const member = await invite(glacier.id, "david@example.com", "viewer");
    const viewerApp = appAs(invitedIdentity(member));

    const list = (await (await request(viewerApp, "/api/trips")).json()) as Trip[];
    expect(list.map((trip) => trip.id)).toEqual([glacier.id]);
    expect(list[0]?.accessRole).toBe("viewer");
    expect((await request(viewerApp, `/api/trips/${glacier.id}`)).status).toBe(200);
    expect((await request(viewerApp, `/api/trips/${privateTrip.id}`)).status).toBe(404);
  });

  it("scopes the trip-filtered checklist endpoint to shared trips", async () => {
    const shared = await createTrip("Glacier");
    const privateTrip = await createTrip("Private");
    await json(ownerApp, "/api/checklist", "POST", {
      tripId: shared.id,
      label: "Pack boots",
    });
    await json(ownerApp, "/api/checklist", "POST", {
      tripId: privateTrip.id,
      label: "Private task",
    });
    const member = await invite(shared.id, "david@example.com", "viewer");
    const viewerApp = appAs(invitedIdentity(member));

    const sharedResponse = await request(
      viewerApp,
      `/api/checklist?tripId=${encodeURIComponent(shared.id)}`,
    );
    expect(sharedResponse.status).toBe(200);
    expect(await sharedResponse.json()).toEqual([
      expect.objectContaining({ tripId: shared.id, label: "Pack boots" }),
    ]);
    expect((await request(
      viewerApp,
      `/api/checklist?tripId=${encodeURIComponent(privateTrip.id)}`,
    )).status).toBe(404);
  });

  it("lets viewers read a shared trip but not change it", async () => {
    const trip = await createTrip("Glacier");
    const member = await invite(trip.id, "david@example.com", "viewer");
    const viewerApp = appAs(invitedIdentity(member));

    expect((await request(viewerApp, `/api/trips/${trip.id}/bookings`)).status).toBe(200);
    expect((await json(viewerApp, `/api/trips/${trip.id}`, "PUT", {
      title: "Changed",
    })).status).toBe(403);
    expect((await request(viewerApp, "/api/settings")).status).toBe(403);
  });

  it("grants editors writes on the shared trip only", async () => {
    const shared = await createTrip("Glacier");
    const privateTrip = await createTrip("Private");
    const member = await invite(shared.id, "david@example.com", "editor");
    const editorApp = appAs(invitedIdentity(member));

    const changed = await json(editorApp, `/api/trips/${shared.id}`, "PUT", {
      title: "Glacier 2026",
    });
    expect(changed.status).toBe(200);
    expect(((await changed.json()) as Trip).accessRole).toBe("editor");
    expect((await json(editorApp, `/api/trips/${privateTrip.id}`, "PUT", {
      title: "Nope",
    })).status).toBe(404);
    expect((await request(editorApp, `/api/trips/${shared.id}/members`)).status).toBe(403);
  });

  it("applies trip access through booking and checklist resource URLs", async () => {
    const shared = await createTrip("Glacier");
    const privateTrip = await createTrip("Private");
    const sharedBookingResponse = await json(ownerApp, `/api/trips/${shared.id}/bookings`, "POST", {
      kind: "other",
      title: "Shared activity",
      details: {},
    });
    const sharedBooking = (await sharedBookingResponse.json()) as { id: string };
    const privateBookingResponse = await json(ownerApp, `/api/trips/${privateTrip.id}/bookings`, "POST", {
      kind: "other",
      title: "Private activity",
      details: {},
    });
    const privateBooking = (await privateBookingResponse.json()) as { id: string };
    const member = await invite(shared.id, "david@example.com", "editor");
    const editorApp = appAs(invitedIdentity(member));

    expect((await json(editorApp, `/api/bookings/${sharedBooking.id}`, "PUT", {
      title: "Updated",
    })).status).toBe(200);
    expect((await json(editorApp, `/api/bookings/${privateBooking.id}`, "PUT", {
      title: "Nope",
    })).status).toBe(404);
    expect((await json(editorApp, "/api/checklist", "POST", {
      tripId: shared.id,
      label: "Pack boots",
    })).status).toBe(201);
    expect((await json(editorApp, "/api/checklist", "POST", {
      tripId: privateTrip.id,
      label: "Leak",
    })).status).toBe(404);
  });

  it("limits the people directory to travelers on accessible trips", async () => {
    const shared = await createTrip("Glacier");
    const privateTrip = await createTrip("Private");
    const now = new Date().toISOString();
    await env.DB.prepare(
      "INSERT INTO person (id, household_id, display_name, created_at) VALUES (?, ?, ?, ?)",
    ).bind("p-shared", owner.householdId, "Shared Person", now).run();
    await env.DB.prepare(
      "INSERT INTO person (id, household_id, display_name, created_at) VALUES (?, ?, ?, ?)",
    ).bind("p-private", owner.householdId, "Private Person", now).run();
    await request(ownerApp, `/api/trips/${shared.id}/people/p-shared`, { method: "PUT" });
    await request(ownerApp, `/api/trips/${privateTrip.id}/people/p-private`, { method: "PUT" });
    const member = await invite(shared.id, "david@example.com", "viewer");
    const viewerApp = appAs(invitedIdentity(member));

    const people = (await (await request(viewerApp, "/api/people")).json()) as Person[];
    expect(people.map((person) => person.id)).toEqual(["p-shared"]);
  });

  it("does not let an editor pull a hidden traveler into a shared trip by id", async () => {
    const shared = await createTrip("Glacier");
    const privateTrip = await createTrip("Private");
    const now = new Date().toISOString();
    await env.DB.prepare(
      "INSERT INTO person (id, household_id, display_name, created_at) VALUES (?, ?, ?, ?)",
    ).bind("p-shared", owner.householdId, "Shared Person", now).run();
    await env.DB.prepare(
      "INSERT INTO person (id, household_id, display_name, created_at) VALUES (?, ?, ?, ?)",
    ).bind("p-private", owner.householdId, "Private Person", now).run();
    await request(ownerApp, `/api/trips/${shared.id}/people/p-shared`, { method: "PUT" });
    await request(ownerApp, `/api/trips/${privateTrip.id}/people/p-private`, { method: "PUT" });
    const member = await invite(shared.id, "david@example.com", "editor");
    const editorApp = appAs(invitedIdentity(member));

    expect((await request(
      editorApp,
      `/api/trips/${shared.id}/people/p-private`,
      { method: "PUT" },
    )).status).toBe(404);
    const travelers = (await (
      await request(ownerApp, `/api/trips/${shared.id}/travelers`)
    ).json()) as Person[];
    expect(travelers.map((person) => person.id)).toEqual(["p-shared"]);
  });
});
