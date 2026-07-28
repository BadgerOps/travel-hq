import { describe, it, expect } from "vitest";
import { findDuplicates, pairKey } from "../../src/server/dedupe.js";
import type { DuplicateCandidate } from "../../src/server/dedupe.js";

function candidate(over: Partial<DuplicateCandidate> & { id: string }): DuplicateCandidate {
  return {
    kind: "flight",
    title: "Delta 1423 SEA-JFK",
    location: null,
    startsAt: "2026-09-04T14:30:00.000Z",
    confirmation: null,
    ...over,
  };
}

describe("findDuplicates", () => {
  it("pairs two imports of the same confirmation number however differently spelled", () => {
    const groups = findDuplicates([
      candidate({ id: "a", confirmation: "HX7T2Q" }),
      // Same departure minute corroborates the locator; the title spelling
      // and the punctuation in the locator are both normalized away.
      candidate({ id: "b", confirmation: "hx7t-2q", title: "DL1423" }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.reason).toBe("confirmation");
    expect(groups[0]?.confidence).toBe("high");
    expect(groups[0]?.bookingIds.sort()).toEqual(["a", "b"]);
  });

  it("does not pair a shared locator that nothing else corroborates", () => {
    // Same reservation, different name, and one side has no time at all —
    // indistinguishable from a second segment whose times went unextracted.
    // Missing a duplicate here costs one merge on the trip page; guessing
    // wrong costs every multi-leg itinerary.
    expect(
      findDuplicates([
        candidate({ id: "a", confirmation: "HX7T2Q" }),
        candidate({ id: "b", confirmation: "hx7t-2q", title: "DL1423", startsAt: null }),
      ]),
    ).toEqual([]);
  });

  it("keeps a hotel modification with the same confirmation but new dates together", () => {
    const groups = findDuplicates([
      candidate({
        id: "a",
        kind: "lodging",
        title: "Hotel Kabuki",
        confirmation: "8891204",
        startsAt: "2026-09-04T23:00:00.000Z",
      }),
      candidate({
        id: "b",
        kind: "lodging",
        title: "Hotel Kabuki",
        confirmation: "8891204",
        startsAt: "2026-09-05T23:00:00.000Z",
      }),
    ]);
    expect(groups.map((g) => g.reason)).toEqual(["confirmation"]);
  });

  it("leaves the legs of one connecting itinerary alone despite their shared PNR", () => {
    // A record locator identifies a reservation, not a segment: BOI→MSP→AMS
    // is one ticket, three flights. Pairing on the locator alone reported
    // every multi-leg trip as duplicates.
    const groups = findDuplicates([
      candidate({
        id: "leg1",
        title: "DL 2586: Boise to Minneapolis",
        location: "Boise Airport to Minneapolis-St Paul International Airport",
        startsAt: "2026-10-21T20:33:00.000Z",
        confirmation: "TRIP90",
      }),
      candidate({
        id: "leg2",
        title: "DL 162: Minneapolis to Amsterdam",
        location: "Minneapolis-St Paul International Airport to Amsterdam Airport Schiphol",
        startsAt: "2026-10-22T00:55:00.000Z",
        confirmation: "TRIP90",
      }),
      candidate({
        id: "leg3",
        title: "DL 9674: Amsterdam to Stuttgart",
        location: "Amsterdam Airport Schiphol to Stuttgart Airport",
        startsAt: "2026-10-22T10:30:00.000Z",
        confirmation: "TRIP90",
      }),
    ]);
    expect(groups).toEqual([]);
  });

  it("still catches the same leg of that itinerary forwarded twice", () => {
    const groups = findDuplicates([
      candidate({ id: "leg1", title: "DL 2586: Boise to Minneapolis", startsAt: "2026-10-21T20:33:00.000Z", confirmation: "TRIP90" }),
      candidate({ id: "leg2", title: "DL 162: Minneapolis to Amsterdam", startsAt: "2026-10-22T00:55:00.000Z", confirmation: "TRIP90" }),
      // The second forward, extracted with a different title for leg 1.
      candidate({ id: "leg1-again", title: "DL2586 BOI-MSP", startsAt: "2026-10-21T20:33:00.000Z", confirmation: "TRIP90" }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.bookingIds.sort()).toEqual(["leg1", "leg1-again"]);
  });

  it("never pairs two different confirmation numbers, however identical the rest", () => {
    const groups = findDuplicates([
      candidate({ id: "a", kind: "lodging", title: "Hotel Kabuki", location: "Japantown", confirmation: "8891204" }),
      candidate({ id: "b", kind: "lodging", title: "Hotel Kabuki", location: "Japantown", confirmation: "8891205" }),
    ]);
    expect(groups).toEqual([]);
  });

  it("pairs the same title at the same minute when only one side kept a confirmation", () => {
    const groups = findDuplicates([
      candidate({ id: "a", confirmation: "HX7T2Q" }),
      // The .ics leg of the same mail: same flight, seconds of drift, no PNR.
      candidate({ id: "b", startsAt: "2026-09-04T14:30:41.000Z", title: "Delta 1423 — SEA→JFK" }),
    ]);
    expect(groups[0]?.reason).toBe("identical");
    expect(groups[0]?.bookingIds.sort()).toEqual(["a", "b"]);
  });

  it("leaves two different flights on the same route at different times alone", () => {
    const groups = findDuplicates([
      candidate({ id: "a", title: "Delta 1423 SEA-JFK" }),
      candidate({ id: "b", title: "Delta 1961 SEA-JFK", startsAt: "2026-09-04T21:00:00.000Z" }),
    ]);
    expect(groups).toEqual([]);
  });

  it("does not pair across kinds", () => {
    const groups = findDuplicates([
      candidate({ id: "a", kind: "activity", title: "Ferry to Bainbridge" }),
      candidate({ id: "b", kind: "other", title: "Ferry to Bainbridge" }),
    ]);
    expect(groups).toEqual([]);
  });

  it("offers a same-place, same-minute, differently-named pair at medium confidence only", () => {
    const groups = findDuplicates([
      candidate({ id: "a", kind: "lodging", title: "Hotel Kabuki", location: "1625 Post St" }),
      candidate({ id: "b", kind: "lodging", title: "Kabuki — room 2", location: "1625 Post St." }),
    ]);
    expect(groups[0]?.reason).toBe("same-slot");
    expect(groups[0]?.confidence).toBe("medium");
  });

  it("pairs undated same-name imports, which is all the evidence an undated extraction leaves", () => {
    const groups = findDuplicates([
      candidate({ id: "a", kind: "car", title: "Hertz - SFO", startsAt: null }),
      candidate({ id: "b", kind: "car", title: "Hertz SFO", startsAt: null }),
    ]);
    expect(groups[0]?.reason).toBe("identical");
  });

  it("does not pair an undated import with a dated one", () => {
    const groups = findDuplicates([
      candidate({ id: "a", kind: "car", title: "Hertz SFO", startsAt: null }),
      candidate({ id: "b", kind: "car", title: "Hertz SFO" }),
    ]);
    expect(groups).toEqual([]);
  });

  it("ignores a confirmation number too short to be a record locator", () => {
    const groups = findDuplicates([
      candidate({ id: "a", kind: "activity", title: "Dinner", location: "Zuni", confirmation: "1" }),
      candidate({ id: "b", kind: "activity", title: "Dinner", location: "Zuni", confirmation: "2" }),
    ]);
    // Neither "1" nor "2" is treated as a locator, so the pair falls through
    // to the title rule instead of being ruled out as two different codes.
    expect(groups[0]?.reason).toBe("identical");
  });

  it("collapses three re-forwards of one flight into a single group", () => {
    const groups = findDuplicates([
      candidate({ id: "a", confirmation: "HX7T2Q" }),
      candidate({ id: "b", confirmation: "HX7T2Q" }),
      candidate({ id: "c" }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.bookingIds.sort()).toEqual(["a", "b", "c"]);
    // The strongest evidence anywhere in the group is what it reports.
    expect(groups[0]?.reason).toBe("confirmation");
  });

  it("ranks confirmation groups above the ones a human may well reject", () => {
    const groups = findDuplicates([
      candidate({ id: "a", kind: "lodging", title: "Kabuki", location: "1625 Post", startsAt: "2026-09-04T23:00:00.000Z" }),
      candidate({ id: "b", kind: "lodging", title: "Kabuki room 2", location: "1625 Post", startsAt: "2026-09-04T23:00:00.000Z" }),
      candidate({ id: "c", confirmation: "HX7T2Q" }),
      candidate({ id: "d", confirmation: "HX7T2Q" }),
    ]);
    expect(groups.map((g) => g.reason)).toEqual(["confirmation", "same-slot"]);
  });

  it("stops reporting a dismissed pair", () => {
    const pair = [candidate({ id: "a", confirmation: "HX7T2Q" }), candidate({ id: "b", confirmation: "HX7T2Q" })];
    expect(findDuplicates(pair)).toHaveLength(1);
    expect(findDuplicates(pair, new Set([pairKey("b", "a")]))).toEqual([]);
  });

  it("still groups a dismissed pair when both match a third booking", () => {
    // The dismissal answered "are A and B the same?", not "are all three?".
    const groups = findDuplicates(
      [
        candidate({ id: "a", confirmation: "HX7T2Q" }),
        candidate({ id: "b", confirmation: "HX7T2Q" }),
        candidate({ id: "c", confirmation: "HX7T2Q" }),
      ],
      new Set([pairKey("a", "b")]),
    );
    expect(groups[0]?.bookingIds.sort()).toEqual(["a", "b", "c"]);
  });

  it("reports nothing for a trip with no repeats", () => {
    expect(
      findDuplicates([
        candidate({ id: "a", confirmation: "HX7T2Q" }),
        candidate({ id: "b", kind: "lodging", title: "Hotel Kabuki", startsAt: "2026-09-05T23:00:00.000Z" }),
      ]),
    ).toEqual([]);
  });
});

describe("pairKey", () => {
  it("is order independent", () => {
    expect(pairKey("b", "a")).toBe(pairKey("a", "b"));
  });
});
