import { describe, it, expect } from "vitest";
import { normalizeExtractedBooking } from "../../../src/server/ingest/extracted.js";

/**
 * Issue #23's compatibility half. Tightening the instant validator and
 * rejecting negative amounts at the repositories is only safe if the
 * email-import funnel keeps emitting values those rules accept -- otherwise
 * the change quietly turns legitimate confirmations into failed imports.
 *
 * `normalizeExtractedBooking` is that funnel: every extractor, model-driven or
 * calendar-driven, passes through it before a draft exists.
 */

/** The minimum the extractor schema demands, so each case states one fact. */
function extracted(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { kind: "activity", title: "Red Bus tour", ...over };
}

describe("normalizeExtractedBooking instants", () => {
  it("canonicalizes the local wall time the model is asked for", () => {
    // EXTRACTED_JSON_SCHEMA asks for "2026-10-09T09:40:00" with a separate
    // IANA zone; the funnel does the timezone arithmetic and emits UTC.
    const value = normalizeExtractedBooking(
      extracted({ startsAt: "2026-10-09T09:40:00", startsAtTz: "America/Denver" }),
    );
    expect(value.startsAt).toBe("2026-10-09T15:40:00.000Z");
    expect(value.startsAtTz).toBe("America/Denver");
  });

  it("re-emits an offset-bearing instant as UTC rather than as written", () => {
    const value = normalizeExtractedBooking(
      extracted({ startsAt: "2026-10-09T09:40:00-06:00", startsAtTz: "America/Denver" }),
    );
    expect(value.startsAt).toBe("2026-10-09T15:40:00.000Z");
  });

  it("emits only instants the repositories accept", () => {
    // The point of the whole funnel: whatever went in, what comes out is the
    // one canonical spelling, so a stricter write-time rule cannot start
    // rejecting imports that used to land.
    for (const startsAt of [
      "2026-10-09T09:40:00",
      "2026-10-09T09:40",
      "2026-10-09T09:40:00-06:00",
      "2026-10-09T15:40:00Z",
    ]) {
      const value = normalizeExtractedBooking(
        extracted({ startsAt, startsAtTz: "America/Denver" }),
      );
      expect(value.startsAt, startsAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    }
  });

  it("drops a time it cannot make sense of instead of failing the whole booking", () => {
    const value = normalizeExtractedBooking(
      extracted({ startsAt: "sometime Tuesday", startsAtTz: "America/Denver" }),
    );
    expect(value.startsAt).toBeNull();
    expect(value.startsAtTz).toBeNull();
    expect(value.title).toBe("Red Bus tour");
  });

  it("drops an impossible date, which Date.parse would have rolled forward", () => {
    const value = normalizeExtractedBooking(
      extracted({ startsAt: "2026-02-30T09:40:00Z", startsAtTz: "America/Denver" }),
    );
    expect(value.startsAt).toBeNull();
  });

  it("drops an end that precedes its start, keeping the load-bearing half", () => {
    const value = normalizeExtractedBooking(
      extracted({
        startsAt: "2026-10-09T09:40:00",
        startsAtTz: "America/Denver",
        endsAt: "2026-10-09T08:40:00",
        endsAtTz: "America/Denver",
      }),
    );
    expect(value.startsAt).toBe("2026-10-09T15:40:00.000Z");
    expect(value.endsAt).toBeNull();
    expect(value.endsAtTz).toBeNull();
  });

  it("keeps a cross-timezone leg whose local times look inverted", () => {
    const value = normalizeExtractedBooking(
      extracted({
        kind: "flight",
        startsAt: "2026-10-09T23:00:00",
        startsAtTz: "America/Anchorage",
        endsAt: "2026-10-11T06:00:00",
        endsAtTz: "Asia/Tokyo",
      }),
    );
    expect(value.startsAt).not.toBeNull();
    expect(value.endsAt).not.toBeNull();
  });
});

describe("normalizeExtractedBooking amounts", () => {
  it("keeps a whole, non-negative cost", () => {
    expect(normalizeExtractedBooking(extracted({ costCents: 12500 })).costCents).toBe(12500);
    expect(normalizeExtractedBooking(extracted({ costCents: 0 })).costCents).toBe(0);
  });

  it("drops a negative cost -- a refund line read as the total", () => {
    // Repositories reject negative amounts outright, so passing one through
    // would make the whole import unacceptable rather than merely priceless.
    expect(normalizeExtractedBooking(extracted({ costCents: -12500 })).costCents).toBeNull();
  });

  it("still drops a fractional cost", () => {
    expect(normalizeExtractedBooking(extracted({ costCents: 125.5 })).costCents).toBeNull();
  });
});
