import { describe, it, expect } from "vitest";
import {
  compareTrips,
  countdownLabel,
  daysUntil,
  formatDualZone,
  formatTimeInZone,
  isActiveOn,
  resolveTripState,
  tripStateBadge,
  tripStateRank,
} from "../../../src/client/lib/dates.js";

type Status = "planning" | "active" | "complete" | "cancelled";

function trip(status: Status, startsOn: string | null, endsOn: string | null = null) {
  return { status, startsOn, endsOn };
}

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

describe("resolveTripState", () => {
  const TODAY = "2026-07-23";

  it("a stored explicit status wins regardless of dates", () => {
    // Dates that would derive "past" — the stored status still decides.
    expect(resolveTripState(trip("cancelled", "2026-01-01", "2026-01-05"), TODAY)).toBe("cancelled");
    expect(resolveTripState(trip("complete", "2027-01-01", "2027-01-05"), TODAY)).toBe("complete");
    expect(resolveTripState(trip("active", "2027-01-01", "2027-01-05"), TODAY)).toBe("active");
    expect(resolveTripState(trip("active", null), TODAY)).toBe("active");
  });

  it("planning derives active from a range covering today", () => {
    expect(resolveTripState(trip("planning", "2026-07-22", "2026-07-25"), TODAY)).toBe("active");
    expect(resolveTripState(trip("planning", TODAY), TODAY)).toBe("active");
  });

  it("planning derives upcoming from a future start or no dates", () => {
    expect(resolveTripState(trip("planning", "2026-08-01", "2026-08-05"), TODAY)).toBe("upcoming");
    expect(resolveTripState(trip("planning", null), TODAY)).toBe("upcoming");
  });

  it("planning derives past from an end before today", () => {
    expect(resolveTripState(trip("planning", "2026-01-01", "2026-01-05"), TODAY)).toBe("past");
    expect(resolveTripState(trip("planning", "2026-01-01"), TODAY)).toBe("past");
  });

  it("ranks states active, upcoming, past, complete, cancelled", () => {
    const ranks = (["active", "upcoming", "past", "complete", "cancelled"] as const).map(
      tripStateRank,
    );
    expect(ranks).toEqual([0, 1, 2, 3, 4]);
  });
});

describe("compareTrips", () => {
  const TODAY = "2026-07-23";

  it("orders by state, then live states soonest-first with undated last", () => {
    const cancelled = { id: "c", ...trip("cancelled", "2026-07-22", "2026-07-25") };
    const activeNow = { id: "a", ...trip("planning", "2026-07-22", "2026-07-25") };
    const soon = { id: "s", ...trip("planning", "2026-08-01") };
    const later = { id: "l", ...trip("planning", "2026-09-01") };
    const undated = { id: "u", ...trip("planning", null) };
    const past = { id: "p", ...trip("planning", "2026-01-01", "2026-01-05") };
    const pastNewer = { id: "pn", ...trip("planning", "2026-06-01", "2026-06-03") };
    const complete = { id: "d", ...trip("complete", "2026-05-01", "2026-05-03") };

    const ordered = [cancelled, complete, pastNewer, past, undated, later, soon, activeNow]
      .sort((a, b) => compareTrips(a, b, TODAY))
      .map((t) => t.id);

    // Past reads most-recent-first; cancelled sorts dead last.
    expect(ordered).toEqual(["a", "s", "l", "u", "pn", "p", "d", "c"]);
  });
});

describe("tripStateBadge", () => {
  const TODAY = "2026-07-23";

  it("names an explicit state", () => {
    expect(tripStateBadge(trip("cancelled", "2026-08-01"), TODAY)).toBe("Cancelled");
    expect(tripStateBadge(trip("complete", "2026-08-01"), TODAY)).toBe("Complete");
  });

  it("says Active for a forced-active trip whose dates do not cover today", () => {
    expect(tripStateBadge(trip("active", "2026-08-01"), TODAY)).toBe("Active");
    expect(tripStateBadge(trip("active", null), TODAY)).toBe("Active");
  });

  it("keeps the countdown language for date-derived states", () => {
    expect(tripStateBadge(trip("planning", TODAY), TODAY)).toBe("Today");
    expect(tripStateBadge(trip("active", "2026-07-22", "2026-07-25"), TODAY)).toBe("Today");
    expect(tripStateBadge(trip("planning", "2026-07-24"), TODAY)).toBe("Tomorrow");
    expect(tripStateBadge(trip("planning", "2026-01-01"), TODAY)).toBe("Past");
    expect(tripStateBadge(trip("planning", null), TODAY)).toBe("Unscheduled");
  });
});
