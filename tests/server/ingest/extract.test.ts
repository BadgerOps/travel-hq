import { describe, it, expect, beforeEach, vi } from "vitest";
import { env } from "cloudflare:test";
import { extractInboundEmail, buildExtractionPrompt } from "../../../src/server/ingest/extract.js";
import type { ExtractionAi } from "../../../src/server/ingest/extract.js";
import { EXTRACTED_JSON_SCHEMA } from "../../../src/server/ingest/extracted.js";
import { InboundEmailRepo } from "../../../src/server/repos/inbound-email.js";
import type { InboundEmail } from "../../../src/server/repos/inbound-email.js";
import { DraftBookingRepo } from "../../../src/server/repos/draft-booking.js";

const HH = "hh-a";

beforeEach(async () => {
  await env.DB.exec("DELETE FROM draft_booking");
  await env.DB.exec("DELETE FROM inbound_email");
  await env.DB.exec("DELETE FROM household");
  await env.DB.prepare("INSERT INTO household (id,name,created_at) VALUES (?,?,?)")
    .bind(HH, "A", new Date().toISOString())
    .run();
});

/** Stores a received row the way ingest does, ready for extraction. */
async function storeEmail(raw: string): Promise<InboundEmail> {
  return InboundEmailRepo.forIngest(env.DB, HH).create({
    from: "badger@example.com",
    to: "trips@badgerops.foo",
    subject: "Your trip",
    raw,
  });
}

/** A fake AI binding. Tests NEVER call the real model. */
function fakeAi(result: unknown): ExtractionAi & { run: ReturnType<typeof vi.fn> } {
  return { run: vi.fn(async () => result) };
}

function run(email: InboundEmail, ai: ExtractionAi | undefined, aiModel = "@cf/meta/llama-3.1-8b-instruct") {
  return extractInboundEmail({ db: env.DB, ai, householdId: HH, aiModel }, email);
}

const ICS_MESSAGE = [
  'Content-Type: multipart/mixed; boundary="B"',
  "",
  "--B",
  "Content-Type: text/plain",
  "",
  "Your flight is attached.",
  "",
  "--B",
  "Content-Type: text/calendar",
  "",
  "BEGIN:VCALENDAR",
  "BEGIN:VEVENT",
  "SUMMARY:Delta 2214 BOI to STS",
  "LOCATION:Boise Airport",
  "DESCRIPTION:Confirmation number: D7WN88",
  "DTSTART;TZID=America/Boise:20261009T094000",
  "DTEND;TZID=America/Los_Angeles:20261009T125500",
  "END:VEVENT",
  "END:VCALENDAR",
  "",
  "--B--",
].join("\r\n");

const PLAIN_MESSAGE = [
  "Subject: Reservation Confirmed",
  "Content-Type: text/plain",
  "",
  "Dawn Ranch Lodge, Oct 9-11. Confirmation D7WN88. Total $612.40.",
].join("\r\n");

const MODEL_BOOKING = {
  kind: "lodging",
  title: "Dawn Ranch Lodge",
  location: "Guerneville, CA",
  startsAt: "2026-10-09T22:00:00.000Z",
  startsAtTz: "America/Los_Angeles",
  endsAt: "2026-10-11T18:00:00.000Z",
  endsAtTz: "America/Los_Angeles",
  confirmationNumber: "D7WN88",
  costCents: 61240,
  details: { propertyName: "Dawn Ranch Lodge" },
};

async function draftsFor(emailId: string) {
  return DraftBookingRepo.forIngest(env.DB, HH).listByEmail(emailId);
}

async function statusOf(emailId: string) {
  const row = await InboundEmailRepo.forIngest(env.DB, HH).findById(emailId);
  return [row?.status, row?.error] as const;
}

