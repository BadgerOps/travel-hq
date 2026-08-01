import { describe, expect, it } from "vitest";
import {
  combineRanges,
  locationWords,
  rankTrips,
  scoreTripMatch,
  tripDateFit,
} from "../../../src/shared/trip-match.js";
import type { MatchableTrip } from "../../../src/shared/trip-match.js";

function trip(
  title: string,
  startsOn: string | null,
  endsOn: string | null,
  destination: string | null = null,
): MatchableTrip & { title: string } {
  return { title, startsOn, endsOn, destination };
}

const october = { startsOn: "2026-10-21", endsOn: "2026-10-23" };

describe("tripDateFit", () => {
  it("recognises containment, including a trip that matches the range exactly", () => {
    expect(tripDateFit(trip("Europe", "2026-10-20", "2026-10-30"), october))
      .toEqual({ fit: "contains", gapDays: 0 });
    expect(tripDateFit(trip("Exact", "2026-10-21", "2026-10-23"), october))
      .toEqual({ fit: "contains", gapDays: 0 });
  });

  it("separates a partial overlap from containment", () => {
    // The trip ends mid-stay: it holds the check-in but not the check-out.
    expect(tripDateFit(trip("Half", "2026-10-19", "2026-10-22"), october))
      .toEqual({ fit: "overlaps", gapDays: 0 });
  });

  it("measures the gap in whole days from the nearest edge, in both directions", () => {
    expect(tripDateFit(trip("Before", "2026-10-01", "2026-10-19"), october))
      .toEqual({ fit: "before", gapDays: 2 });
    expect(tripDateFit(trip("After", "2026-10-30", "2026-11-02"), october))
      .toEqual({ fit: "after", gapDays: 7 });
  });

  it("treats a half-dated trip as undated: containment is a claim about an interval", () => {
    expect(tripDateFit(trip("Open", "2026-10-21", null), october).fit).toBe("undated");
    expect(tripDateFit(trip("Undated", null, null), october).fit).toBe("undated");
  });

  it("declines to rank rather than inventing a day the calendar does not contain", () => {
    expect(tripDateFit(trip("Impossible", "2026-02-30", "2026-03-04"), october).fit)
      .toBe("undated");
    expect(tripDateFit(trip("Europe", "2026-10-20", "2026-10-30"), null).fit)
      .toBe("unknown");
  });
});

describe("locationWords", () => {
  it("is case-, accent- and punctuation-insensitive", () => {
    expect(locationWords("Zürich, Switzerland")).toEqual(["zurich", "switzerland"]);
    expect(locationWords("ST. MARY / EAST GLACIER")).toEqual(["mary", "glacier"]);
  });

  it("drops the short tokens and generic words a wrong match would come from", () => {
    // An airport pair is not a destination: "DEN" must never match Denmark.
    expect(locationWords("DEN → AMS")).toEqual([]);
    expect(locationWords("Family trip")).toEqual(["family"]);
    expect(locationWords("")).toEqual([]);
    expect(locationWords(null)).toEqual([]);
  });
});

describe("combineRanges", () => {
  it("unions the dated entries and ignores the rest", () => {
    expect(combineRanges([
      { startsOn: "2026-10-22", endsOn: "2026-10-24" },
      null,
      { startsOn: "2026-10-21", endsOn: "2026-10-21" },
      undefined,
    ])).toEqual({ startsOn: "2026-10-21", endsOn: "2026-10-24" });
    expect(combineRanges([null, undefined])).toBeNull();
  });
});

describe("scoreTripMatch", () => {
  it("explains itself: every fit carries the reason it ranked where it did", () => {
    const selection = { range: october, locations: ["Amsterdam"] };
    expect(scoreTripMatch(trip("Europe", "2026-10-20", "2026-10-30", "Amsterdam"), selection).label)
      .toBe("covers these dates · same destination");
    expect(scoreTripMatch(trip("Half", "2026-10-19", "2026-10-22"), selection).label)
      .toBe("dates overlap");
    expect(scoreTripMatch(trip("Earlier", "2026-10-01", "2026-10-20"), selection).label)
      .toBe("ends 1 day before");
    expect(scoreTripMatch(trip("Later", "2026-10-25", "2026-10-28"), selection).label)
      .toBe("starts 2 days later");
    expect(scoreTripMatch(trip("Someday", null, null), selection).label)
      .toBe("no dates");
  });

  it("matches a destination written at a different zoom level, and only shares a word otherwise", () => {
    const selection = { range: null, locations: ["Stuttgart, Germany"] };
    expect(scoreTripMatch(trip("A", null, null, "Germany"), selection).locationFit)
      .toBe("destination");
    expect(scoreTripMatch(trip("B", null, null, "Munich, Germany"), selection).locationFit)
      .toBe("destination-word");
    expect(scoreTripMatch(trip("C", null, null, "Lisbon"), selection).locationFit)
      .toBe("none");
  });

  it("falls back to the trip's own name, which is where the place often is", () => {
    const selection = { range: null, locations: ["Silverwood RV Park"] };
    // Plenty of trips are named after the place and never get a destination.
    expect(scoreTripMatch(trip("Silverwood weekend", null, null), selection).locationFit)
      .toBe("title-word");
    // A destination that says something else does not veto the title: it is
    // the weakest signal there is (a quarter of a destination match), so it
    // can only separate trips whose dates already tie.
    expect(scoreTripMatch(trip("Silverwood weekend", null, null, "Boise"), selection).locationFit)
      .toBe("title-word");
    expect(scoreTripMatch(trip("Lisbon weekend", null, null, "Boise"), selection).locationFit)
      .toBe("none");
  });
});

