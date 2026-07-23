import { beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:test";
import { createApp } from "../../../src/server/index.js";
import type { AppBindings } from "../../../src/server/index.js";
import type { Identity } from "../../../src/server/auth.js";
import { Keyring } from "../../../src/server/crypto/envelope.js";
import { MAX_AI_TEXT_CHARS } from "../../../src/server/ingest/extract.js";

const identity: Identity = {
  userId: "u1",
  email: "owner@example.com",
  householdId: "hh-a",
  role: "owner",
};
const ring = new Keyring("test", { test: crypto.getRandomValues(new Uint8Array(32)) });
const BOOKING = {
  kind: "flight",
  title: "BOI to STS",
  location: "Boise",
  startsAt: null,
  startsAtTz: null,
  endsAt: null,
  endsAtTz: null,
  confirmationNumber: "FLY123",
  costCents: null,
  details: {},
};

beforeEach(async () => {
  await env.DB.exec("DELETE FROM draft_booking");
  await env.DB.exec("DELETE FROM inbound_email");
  await env.DB.exec("DELETE FROM household_settings");
  await env.DB.exec("DELETE FROM household");
  await env.DB.prepare("INSERT INTO household (id,name,created_at) VALUES (?,?,?)")
    .bind("hh-a", "A", new Date().toISOString()).run();
});

function makeApp(who = identity) {
  const create = vi.fn(async () => ({
    content: [{ type: "text", text: JSON.stringify({ bookings: [BOOKING] }) }],
    stop_reason: "end_turn",
  }));
  return {
    app: createApp({
      verify: async () => who,
      ring,
      anthropicClientFactory: () => ({ create }),
    }),
    create,
  };
}

function request(app: ReturnType<typeof createApp>, path: string, init?: RequestInit) {
  return app.request(path, init, { DB: env.DB } as unknown as AppBindings);
}

describe("POST /api/settings/extraction-test", () => {
  it("uses configured instructions/provider and persists nothing", async () => {
    const { app, create } = makeApp();
    await request(app, "/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        aiProvider: "anthropic",
        anthropicApiKey: "sk-ant-test",
        extractionInstructions: "Home airport is BOI.",
      }),
    });
    const res = await request(app, "/api/settings/extraction-test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ subject: "Flight", text: "Confirmation FLY123" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      bookings: [{ title: "BOI to STS", confirmationNumber: "FLY123" }],
    });
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      system: expect.stringContaining("Home airport is BOI."),
    }));
    expect(await env.DB.prepare("SELECT COUNT(*) n FROM inbound_email").first<{ n: number }>()).toEqual({ n: 0 });
    expect(await env.DB.prepare("SELECT COUNT(*) n FROM draft_booking").first<{ n: number }>()).toEqual({ n: 0 });
  });

  it("rejects oversized input and viewers", async () => {
    const owner = makeApp().app;
    const oversized = await request(owner, "/api/settings/extraction-test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "x".repeat(MAX_AI_TEXT_CHARS + 1) }),
    });
    expect(oversized.status).toBe(400);

    const viewer = makeApp({ ...identity, role: "viewer" }).app;
    const forbidden = await request(viewer, "/api/settings/extraction-test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "confirmation" }),
    });
    expect(forbidden.status).toBe(403);
  });
});
