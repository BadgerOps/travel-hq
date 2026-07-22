import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import worker from "../../src/server/worker.js";

describe("worker smoke", () => {
  it("serves /healthz", async () => {
    const res = await worker.fetch(new Request("http://x/healthz"), env, {} as ExecutionContext);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  it("has a migrated D1 with the household table", async () => {
    // Proves the harness applied migrations/0001_initial.sql to the local D1.
    const row = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='household'",
    ).first<{ name: string }>();
    expect(row?.name).toBe("household");
  });

  // Plan B regression guard: wrangler.toml's [env.testing.assets] block (added
  // to serve the SPA from the Worker) must not shadow /api/* or /healthz --
  // there is no dist/api, and the workers pool doesn't serve static assets at
  // all, so this exercises the same Hono app + bindings the real Worker uses,
  // proving the assets config didn't change routing to /api or /healthz. Full
  // asset/SPA-fallback serving is verified manually via `wrangler dev` (see
  // task-B-report.md).
  it("still serves /api/me via the Worker (not shadowed by the assets config)", async () => {
    const now = new Date().toISOString();
    await env.DB.prepare("INSERT INTO household (id,name,created_at) VALUES (?,?,?)")
      .bind("hh-assets", "Assets HH", now)
      .run();
    await env.DB.prepare("INSERT INTO user (id,email,created_at) VALUES (?,?,?)")
      .bind("u-assets", "assets-check@example.com", now)
      .run();
    await env.DB.prepare("INSERT INTO household_member (household_id,user_id,role) VALUES (?,?,?)")
      .bind("hh-assets", "u-assets", "owner")
      .run();

    const devEnv = { ...env, TRAVEL_HQ_ENV: "development", TRAVEL_HQ_DEV_EMAIL: "assets-check@example.com" };
    const res = await worker.fetch(new Request("http://x/api/me"), devEnv, {} as ExecutionContext);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      userId: "u-assets",
      email: "assets-check@example.com",
      householdId: "hh-assets",
      role: "owner",
    });
  });
});
