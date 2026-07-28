import { describe, expect, it } from "vitest";
import {
  enrichActivityDetails,
  hasActivityLogistics,
  parseActivityDetails,
} from "../../../src/server/ingest/activity-details.js";

/** The email that motivated this module, verbatim. */
const RED_BUS = [
  "Pickup: 1:30pm at Quarter Circle/West Side Parking Lot. Please arrive at your",
  "pickup location 15 minutes before departure time. This tour begins in the great",
  "cedar and hemlock forests that lie within the Lake McDonald Valley. You will",
  "traverse the famed Going-to-the-Sun Road to the high alpine region of the park",
  "and stand on top of the Continental Divide. Discover incredible mountain ranges,",
  "glaciers, waterfalls, and wildflowers along the way as your Red Bus glides along",
  "the glacially carved Garden Wall. October tours are weather and road condition",
  "dependent. Approximate return time: 5:00",
].join("\n");

describe("parseActivityDetails", () => {
  it("pulls the pickup, the call time and the return out of a Red Bus confirmation", () => {
    expect(parseActivityDetails(RED_BUS)).toEqual({
      pickupTime: "1:30 PM",
      pickupLocation: "Quarter Circle/West Side Parking Lot",
      arriveMinutesBefore: 15,
      // "5:00" with no meridiem, after a 1:30 PM pickup, is the afternoon.
      returnTime: "5:00 PM",
    });
  });

  it("reads a place that precedes its time", () => {
    // "Meeting point: <place> at <time>" is as common as the other order, and
    // taking only the text after the time would find nothing here.
    expect(parseActivityDetails("Meeting point: Apgar Visitor Center at 9:00 AM")).toEqual({
      pickupTime: "9:00 AM",
      pickupLocation: "Apgar Visitor Center",
    });
  });

  it("reads labelled lines with no time and times with no place", () => {
    // Two labelled lines must stay two chunks. Unwrapping them into one would
    // hand the return's 4:45 PM to the pickup.
    const text = ["Pickup location: Lake McDonald Lodge lobby", "Return time: 4:45 PM"].join("\n");
    expect(parseActivityDetails(text)).toEqual({
      pickupLocation: "Lake McDonald Lodge lobby",
      returnTime: "4:45 PM",
    });
  });

  it("normalises a 24-hour clock and keeps a genuinely ambiguous one as written", () => {
    expect(parseActivityDetails("Departure: 17:00").pickupTime).toBe("5:00 PM");
    // No pickup to disambiguate against, so nothing is invented.
    expect(parseActivityDetails("Return: 5:00").returnTime).toBe("5:00");
  });

  it("converts an hours-early call time to minutes", () => {
    expect(
      parseActivityDetails("Please arrive 2 hours before departure.").arriveMinutesBefore,
    ).toBe(120);
  });

  it("ignores a cancellation policy stated in hours", () => {
    // "Cancel 24 hours in advance" is not a call time, and treating it as one
    // would have the family at the car park the previous afternoon.
    expect(
      parseActivityDetails("Cancellations must be received 24 hours in advance.")
        .arriveMinutesBefore,
    ).toBeUndefined();
  });

  it("does not mistake the arrival reminder for the pickup location", () => {
    // The reminder sentence contains the word "pickup"; an unanchored match
    // would take "your pickup location" as the place itself.
    const details = parseActivityDetails(
      "Please arrive at your pickup location 15 minutes before departure time.",
    );
    expect(details.pickupLocation).toBeUndefined();
    expect(details.arriveMinutesBefore).toBe(15);
  });

  it("keeps an address whose abbreviation ends in a full stop intact", () => {
    expect(parseActivityDetails("Pickup: 8:00 AM at St. Mary Lodge front entrance"))
      .toEqual({ pickupTime: "8:00 AM", pickupLocation: "St. Mary Lodge front entrance" });
  });

  it("reads a separate drop-off", () => {
    expect(parseActivityDetails("Drop-off: 5:00 PM at the West Glacier depot")).toEqual({
      returnTime: "5:00 PM",
      dropoffLocation: "the West Glacier depot",
    });
  });

  it("reads a duration", () => {
    expect(parseActivityDetails("Duration: approximately 3.5 hours").duration).toBe(
      "approximately 3.5 hours",
    );
  });

  it("finds nothing in text that says nothing", () => {
    expect(parseActivityDetails("Thanks for booking with us. See you soon!")).toEqual({});
    expect(parseActivityDetails(null)).toEqual({});
    expect(parseActivityDetails("")).toEqual({});
  });

  it("never lets a date be read as a clock time", () => {
    expect(parseActivityDetails("Departure: October 9, 2026").pickupTime).toBeUndefined();
  });
});

describe("enrichActivityDetails", () => {
  it("fills only the gaps, leaving what the extractor found alone", () => {
    const merged = enrichActivityDetails(
      { venue: "Glacier Red Bus Tours", pickupLocation: "West Side Lot (gate 2)" },
      RED_BUS,
    );
    expect(merged).toEqual({
      venue: "Glacier Red Bus Tours",
      // The model's own value wins: it read the whole message.
      pickupLocation: "West Side Lot (gate 2)",
      pickupTime: "1:30 PM",
      arriveMinutesBefore: 15,
      returnTime: "5:00 PM",
    });
  });

  it("treats a non-record as an empty record rather than throwing", () => {
    expect(enrichActivityDetails(null, "Pickup: 9:00 AM at the dock")).toEqual({
      pickupTime: "9:00 AM",
      pickupLocation: "the dock",
    });
    expect(enrichActivityDetails("nonsense", "")).toEqual({});
  });
});

describe("hasActivityLogistics", () => {
  it("is true only for a record carrying a logistics field", () => {
    expect(hasActivityLogistics({ pickupTime: "1:30 PM" })).toBe(true);
    expect(hasActivityLogistics({ arriveMinutesBefore: 15 })).toBe(true);
    expect(hasActivityLogistics({ venue: "Somewhere" })).toBe(false);
    expect(hasActivityLogistics({ pickupLocation: "" })).toBe(false);
    expect(hasActivityLogistics(null)).toBe(false);
  });
});
