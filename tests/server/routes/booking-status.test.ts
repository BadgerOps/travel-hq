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
function request(a: ReturnType<typeof createApp>, path: string, init?: RequestInit) {
  return a.request(path, init, testEnv);
}
function jsonRequest(path: string, method: string, body: unknown) {
  return request(app, path, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}
async function makeBooking(status: string): Promise<{ tripId: string; bookingId: string }> {
  const trip = (await (await jsonRequest("/api/trips", "POST", { title: "Guerneville" })).json()) as { id: string };
  const booking = (await (await jsonRequest(`/api/trips/${trip.id}/bookings`, "POST", { kind: "lodging", title: "Dawn Ranch Lodge", status, details: { propertyName: "Dawn Ranch Lodge" } })).json()) as { id: string };
  return { tripId: trip.id, bookingId: booking.id };
}

beforeEach(async () => {
  await env.DB.exec("DELETE FROM booking");
  await env.DB.exec("DELETE FROM trip");
  await env.DB.exec("DELETE FROM household");
  await env.DB.prepare("INSERT INTO household (id, name, created_at) VALUES (?, ?, ?)").bind("hh-a", "Badger", new Date().toISOString()).run();
  await env.DB.prepare("INSERT INTO household (id, name, created_at) VALUES (?, ?, ?)").bind("hh-b", "Other", new Date().toISOString()).run();
  app = appAs(owner);
});

describe("PUT /api/bookings/:bookingId/status", () => {
  it("promotes a planned booking to booked", async () => {
    const { tripId, bookingId } = await makeBooking("planned");
    expect((await jsonRequest(`/api/bookings/${bookingId}/status`, "PUT", { status: "booked" })).status).toBe(204);
    const list = (await (await request(app, `/api/trips/${tripId}/bookings`)).json()) as { id: string; status: string }[];
    expect(list.find((b) => b.id === bookingId)?.status).toBe("booked");
  });
  it("promotes a draft booking out of draft", async () => {
    const { tripId, bookingId } = await makeBooking("draft");
    expect((await jsonRequest(`/api/bookings/${bookingId}/status`, "PUT", { status: "planned" })).status).toBe(204);
    const list = (await (await request(app, `/api/trips/${tripId}/bookings`)).json()) as { status: string }[];
    expect(list[0]?.status).toBe("planned");
  });
  it("answers 404 for an unknown booking", async () => {
    expect((await jsonRequest("/api/bookings/b-nope/status", "PUT", { status: "booked" })).status).toBe(404);
  });
  it("answers 404 for another household's booking", async () => {
    const { bookingId } = await makeBooking("planned");
    const otherApp = appAs({ ...owner, householdId: "hh-b" });
    const res = await request(otherApp, `/api/bookings/${bookingId}/status`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: "booked" }) });
    expect(res.status).toBe(404);
  });
  it("answers 400 for a status outside the enum", async () => {
    const { bookingId } = await makeBooking("planned");
    expect((await jsonRequest(`/api/bookings/${bookingId}/status`, "PUT", { status: "confirmed" })).status).toBe(400);
  });
  it("answers 400 for malformed JSON", async () => {
    const { bookingId } = await makeBooking("planned");
    const res = await request(app, `/api/bookings/${bookingId}/status`, { method: "PUT", headers: { "content-type": "application/json" }, body: "{" });
    expect(res.status).toBe(400);
  });
  it("answers 403 for a viewer", async () => {
    const { bookingId } = await makeBooking("planned");
    const viewerApp = appAs({ ...owner, role: "viewer" });
    const res = await request(viewerApp, `/api/bookings/${bookingId}/status`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: "booked" }) });
    expect(res.status).toBe(403);
  });
});
