import { describe, it, expect } from "vitest";
import {
  countdownLabel,
  daysUntil,
  formatDualZone,
  formatTimeInZone,
  isActiveOn,
} from "../../../src/client/lib/dates.js";

describe("dates", () => {
  it("counts whole days until a future date", () => {
    expect(daysUntil("2026-10-09", "2026-07-20")).toBe(81);
  });

  it("returns zero on the day itself", () => {
    expect(daysUntil("2026-07-20", "2026-07-20")).toBe(0);
  });

  it("returns a negative count for past dates", () => {
    expect(daysUntil("2026-07-19", "2026-07-20")).toBe(-1);
  });

  it("labels a trip happening today", () => {
    expect(countdownLabel("2026-10-09", "2026-10-11", "2026-10-10")).toBe("Today");
  });

  it("labels a future trip in days", () => {
    expect(countdownLabel("2026-10-09", "2026-10-11", "2026-07-20")).toBe("In 81 days");
  });

  it("labels a past trip", () => {
    expect(countdownLabel("2026-10-09", "2026-10-11", "2026-12-01")).toBe("Past");
  });

  it("treats the first and last day as active", () => {
    const trip = { startsOn: "2026-10-09", endsOn: "2026-10-11" };
    expect(isActiveOn(trip, "2026-10-09")).toBe(true);
    expect(isActiveOn(trip, "2026-10-11")).toBe(true);
    expect(isActiveOn(trip, "2026-10-12")).toBe(false);
  });

  it("treats a trip with no dates as never active", () => {
    expect(isActiveOn({ startsOn: null, endsOn: null }, "2026-10-09")).toBe(false);
  });

  it("treats a start with no end as a single active day", () => {
    const trip = { startsOn: "2026-10-09", endsOn: null };
    expect(isActiveOn(trip, "2026-10-08")).toBe(false);
    expect(isActiveOn(trip, "2026-10-09")).toBe(true);
    expect(isActiveOn(trip, "2026-10-10")).toBe(false);
  });

  it("formats a UTC instant in its own zone", () => {
    expect(formatTimeInZone("2026-10-10T04:00:00Z", "America/Boise")).toBe("10:00 PM");
  });

  it("shows both zones when they differ", () => {
    expect(
      formatDualZone(
        "2026-10-10T05:30:00Z",
        "America/Boise",
        "2026-10-10T11:00:00Z",
        "America/New_York",
      ),
    ).toBe("11:30 PM MDT → 7:00 AM EDT");
  });

  it("shows one zone when both endpoints share it", () => {
    expect(
      formatDualZone(
        "2026-10-10T01:00:00Z",
        "America/Boise",
        "2026-10-10T03:00:00Z",
        "America/Boise",
      ),
    ).toBe("7:00 PM → 9:00 PM MDT");
  });
});
