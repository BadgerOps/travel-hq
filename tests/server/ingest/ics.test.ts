import { describe, it, expect } from "vitest";
import { parseIcs } from "../../../src/server/ingest/ics.js";

const FLIGHT = [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "BEGIN:VEVENT",
  "UID:dl2214@delta.com",
  "SUMMARY:Delta 2214 BOI to STS",
  "LOCATION:Boise Airport",
  "DESCRIPTION:Confirmation number: D7WN88\\nThanks for flying.",
  "DTSTART;TZID=America/Boise:20261009T094000",
  "DTEND;TZID=America/Los_Angeles:20261009T125500",
  "END:VEVENT",
  "END:VCALENDAR",
].join("\r\n");

describe("parseIcs", () => {
  it("reads summary, location, and description", () => {
    const [event] = parseIcs(FLIGHT);
    expect(event?.summary).toBe("Delta 2214 BOI to STS");
    expect(event?.location).toBe("Boise Airport");
    expect(event?.description).toContain("D7WN88");
  });

  it("converts a TZID wall clock to a UTC instant and keeps the zone", () => {
    // 9:40 MDT is 15:40 UTC. Keeping the zone alongside is the entire reason
    // .ics is preferred over the email body.
    const [event] = parseIcs(FLIGHT);
    expect(event?.startsAt).toBe("2026-10-09T15:40:00.000Z");
    expect(event?.startsAtTz).toBe("America/Boise");
  });

  it("keeps each endpoint's own zone", () => {
    const [event] = parseIcs(FLIGHT);
    expect(event?.endsAtTz).toBe("America/Los_Angeles");
    expect(event?.endsAt).toBe("2026-10-09T19:55:00.000Z");
  });

  it("reads a UTC value written with a trailing Z", () => {
    const utc = [
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "SUMMARY:Checkout",
      "DTSTART:20261011T180000Z",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");
    const [event] = parseIcs(utc);
    expect(event?.startsAt).toBe("2026-10-11T18:00:00.000Z");
    expect(event?.startsAtTz).toBe("UTC");
  });

  it("unfolds a summary split across lines", () => {
    const folded = [
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "SUMMARY:Delta 2214 ",
      " BOI to STS",
      "DTSTART:20261009T154000Z",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");
    expect(parseIcs(folded)[0]?.summary).toBe("Delta 2214 BOI to STS");
  });

  it("returns every VEVENT in a multi-leg itinerary", () => {
    const two = FLIGHT.replace(
      "END:VCALENDAR",
      [
        "BEGIN:VEVENT",
        "SUMMARY:Delta 2215 STS to BOI",
        "DTSTART;TZID=America/Los_Angeles:20261011T130000",
        "END:VEVENT",
        "END:VCALENDAR",
      ].join("\r\n"),
    );
    expect(parseIcs(two)).toHaveLength(2);
  });

  it("skips an event whose DTSTART is unparseable rather than emitting a bad instant", () => {
    // An unparseable starts_at, once stored, throws inside
    // ItineraryRepo.localDateOf on every future read of that trip's day view.
    // Dropping the event and letting a human enter it is strictly better.
    const bad = [
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "SUMMARY:Nonsense",
      "DTSTART;TZID=Mars/Olympus:whenever",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");
    expect(parseIcs(bad)).toEqual([]);
  });

  it("degrades a bad DTEND to null instead of dropping the event", () => {
    const badEnd = [
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "SUMMARY:Checkout",
      "DTSTART:20261011T180000Z",
      "DTEND;TZID=Mars/Olympus:20261011T190000",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");
    const [event] = parseIcs(badEnd);
    expect(event?.startsAt).toBe("2026-10-11T18:00:00.000Z");
    expect(event?.endsAt).toBeNull();
    expect(event?.endsAtTz).toBeNull();
  });

  it("unescapes RFC 5545 text escapes in free-text fields", () => {
    const escaped = [
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "SUMMARY:Dinner\\, drinks\\; dessert",
      "DTSTART:20261011T180000Z",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");
    expect(parseIcs(escaped)[0]?.summary).toBe("Dinner, drinks; dessert");
  });

  it("returns nothing for text that is not a calendar", () => {
    expect(parseIcs("Dear customer, your stay is confirmed.")).toEqual([]);
  });
});
