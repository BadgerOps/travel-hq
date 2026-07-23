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

  it("turns an HTML-only airline confirmation into readable prompt text", () => {
    const parsed = parseMime([
      "From: Delta <receipts@delta.com>",
      "Subject: Your flight is confirmed",
      "Content-Type: text/html; charset=utf-8",
      "",
      "<html><head><style>.hidden{display:none}</style></head><body>",
      "<h1>Flight DL 2214</h1>",
      "<table><tr><td>BOI</td><td>&rarr;</td><td>STS</td></tr></table>",
      "<p>Confirmation: <strong>D7WN88</strong> &amp; total &#36;412.50</p>",
      "<script>stealSecrets()</script>",
      "</body></html>",
    ].join("\r\n"));

    expect(parsed.textBody).toContain("Flight DL 2214");
    expect(parsed.textBody).toContain("BOI");
    expect(parsed.textBody).toContain("STS");
    expect(parsed.textBody).toContain("D7WN88 & total $412.50");
    expect(parsed.textBody).not.toContain("display:none");
    expect(parsed.textBody).not.toContain("stealSecrets");
  });

  it("recurses into an attached forwarded hotel confirmation", () => {
    const parsed = parseMime([
      "Subject: Fwd: hotel",
      'Content-Type: multipart/mixed; boundary="ForwardB"',
      "",
      "--ForwardB",
      "Content-Type: text/plain",
      "",
      "Please import this trip.",
      "--ForwardB",
      "Content-Type: message/rfc822",
      "",
      "From: reservations@hotel.example",
      "Subject: Dawn Ranch reservation confirmed",
      "Content-Type: text/html",
      "",
      "<p>Check-in: October 9</p><p>Confirmation H0TEL42</p>",
      "--ForwardB--",
    ].join("\r\n"));

    expect(parsed.textBody).toContain("Please import this trip.");
    expect(parsed.textBody).toContain("Forwarded subject: Dawn Ranch reservation confirmed");
    expect(parsed.textBody).toContain("Forwarded from: reservations@hotel.example");
    expect(parsed.textBody).toContain("Check-in: October 9");
    expect(parsed.textBody).toContain("Confirmation H0TEL42");
  });

  it("rejects pathologically deep forwarded-message nesting", () => {
    let raw = "Content-Type: text/plain\r\n\r\nConfirmation ABC123";
    for (let depth = 0; depth < 22; depth++) {
      raw = `Content-Type: message/rfc822\r\n\r\n${raw}`;
    }
    expect(() => parseMime(raw)).toThrow("MIME nesting exceeds");
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
