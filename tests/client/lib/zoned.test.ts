import { describe, it, expect } from "vitest";
import { zonedToUtc } from "../../../src/client/lib/dates.js";

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
