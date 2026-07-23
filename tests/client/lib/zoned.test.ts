import { describe, it, expect } from "vitest";
import { utcToZonedLocal, zonedToUtc } from "../../../src/client/lib/dates.js";

describe("zonedToUtc", () => {
  it("converts a wall-clock time in a named zone to a UTC instant", () => {
    // 9:40 AM MDT (UTC-6) on 2026-10-09 is 15:40 UTC.
    expect(zonedToUtc("2026-10-09T09:40", "America/Boise")).toBe("2026-10-09T15:40:00.000Z");
  });

  it("uses the zone's offset, not the machine's", () => {
    // The same wall clock in a different zone must not produce the same
    // instant. This is the whole reason the helper exists: `new Date(local)`
    // would answer identically for both.
    const boise = zonedToUtc("2026-10-09T09:40", "America/Boise");
    const newYork = zonedToUtc("2026-10-09T09:40", "America/New_York");
    expect(boise).not.toBe(newYork);
    expect(newYork).toBe("2026-10-09T13:40:00.000Z");
  });

  it("applies the offset in force on that date, not today's", () => {
    // January is MST (UTC-7), October is MDT (UTC-6). A fixed offset would
    // get one of these wrong.
    expect(zonedToUtc("2026-01-09T09:40", "America/Boise")).toBe("2026-01-09T16:40:00.000Z");
  });

  it("round-trips through formatTimeInZone", async () => {
    const { formatTimeInZone } = await import("../../../src/client/lib/dates.js");
    expect(formatTimeInZone(zonedToUtc("2026-10-09T09:40", "America/Boise"), "America/Boise"))
      .toBe("9:40 AM");
  });

  it("throws on an unparseable local value rather than producing Invalid Date", () => {
    // A booking whose starts_at is "Invalid Date" passes a non-empty-string
    // check, is stored, and then throws inside ItineraryRepo.localDateOf on
    // every future read of that trip's day view. Fail here instead.
    expect(() => zonedToUtc("not a date", "America/Boise")).toThrow(RangeError);
  });

  it("throws on an unknown timezone", () => {
    expect(() => zonedToUtc("2026-10-09T09:40", "Mars/Olympus")).toThrow(RangeError);
  });
});

describe("utcToZonedLocal", () => {
  it("renders a UTC instant as the wall clock in the named zone, datetime-local shaped", () => {
    // 15:40 UTC on 2026-10-09 is 9:40 AM MDT in Boise.
    expect(utcToZonedLocal("2026-10-09T15:40:00.000Z", "America/Boise")).toBe("2026-10-09T09:40");
  });

  it("is the inverse of zonedToUtc, either side of a DST boundary", () => {
    // The import edit form prefills with utcToZonedLocal and saves through
    // zonedToUtc; an untouched field must round-trip to the same instant.
    for (const instant of ["2026-10-09T15:40:00.000Z", "2026-01-09T16:40:00.000Z"]) {
      expect(zonedToUtc(utcToZonedLocal(instant, "America/Boise"), "America/Boise")).toBe(instant);
    }
  });

  it("crosses the date line: the local calendar date may differ from UTC's", () => {
    // 15:40 UTC on Oct 9 is already 00:40 on Oct 10 in Tokyo.
    expect(utcToZonedLocal("2026-10-09T15:40:00.000Z", "Asia/Tokyo")).toBe("2026-10-10T00:40");
  });

  it("renders midnight as 00, not 24", () => {
    // Some engines format midnight as hour 24 under hour12:false; the raw
    // value would not parse as a datetime-local value.
    expect(utcToZonedLocal("2026-10-09T00:00:00.000Z", "UTC")).toBe("2026-10-09T00:00");
  });
});
