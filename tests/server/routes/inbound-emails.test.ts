import { beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { createApp } from "../../../src/server/index.js";
import type { AppBindings } from "../../../src/server/index.js";
import type { Identity } from "../../../src/server/auth.js";
import { Keyring } from "../../../src/server/crypto/envelope.js";
import { InboundEmailRepo } from "../../../src/server/repos/inbound-email.js";
import { DraftBookingRepo } from "../../../src/server/repos/draft-booking.js";

const identity: Identity = {
  userId: "u1", email: "owner@example.com", householdId: "hh-a", role: "owner",
};
const ring = new Keyring("test", { test: crypto.getRandomValues(new Uint8Array(32)) });

beforeEach(async () => {
  await env.DB.exec("DELETE FROM draft_booking");
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

function request(app: ReturnType<typeof createApp>, path = "/api/inbound-emails") {
  return app.request(path, undefined, { DB: env.DB } as unknown as AppBindings);
}

describe("GET /api/inbound-emails", () => {
  it("returns newest-first metadata without raw or Message-ID", async () => {
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
      id: expect.any(String),
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
  });

  it("blocks viewers", async () => {
    expect((await request(appAs({ ...identity, role: "viewer" }))).status).toBe(403);
  });
});

describe("GET /api/inbound-emails/:id", () => {
  const raw = [
    "From: Silverwood <res@example.com>",
    "Subject: Your Silverwood RV Park Reservation",
    "Content-Type: text/plain",
    "",
    "Site A12, arriving July 30.",
  ].join("\r\n");

  async function seedExtracted() {
    const email = await InboundEmailRepo.forIngest(env.DB, "hh-a").create({
      from: "sol@example.com", to: "trips@example.com",
      subject: "Fwd: Your Silverwood RV Park Reservation",
      messageId: "<secret-detail>", raw,
    });
    await DraftBookingRepo.forIngest(env.DB, "hh-a").createMany([{
      inboundEmailId: email.id,
      ordinal: 0,
      kind: "lodging",
      title: "Silverwood RV Park",
      location: "Athol, ID",
      confirmationNumber: "RV-4001",
      source: "ai",
      extracted: { kind: "lodging", title: "Silverwood RV Park", costCents: 12_500 },
    }]);
    return email;
  }

  it("returns the parsed message content and the drafts extracted from it", async () => {
    const email = await seedExtracted();
    const res = await request(appAs(identity), `/api/inbound-emails/${email.id}`);
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown> & {
      drafts: Array<Record<string, unknown>>;
    };
    expect(body).toMatchObject({
      id: email.id,
      from: "sol@example.com",
      subject: "Your Silverwood RV Park Reservation",
      textBody: "Site A12, arriving July 30.",
      calendars: [],
    });
    expect(body.drafts).toHaveLength(1);
    expect(body.drafts[0]).toMatchObject({
      kind: "lodging",
      title: "Silverwood RV Park",
      confirmationNumber: "RV-4001",
      extracted: { costCents: 12_500 },
    });
    // The raw RFC 5322 message and Message-ID stay server-side.
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("secret-detail");
    expect(serialized).not.toContain('"raw"');
  });

  it("still serves envelope metadata when the stored raw is empty", async () => {
    const email = await InboundEmailRepo.forIngest(env.DB, "hh-a").create({
      from: "koa@example.com", to: "trips@example.com", subject: "Rejected one",
      raw: "", status: "rejected", error: "sender is not on the household allowlist",
    });
    const res = await request(appAs(identity), `/api/inbound-emails/${email.id}`);
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body).toMatchObject({
      subject: "Rejected one",
      status: "rejected",
      error: "sender is not on the household allowlist",
      textBody: null,
      drafts: [],
    });
  });

  it("hides other households' emails", async () => {
    const other = await InboundEmailRepo.forIngest(env.DB, "hh-b").create({
      from: "other@example.com", to: "other@example.com", raw: "OTHER SECRET",
    });
    const res = await request(appAs(identity), `/api/inbound-emails/${other.id}`);
    expect(res.status).toBe(404);
  });

  it("blocks viewers", async () => {
    const email = await seedExtracted();
    const res = await request(
      appAs({ ...identity, role: "viewer" }),
      `/api/inbound-emails/${email.id}`,
    );
    expect(res.status).toBe(403);
  });
});
