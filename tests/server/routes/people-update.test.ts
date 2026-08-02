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
const revealInit: RequestInit = {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: "{}",
};
async function createAva(): Promise<string> {
  const res = await jsonRequest("/api/people", "POST", { displayName: "Ava", passportNumber: "C03X72119" });
  return ((await res.json()) as { id: string }).id;
}

beforeEach(async () => {
  await env.DB.exec("DELETE FROM person");
  await env.DB.exec("DELETE FROM household");
  await env.DB.prepare("INSERT INTO household (id, name, created_at) VALUES (?, ?, ?)").bind("hh-a", "Badger", new Date().toISOString()).run();
  app = appAs(owner);
});

describe("PUT /api/people/:id", () => {
  it("updates a name and returns the masked person", async () => {
    const id = await createAva();
    const res = await jsonRequest(`/api/people/${id}`, "PUT", { displayName: "Ava Wright" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { displayName: string; passportNumberMasked: string };
    expect(body.displayName).toBe("Ava Wright");
    expect(body.passportNumberMasked).toBe("••••2119");
  });
  it("creates and updates optional contact fields", async () => {
    const created = await jsonRequest("/api/people", "POST", {
      displayName: "Finn",
      email: "finn@example.com",
      phone: "+1 208 555 0199",
    });
    expect(created.status).toBe(201);
    const person = await created.json() as { id: string; email: string; phone: string };
    expect(person).toMatchObject({
      email: "finn@example.com",
      phone: "+1 208 555 0199",
    });
    const updated = await jsonRequest(`/api/people/${person.id}`, "PUT", {
      email: null,
      phone: "+1 208 555 0101",
    });
    expect(await updated.json()).toMatchObject({
      email: null,
      phone: "+1 208 555 0101",
    });
  });
  it("rejects an invalid contact email", async () => {
    expect((await jsonRequest("/api/people", "POST", {
      displayName: "Finn",
      email: "not-an-email",
    })).status).toBe(400);
  });
  it("does not disturb the passport when the field is omitted", async () => {
    const id = await createAva();
    await jsonRequest(`/api/people/${id}`, "PUT", { displayName: "Ava Wright" });
    const revealed = (await (
      await request(app, `/api/people/${id}/reveal/passport_number`, revealInit)
    ).json()) as { value: string };
    expect(revealed.value).toBe("C03X72119");
  });
  it("answers 400 for a masked passport value and leaves the stored one intact", async () => {
    const id = await createAva();
    const res = await jsonRequest(`/api/people/${id}`, "PUT", { passportNumber: "••••2119" });
    expect(res.status).toBe(400);
    const revealed = (await (
      await request(app, `/api/people/${id}/reveal/passport_number`, revealInit)
    ).json()) as { value: string };
    expect(revealed.value).toBe("C03X72119");
  });
  it("clears a document field on an explicit null", async () => {
    const id = await createAva();
    const res = await jsonRequest(`/api/people/${id}`, "PUT", { passportNumber: null });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { passportNumberMasked: string | null }).passportNumberMasked).toBe(null);
  });
  it("encrypts, masks, and reveals a scanned driver's licence number", async () => {
    const created = await jsonRequest("/api/people", "POST", {
      displayName: "Ava",
      driverLicenseNumber: "D1234567",
      driverLicenseExpiry: "2031-04-15",
      driverLicenseJurisdiction: "ID",
    });
    expect(created.status).toBe(201);
    const person = (await created.json()) as {
      id: string;
      driverLicenseNumberMasked: string;
      driverLicenseExpiry: string;
      driverLicenseJurisdiction: string;
    };
    expect(person).toMatchObject({
      driverLicenseNumberMasked: "••••4567",
      driverLicenseExpiry: "2031-04-15",
      driverLicenseJurisdiction: "ID",
    });
    const row = await env.DB.prepare("SELECT driver_license_number FROM person WHERE id = ?")
      .bind(person.id)
      .first<{ driver_license_number: string }>();
    expect(row?.driver_license_number).not.toContain("D1234567");

    const revealed = await request(
      app,
      `/api/people/${person.id}/reveal/driver_license_number`,
      revealInit,
    );
    expect(revealed.status).toBe(200);
    expect(await revealed.json()).toMatchObject({ value: "D1234567" });
  });
  it("answers 404 for an unknown person", async () => {
    expect((await jsonRequest("/api/people/p-nope", "PUT", { displayName: "X" })).status).toBe(404);
  });
  it("answers 400 for malformed JSON", async () => {
    const id = await createAva();
    const res = await request(app, `/api/people/${id}`, { method: "PUT", headers: { "content-type": "application/json" }, body: "{not json" });
    expect(res.status).toBe(400);
  });
  it("answers 400 for an empty display name", async () => {
    const id = await createAva();
    expect((await jsonRequest(`/api/people/${id}`, "PUT", { displayName: "" })).status).toBe(400);
  });
  it("answers 403 for a viewer", async () => {
    const id = await createAva();
    const viewerApp = appAs({ ...owner, role: "viewer" });
    const res = await request(viewerApp, `/api/people/${id}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ displayName: "Nope" }) });
    expect(res.status).toBe(403);
  });
});
