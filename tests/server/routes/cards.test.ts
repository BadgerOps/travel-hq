import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { Keyring } from "../../../src/server/crypto/envelope.js";
import { createApp } from "../../../src/server/index.js";
import type { AppBindings } from "../../../src/server/index.js";
import type { Identity } from "../../../src/server/auth.js";
import type { CardWithPerks } from "../../../src/server/repos/card.js";

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
async function createCard(): Promise<string> {
  const res = await jsonRequest("/api/cards", "POST", { name: "Sapphire Reserve", pointsProgram: "UR", pointsBalance: 85_000 });
  expect(res.status).toBe(201);
  return ((await res.json()) as { id: string }).id;
}
async function createCredit(cardId: string): Promise<string> {
  const res = await jsonRequest(`/api/cards/${cardId}/perks`, "POST", {
    name: "Travel credit", kind: "statement_credit", valueCents: 30_000, cadence: "annual", resetMonthDay: "01-01",
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

beforeEach(async () => {
  await env.DB.exec("DELETE FROM card_perk");
  await env.DB.exec("DELETE FROM card");
  await env.DB.exec("DELETE FROM household");
  const now = new Date().toISOString();
  await env.DB.prepare("INSERT INTO household (id, name, created_at) VALUES (?, ?, ?)").bind("hh-a", "Badger", now).run();
  await env.DB.prepare("INSERT INTO household (id, name, created_at) VALUES (?, ?, ?)").bind("hh-b", "Other", now).run();
  app = appAs(owner);
});

describe("/api/cards", () => {
  it("creates a card and lists it with nested perks and the unspent total", async () => {
    const cardId = await createCard();
    await createCredit(cardId);
    const res = await request(app, "/api/cards");
    expect(res.status).toBe(200);
    const cards = (await res.json()) as CardWithPerks[];
    expect(cards).toHaveLength(1);
    expect(cards[0]!.name).toBe("Sapphire Reserve");
    expect(cards[0]!.pointsBalance).toBe(85_000);
    expect(cards[0]!.perks).toHaveLength(1);
    expect(cards[0]!.perks[0]!.usedThisPeriod).toBe(false);
    expect(cards[0]!.unspentCents).toBe(30_000);
  });

  it("answers 400 for malformed JSON and an invalid body", async () => {
    const bad = await request(app, "/api/cards", { method: "POST", headers: { "content-type": "application/json" }, body: "{not json" });
    expect(bad.status).toBe(400);
    expect((await jsonRequest("/api/cards", "POST", { pointsProgram: "UR" })).status).toBe(400);
  });

  it("updates a card partially and rejects unknown keys", async () => {
    const cardId = await createCard();
    const res = await jsonRequest(`/api/cards/${cardId}`, "PUT", { issuer: "Chase" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { issuer: string; name: string };
    expect(body.issuer).toBe("Chase");
    expect(body.name).toBe("Sapphire Reserve");
    expect((await jsonRequest(`/api/cards/${cardId}`, "PUT", { nope: 1 })).status).toBe(400);
  });

  it("answers 404 for an unknown card and for another household's card", async () => {
    expect((await jsonRequest("/api/cards/c-nope", "PUT", { name: "X" })).status).toBe(404);

    const cardId = await createCard();
    const otherApp = appAs({ ...owner, householdId: "hh-b" });
    const foreign = await otherApp.request(`/api/cards/${cardId}`, {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Stolen" }),
    }, testEnv);
    expect(foreign.status).toBe(404);
    const list = (await (await otherApp.request("/api/cards", undefined, testEnv)).json()) as unknown[];
    expect(list).toEqual([]);
  });

  it("deletes a card (204) along with its perks", async () => {
    const cardId = await createCard();
    await createCredit(cardId);
    expect((await request(app, `/api/cards/${cardId}`, { method: "DELETE" })).status).toBe(204);
    expect(((await (await request(app, "/api/cards")).json()) as unknown[])).toEqual([]);
    expect((await request(app, `/api/cards/${cardId}`, { method: "DELETE" })).status).toBe(404);
  });

  it("answers 403 for every viewer write, and still serves the viewer reads", async () => {
    const cardId = await createCard();
    const perkId = await createCredit(cardId);

    const viewerApp = appAs({ ...owner, role: "viewer" });
    const post = (path: string, body: unknown) =>
      viewerApp.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }, testEnv);
    const put = (path: string, body: unknown) =>
      viewerApp.request(path, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }, testEnv);

    expect((await post("/api/cards", { name: "X" })).status).toBe(403);
    expect((await put(`/api/cards/${cardId}`, { name: "X" })).status).toBe(403);
    expect((await viewerApp.request(`/api/cards/${cardId}`, { method: "DELETE" }, testEnv)).status).toBe(403);
    expect((await post(`/api/cards/${cardId}/perks`, { name: "X", kind: "lounge", cadence: "annual" })).status).toBe(403);
    expect((await put(`/api/cards/${cardId}/perks/${perkId}`, { name: "X" })).status).toBe(403);
    expect((await viewerApp.request(`/api/cards/${cardId}/perks/${perkId}`, { method: "DELETE" }, testEnv)).status).toBe(403);
    expect((await put(`/api/cards/${cardId}/perks/${perkId}/used`, { used: true })).status).toBe(403);

    const list = (await (await viewerApp.request("/api/cards", undefined, testEnv)).json()) as CardWithPerks[];
    expect(list[0]!.perks).toHaveLength(1);
  });
});

describe("/api/cards/:cardId/perks", () => {
  it("rejects an unknown kind at the boundary (Zod 400)", async () => {
    const cardId = await createCard();
    const res = await jsonRequest(`/api/cards/${cardId}/perks`, "POST", { name: "X", kind: "cashback", cadence: "annual" });
    expect(res.status).toBe(400);
  });

  it("rejects an incoherent shape via the repo (ValidationError 400)", async () => {
    const cardId = await createCard();
    const res = await jsonRequest(`/api/cards/${cardId}/perks`, "POST", {
      name: "3x travel", kind: "multiplier", multiplier: 3, category: "travel", valueCents: 100, cadence: "one_time",
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/multiplier perk/i);
  });

  it("updates and deletes a perk", async () => {
    const cardId = await createCard();
    const perkId = await createCredit(cardId);
    const res = await jsonRequest(`/api/cards/${cardId}/perks/${perkId}`, "PUT", { valueCents: 25_000 });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { valueCents: number }).valueCents).toBe(25_000);

    expect((await request(app, `/api/cards/${cardId}/perks/${perkId}`, { method: "DELETE" })).status).toBe(204);
    expect((await jsonRequest(`/api/cards/${cardId}/perks/${perkId}`, "PUT", { name: "X" })).status).toBe(404);
  });

  it("marks a credit used and the unspent total reflects it", async () => {
    const cardId = await createCard();
    const perkId = await createCredit(cardId);

    const used = await jsonRequest(`/api/cards/${cardId}/perks/${perkId}/used`, "PUT", { used: true });
    expect(used.status).toBe(204);
    let cards = (await (await request(app, "/api/cards")).json()) as CardWithPerks[];
    expect(cards[0]!.perks[0]!.usedThisPeriod).toBe(true);
    expect(cards[0]!.unspentCents).toBe(0);

    const unused = await jsonRequest(`/api/cards/${cardId}/perks/${perkId}/used`, "PUT", { used: false });
    expect(unused.status).toBe(204);
    cards = (await (await request(app, "/api/cards")).json()) as CardWithPerks[];
    expect(cards[0]!.perks[0]!.usedThisPeriod).toBe(false);
    expect(cards[0]!.unspentCents).toBe(30_000);
  });

  it("answers 400 when marking a multiplier perk used, and for a malformed body", async () => {
    const cardId = await createCard();
    const res = await jsonRequest(`/api/cards/${cardId}/perks`, "POST", {
      name: "3x travel", kind: "multiplier", multiplier: 3, category: "travel", cadence: "one_time",
    });
    const perkId = ((await res.json()) as { id: string }).id;
    expect((await jsonRequest(`/api/cards/${cardId}/perks/${perkId}/used`, "PUT", { used: true })).status).toBe(400);
    expect((await jsonRequest(`/api/cards/${cardId}/perks/${perkId}/used`, "PUT", { used: "yes" })).status).toBe(400);
  });

  it("answers 404 for a perk reached through the wrong card", async () => {
    const cardId = await createCard();
    const perkId = await createCredit(cardId);
    const otherRes = await jsonRequest("/api/cards", "POST", { name: "Amex Gold" });
    const otherId = ((await otherRes.json()) as { id: string }).id;
    expect((await jsonRequest(`/api/cards/${otherId}/perks/${perkId}/used`, "PUT", { used: true })).status).toBe(404);
  });
});
