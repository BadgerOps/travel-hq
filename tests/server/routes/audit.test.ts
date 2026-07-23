import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { Keyring } from "../../../src/server/crypto/envelope.js";
import { createApp } from "../../../src/server/index.js";
import type { AppBindings } from "../../../src/server/index.js";
import type { Identity } from "../../../src/server/auth.js";
import type { RevealAuditEntry } from "../../../src/server/repos/reveal-audit.js";

const ring = new Keyring("server-v1", { "server-v1": crypto.getRandomValues(new Uint8Array(32)) });
const owner: Identity = { userId: "u1", email: "badger@example.com", householdId: "hh-a", role: "owner" };
const testEnv = { DB: env.DB } as unknown as AppBindings;

function appAs(who: Identity) {
  return createApp({ verify: async () => who, ring });
}

let app: ReturnType<typeof createApp>;

function request(a: ReturnType<typeof createApp>, path: string, init?: RequestInit) {
  return a.request(path, init, testEnv);
}
function postJson(a: ReturnType<typeof createApp>, path: string, body: unknown) {
  return request(a, path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function createAva(a: ReturnType<typeof createApp>): Promise<string> {
  const res = await postJson(a, "/api/people", { displayName: "Ava", passportNumber: "C03X72119" });
  expect(res.status).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

async function auditRows(): Promise<Record<string, string>[]> {
  const { results } = await env.DB.prepare(
    "SELECT household_id, user_id, user_email, person_id, field FROM reveal_audit ORDER BY revealed_at, id",
  ).all<Record<string, string>>();
  return results;
}

beforeEach(async () => {
  await env.DB.exec("DELETE FROM reveal_audit");
  await env.DB.exec("DELETE FROM person");
  await env.DB.exec("DELETE FROM household");
  const now = new Date().toISOString();
  await env.DB.prepare("INSERT INTO household (id,name,created_at) VALUES (?,?,?)").bind("hh-a", "A", now).run();
  await env.DB.prepare("INSERT INTO household (id,name,created_at) VALUES (?,?,?)").bind("hh-b", "B", now).run();
  app = appAs(owner);
});

describe("reveal audit (issue #8)", () => {
  it("writes exactly one audit row per successful document reveal", async () => {
    const personId = await createAva(app);
    const res = await request(app, `/api/people/${personId}/reveal/passport_number`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ value: "C03X72119" });

    expect(await auditRows()).toEqual([
      {
        household_id: "hh-a",
        user_id: "u1",
        user_email: "badger@example.com",
        person_id: personId,
        field: "passport_number",
      },
    ]);
  });

  it("records an adult's reveal too, and the owner can read it in the trail", async () => {
    const personId = await createAva(app);
    const adultApp = appAs({ ...owner, userId: "u2", email: "adult@example.com", role: "adult" });
    expect((await request(adultApp, `/api/people/${personId}/reveal/known_traveler_number`)).status).toBe(200);

    const res = await request(app, "/api/audit/reveals");
    expect(res.status).toBe(200);
    const entries = (await res.json()) as RevealAuditEntry[];
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      userId: "u2",
      userEmail: "adult@example.com",
      personId,
      personName: "Ava",
      field: "known_traveler_number",
    });
    expect(entries[0]!.revealedAt).toBeTruthy();
    // The trail records access, never the revealed value (which was null
    // here anyway — an unset field is still a reveal attempt worth auditing).
    expect(JSON.stringify(entries)).not.toContain("C03X72119");
  });

  it("writes no audit row for a denied (viewer) reveal", async () => {
    const personId = await createAva(app);
    const viewerApp = appAs({ ...owner, userId: "u3", role: "viewer" });
    expect((await request(viewerApp, `/api/people/${personId}/reveal/passport_number`)).status).toBe(403);
    expect(await auditRows()).toEqual([]);
  });

  it("writes no audit row for a reveal of a person that does not exist", async () => {
    expect((await request(app, "/api/people/nope/reveal/passport_number")).status).toBe(404);
    expect(await auditRows()).toEqual([]);
  });

  it("serves GET /api/audit/reveals to the owner only: adult and viewer get 403", async () => {
    const adultApp = appAs({ ...owner, userId: "u2", role: "adult" });
    const viewerApp = appAs({ ...owner, userId: "u3", role: "viewer" });
    const adultRes = await request(adultApp, "/api/audit/reveals");
    expect(adultRes.status).toBe(403);
    expect(await adultRes.json()).toEqual({ error: "Forbidden" });
    expect((await request(viewerApp, "/api/audit/reveals")).status).toBe(403);
  });

  it("is tenant-scoped: household B's owner sees an empty trail", async () => {
    const personId = await createAva(app);
    expect((await request(app, `/api/people/${personId}/reveal/passport_number`)).status).toBe(200);
    const otherApp = appAs({ ...owner, userId: "u9", householdId: "hh-b" });
    const res = await request(otherApp, "/api/audit/reveals");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });
});
