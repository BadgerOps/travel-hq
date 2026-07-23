import { describe, it, expect } from "vitest";
import {
  EXTRACTED_JSON_SCHEMA,
  ExtractionError,
  normalizeExtractedBooking,
  validateExtracted,
} from "../../../src/server/ingest/extracted.js";
import { BOOKING_KINDS } from "../../../src/server/schemas/booking-kinds.js";

const flight = {
  kind: "flight",
  title: "Delta 2214 BOI to STS",
  location: "Boise Airport",
  startsAt: "2026-10-09T15:40:00.000Z",
  startsAtTz: "America/Boise",
  endsAt: null,
  endsAtTz: null,
  confirmationNumber: "D7WN88",
  costCents: 61240,
  details: { carrier: "Delta", flightNumber: "2214", originIata: "boi", destinationIata: "sts" },
};

describe("validateExtracted", () => {
  it("accepts a well-formed response and runs per-kind details through the booking schemas", () => {
    const [booking] = validateExtracted({ bookings: [flight] });
    expect(booking?.kind).toBe("flight");
    expect(booking?.confirmationNumber).toBe("D7WN88");
    // The same iata transform the booking route applies: lowercased input
    // comes back uppercased, proving parseDetails really ran.
    expect(booking?.details).toMatchObject({ originIata: "BOI", destinationIata: "STS" });
  });

  it("rejects a response that is not the { bookings: [...] } envelope", () => {
    expect(() => validateExtracted("plain prose")).toThrow(ExtractionError);
    expect(() => validateExtracted({ items: [flight] })).toThrow(ExtractionError);
    expect(() => validateExtracted(null)).toThrow(ExtractionError);
  });

  it("rejects the whole response when ANY booking is malformed — no partial results", () => {
    expect(() =>
      validateExtracted({ bookings: [flight, { kind: "spaceship", title: "X", details: {} }] }),
    ).toThrow(ExtractionError);
    expect(() => validateExtracted({ bookings: [flight, { kind: "other" }] })).toThrow(ExtractionError);
  });

  it("rejects an empty bookings list — an email the model read and found nothing in needs a human", () => {
    expect(() => validateExtracted({ bookings: [] })).toThrow(ExtractionError);
  });
});

describe("normalizeExtractedBooking", () => {
  it("nulls a timestamp that arrives without its zone rather than dropping the booking", () => {
    const booking = normalizeExtractedBooking({
      kind: "other",
      title: "Dinner",
      startsAt: "2026-10-10T02:00:00Z",
      details: {},
    });
    expect(booking.title).toBe("Dinner");
    expect(booking.startsAt).toBeNull();
    expect(booking.startsAtTz).toBeNull();
  });

  it("nulls an unparseable timestamp rather than storing one that bricks the day view", () => {
    const booking = normalizeExtractedBooking({
      kind: "other",
      title: "Dinner",
      startsAt: "next tuesday",
      startsAtTz: "America/Boise",
      details: {},
    });
    expect(booking.startsAt).toBeNull();
  });

  it("nulls an unrecognised timezone", () => {
    const booking = normalizeExtractedBooking({
      kind: "other",
      title: "Dinner",
      startsAt: "2026-10-10T02:00:00Z",
      startsAtTz: "Mars/Olympus",
      details: {},
    });
    expect(booking.startsAtTz).toBeNull();
  });

  it("degrades a booking whose per-kind details fail to kind other, keeping the draft", () => {
    // A "flight" with no carrier fails flightDetails. Losing the whole email
    // over it serves nobody — the reviewer fixes the kind in one click (#7),
    // and the full payload rides along on the draft.
    const booking = normalizeExtractedBooking({
      kind: "flight",
      title: "DL2214",
      details: { note: "no carrier field" },
    });
    expect(booking.kind).toBe("other");
    expect(booking.details).toEqual({ note: "no carrier field" });
  });

  it("nulls a non-integer costCents rather than inventing or losing money", () => {
    const booking = normalizeExtractedBooking({
      kind: "other",
      title: "Hotel",
      costCents: 612.4,
      details: {},
    });
    expect(booking.costCents).toBeNull();
  });

  it("rejects a kind outside BOOKING_KINDS", () => {
    expect(() => normalizeExtractedBooking({ kind: "spaceship", title: "X", details: {} })).toThrow(
      ExtractionError,
    );
  });

  it("rejects a blank title", () => {
    expect(() => normalizeExtractedBooking({ kind: "other", title: "   ", details: {} })).toThrow(
      ExtractionError,
    );
  });
});

describe("EXTRACTED_JSON_SCHEMA (the model contract)", () => {
  it("offers exactly the booking kinds the app knows", () => {
    const items = EXTRACTED_JSON_SCHEMA.properties.bookings.items;
    expect(items.properties.kind.enum).toEqual([...BOOKING_KINDS]);
  });

  /**
   * STRICT-MODE DISCIPLINE, asserted recursively: every object schema with
   * additionalProperties: false must list EVERY declared property in
   * `required`. Schema-constrained decoders reject — or worse, silently
   * ignore — a schema that breaks this, and "silently ignore" means
   * unconstrained decoding with nothing failing to say so.
   */
  function assertStrictRequired(node: unknown, path: string): void {
    if (node === null || typeof node !== "object") return;
    const schema = node as Record<string, unknown>;
    if (schema.type === "object" && schema.additionalProperties === false) {
      const properties = Object.keys((schema.properties ?? {}) as Record<string, unknown>);
      const required = [...((schema.required ?? []) as string[])];
      expect(required.sort(), `at ${path}`).toEqual(properties.sort());
    }
    for (const [key, value] of Object.entries(schema)) {
      assertStrictRequired(value, `${path}.${key}`);
    }
  }

  it("lists every declared property as required wherever additionalProperties is false", () => {
    assertStrictRequired(EXTRACTED_JSON_SCHEMA, "$");
  });

  it("expresses optionality as nullable unions, so null stays expressible", () => {
    const items = EXTRACTED_JSON_SCHEMA.properties.bookings.items;
    expect(items.properties.startsAt.type).toEqual(["string", "null"]);
    expect(items.properties.confirmationNumber.type).toEqual(["string", "null"]);
    expect(items.properties.costCents.type).toEqual(["integer", "null"]);
  });
});
