import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { env } from "cloudflare:test";
import { Keyring } from "../../../src/server/crypto/envelope.js";
import { createApp } from "../../../src/server/index.js";
import type { AppBindings } from "../../../src/server/index.js";
import type { Identity } from "../../../src/server/auth.js";

/**
 * Issue #19: parent-child integrity on nested trip routes.
 *
 * The nested URL is a claim about a relationship ("this booking, on this
 * trip"). Two routes were not checking the claim:
 *
 *  - POST /:tripId/bookings/:bookingId/reveal read :tripId and threw it away,
 *    so ANY booking in the household could be revealed under ANY of that
 *    household's trip URLs. No cross-tenant disclosure (household scoping saw
 *    to that) -- but the audit record issue #8 now writes would have named a
 *    trip the booking was never on, which is a confidently wrong answer to
 *    "where did this happen".
 *
 *  - GET /:tripId/travelers answered `200 []` for an unknown or cross-household
 *    trip, while its siblings (/bookings, /itinerary, /rollup) answer 404 for
 *    the same input. "Empty" and "absent" are different facts.
 */

const ring = new Keyring("server-v1", { "server-v1": crypto.getRandomValues(new Uint8Array(32)) });
const owner: Identity = {
  userId: "u1",
  email: "badger@example.com",
  householdId: "hh-a",
  role: "owner",
};
const testEnv = { DB: env.DB } as unknown as AppBindings;

const revealInit: RequestInit = {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: "{}",
};

let app: ReturnType<typeof createApp>;

function request(path: string, init?: RequestInit) {
  return app.request(path, init, testEnv);
}
function postJson(path: string, body: unknown) {
  return request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
async function createTrip(title: string): Promise<string> {
  return ((await (await postJson("/api/trips", { title })).json()) as { id: string }).id;
}
async function auditRows(): Promise<{ subject_id: string; trip_id: string | null }[]> {
  const { results } = await env.DB.prepare(
    "SELECT subject_id, trip_id FROM audit_log ORDER BY at, id",
  ).all<{ subject_id: string; trip_id: string | null }>();
  return results;
}

beforeEach(async () => {
  await env.DB.exec("DELETE FROM household");
  const now = new Date().toISOString();
  await env.DB.prepare("INSERT INTO household (id, name, created_at) VALUES (?, ?, ?)")
    .bind("hh-a", "Badger", now)
    .run();
  await env.DB.prepare("INSERT INTO household (id, name, created_at) VALUES (?, ?, ?)")
    .bind("hh-b", "Other", now)
    .run();
  app = createApp({ verify: async () => owner, ring });
  // Keep the structured request log out of the test output; several cases
  // below also assert on what was (not) logged.
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("POST /api/trips/:tripId/bookings/:bookingId/reveal requires the booking to be on that trip", () => {
  async function bookingOnItsOwnTrip() {
    const tripId = await createTrip("Guerneville");
    const otherTripId = await createTrip("Tahoe");
    const bookingId = (
      (await (
        await postJson(`/api/trips/${tripId}/bookings`, {
          kind: "other",
          title: "Rehearsal dinner",
          confirmationNumber: "ABCDX4T2",
          details: {},
        })
      ).json()) as { id: string }
    ).id;
    return { tripId, otherTripId, bookingId };
  }

  it("reveals under the booking's own trip", async () => {
    const { tripId, bookingId } = await bookingOnItsOwnTrip();
    const res = await request(`/api/trips/${tripId}/bookings/${bookingId}/reveal`, revealInit);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ value: "ABCDX4T2" });
  });

  it("404s under ANOTHER trip in the SAME household -- the wrong-parent case", async () => {
    const { otherTripId, bookingId } = await bookingOnItsOwnTrip();
    const res = await request(`/api/trips/${otherTripId}/bookings/${bookingId}/reveal`, revealInit);
    expect(res.status).toBe(404);
    // Same answer as a booking that genuinely does not exist: the response
    // discloses nothing about which trips the booking is actually on.
    expect(await res.json()).toEqual({ error: "Not found" });
  });

  it("writes no audit record for a wrong-parent attempt", async () => {
    const { otherTripId, bookingId } = await bookingOnItsOwnTrip();
    await request(`/api/trips/${otherTripId}/bookings/${bookingId}/reveal`, revealInit);
    // A reveal that was refused is not a reveal. The log must never claim one.
    expect(await auditRows()).toEqual([]);
  });

  it("records the VALIDATED trip id on the audit entry of a successful reveal", async () => {
    const { tripId, bookingId } = await bookingOnItsOwnTrip();
    await request(`/api/trips/${tripId}/bookings/${bookingId}/reveal`, revealInit);
    expect(await auditRows()).toEqual([{ subject_id: bookingId, trip_id: tripId }]);
  });

  it("still 404s for a booking that does not exist at all", async () => {
    const tripId = await createTrip("Guerneville");
    expect(
      (await request(`/api/trips/${tripId}/bookings/does-not-exist/reveal`, revealInit)).status,
    ).toBe(404);
  });
});

describe("GET /api/trips/:tripId/travelers existence-checks its parent", () => {
  it("404s for an unknown trip instead of answering 200 []", async () => {
    const res = await request("/api/trips/t-does-not-exist/travelers");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Not found" });
  });

  it("404s for a trip in ANOTHER household", async () => {
    await env.DB.prepare("INSERT INTO trip (id, household_id, title, created_at) VALUES (?, ?, ?, ?)")
      .bind("t-foreign", "hh-b", "Not yours", new Date().toISOString())
      .run();
    expect((await request("/api/trips/t-foreign/travelers")).status).toBe(404);
  });

  it("answers 200 [] for a real trip with nobody on it -- the fact it can now express", async () => {
    const tripId = await createTrip("Guerneville");
    const res = await request(`/api/trips/${tripId}/travelers`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it("agrees with its sibling routes, which already 404'd for the same input", async () => {
    const statuses = await Promise.all(
      ["travelers", "bookings", "rollup", "itinerary"].map(async (leaf) =>
        (await request(`/api/trips/t-does-not-exist/${leaf}`)).status,
      ),
    );
    expect(statuses).toEqual([404, 404, 404, 404]);
  });
});
