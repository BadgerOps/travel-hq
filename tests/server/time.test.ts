import { describe, expect, it } from "vitest";
import {
  isValidTimestamp,
  zonedTimestampToUtc,
} from "../../src/server/time.js";

describe("server timestamp normalization", () => {
  it("distinguishes an absolute instant from a timezone-dependent wall clock", () => {
    expect(isValidTimestamp("2026-08-05T18:00:00.000Z")).toBe(true);
    expect(isValidTimestamp("2026-08-05T12:00:00")).toBe(false);
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
