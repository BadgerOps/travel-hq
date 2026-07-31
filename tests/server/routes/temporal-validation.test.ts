import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { Keyring } from "../../../src/server/crypto/envelope.js";
import { createApp } from "../../../src/server/index.js";
import type { AppBindings } from "../../../src/server/index.js";
import type { Identity } from "../../../src/server/auth.js";

/**
 * Issue #23, at the HTTP boundary. The repository is the enforcement point
 * (see tests/server/repos/temporal-validation.test.ts); these assertions exist
 * because a bad date should come back as a 400 naming the field, and because a
 * route schema that silently drifts from its repository is how the create and
 * update paths disagreed in the first place.
 *
 * Every rejection below must be 400 specifically -- not 500. A ValidationError
 * that escaped mapError, or a Zod refinement that threw rather than failing,
 * would show up here as a 500 and nowhere else.
 */

const ring = new Keyring("server-v1", { "server-v1": crypto.getRandomValues(new Uint8Array(32)) });
const owner: Identity = {
  userId: "u1",
  email: "badger@example.com",
  householdId: "hh-a",
  role: "owner",
};
const testEnv = { DB: env.DB } as unknown as AppBindings;

let app: ReturnType<typeof createApp>;

function send(path: string, method: string, body: unknown) {
  return app.request(
    path,
    { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
    testEnv,
  );
}

async function createTrip(body: Record<string, unknown> = {}): Promise<string> {
  const res = await send("/api/trips", "POST", { title: "Glacier", ...body });
  expect(res.status).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

/** The minimum a booking needs, so each case states only what it is about. */
function booking(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { kind: "activity", title: "Red Bus tour", details: {}, ...over };
}

beforeEach(async () => {
  for (const table of [
    "booking_person",
    "checklist_item",
    "booking",
    "trip_person",
    "person",
    "trip",
    "household",
  ]) {
    await env.DB.exec(`DELETE FROM ${table}`);
  }
  const now = new Date().toISOString();
  await env.DB.prepare("INSERT INTO household (id, name, created_at) VALUES (?, ?, ?)")
    .bind("hh-a", "Badger", now)
    .run();
  app = createApp({
    verify: (async () => owner) as (req: Request, e: AppBindings) => Promise<Identity>,
    ring,
  });
});

describe("POST /api/trips", () => {
  it("creates a trip with a well-formed range", async () => {
    const res = await send("/api/trips", "POST", {
      title: "Glacier",
      startsOn: "2026-10-09",
      endsOn: "2026-10-11",
    });
    expect(res.status).toBe(201);
  });

  it("400s on an impossible or free-text date, which used to be stored as sent", async () => {
    for (const startsOn of ["2026-02-30", "10/09/2026", "next tuesday"]) {
      const res = await send("/api/trips", "POST", { title: "Glacier", startsOn });
      expect(res.status, startsOn).toBe(400);
    }
  });

  it("400s on an inverted range", async () => {
    const res = await send("/api/trips", "POST", {
      title: "Glacier",
      startsOn: "2026-10-11",
      endsOn: "2026-10-09",
    });
    expect(res.status).toBe(400);
  });
});

describe("PUT /api/trips/:tripId", () => {
  it("400s on a malformed date", async () => {
    const id = await createTrip();
    expect((await send(`/api/trips/${id}`, "PUT", { startsOn: "2026-02-30" })).status).toBe(400);
  });

  it("400s when the patch inverts the range against the stored half", async () => {
    const id = await createTrip({ startsOn: "2026-10-09", endsOn: "2026-10-11" });
    expect((await send(`/api/trips/${id}`, "PUT", { endsOn: "2026-10-08" })).status).toBe(400);
  });

  it("still clears a range with null", async () => {
    const id = await createTrip({ startsOn: "2026-10-09", endsOn: "2026-10-11" });
    const res = await send(`/api/trips/${id}`, "PUT", { startsOn: null, endsOn: null });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ startsOn: null, endsOn: null });
  });
});

describe("POST /api/checklist", () => {
  it("400s on a malformed due date and accepts a well-formed one", async () => {
    const tripId = await createTrip();
    expect(
      (await send("/api/checklist", "POST", { tripId, label: "Pack", dueOn: "2026-02-30" })).status,
    ).toBe(400);
    expect(
      (await send("/api/checklist", "POST", { tripId, label: "Pack", dueOn: "next tuesday" }))
        .status,
    ).toBe(400);
    expect(
      (await send("/api/checklist", "POST", { tripId, label: "Pack", dueOn: "2026-10-01" })).status,
    ).toBe(201);
  });
});

