import { describe, expect, it } from "vitest";
import {
  isValidCalendarDate,
  isValidInstant,
  isValidTimestamp,
  zonedTimestampToUtc,
} from "../../src/server/time.js";

describe("server timestamp normalization", () => {
  it("distinguishes an absolute instant from a timezone-dependent wall clock", () => {
    expect(isValidTimestamp("2026-08-05T18:00:00.000Z")).toBe(true);
    expect(isValidTimestamp("2026-08-05T12:00:00")).toBe(false);
  });

  it("exposes one implementation under both names", () => {
    expect(isValidTimestamp).toBe(isValidInstant);
  });

  it("converts a reservation's local wall time with its named timezone", () => {
    expect(
      zonedTimestampToUtc("2026-08-05T12:00:00", "America/Denver"),
    ).toBe("2026-08-05T18:00:00.000Z");
  });

  it("rejects impossible and nonexistent local wall times", () => {
    expect(() =>
      zonedTimestampToUtc("2026-02-30T12:00:00", "America/Denver")
    ).toThrow(RangeError);
    expect(() =>
      zonedTimestampToUtc("2026-03-08T02:30:00", "America/Denver")
    ).toThrow(RangeError);
  });
});

describe("isValidInstant", () => {
  it("accepts the ISO-8601 spellings a confirmation actually uses", () => {
    for (const value of [
      "2026-08-05T18:00:00.000Z", // what toISOString() emits
      "2026-08-05T18:00:00Z", // second precision
      "2026-08-05T18:00Z", // minute precision, as printed on tickets
      "2026-08-05T12:00:00-06:00", // a negative offset
      "2026-08-05T23:00:00+09:00", // a positive one
      "2028-02-29T12:00:00Z", // a leap day that exists
      "2026-08-05t18:00:00z", // lowercase designators are still ISO-8601
    ]) {
      expect(isValidInstant(value), value).toBe(true);
    }
  });

  it("rejects a wall clock with no offset, which is not a moment in time", () => {
    expect(isValidInstant("2026-08-05T18:00:00")).toBe(false);
    expect(isValidInstant("2026-08-05T18:00:00.000")).toBe(false);
  });

  it("rejects a date with no time, whose meaning depends on the reader", () => {
    // Before this rule, "2026-08-05Z" passed: it ends in Z and Date.parse
    // happily returns midnight UTC for it.
    expect(isValidInstant("2026-08-05Z")).toBe(false);
    expect(isValidInstant("2026-08-05")).toBe(false);
  });

  it("rejects a date the calendar does not contain, instead of rolling it over", () => {
    // Date.parse("2026-02-30T00:00:00Z") is March 2nd, so the old check stored
    // a row nobody asked for rather than refusing one.
    expect(isValidInstant("2026-02-30T00:00:00Z")).toBe(false);
    expect(isValidInstant("2026-02-29T00:00:00Z")).toBe(false); // 2026 is not a leap year
    expect(isValidInstant("2026-13-01T00:00:00Z")).toBe(false);
    expect(isValidInstant("2026-00-10T00:00:00Z")).toBe(false);
  });

  it("rejects out-of-range times and offsets", () => {
    expect(isValidInstant("2026-08-05T24:00:00Z")).toBe(false);
    expect(isValidInstant("2026-08-05T18:60:00Z")).toBe(false);
    expect(isValidInstant("2026-08-05T23:59:60Z")).toBe(false); // leap second
    expect(isValidInstant("2026-08-05T18:00:00+25:00")).toBe(false);
    expect(isValidInstant("2026-08-05T18:00:00+05:70")).toBe(false);
  });

  it("rejects the implementation-defined legacy parser no two runtimes agree on", () => {
    expect(isValidInstant("Jan 5 2026 10:00 GMT+05:00")).toBe(false);
    expect(isValidInstant("+002026-08-05T18:00:00Z")).toBe(false);
    expect(isValidInstant("20260805T180000Z")).toBe(false);
    expect(isValidInstant("2026-08-05 18:00:00Z")).toBe(false);
    expect(isValidInstant("2026-08-05T18:00:00+0500")).toBe(false);
    expect(isValidInstant("")).toBe(false);
    expect(isValidInstant("next tuesday")).toBe(false);
  });
});

describe("isValidCalendarDate", () => {
  it("accepts a day that exists, in the one comparable format", () => {
    expect(isValidCalendarDate("2026-10-09")).toBe(true);
    expect(isValidCalendarDate("2028-02-29")).toBe(true);
  });

  it("rejects a day that does not exist, rather than rolling it forward", () => {
    expect(isValidCalendarDate("2026-02-30")).toBe(false);
    expect(isValidCalendarDate("2026-02-31")).toBe(false);
    expect(isValidCalendarDate("2027-02-29")).toBe(false);
    expect(isValidCalendarDate("2026-13-01")).toBe(false);
  });

  it("rejects every spelling that is not YYYY-MM-DD", () => {
    expect(isValidCalendarDate("10/09/2026")).toBe(false);
    expect(isValidCalendarDate("2026-9-9")).toBe(false);
    expect(isValidCalendarDate("2026-10-09T00:00:00Z")).toBe(false);
    expect(isValidCalendarDate("next tuesday")).toBe(false);
    expect(isValidCalendarDate("")).toBe(false);
  });
});
