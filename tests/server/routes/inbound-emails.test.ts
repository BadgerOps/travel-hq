import { beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { createApp } from "../../../src/server/index.js";
import type { AppBindings } from "../../../src/server/index.js";
import type { Identity } from "../../../src/server/auth.js";
import { Keyring } from "../../../src/server/crypto/envelope.js";
import { InboundEmailRepo } from "../../../src/server/repos/inbound-email.js";

const identity: Identity = {
  userId: "u1", email: "owner@example.com", householdId: "hh-a", role: "owner",
};
const ring = new Keyring("test", { test: crypto.getRandomValues(new Uint8Array(32)) });

beforeEach(async () => {
  await env.DB.exec("DELETE FROM inbound_email");
  await env.DB.exec("DELETE FROM household");
  const now = new Date().toISOString();
  await env.DB.prepare("INSERT INTO household (id,name,created_at) VALUES (?,?,?)")
    .bind("hh-a", "A", now).run();
  await env.DB.prepare("INSERT INTO household (id,name,created_at) VALUES (?,?,?)")
    .bind("hh-b", "B", now).run();
});

function appAs(who: Identity) {
  return createApp({ verify: async () => who, ring });
}

function request(app: ReturnType<typeof createApp>) {
  return app.request("/api/inbound-emails", undefined, { DB: env.DB } as unknown as AppBindings);
}

describe("GET /api/inbound-emails", () => {
  it("returns newest-first metadata without raw or identifiers", async () => {
    const repo = InboundEmailRepo.forIngest(env.DB, "hh-a");
    await repo.create({
      from: "first@example.com", to: "trips@example.com", subject: "First",
      messageId: "<secret-first>", raw: "SECRET RAW FIRST",
    });
    await repo.create({
      from: "second@example.com", to: "trips@example.com", subject: "Second",
      messageId: "<secret-second>", raw: "SECRET RAW SECOND", status: "failed", error: "boom",
    });
    await InboundEmailRepo.forIngest(env.DB, "hh-b").create({
      from: "other@example.com", to: "other@example.com", raw: "OTHER SECRET",
    });

    const res = await request(appAs(identity));
    expect(res.status).toBe(200);
    const body = await res.json() as Array<Record<string, unknown>>;
    expect(body.map((row) => row.subject)).toEqual(["Second", "First"]);
    expect(body[0]).toEqual({
      from: "second@example.com",
      to: "trips@example.com",
      subject: "Second",
      status: "failed",
      error: "boom",
      receivedAt: expect.any(String),
    });
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("SECRET");
    expect(serialized).not.toContain("messageId");
    expect(body[0]).not.toHaveProperty("id");
  });

  it("blocks viewers", async () => {
    expect((await request(appAs({ ...identity, role: "viewer" }))).status).toBe(403);
  });
});