describe("extractInboundEmail — .ics-first", () => {
  it("extracts from the calendar attachment WITHOUT touching the model", async () => {
    const ai = fakeAi({ response: { bookings: [MODEL_BOOKING] } });
    const email = await storeEmail(ICS_MESSAGE);

    await run(email, ai);

    expect(ai.run).not.toHaveBeenCalled();
    expect(await statusOf(email.id)).toEqual(["extracted", null]);

    const drafts = await draftsFor(email.id);
    expect(drafts).toHaveLength(1);
    const draft = drafts[0]!;
    expect(draft.source).toBe("ics");
    // Kind is honestly unknown from a VEVENT; the reviewer reclassifies.
    expect(draft.kind).toBe("other");
    expect(draft.title).toBe("Delta 2214 BOI to STS");
    expect(draft.location).toBe("Boise Airport");
    // Real zones from the attachment, one per endpoint.
    expect(draft.startsAt).toBe("2026-10-09T15:40:00.000Z");
    expect(draft.startsAtTz).toBe("America/Boise");
    expect(draft.endsAt).toBe("2026-10-09T19:55:00.000Z");
    expect(draft.endsAtTz).toBe("America/Los_Angeles");
    // Pulled from the VEVENT description.
    expect(draft.confirmationNumber).toBe("D7WN88");
    expect(draft.status).toBe("pending");
  });

  it("creates one draft per VEVENT in a multi-leg itinerary", async () => {
    const twoLegs = ICS_MESSAGE.replace(
      "END:VCALENDAR",
      [
        "BEGIN:VEVENT",
        "SUMMARY:Delta 2215 STS to BOI",
        "DTSTART;TZID=America/Los_Angeles:20261011T130000",
        "END:VEVENT",
        "END:VCALENDAR",
      ].join("\r\n"),
    );
    const email = await storeEmail(twoLegs);
    await run(email, fakeAi("never used"));

    expect(await statusOf(email.id)).toEqual(["extracted", null]);
    expect((await draftsFor(email.id)).map((d) => d.title)).toEqual([
      "Delta 2214 BOI to STS",
      "Delta 2215 STS to BOI",
    ]);
  });

  it("falls through to the model when the calendar part yields no usable events", async () => {
    const uselessIcs = [
      "Content-Type: text/calendar",
      "",
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "SUMMARY:No start time",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");
    const ai = fakeAi({ response: { bookings: [MODEL_BOOKING] } });
    const email = await storeEmail(uselessIcs);

    await run(email, ai);

    expect(ai.run).toHaveBeenCalledTimes(1);
    expect(await statusOf(email.id)).toEqual(["extracted", null]);
    expect((await draftsFor(email.id)).map((d) => d.source)).toEqual(["ai"]);
  });
});

describe("extractInboundEmail — Workers AI JSON Mode", () => {
  it("routes a plain confirmation email to the model and writes drafts from its JSON", async () => {
    const ai = fakeAi({ response: { bookings: [MODEL_BOOKING] } });
    const email = await storeEmail(PLAIN_MESSAGE);

    await run(email, ai, "@cf/meta/llama-3.3-70b-instruct-fp8-fast");

    // The model is called with the settings model, JSON Mode, and the one
    // schema that is the contract.
    expect(ai.run).toHaveBeenCalledTimes(1);
    const [model, inputs] = ai.run.mock.calls[0]! as [string, Record<string, unknown>];
    expect(model).toBe("@cf/meta/llama-3.3-70b-instruct-fp8-fast");
    expect(inputs.response_format).toEqual({ type: "json_schema", json_schema: EXTRACTED_JSON_SCHEMA });
    const messages = inputs.messages as { role: string; content: string }[];
    expect(messages.map((m) => m.role)).toEqual(["system", "user"]);
    expect(messages[1]!.content).toContain("Dawn Ranch Lodge");

    expect(await statusOf(email.id)).toEqual(["extracted", null]);
    const drafts = await draftsFor(email.id);
    expect(drafts).toHaveLength(1);
    const draft = drafts[0]!;
    expect(draft.source).toBe("ai");
    expect(draft.kind).toBe("lodging");
    expect(draft.title).toBe("Dawn Ranch Lodge");
    expect(draft.confirmationNumber).toBe("D7WN88");
    expect(draft.startsAtTz).toBe("America/Los_Angeles");
    // The full payload — costCents and details included — rides along.
    expect(draft.extracted).toMatchObject({ costCents: 61240, details: { propertyName: "Dawn Ranch Lodge" } });
  });

  it("accepts a response delivered as a JSON string", async () => {
    const ai = fakeAi({ response: JSON.stringify({ bookings: [MODEL_BOOKING] }) });
    const email = await storeEmail(PLAIN_MESSAGE);
    await run(email, ai);
    expect(await statusOf(email.id)).toEqual(["extracted", null]);
    expect(await draftsFor(email.id)).toHaveLength(1);
  });

  it("softens a model booking with an unusable timestamp pair instead of failing it", async () => {
    const ai = fakeAi({
      response: { bookings: [{ ...MODEL_BOOKING, startsAt: "2026-10-09T22:00:00.000Z", startsAtTz: null }] },
    });
    const email = await storeEmail(PLAIN_MESSAGE);
    await run(email, ai);
    const [draft] = await draftsFor(email.id);
    expect(draft?.startsAt).toBeNull();
    expect(draft?.startsAtTz).toBeNull();
    expect(draft?.endsAt).toBe("2026-10-11T18:00:00.000Z");
  });

  it("degrades a model booking whose per-kind details fail to kind other", async () => {
    const ai = fakeAi({
      response: { bookings: [{ ...MODEL_BOOKING, kind: "flight", details: {} }] },
    });
    const email = await storeEmail(PLAIN_MESSAGE);
    await run(email, ai);
    const [draft] = await draftsFor(email.id);
    expect(draft?.kind).toBe("other");
  });
});

describe("extractInboundEmail — failure paths (fail-soft, no partial drafts)", () => {
  it("marks the email failed when the model response is not JSON at all", async () => {
    const ai = fakeAi({ response: "Sorry, I could not read this email." });
    const email = await storeEmail(PLAIN_MESSAGE);

    await run(email, ai);

    const [status, error] = await statusOf(email.id);
    expect(status).toBe("failed");
    expect(error).toContain("Extraction failed:");
    expect(error).toContain("not valid JSON");
    expect(await draftsFor(email.id)).toEqual([]);
  });

  it("marks the email failed when the response is JSON of the wrong shape", async () => {
    const ai = fakeAi({ response: { reservations: ["not the contract"] } });
    const email = await storeEmail(PLAIN_MESSAGE);
    await run(email, ai);
    expect((await statusOf(email.id))[0]).toBe("failed");
    expect(await draftsFor(email.id)).toEqual([]);
  });

  it("marks the email failed when the model returns an empty bookings list", async () => {
    const ai = fakeAi({ response: { bookings: [] } });
    const email = await storeEmail(PLAIN_MESSAGE);
    await run(email, ai);
    const [status, error] = await statusOf(email.id);
    expect(status).toBe("failed");
    expect(error).toContain("no bookings");
    expect(await draftsFor(email.id)).toEqual([]);
  });

  it("writes NO partial drafts when one booking in the response is malformed", async () => {
    const ai = fakeAi({
      response: { bookings: [MODEL_BOOKING, { kind: "spaceship", title: "X", details: {} }] },
    });
    const email = await storeEmail(PLAIN_MESSAGE);
    await run(email, ai);
    expect((await statusOf(email.id))[0]).toBe("failed");
    expect(await draftsFor(email.id)).toEqual([]);
  });

  it("marks the email failed when the model call itself throws, and never propagates", async () => {
    const ai: ExtractionAi = {
      run: async () => {
        throw new Error("Workers AI is on fire");
      },
    };
    const email = await storeEmail(PLAIN_MESSAGE);
    await expect(run(email, ai)).resolves.toBeUndefined();
    const [status, error] = await statusOf(email.id);
    expect(status).toBe("failed");
    expect(error).toBe("Extraction failed: Workers AI is on fire");
    expect(await draftsFor(email.id)).toEqual([]);
  });

  it("leaves a model-path email queued as received when no AI binding is configured", async () => {
    // A stripped env without [ai] must degrade to storage-only ingest, not
    // fail mail for a deployment gap. The .ics path still works there.
    const email = await storeEmail(PLAIN_MESSAGE);
    await run(email, undefined);
    expect(await statusOf(email.id)).toEqual(["received", null]);
    expect(await draftsFor(email.id)).toEqual([]);

    const icsEmail = await storeEmail(ICS_MESSAGE);
    await run(icsEmail, undefined);
    expect(await statusOf(icsEmail.id)).toEqual(["extracted", null]);
  });
});

describe("buildExtractionPrompt", () => {
  it("hands the model the subject, sender, and text body", () => {
    const prompt = buildExtractionPrompt({
      from: "res@dawnranch.com",
      subject: "Reservation Confirmed",
      textBody: "Confirmation D7WN88",
      calendars: [],
    });
    expect(prompt.system).toContain("travel confirmation emails");
    expect(prompt.user).toContain("Subject: Reservation Confirmed");
    expect(prompt.user).toContain("From: res@dawnranch.com");
    expect(prompt.user).toContain("D7WN88");
  });

  it("says so when there is no text body rather than sending nothing", () => {
    const prompt = buildExtractionPrompt({ from: null, subject: null, textBody: null, calendars: [] });
    expect(prompt.user).toContain("(no text body)");
  });
});
