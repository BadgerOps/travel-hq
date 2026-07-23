import { beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:test";
import { extractInboundEmail } from "../../../src/server/ingest/extract.js";
import type { ExtractionAi } from "../../../src/server/ingest/extract.js";
import { EXTRACTED_JSON_SCHEMA } from "../../../src/server/ingest/extracted.js";
import { InboundEmailRepo } from "../../../src/server/repos/inbound-email.js";
import type { InboundEmail } from "../../../src/server/repos/inbound-email.js";
import { DraftBookingRepo } from "../../../src/server/repos/draft-booking.js";

const HOUSEHOLD = "extract-household";

beforeEach(async () => {
  await env.DB.exec("DELETE FROM draft_booking");
  await env.DB.exec("DELETE FROM inbound_email");
  await env.DB.exec("DELETE FROM household");
  await env.DB.prepare("INSERT INTO household (id,name,created_at) VALUES (?,?,?)")
    .bind(HOUSEHOLD, "Extract", new Date().toISOString())
    .run();
});

async function store(raw: string): Promise<InboundEmail> {
  return InboundEmailRepo.forIngest(env.DB, HOUSEHOLD).create({
    from: "booking@example.com",
    to: "trips@example.com",
    subject: "Reservation",
    raw,
  });
}

function fakeAi(result: unknown): ExtractionAi & { run: ReturnType<typeof vi.fn> } {
  return { run: vi.fn(async () => result) };
}

async function run(email: InboundEmail, ai?: ExtractionAi): Promise<void> {
  await extractInboundEmail(
    { db: env.DB, ai, householdId: HOUSEHOLD, aiModel: "@cf/test/model" },
    email,
  );
}

async function status(id: string) {
  return InboundEmailRepo.forIngest(env.DB, HOUSEHOLD).findById(id);
}

async function drafts(id: string) {
  return DraftBookingRepo.forIngest(env.DB, HOUSEHOLD).listByEmail(id);
}

const CALENDAR_MESSAGE = [
  'Content-Type: multipart/mixed; boundary="CaseSensitiveB"',
  "",
  "--CaseSensitiveB",
  "Content-Type: text/plain",
  "",
  "Calendar attached.",
  "--CaseSensitiveB",
  "Content-Type: text/calendar",
  "",
  "BEGIN:VCALENDAR",
  "BEGIN:VEVENT",
  "SUMMARY:Flight BOI to STS",
  "LOCATION:Boise Airport",
  "DESCRIPTION:Confirmation number: ABC123",
  "DTSTART;TZID=America/Boise:20261009T094000",
  "DTEND;TZID=America/Los_Angeles:20261009T125500",
  "END:VEVENT",
  "END:VCALENDAR",
  "--CaseSensitiveB--",
].join("\r\n");

const MODEL_BOOKING = {
  kind: "lodging",
  title: "Dawn Ranch",
  location: "Guerneville, CA",
  startsAt: "2026-10-09T22:00:00.000Z",
  startsAtTz: "America/Los_Angeles",
  endsAt: "2026-10-11T18:00:00.000Z",
  endsAtTz: "America/Los_Angeles",
  confirmationNumber: "D7WN88",
  costCents: 61240,
  details: { propertyName: "Dawn Ranch" },
};

describe("extractInboundEmail", () => {
  it("prefers a calendar attachment and never touches AI", async () => {
    const ai = fakeAi({ response: { bookings: [MODEL_BOOKING] } });
    const email = await store(CALENDAR_MESSAGE);
    await run(email, ai);

    expect(ai.run).not.toHaveBeenCalled();
    expect((await status(email.id))?.status).toBe("extracted");
    expect(await drafts(email.id)).toMatchObject([
      {
        ordinal: 0,
        source: "ics",
        kind: "other",
        title: "Flight BOI to STS",
        startsAt: "2026-10-09T15:40:00.000Z",
        startsAtTz: "America/Boise",
        endsAt: "2026-10-09T19:55:00.000Z",
        confirmationNumber: "ABC123",
        status: "pending",
      },
    ]);
  });

  it("fails an unusable calendar without falling through to AI", async () => {
    const ai = fakeAi({ response: { bookings: [MODEL_BOOKING] } });
    const email = await store([
      "Content-Type: text/calendar",
      "",
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "SUMMARY:Missing start",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n"));
    await run(email, ai);

    expect(ai.run).not.toHaveBeenCalled();
    expect((await status(email.id))?.status).toBe("failed");
    expect((await status(email.id))?.error).toContain("invalid or missing date/time");
    expect(await drafts(email.id)).toEqual([]);
  });

  it("writes no drafts when any VEVENT in a calendar is malformed", async () => {
    const mixed = CALENDAR_MESSAGE.replace(
      "END:VCALENDAR",
      [
        "BEGIN:VEVENT",
        "SUMMARY:Broken second leg",
        "DTSTART:20261011T130000",
        "END:VEVENT",
        "END:VCALENDAR",
      ].join("\r\n"),
    );
    const ai = fakeAi({ response: { bookings: [MODEL_BOOKING] } });
    const email = await store(mixed);
    await run(email, ai);

    expect(ai.run).not.toHaveBeenCalled();
    expect((await status(email.id))?.status).toBe("failed");
    expect(await drafts(email.id)).toEqual([]);
  });

  it("uses the configured AI model and strict schema for plain mail", async () => {
    const ai = fakeAi({ response: { bookings: [MODEL_BOOKING] } });
    const email = await store("Subject: Lodge\r\n\r\nDawn Ranch confirmation D7WN88");
    await run(email, ai);

    expect(ai.run).toHaveBeenCalledTimes(1);
    expect(ai.run.mock.calls[0]?.[0]).toBe("@cf/test/model");
    expect(ai.run.mock.calls[0]?.[1]).toMatchObject({
      response_format: { type: "json_schema", json_schema: EXTRACTED_JSON_SCHEMA },
    });
    expect((await status(email.id))?.status).toBe("extracted");
    expect(await drafts(email.id)).toMatchObject([
      {
        source: "ai",
        kind: "lodging",
        title: "Dawn Ranch",
        extracted: { costCents: 61240 },
      },
    ]);
  });

  it.each([
    ["empty", { response: { bookings: [] } }],
    ["malformed", { response: "not json" }],
    ["partially invalid", { response: { bookings: [MODEL_BOOKING, { kind: "spaceship", title: "Bad" }] } }],
  ])("marks a %s model response failed and writes no partial drafts", async (_name, response) => {
    const email = await store("Subject: Plain\r\n\r\nbody");
    await run(email, fakeAi(response));
    expect((await status(email.id))?.status).toBe("failed");
    expect(await drafts(email.id)).toEqual([]);
  });

  it("leaves plain mail received when the AI binding is unavailable", async () => {
    const email = await store("Subject: Plain\r\n\r\nbody");
    await run(email);
    expect((await status(email.id))?.status).toBe("received");
    expect(await drafts(email.id)).toEqual([]);
  });

  it("finishes a post-commit retry without creating duplicate drafts", async () => {
    const email = await store(CALENDAR_MESSAGE);
    await run(email);
    await env.DB.prepare("UPDATE inbound_email SET status = 'received' WHERE id = ?")
      .bind(email.id)
      .run();

    await run({ ...email, status: "received" }, fakeAi({ response: { bookings: [MODEL_BOOKING] } }));

    expect((await status(email.id))?.status).toBe("extracted");
    expect(await drafts(email.id)).toHaveLength(1);
  });
});
