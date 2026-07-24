import { describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:test";
import { createApp } from "../../../src/server/index.js";
import type { AppBindings } from "../../../src/server/index.js";
import type { Identity } from "../../../src/server/auth.js";
import { Keyring } from "../../../src/server/crypto/envelope.js";
import {
  MODEL_CATALOG_TTL_MS,
  WorkersAiModelCatalog,
} from "../../../src/server/ingest/model-catalog.js";

const identity: Identity = {
  userId: "u1",
  email: "owner@example.com",
  householdId: "hh-a",
  role: "owner",
};
const ring = new Keyring("test", { test: crypto.getRandomValues(new Uint8Array(32)) });

const TEXT_GEN = { id: "tg", name: "Text Generation", description: "" };
const CLASSIFIER = { id: "tc", name: "Text Classification", description: "" };

function entry(name: string, task = TEXT_GEN, description = `${name} desc`) {
  return { id: `id-${name}`, source: 1, name, description, task, tags: [], properties: [] };
}

/**
 * The catalog is exercised through the app so the route's mapping and error
 * envelope are covered too. Each makeApp gets a FRESH catalog: the cache
 * under test is per-instance state, and sharing the module singleton across
 * tests would leak one test's pull into the next.
 */
function makeApp(models: unknown[] | (() => unknown[]), now?: () => number) {
  const lister = vi.fn(async (params?: { page?: number; per_page?: number }) => {
    const all = typeof models === "function" ? models() : models;
    const per = params?.per_page ?? all.length;
    const page = params?.page ?? 1;
    return all.slice((page - 1) * per, page * per);
  });
  const app = createApp({
    verify: async () => identity,
    ring,
    modelCatalog: new WorkersAiModelCatalog(now),
  });
  return { app, lister };
}

function request(app: ReturnType<typeof createApp>, lister: unknown) {
  return app.request("/api/settings/ai-models", undefined, {
    DB: env.DB,
    AI: { models: lister },
  } as unknown as AppBindings);
}

describe("GET /api/settings/ai-models", () => {
  it("returns text-generation models only, sorted by name", async () => {
    const { app, lister } = makeApp([
      entry("@cf/meta/llama-3.3-70b-instruct-fp8-fast"),
      entry("@cf/huggingface/distilbert-sst-2-int8", CLASSIFIER),
      entry("@cf/meta/llama-3.1-8b-instruct"),
    ]);
    const res = await request(app, lister);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { models: { name: string; description: string }[] };
    expect(body.models.map((m) => m.name)).toEqual([
      "@cf/meta/llama-3.1-8b-instruct",
      "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    ]);
    expect(body.models[0]!.description).toBe("@cf/meta/llama-3.1-8b-instruct desc");
  });

  it("serves the second request from cache without re-pulling", async () => {
    const { app, lister } = makeApp([entry("@cf/meta/llama-3.1-8b-instruct")]);
    await request(app, lister);
    const res = await request(app, lister);
    expect(((await res.json()) as { models: unknown[] }).models).toHaveLength(1);
    expect(lister).toHaveBeenCalledTimes(1);
  });

  it("re-pulls after the TTL expires", async () => {
    let t = 0;
    const { app, lister } = makeApp([entry("@cf/meta/llama-3.1-8b-instruct")], () => t);
    await request(app, lister);
    t = MODEL_CATALOG_TTL_MS + 1;
    await request(app, lister);
    expect(lister).toHaveBeenCalledTimes(2);
  });

  it("paginates when the catalog is larger than one page", async () => {
    // 60 models with a per_page of 50 (the catalog's page size) forces a
    // second pull; a full second page then requires a third, empty, pull.
    const many = Array.from({ length: 60 }, (_, i) =>
      entry(`@cf/test/model-${String(i).padStart(2, "0")}`),
    );
    const { app, lister } = makeApp(many);
    const res = await request(app, lister);
    const body = (await res.json()) as { models: unknown[] };
    expect(body.models).toHaveLength(60);
    expect(lister.mock.calls.length).toBeGreaterThan(1);
  });

  it("answers an empty list with an error note when the pull fails cold", async () => {
    const lister = vi.fn(async () => {
      throw new Error("upstream down");
    });
    const app = createApp({
      verify: async () => identity,
      ring,
      modelCatalog: new WorkersAiModelCatalog(),
    });
    const res = await request(app, lister);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ models: [], error: "Workers AI is unavailable" });
  });

  it("serves the stale list when a refresh pull fails after expiry", async () => {
    let t = 0;
    let fail = false;
    const models = () => {
      if (fail) throw new Error("upstream down");
      return [entry("@cf/meta/llama-3.1-8b-instruct")];
    };
    const { app, lister } = makeApp(models as never, () => t);
    await request(app, lister);
    fail = true;
    t = MODEL_CATALOG_TTL_MS + 1;
    const res = await request(app, lister);
    const body = (await res.json()) as { models: { name: string }[] };
    expect(body.models.map((m) => m.name)).toEqual(["@cf/meta/llama-3.1-8b-instruct"]);
  });
});