describe("rankTrips", () => {
  const selection = { range: october, locations: ["Amsterdam"] };

  it("puts date containment first, then overlap, then the nearest gap, then the undated", () => {
    const ranked = rankTrips(
      [
        trip("Undated", null, null),
        trip("Month away", "2026-11-20", "2026-11-30"),
        trip("Overlaps", "2026-10-19", "2026-10-22"),
        trip("Two days later", "2026-10-25", "2026-10-28"),
        trip("Contains", "2026-10-20", "2026-10-30"),
      ],
      selection,
    );
    expect(ranked.map((entry) => entry.trip.title)).toEqual([
      "Contains",
      "Overlaps",
      "Two days later",
      "Month away",
      "Undated",
    ]);
  });

  it("breaks a date tie on location but never outranks a clear containment", () => {
    const ranked = rankTrips(
      [
        // Same dates as each other; only the destination separates them.
        trip("Wrong place", "2026-10-19", "2026-10-22", "Lisbon"),
        trip("Right place", "2026-10-19", "2026-10-22", "Amsterdam"),
        // Contains the dates and names the wrong place: still first.
        trip("Contains", "2026-10-20", "2026-10-30", "Reykjavik"),
      ],
      selection,
    );
    expect(ranked.map((entry) => entry.trip.title)).toEqual([
      "Contains",
      "Right place",
      "Wrong place",
    ]);
  });

  it("cannot lift an undated trip over a dated one, however well its name reads", () => {
    const ranked = rankTrips(
      [
        trip("Amsterdam someday", null, null, "Amsterdam"),
        trip("A year away", "2027-10-20", "2027-10-30"),
      ],
      selection,
    );
    expect(ranked.map((entry) => entry.trip.title)).toEqual([
      "A year away",
      "Amsterdam someday",
    ]);
  });

  it("never orders trips against the day counts their own labels print", () => {
    // Regression: everything past a month ties at 0 (600 - 20/day, floored),
    // so the stable sort used to leave far-away trips in API order — and the
    // picker read "ends 2 days before / ends 103 days before / starts 67 days
    // later", which looks broken however correct the scoring is.
    const oneDay = { startsOn: "2026-07-30", endsOn: "2026-07-30" };
    const ranked = rankTrips(
      [
        trip("Amsterdam spring", "2026-04-10", "2026-04-18"),
        trip("Someday list", null, null),
        trip("Tokyo food crawl", "2026-10-18", "2026-10-28"),
        trip("Maui summer week", "2026-07-21", "2026-07-28"),
        trip("Tokyo in autumn", "2026-10-05", "2026-10-15"),
      ],
      { range: oneDay, locations: [] },
    );

    expect(ranked.map((entry) => `${entry.trip.title} — ${entry.match.label}`)).toEqual([
      "Maui summer week — ends 2 days before",
      "Tokyo in autumn — starts 67 days later",
      "Tokyo food crawl — starts 80 days later",
      "Amsterdam spring — ends 103 days before",
      "Someday list — no dates",
    ]);
    // The tie-break orders them; it does not pretend they differ in fit.
    expect(ranked.slice(1, 4).map((entry) => entry.match.score)).toEqual([0, 0, 0]);
  });

  it("keeps the tie-break from disturbing trips that have no gap to compare", () => {
    // Containment, overlap and undated all carry gapDays 0/null, so equal
    // scores still fall back to the caller's order rather than to a number
    // none of them has.
    const ranked = rankTrips(
      [
        trip("Second contains", "2026-10-19", "2026-10-31"),
        trip("First contains", "2026-10-20", "2026-10-30"),
        trip("Later undated", null, null),
        trip("Earlier undated", null, null),
      ],
      { range: october, locations: [] },
    );
    expect(ranked.map((entry) => entry.trip.title)).toEqual([
      "Second contains",
      "First contains",
      "Later undated",
      "Earlier undated",
    ]);
  });

  it("leaves the caller's order alone when the selection says nothing", () => {
    const trips = [trip("First", null, null), trip("Second", "2026-10-20", "2026-10-30")];
    const ranked = rankTrips(trips, { range: null, locations: [] });
    expect(ranked.map((entry) => entry.trip.title)).toEqual(["First", "Second"]);
    expect(ranked.every((entry) => entry.match.label === "")).toBe(true);
  });

  it("scores a multi-draft selection against its combined range, not one draft at a time", () => {
    // A flight on the 21st and a stay through the 24th. The week-long trip
    // holds both; the day trip holds only the flight and must not win.
    const range = combineRanges([
      { startsOn: "2026-10-21", endsOn: "2026-10-21" },
      { startsOn: "2026-10-22", endsOn: "2026-10-24" },
    ]);
    const ranked = rankTrips(
      [trip("Day trip", "2026-10-21", "2026-10-21"), trip("The week", "2026-10-20", "2026-10-27")],
      { range, locations: [] },
    );
    expect(ranked[0]!.trip.title).toBe("The week");
    expect(ranked[0]!.match.dateFit).toBe("contains");
    expect(ranked[1]!.match.dateFit).toBe("overlaps");
  });
});
