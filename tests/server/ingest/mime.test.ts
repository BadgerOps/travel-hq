import { describe, it, expect } from "vitest";
import { parseMime } from "../../../src/server/ingest/mime.js";

const MULTIPART = [
  "From: reservations@dawnranch.com",
  "Subject: Reservation Confirmed",
  'Content-Type: multipart/mixed; boundary="BOUND1"',
  "",
  "--BOUND1",
  "Content-Type: text/plain; charset=utf-8",
  "",
  "Confirmation number: D7WN88",
  "",
  "--BOUND1",
  'Content-Type: text/calendar; name="invite.ics"',
  "Content-Transfer-Encoding: base64",
  "",
  btoa("BEGIN:VCALENDAR\r\nEND:VCALENDAR"),
  "",
  "--BOUND1--",
].join("\r\n");

describe("parseMime", () => {
  it("reads the headers it needs", () => {
    const mail = parseMime(MULTIPART);
    expect(mail.from).toBe("reservations@dawnranch.com");
    expect(mail.subject).toBe("Reservation Confirmed");
  });

  it("reads the plain-text part", () => {
    expect(parseMime(MULTIPART).textBody).toContain("D7WN88");
  });

  it("decodes a base64 calendar attachment", () => {
    const [ics] = parseMime(MULTIPART).calendars;
    expect(ics).toContain("BEGIN:VCALENDAR");
  });

  it("handles a message with no multipart wrapper at all", () => {
    const plain = ["Subject: Hi", "Content-Type: text/plain", "", "Just text."].join("\r\n");
    const mail = parseMime(plain);
    expect(mail.textBody).toBe("Just text.");
    expect(mail.calendars).toEqual([]);
  });

  it("unfolds a header split across lines", () => {
    const folded = ["Subject: Reservation", "  Confirmed", "", "body"].join("\r\n");
    expect(parseMime(folded).subject).toBe("Reservation Confirmed");
  });

  it("strips display-name syntax from From", () => {
    const withName = ['From: "Dawn Ranch" <res@dawnranch.com>', "", "body"].join("\r\n");
    expect(parseMime(withName).from).toBe("res@dawnranch.com");
  });

  it("survives a truncated message rather than throwing", () => {
    // Ingest stores whatever Email Routing handed it, truncation marker and
    // all. A parser that throws here fails the extraction of a real email.
    expect(() => parseMime("")).not.toThrow();
    expect(parseMime("").textBody).toBe(null);
  });

  it("prefers text/plain over text/html when both are present", () => {
    const both = [
      'Content-Type: multipart/alternative; boundary="B"',
      "",
      "--B",
      "Content-Type: text/html",
      "",
      "<p>markup</p>",
      "",
      "--B",
      "Content-Type: text/plain",
      "",
      "the words",
      "",
      "--B--",
    ].join("\r\n");
    expect(parseMime(both).textBody).toBe("the words");
  });

  it("decodes a quoted-printable body, multi-byte characters included", () => {
    const qp = [
      "Content-Type: text/plain; charset=utf-8",
      "Content-Transfer-Encoding: quoted-printable",
      "",
      "Caf=C3=A9 booking con=",
      "firmed",
    ].join("\r\n");
    expect(parseMime(qp).textBody).toBe("Café booking confirmed");
  });

  it("recurses into a nested multipart to find the calendar part", () => {
    const nested = [
      'Content-Type: multipart/mixed; boundary="OUTER"',
      "",
      "--OUTER",
      'Content-Type: multipart/alternative; boundary="INNER"',
      "",
      "--INNER",
      "Content-Type: text/plain",
      "",
      "words",
      "",
      "--INNER--",
      "",
      "--OUTER",
      "Content-Type: text/calendar",
      "",
      "BEGIN:VCALENDAR",
      "END:VCALENDAR",
      "",
      "--OUTER--",
    ].join("\r\n");
    const mail = parseMime(nested);
    expect(mail.textBody).toBe("words");
    expect(mail.calendars).toHaveLength(1);
  });
});
