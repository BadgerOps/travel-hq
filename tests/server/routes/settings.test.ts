import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { Keyring } from "../../../src/server/crypto/envelope.js";
import { createApp } from "../../../src/server/index.js";
import type { AppBindings } from "../../../src/server/index.js";
import type { Identity } from "../../../src/server/auth.js";
import { DEFAULT_AI_MODEL } from "../../../src/server/repos/household-settings.js";

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
  await env.DB.exec("DELETE FROM inbound_email");
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
    expect(await res.json()).toEqual({
      forwardAddress: null,
      senderAllowlist: [],
      aiModel: DEFAULT_AI_MODEL,
    });
  });

  it("PUT round-trips the allowlist and model, and GET reflects them", async () => {
    const put = await putJson(
      app,
      JSON.stringify({
        forwardAddress: "trips@badgerops.foo",
        senderAllowlist: ["badger@example.com", "airline.com"],
        aiModel: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
      }),
    );
    expect(put.status).toBe(200);
    const body = (await (await request(app, "/api/settings")).json()) as Record<string, unknown>;
    expect(body).toEqual({
      forwardAddress: "trips@badgerops.foo",
      senderAllowlist: ["badger@example.com", "airline.com"],
      aiModel: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
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
    expect(body).toEqual({ forwardAddress: null, senderAllowlist: [], aiModel: DEFAULT_AI_MODEL });
  });
});

describe("GET /api/settings/ingest-activity (issue #8)", () => {
  async function seedEmail(
    id: string,
    householdId: string,
    over: Partial<{ status: string; error: string | null; subject: string | null; receivedAt: string }> = {},
  ) {
    await env.DB.prepare(
      `INSERT INTO inbound_email (id, household_id, from_address, to_address, subject, raw, status, error, received_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        id,
        householdId,
        "airline@airline.com",
        "trips@badgerops.foo",
        over.subject === undefined ? "Your flight" : over.subject,
        "RAW MESSAGE TEXT — must never appear in the feed",
        over.status ?? "extracted",
        over.error ?? null,
        over.receivedAt ?? new Date().toISOString(),
      )
      .run();
  }

  it("answers recent activity newest-first with outcome and reason, never raw", async () => {
    await seedEmail("e-old", "hh-a", { status: "extracted", receivedAt: "2026-07-20T10:00:00.000Z" });
    await seedEmail("e-new", "hh-a", {
      status: "rejected",
      error: "sender is not on the household allowlist",
      receivedAt: "2026-07-22T10:00:00.000Z",
    });

    const res = await request(app, "/api/settings/ingest-activity");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>[];
    expect(body.map((e) => e.id)).toEqual(["e-new", "e-old"]);
    expect(body[0]).toEqual({
      id: "e-new",
      from: "airline@airline.com",
      subject: "Your flight",
      status: "rejected",
      error: "sender is not on the household allowlist",
      receivedAt: "2026-07-22T10:00:00.000Z",
    });
    // The raw message text stays behind GET /api/import/emails/:emailId.
    expect(JSON.stringify(body)).not.toContain("RAW MESSAGE TEXT");
  });

  it("respects a limit query and rejects a malformed one with 400", async () => {
    await seedEmail("e-1", "hh-a", { receivedAt: "2026-07-20T10:00:00.000Z" });
    await seedEmail("e-2", "hh-a", { receivedAt: "2026-07-21T10:00:00.000Z" });

    const limited = (await (await request(app, "/api/settings/ingest-activity?limit=1")).json()) as {
      id: string;
    }[];
    expect(limited.map((e) => e.id)).toEqual(["e-2"]);

    expect((await request(app, "/api/settings/ingest-activity?limit=0")).status).toBe(400);
    expect((await request(app, "/api/settings/ingest-activity?limit=101")).status).toBe(400);
    expect((await request(app, "/api/settings/ingest-activity?limit=banana")).status).toBe(400);
  });

  it("blocks a viewer with 403 but allows an adult", async () => {
    const viewerApp = appAs({ ...identity, role: "viewer" });
    const viewerRes = await request(viewerApp, "/api/settings/ingest-activity");
    expect(viewerRes.status).toBe(403);
    expect(await viewerRes.json()).toEqual({ error: "Forbidden" });

    const adultApp = appAs({ ...identity, userId: "u2", role: "adult" });
    expect((await request(adultApp, "/api/settings/ingest-activity")).status).toBe(200);
  });

  it("is tenant-scoped: another household's mail never appears", async () => {
    await seedEmail("e-b", "hh-b");
    const res = await request(app, "/api/settings/ingest-activity");
    expect(await res.json()).toEqual([]);
  });
});
