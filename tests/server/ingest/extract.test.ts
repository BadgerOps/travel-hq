import { beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:test";
import {
  buildExtractionPrompt,
  extractInboundEmail,
  MAX_AI_TEXT_CHARS,
} from "../../../src/server/ingest/extract.js";
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
        extracted: { costCents: 61240, extractionProvider: "workers-ai" },
      },
    ]);
  });

  it("classifies an RV park as lodging and converts its local check-in deterministically", async () => {
    const ai = fakeAi({
      response: {
        bookings: [{
          kind: "other",
          title: "Silverwood RV Park Reservation",
          location: "Silverwood RV Park",
          startsAt: "2026-07-29T13:00:00",
          startsAtTz: "America/Boise",
          endsAt: "2026-07-30T10:00:00",
          endsAtTz: "America/Boise",
          confirmationNumber: "218088",
          costCents: 16_416,
          details: { site: "1", type: "RV", waterParkOpen: true },
        }],
      },
    });
    const email = await store("Subject: RV park\r\n\r\nSite 1, check in 1 PM");
    await run(email, ai);

    expect(await drafts(email.id)).toMatchObject([{
      kind: "lodging",
      startsAt: "2026-07-29T19:00:00.000Z",
      endsAt: "2026-07-30T16:00:00.000Z",
      extracted: {
        details: {
          propertyName: "Silverwood RV Park Reservation",
          site: "1",
          type: "RV",
          waterParkOpen: true,
        },
      },
    }]);
  });

  it("sends HTML-only forwarded booking details to AI as readable text", async () => {
    const ai = fakeAi({ response: { bookings: [MODEL_BOOKING] } });
    const email = await store([
      "Subject: Fwd: Your hotel is confirmed",
      "Content-Type: text/html",
      "",
      "<h1>Dawn Ranch</h1><p>Confirmation <b>D7WN88</b></p>",
      "<p>Check-in October 9 &amp; checkout October 11</p>",
    ].join("\r\n"));

    await run(email, ai);

    const messages = ai.run.mock.calls[0]?.[1].messages as { role: string; content: string }[];
    expect(messages[1]?.content).toContain("Dawn Ranch");
    expect(messages[1]?.content).toContain("Confirmation D7WN88");
    expect(messages[1]?.content).toContain("October 9 & checkout October 11");
    expect((await status(email.id))?.status).toBe("extracted");
  });

  it("sends an attached forwarded airline message to AI", async () => {
    const ai = fakeAi({ response: { bookings: [MODEL_BOOKING] } });
    const email = await store([
      "Subject: Please import",
      "Content-Type: message/rfc822",
      "",
      "From: receipts@airline.example",
      "Subject: Flight confirmation Q7FLY9",
      "Content-Type: text/html",
      "",
      "<p>Flight 2214 from BOI to STS</p><p>October 9 at 9:40 AM</p>",
    ].join("\r\n"));

    await run(email, ai);

    const messages = ai.run.mock.calls[0]?.[1].messages as { role: string; content: string }[];
    expect(messages[1]?.content).toContain("Forwarded subject: Flight confirmation Q7FLY9");
    expect(messages[1]?.content).toContain("Forwarded from: receipts@airline.example");
    expect(messages[1]?.content).toContain("Flight 2214 from BOI to STS");
    expect((await status(email.id))?.status).toBe("extracted");
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

describe("buildExtractionPrompt", () => {
  it("appends household notes after fixed rules in a delimited section", () => {
    const prompt = buildExtractionPrompt({
      from: "sender@example.com",
      subject: "Confirmation",
      textBody: "Body",
      calendars: [],
    }, "Prefer Boise departures.");
    expect(prompt.system).toContain("Copy confirmation numbers exactly");
    expect(prompt.system).toContain(
      "Do not include a forwarding sender or recipient",
    );
    expect(prompt.system).toContain("local wall-clock");
    expect(prompt.system).toContain("RV parks as lodging");
    expect(prompt.system).toContain("Household notes");
    expect(prompt.system).toContain("Prefer Boise departures.");
    expect(prompt.system.indexOf("Household notes")).toBeGreaterThan(
      prompt.system.indexOf("Copy confirmation numbers exactly"),
    );
  });

  it("bounds large forwarded emails while preserving their tail", () => {
    const prompt = buildExtractionPrompt({
      from: "sender@example.com",
      subject: "Large confirmation",
      textBody: `${"A".repeat(MAX_AI_TEXT_CHARS + 10_000)}TAIL-CONFIRMATION`,
      calendars: [],
    });
    expect(prompt.user).toContain("email text truncated for model context");
    expect(prompt.user).toContain("TAIL-CONFIRMATION");
    expect(prompt.user.length).toBeLessThan(MAX_AI_TEXT_CHARS + 200);
  });
});
