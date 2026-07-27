import { beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:test";
import { createApp } from "../../../src/server/index.js";
import type { AppBindings } from "../../../src/server/index.js";
import type { Identity } from "../../../src/server/auth.js";
import { Keyring } from "../../../src/server/crypto/envelope.js";
import type { FileImportResult } from "../../../src/server/routes/imports.js";
import { MAX_IMPORT_EML_BYTES } from "../../../src/server/routes/imports.js";
import {
  DELTA_BOOKINGS_90_DAYS,
  DELTA_EML_90_DAYS,
  DELTA_ITINERARY_90_DAYS,
} from "../../fixtures/delta-itinerary.js";

const identity: Identity = {
  userId: "u1",
  email: "owner@example.com",
  householdId: "hh-a",
  role: "owner",
};
const ring = new Keyring("test", { test: crypto.getRandomValues(new Uint8Array(32)) });

beforeEach(async () => {
  await env.DB.exec("DELETE FROM draft_booking");
  await env.DB.exec("DELETE FROM inbound_email");
  await env.DB.exec("DELETE FROM household_settings");
  await env.DB.exec("DELETE FROM household");
  await env.DB.prepare("INSERT INTO household (id,name,created_at) VALUES (?,?,?)")
    .bind("hh-a", "A", new Date().toISOString())
    .run();
});

function setup(who: Identity = identity) {
  const toMarkdown = vi.fn(async () => ({
    id: "converted",
    name: "trip.pdf",
    mimeType: "application/pdf",
    format: "markdown" as const,
    tokens: 1_200,
    data: DELTA_ITINERARY_90_DAYS,
  }));
  const run = vi.fn(async (_model: string, input: {
    messages: Array<{ role: string; content: string }>;
  }) => {
    const prompt = input.messages.at(-1)?.content ?? "";
    expect(prompt).toContain("TRIP90");
    expect(prompt).toContain("10/21/2026");
    expect(prompt).toContain("DL 9674");
    return {
      response: `\`\`\`json\n${JSON.stringify({ bookings: DELTA_BOOKINGS_90_DAYS })}\n\`\`\``,
    };
  });
  const app = createApp({ verify: async () => who, ring });
  const bindings = { DB: env.DB, AI: { toMarkdown, run } } as unknown as AppBindings;
  return { app, bindings, toMarkdown, run };
}

function uploadForm(file = new File(["%PDF-1.4 test"], "delta-trip.pdf", {
  type: "application/pdf",
})) {
  const body = new FormData();
  body.set("file", file);
  return body;
}

describe("POST /api/imports/file", () => {
  it("converts the shifted Delta PDF text and creates all three drafts", async () => {
    const { app, bindings, toMarkdown, run } = setup();
    const res = await app.request("/api/imports/file", {
      method: "POST",
      body: uploadForm(),
    }, bindings);

    expect(res.status).toBe(200);
    const result = await res.json() as FileImportResult;
    expect(result).toMatchObject({
      status: "extracted",
      error: null,
      bookings: DELTA_BOOKINGS_90_DAYS,
    });
    expect(result.inboundEmailId).toEqual(expect.any(String));
    expect(toMarkdown).toHaveBeenCalledWith(
      expect.objectContaining({ name: "delta-trip.pdf" }),
      { conversionOptions: { pdf: { metadata: false } } },
    );
    expect(run).toHaveBeenCalledTimes(1);

    const email = await env.DB.prepare(
      "SELECT from_address, subject, raw, status FROM inbound_email",
    ).first<{
      from_address: string;
      subject: string;
      raw: string;
      status: string;
    }>();
    expect(email).toMatchObject({
      from_address: "file-import@travel-hq.invalid",
      subject: "File import: delta-trip.pdf",
      status: "extracted",
    });
    expect(email?.raw).toContain(DELTA_ITINERARY_90_DAYS);

    const { results: drafts } = await env.DB.prepare(
      `SELECT ordinal, title, starts_at, starts_at_tz, ends_at, ends_at_tz,
              confirmation_number, source
         FROM draft_booking ORDER BY ordinal`,
    ).all();
    expect(drafts).toMatchObject(DELTA_BOOKINGS_90_DAYS.map((booking, ordinal) => ({
      ordinal,
      title: booking.title,
      starts_at: booking.startsAt,
      starts_at_tz: booking.startsAtTz,
      ends_at: booking.endsAt,
      ends_at_tz: booking.endsAtTz,
      confirmation_number: "TRIP90",
      source: "ai",
    })));
  });

  it("imports a raw EML through the same MIME and extraction path without PDF conversion", async () => {
    const { app, bindings, toMarkdown, run } = setup();
    // Browsers commonly leave .eml MIME types blank, so extension detection
    // must work without relying on message/rfc822.
    const eml = new File([DELTA_EML_90_DAYS], "delta-trip.eml");
    const res = await app.request("/api/imports/file", {
      method: "POST",
      body: uploadForm(eml),
    }, bindings);

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      status: "extracted",
      error: null,
      bookings: DELTA_BOOKINGS_90_DAYS,
    });
    expect(toMarkdown).not.toHaveBeenCalled();
    expect(run).toHaveBeenCalledTimes(1);

    const email = await env.DB.prepare(
      "SELECT from_address, subject, raw, status FROM inbound_email",
    ).first<{
      from_address: string;
      subject: string;
      raw: string;
      status: string;
    }>();
    expect(email).toEqual({
      from_address: "receipts@delta.example",
      subject: "Delta.com Trip Information",
      raw: DELTA_EML_90_DAYS,
      status: "extracted",
    });
  });

  it("rejects missing and unsupported uploads before conversion", async () => {
    const { app, bindings, toMarkdown } = setup();
    const missing = await app.request("/api/imports/file", {
      method: "POST",
      body: new FormData(),
    }, bindings);
    expect(missing.status).toBe(400);

    const text = await app.request("/api/imports/file", {
      method: "POST",
      body: uploadForm(new File(["hello"], "notes.txt", { type: "text/plain" })),
    }, bindings);
    expect(text.status).toBe(415);
    expect(toMarkdown).not.toHaveBeenCalled();
  });

  it("rejects an EML larger than the forwarded-email storage limit", async () => {
    const { app, bindings, toMarkdown, run } = setup();
    const oversized = new File(
      [new Uint8Array(MAX_IMPORT_EML_BYTES + 1)],
      "oversized.eml",
      { type: "message/rfc822" },
    );
    const res = await app.request("/api/imports/file", {
      method: "POST",
      body: uploadForm(oversized),
    }, bindings);

    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: "EML files must be 1 MB or smaller" });
    expect(toMarkdown).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it("blocks viewers without spending a conversion call", async () => {
    const { app, bindings, toMarkdown } = setup({ ...identity, role: "viewer" });
    const res = await app.request("/api/imports/file", {
      method: "POST",
      body: uploadForm(),
    }, bindings);
    expect(res.status).toBe(403);
    expect(toMarkdown).not.toHaveBeenCalled();
  });

  it("reports conversion failures without creating an audit row or calling the model", async () => {
    const { app, bindings, toMarkdown, run } = setup();
    toMarkdown.mockResolvedValueOnce({
      id: "failed",
      name: "delta-trip.pdf",
      mimeType: "application/pdf",
      format: "error",
      error: "unsupported PDF encoding",
    } as never);
    const res = await app.request("/api/imports/file", {
      method: "POST",
      body: uploadForm(),
    }, bindings);

    expect(res.status).toBe(422);
    expect(run).not.toHaveBeenCalled();
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS count FROM inbound_email").first(),
    ).toEqual({ count: 0 });
  });
});