describe("/api/people", () => {
  it("400s on a malformed DOB or passport expiry, on create and update", async () => {
    expect(
      (await send("/api/people", "POST", { displayName: "Ava", dob: "2018-02-30" })).status,
    ).toBe(400);
    expect(
      (await send("/api/people", "POST", { displayName: "Ava", passportExpiry: "sometime 2031" }))
        .status,
    ).toBe(400);

    const created = await send("/api/people", "POST", { displayName: "Ava", dob: "2018-04-02" });
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: string };
    expect((await send(`/api/people/${id}`, "PUT", { dob: "04/02/2018" })).status).toBe(400);
    expect((await send(`/api/people/${id}`, "PUT", { passportExpiry: "2031-13-01" })).status).toBe(
      400,
    );
    expect((await send(`/api/people/${id}`, "PUT", { dob: null })).status).toBe(200);
  });
});

describe("POST /api/trips/:tripId/bookings", () => {
  it("400s on an ambiguous instant", async () => {
    const tripId = await createTrip();
    for (const startsAt of ["2026-10-09T19:30:00", "2026-10-09Z", "2026-02-30T19:30:00Z"]) {
      const res = await send(
        `/api/trips/${tripId}/bookings`,
        "POST",
        booking({ startsAt, startsAtTz: "America/Denver" }),
      );
      expect(res.status, startsAt).toBe(400);
    }
  });

  it("400s on a booking that ends before it starts", async () => {
    const tripId = await createTrip();
    const res = await send(
      `/api/trips/${tripId}/bookings`,
      "POST",
      booking({
        startsAt: "2026-10-09T19:30:00.000Z",
        startsAtTz: "America/Denver",
        endsAt: "2026-10-09T18:30:00.000Z",
        endsAtTz: "America/Denver",
      }),
    );
    expect(res.status).toBe(400);
  });

  it("400s on a negative cost or points total", async () => {
    const tripId = await createTrip();
    expect(
      (await send(`/api/trips/${tripId}/bookings`, "POST", booking({ costCents: -1 }))).status,
    ).toBe(400);
    expect(
      (await send(`/api/trips/${tripId}/bookings`, "POST", booking({ pointsUsed: -25000 }))).status,
    ).toBe(400);
    expect(
      (await send(`/api/trips/${tripId}/bookings`, "POST", booking({ costCents: 0 }))).status,
    ).toBe(201);
  });
});

describe("PUT /api/bookings/:bookingId", () => {
  async function seedBooking(): Promise<string> {
    const tripId = await createTrip();
    const res = await send(
      `/api/trips/${tripId}/bookings`,
      "POST",
      booking({
        startsAt: "2026-10-09T19:30:00.000Z",
        startsAtTz: "America/Denver",
        endsAt: "2026-10-09T23:30:00.000Z",
        endsAtTz: "America/Denver",
      }),
    );
    expect(res.status).toBe(201);
    return ((await res.json()) as { id: string }).id;
  }

  it("400s on an ambiguous instant", async () => {
    const id = await seedBooking();
    expect((await send(`/api/bookings/${id}`, "PUT", { startsAt: "2026-10-09T19:30:00" })).status)
      .toBe(400);
    expect((await send(`/api/bookings/${id}`, "PUT", { endsAt: "2026-02-30T19:30:00Z" })).status)
      .toBe(400);
  });

  it("400s when the patch inverts the range against the stored half", async () => {
    const id = await seedBooking();
    const res = await send(`/api/bookings/${id}`, "PUT", {
      endsAt: "2026-10-09T18:00:00.000Z",
    });
    expect(res.status).toBe(400);
  });

  it("400s on a negative amount but still clears one with null", async () => {
    const id = await seedBooking();
    expect((await send(`/api/bookings/${id}`, "PUT", { costCents: -500 })).status).toBe(400);
    expect((await send(`/api/bookings/${id}`, "PUT", { pointsUsed: -1 })).status).toBe(400);
    expect((await send(`/api/bookings/${id}`, "PUT", { costCents: null })).status).toBe(200);
  });
});
