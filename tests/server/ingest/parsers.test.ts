import { describe, expect, it } from "vitest";
import { parseIcs } from "../../../src/server/ingest/ics.js";
import { parseMime } from "../../../src/server/ingest/mime.js";

describe("parseMime", () => {
  it("decodes nested multipart calendar and quoted-printable text", () => {
    const calendar = [
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "DTSTART:20261009T154000Z",
      "SUMMARY:Trip",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");
    const raw = [
      'Content-Type: multipart/mixed; boundary="OuterX"',
      "Subject: Folded",
      "\tSubject",
      "",
      "--OuterX",
      'Content-Type: multipart/alternative; boundary="InnerY"',
      "",
      "--InnerY",
      "Content-Type: text/plain",
      "Content-Transfer-Encoding: quoted-printable",
      "",
      "Confirmation=20ABC123",
      "--InnerY--",
      "--OuterX",
      "Content-Type: text/calendar",
      "Content-Transfer-Encoding: base64",
      "",
      btoa(calendar),
      "--OuterX--",
    ].join("\r\n");

    expect(parseMime(raw)).toEqual({
      from: null,
      subject: "Folded Subject",
      textBody: "Confirmation ABC123",
      calendars: [calendar],
    });
  });
});

describe("parseIcs", () => {
  it("unfolds values and accepts UTC events", () => {
    expect(parseIcs([
      "BEGIN:VEVENT",
      "DTSTART:20261009T154000Z",
      "SUMMARY:Long ",
      " title",
      "LOCATION:Boise\\, ID",
      "END:VEVENT",
    ].join("\r\n"))).toEqual([
      {
        summary: "Long title",
        location: "Boise, ID",
        description: null,
        startsAt: "2026-10-09T15:40:00.000Z",
        startsAtTz: "UTC",
        endsAt: null,
        endsAtTz: null,
      },
    ]);
  });

  it("rejects floating local times and invalid zones", () => {
    expect(() => parseIcs([
      "BEGIN:VEVENT",
      "DTSTART:20261009T154000",
      "SUMMARY:Floating",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "DTSTART;TZID=Mars/Olympus:20261009T154000",
      "SUMMARY:Bad zone",
      "END:VEVENT",
    ].join("\r\n"))).toThrow("invalid or missing date/time");
  });

  it("rejects impossible and nonexistent DST wall times", () => {
    expect(() => parseIcs([
      "BEGIN:VEVENT",
      "DTSTART;TZID=America/Boise:20260230T120000",
      "END:VEVENT",
    ].join("\r\n"))).toThrow();
    expect(() => parseIcs([
      "BEGIN:VEVENT",
      "DTSTART;TZID=America/Boise:20260308T023000",
      "END:VEVENT",
    ].join("\r\n"))).toThrow();
  });
});
