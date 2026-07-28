import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { Keyring } from "../../../src/server/crypto/envelope.js";
import { createApp } from "../../../src/server/index.js";
import type { AppBindings } from "../../../src/server/index.js";
import type { Identity } from "../../../src/server/auth.js";
import type { Booking } from "../../../src/server/repos/booking.js";

const ring = new Keyring("server-v1", { "server-v1": crypto.getRandomValues(new Uint8Array(32)) });
const owner: Identity = {
  userId: "u1",
  email: "badger@example.com",
  householdId: "hh-a",
  role: "owner",
};
const testEnv = { DB: env.DB } as unknown as AppBindings;

function appAs(who: Identity) {
  return createApp({
    verify: (async () => who) as (req: Request, e: AppBindings) => Promise<Identity>,
    ring,
  });
}

let app: ReturnType<typeof createApp>;

function send(a: ReturnType<typeof createApp>, path: string, method: string, body: unknown) {
  return a.request(
    path,
    { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
    testEnv,
  );
}

function jsonRequest(path: string, method: string, body: unknown) {
  return send(app, path, method, body);
}

/** The Red Bus excursion, imported with only half its logistics. */
async function excursion(): Promise<Booking> {
  const trip = (await (
    await jsonRequest("/api/trips", "POST", { title: "Glacier" })
  ).json()) as { id: string };
  return (await (
    await jsonRequest(`/api/trips/${trip.id}/bookings`, "POST", {
      kind: "activity",
      title: "Going-to-the-Sun Road Red Bus tour",
      startsAt: "2026-10-09T19:30:00.000Z",
      startsAtTz: "America/Denver",
      details: { venue: "Glacier Red Bus Tours" },
    })
  ).json()) as Booking;
}

beforeEach(async () => {
  await env.DB.exec("DELETE FROM booking");
  await env.DB.exec("DELETE FROM trip");
  await env.DB.exec("DELETE FROM household");
  const now = new Date().toISOString();
  for (const id of ["hh-a", "hh-b"]) {
    await env.DB.prepare("INSERT INTO household (id, name, created_at) VALUES (?, ?, ?)")
      .bind(id, id, now)
      .run();
  }
  app = appAs(owner);
});

describe("PUT /api/bookings/:bookingId", () => {
  it("adds the pickup time and location an import missed", async () => {
    const booking = await excursion();
    const res = await jsonRequest(`/api/bookings/${booking.id}`, "PUT", {
      location: "West Glacier, MT",
      details: {
        venue: "Glacier Red Bus Tours",
        pickupTime: "1:30 PM",
        pickupLocation: "Quarter Circle/West Side Parking Lot",
        arriveMinutesBefore: 15,
        returnTime: "5:00 PM",
      },
    });

    expect(res.status).toBe(200);
    const updated = (await res.json()) as Booking;
    expect(updated.location).toBe("West Glacier, MT");
    expect(updated.details).toMatchObject({
      pickupTime: "1:30 PM",
      pickupLocation: "Quarter Circle/West Side Parking Lot",
      arriveMinutesBefore: 15,
      returnTime: "5:00 PM",
    });
    // And it is what the trip's booking list now serves.
    const list = (await (
      await app.request(`/api/trips/${booking.tripId}/bookings`, undefined, testEnv)
    ).json()) as Booking[];
    expect(list[0]?.location).toBe("West Glacier, MT");
  });

  it("moves an excursion in time, both endpoints with their zones", async () => {
    const booking = await excursion();
    const updated = (await (
      await jsonRequest(`/api/bookings/${booking.id}`, "PUT", {
        startsAt: "2026-10-09T20:30:00.000Z",
        startsAtTz: "America/Denver",
        endsAt: "2026-10-09T23:00:00.000Z",
        endsAtTz: "America/Denver",
      })
    ).json()) as Booking;
    expect(updated.startsAt).toBe("2026-10-09T20:30:00.000Z");
    expect(updated.endsAt).toBe("2026-10-09T23:00:00.000Z");
    expect(updated.endsAtTz).toBe("America/Denver");
  });

  it("answers 400 when a patch would leave a timestamp without its zone", async () => {
    const booking = await excursion();
    const res = await jsonRequest(`/api/bookings/${booking.id}`, "PUT", { startsAtTz: null });
    expect(res.status).toBe(400);
  });

  it("answers 400 for an unknown key rather than silently dropping it", async () => {
    // A form that PUTs back the object it was shown would send `id` and
    // `confirmationNumberMasked`; a permissive schema would drop both and
    // leave the operator believing the edit landed.
    const booking = await excursion();
    const res = await jsonRequest(`/api/bookings/${booking.id}`, "PUT", {
      id: booking.id,
      title: "Red Bus tour",
    });
    expect(res.status).toBe(400);
  });

  it("answers 400 for a masked confirmation number echoed back", async () => {
    const booking = await excursion();
    await jsonRequest(`/api/bookings/${booking.id}`, "PUT", { confirmationNumber: "REDBUS88" });
    const res = await jsonRequest(`/api/bookings/${booking.id}`, "PUT", {
      confirmationNumber: "••••US88",
    });
    expect(res.status).toBe(400);
    const reveal = (await (
      await jsonRequest(`/api/trips/${booking.tripId}/bookings/${booking.id}/reveal`, "POST", {})
    ).json()) as { value: string | null };
    expect(reveal.value).toBe("REDBUS88");
  });

  it("answers 400 for details that do not match the kind", async () => {
    const booking = await excursion();
    const res = await jsonRequest(`/api/bookings/${booking.id}`, "PUT", {
      kind: "flight",
      details: { carrier: "Alaska" },
    });
    expect(res.status).toBe(400);
  });

  it("answers 400 for a malformed body", async () => {
    const booking = await excursion();
    const res = await app.request(
      `/api/bookings/${booking.id}`,
      { method: "PUT", headers: { "content-type": "application/json" }, body: "{" },
      testEnv,
    );
    expect(res.status).toBe(400);
  });

  it("answers 404 for an unknown booking and for another household's", async () => {
    const booking = await excursion();
    expect((await jsonRequest("/api/bookings/b-nope", "PUT", { title: "x" })).status).toBe(404);
    const other = appAs({ ...owner, householdId: "hh-b" });
    expect((await send(other, `/api/bookings/${booking.id}`, "PUT", { title: "x" })).status).toBe(404);
  });

  it("answers 403 for a viewer", async () => {
    const booking = await excursion();
    const viewer = appAs({ ...owner, role: "viewer" });
    expect((await send(viewer, `/api/bookings/${booking.id}`, "PUT", { title: "x" })).status).toBe(403);
  });
});
