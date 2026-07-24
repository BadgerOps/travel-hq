import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { Keyring } from "../../../src/server/crypto/envelope.js";
import { createApp } from "../../../src/server/index.js";
import type { AppBindings } from "../../../src/server/index.js";
import type { Identity } from "../../../src/server/auth.js";
import { DEFAULT_AI_MODEL } from "../../../src/server/repos/household-settings.js";

const SAFE_DEFAULTS = {
  forwardAddress: null,
  senderAllowlist: [],
  aiModel: DEFAULT_AI_MODEL,
  aiMaxTokens: 4_096,
  aiProvider: "workers-ai",
  anthropicModel: "claude-opus-4-8",
  anthropicKeyConfigured: false,
  extractionInstructions: "",
};

const ring = new Keyring("server-v1", { "server-v1": crypto.getRandomValues(new Uint8Array(32)) });
const identity: Identity = { userId: "u1", email: "badger@example.com", householdId: "hh-a", role: "owner" };
const testEnv = { DB: env.DB } as unknown as AppBindings;

function appAs(who: Identity) {
  return createApp({ verify: async () => who, ring });
}

let app: ReturnType<typeof createApp>;

function request(a: ReturnType<typeof createApp>, path: string, init?: RequestInit) {
  return a.request(path, init, testEnv);
}
function putJson(a: ReturnType<typeof createApp>, body: BodyInit) {
  return request(a, "/api/settings", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body,
  });
}

beforeEach(async () => {
  await env.DB.exec("DELETE FROM household_settings");
  await env.DB.exec("DELETE FROM household");
  const now = new Date().toISOString();
  await env.DB.prepare("INSERT INTO household (id, name, created_at) VALUES (?, ?, ?)").bind("hh-a", "Badger", now).run();
  await env.DB.prepare("INSERT INTO household (id, name, created_at) VALUES (?, ?, ?)").bind("hh-b", "Other", now).run();
  app = appAs(identity);
});

describe("/api/settings", () => {
  it("GET answers the defaults (default model, empty allowlist) when no row exists", async () => {
    const res = await request(app, "/api/settings");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(SAFE_DEFAULTS);
  });

  it("PUT round-trips the allowlist and model, and GET reflects them", async () => {
    const put = await putJson(
      app,
      JSON.stringify({
        forwardAddress: "trips@badgerops.foo",
        senderAllowlist: ["badger@example.com", "airline.com"],
        aiModel: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
        aiMaxTokens: 6_144,
      }),
    );
    expect(put.status).toBe(200);
    const body = (await (await request(app, "/api/settings")).json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      forwardAddress: "trips@badgerops.foo",
      senderAllowlist: ["badger@example.com", "airline.com"],
      aiModel: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
      aiMaxTokens: 6_144,
    });
  });

  it("PUT supports partial updates: an absent field keeps its stored value", async () => {
    await putJson(app, JSON.stringify({ forwardAddress: "trips@badgerops.foo" }));
    await putJson(app, JSON.stringify({ senderAllowlist: ["badger@example.com"] }));
    const body = (await (await request(app, "/api/settings")).json()) as Record<string, unknown>;
    expect(body.forwardAddress).toBe("trips@badgerops.foo");
    expect(body.senderAllowlist).toEqual(["badger@example.com"]);
    expect(body.aiModel).toBe(DEFAULT_AI_MODEL);
  });

  it("blocks a viewer from GET with 403", async () => {
    const viewerApp = appAs({ ...identity, role: "viewer" });
    const res = await request(viewerApp, "/api/settings");
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Forbidden" });
  });

  it("blocks a viewer from PUT with 403", async () => {
    const viewerApp = appAs({ ...identity, role: "viewer" });
    const res = await putJson(viewerApp, JSON.stringify({ aiModel: "x" }));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Forbidden" });
  });

  it("allows an adult (not just the owner) to read and write", async () => {
    const adultApp = appAs({ ...identity, userId: "u2", role: "adult" });
    expect((await request(adultApp, "/api/settings")).status).toBe(200);
    expect((await putJson(adultApp, JSON.stringify({ senderAllowlist: ["a@b.com"] }))).status).toBe(200);
  });

  it("rejects a malformed JSON body with 400", async () => {
    const res = await putJson(app, "{ not json");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Invalid JSON body" });
  });

  it("rejects an unknown key with 400 (strict schema)", async () => {
    const res = await putJson(app, JSON.stringify({ aiModel: "x", extra: true }));
    expect(res.status).toBe(400);
  });

  it("rejects a wrongly-typed allowlist with 400", async () => {
    const res = await putJson(app, JSON.stringify({ senderAllowlist: "badger@example.com" }));
    expect(res.status).toBe(400);
  });

  it("rejects a malformed forward address with 400", async () => {
    const res = await putJson(app, JSON.stringify({ forwardAddress: "not-an-address" }));
    expect(res.status).toBe(400);
  });

  it("rejects a Workers AI model that cannot satisfy the extraction schema", async () => {
    const res = await putJson(
      app,
      JSON.stringify({ aiModel: "@cf/google/gemma-4-26b-a4b-it" }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "aiModel must be a supported Workers AI extraction model",
    });
  });

  it("rejects an invalid Workers AI output-token budget", async () => {
    for (const aiMaxTokens of [255, 8_193, 1024.5]) {
      const res = await putJson(app, JSON.stringify({ aiMaxTokens }));
      expect(res.status).toBe(400);
    }
  });

  it("rejects a forward address already claimed by another household with 400", async () => {
    await putJson(app, JSON.stringify({ forwardAddress: "trips@badgerops.foo" }));
    const otherApp = appAs({ ...identity, userId: "u2", householdId: "hh-b" });
    const res = await putJson(otherApp, JSON.stringify({ forwardAddress: "trips@badgerops.foo" }));
    expect(res.status).toBe(400);
  });

  it("is tenant-scoped: another household still reads the defaults", async () => {
    await putJson(app, JSON.stringify({ forwardAddress: "trips@badgerops.foo", senderAllowlist: ["a@b.com"] }));
    const otherApp = appAs({ ...identity, userId: "u2", householdId: "hh-b" });
    const body = (await (await request(otherApp, "/api/settings")).json()) as Record<string, unknown>;
    expect(body).toEqual(SAFE_DEFAULTS);
  });

  it("stores an Anthropic key write-only and rejects masked replacement without mutation", async () => {
    const put = await putJson(app, JSON.stringify({
      aiProvider: "anthropic",
      anthropicModel: "claude-sonnet-5",
      anthropicApiKey: "sk-ant-route-secret",
      extractionInstructions: "Use Boise as the usual origin.",
    }));
    expect(put.status).toBe(200);
    const safe = await put.json() as Record<string, unknown>;
    expect(safe).toMatchObject({
      aiProvider: "anthropic",
      anthropicModel: "claude-sonnet-5",
      anthropicKeyConfigured: true,
    });
    expect(JSON.stringify(safe)).not.toContain("sk-ant-route-secret");
    expect(safe).not.toHaveProperty("anthropicApiKey");

    const before = await env.DB.prepare(
      "SELECT anthropic_api_key FROM household_settings WHERE household_id = ?",
    ).bind("hh-a").first<{ anthropic_api_key: string }>();
    const rejected = await putJson(app, JSON.stringify({ anthropicApiKey: "Configured ••••" }));
    expect(rejected.status).toBe(400);
    const after = await env.DB.prepare(
      "SELECT anthropic_api_key FROM household_settings WHERE household_id = ?",
    ).bind("hh-a").first<{ anthropic_api_key: string }>();
    expect(after).toEqual(before);
  });
});
