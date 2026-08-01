import { beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:test";
import { createApp } from "../../../src/server/index.js";
import type { AppBindings } from "../../../src/server/index.js";
import type { Identity } from "../../../src/server/auth.js";
import { Keyring } from "../../../src/server/crypto/envelope.js";
import { InboundEmailRepo } from "../../../src/server/repos/inbound-email.js";
import { DraftBookingRepo } from "../../../src/server/repos/draft-booking.js";
import type { InboundEmailDetail } from "../../../src/server/routes/inbound-emails.js";
import { RAW_RETENTION_UNRESOLVED_DAYS } from "../../../src/shared/email-retention.js";

const identity: Identity = {
  userId: "u1",
  email: "owner@example.com",
  householdId: "hh-a",
  role: "owner",
};
const ring = new Keyring("k1", { k1: crypto.getRandomValues(new Uint8Array(32)) });

const MESSAGE = [
  "From: receipts@example.com",
  "Subject: Your reservation",
  "MIME-Version: 1.0",
  'Content-Type: text/plain; charset="utf-8"',
  "",
  "Confirmation ABC123 for the Grand Hotel, 12 August 2026.",
].join("\r\n");

beforeEach(async () => {
  await env.DB.exec("DELETE FROM draft_booking");
  await env.DB.exec("DELETE FROM inbound_email");
  await env.DB.exec("DELETE FROM household_settings");
  await env.DB.exec("DELETE FROM household");
  await env.DB.prepare("INSERT INTO household (id,name,created_at) VALUES (?,?,?)")
    .bind("hh-a", "A", new Date().toISOString())
    .run();
});

/** A Workers AI stand-in that always finds one lodging booking. */
function setup(who: Identity = identity) {
  const run = vi.fn(async () => ({
    response: JSON.stringify({
      bookings: [{ kind: "lodging", title: "Grand Hotel", confirmationNumber: "ABC123" }],
    }),
  }));
  const app = createApp({ verify: async () => who, ring });
  const bindings = { DB: env.DB, AI: { run } } as unknown as AppBindings;
  return { app, bindings, run };
}

function emails(): InboundEmailRepo {
  return new InboundEmailRepo(env.DB, { householdId: "hh-a", userId: "u1", role: "owner" }, ring);
}

async function storeMessage(raw = MESSAGE) {
  return await emails().create({ from: "receipts@example.com", to: "trips@example.com", subject: "Your reservation", raw });
}

/** Backdate a row past every retention window and sweep it. */
async function expire(id: string): Promise<void> {
  await env.DB.prepare("UPDATE inbound_email SET received_at = ? WHERE id = ?")
    .bind(new Date(Date.now() - (RAW_RETENTION_UNRESOLVED_DAYS + 1) * 86_400_000).toISOString(), id)
    .run();
  await emails().purgeExpiredRaw();
}

describe("GET /api/inbound-emails/:id retention disclosure", () => {
  it("tells the reader when a retained message is due to be deleted", async () => {
    const { app, bindings } = setup();
    const email = await storeMessage();

    const res = await app.request(`/api/inbound-emails/${email.id}`, undefined, bindings);
    expect(res.status).toBe(200);
    const detail = await res.json() as InboundEmailDetail;
    expect(detail.rawState).toBe("retained");
    expect(detail.rawUnavailableReason).toBeNull();
    expect(Date.parse(detail.rawExpiresAt!)).toBeGreaterThan(Date.now());
    // Encryption at rest is invisible from up here: the body still reads.
    expect(detail.textBody).toContain("Confirmation ABC123");
  });

  it("says a purged message was retained and then deleted, not that none was stored", async () => {
    const { app, bindings } = setup();
    const email = await storeMessage();
    await expire(email.id);

    const detail = await (await app.request(
      `/api/inbound-emails/${email.id}`,
      undefined,
      bindings,
    )).json() as InboundEmailDetail;

    expect(detail.rawState).toBe("purged");
    expect(detail.textBody).toBeNull();
    expect(detail.rawExpiresAt).toBeNull();
    expect(detail.rawUnavailableReason).toMatch(/no longer retained/i);
    // The row itself is untouched, which is why the activity feed and every
    // booking's provenance link still work after the message is gone.
    expect(detail.from).toBe("receipts@example.com");
    expect(detail.subject).toBe("Your reservation");
  });

  it("distinguishes a message that was never stored from one that was purged", async () => {
    const { app, bindings } = setup();
    const rejected = await emails().create({
      from: "spammer@example.com",
      to: "trips@example.com",
      raw: "",
      status: "rejected",
      error: "sender is not on the household allowlist",
    });

    const detail = await (await app.request(
      `/api/inbound-emails/${rejected.id}`,
      undefined,
      bindings,
    )).json() as InboundEmailDetail;
    expect(detail.rawState).toBe("never-stored");
    expect(detail.rawUnavailableReason).toMatch(/No copy .* was stored/i);
  });
});

describe("POST /api/imports/:id/reextract", () => {
  it("re-runs extraction while the message is still retained", async () => {
    const { app, bindings, run } = setup();
    const email = await storeMessage();

    const res = await app.request(
      `/api/imports/${email.id}/reextract`,
      { method: "POST" },
      bindings,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      inboundEmailId: email.id,
      status: "extracted",
      bookings: [expect.objectContaining({ title: "Grand Hotel" })],
    });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("answers 410 with a plain explanation once the raw has been purged", async () => {
    const { app, bindings, run } = setup();
    const email = await storeMessage();
    await expire(email.id);

    const res = await app.request(
      `/api/imports/${email.id}/reextract`,
      { method: "POST" },
      bindings,
    );
    // Not a silent empty extraction reported as "no bookings found" — that
    // reads as a model failure and invites the user to keep retrying
    // something that can never succeed.
    expect(res.status).toBe(410);
    expect(await res.json()).toEqual({
      error: expect.stringMatching(/no longer retained.*cannot be re-run/is),
    });
    expect(run).not.toHaveBeenCalled();
    // And nothing was written off the back of an empty message.
    const { results } = await env.DB.prepare("SELECT id FROM draft_booking").all();
    expect(results).toEqual([]);
  });

  it("404s an email from another household and 403s a viewer", async () => {
    const { app, bindings } = setup();
    const email = await storeMessage();

    const missing = await app.request(
      "/api/imports/nope/reextract",
      { method: "POST" },
      bindings,
    );
    expect(missing.status).toBe(404);

    const viewerApp = setup({ ...identity, role: "viewer" });
    const forbidden = await viewerApp.app.request(
      `/api/imports/${email.id}/reextract`,
      { method: "POST" },
      viewerApp.bindings,
    );
    expect(forbidden.status).toBe(403);
  });
});

describe("opportunistic retention sweep on the review path", () => {
  it("purges expired raw when a draft is dismissed", async () => {
    const { app, bindings } = setup();
    const stale = await storeMessage();
    const current = await storeMessage();
    const drafts = await new DraftBookingRepo(env.DB, {
      householdId: "hh-a",
      userId: "u1",
      role: "owner",
    }).createMany([
      { inboundEmailId: current.id, ordinal: 0, kind: "lodging", title: "Grand Hotel", source: "ai" },
    ]);
    await env.DB.prepare("UPDATE inbound_email SET received_at = ? WHERE id = ?")
      .bind(
        new Date(Date.now() - (RAW_RETENTION_UNRESOLVED_DAYS + 1) * 86_400_000).toISOString(),
        stale.id,
      )
      .run();

    const res = await app.request("/api/imports/dismiss", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ draftIds: [drafts[0]!.id] }),
    }, bindings);
    expect(res.status).toBe(200);

    // The dismissal is the trigger; the row it swept is a different one, which
    // is the whole idea of an opportunistic sweep with no cron behind it.
    expect((await emails().findById(stale.id))?.rawState).toBe("purged");
    expect((await emails().findById(current.id))?.rawState).toBe("retained");
  });
});
