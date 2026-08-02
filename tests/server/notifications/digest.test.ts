import { describe, it, expect } from "vitest";
import {
  EARLY_EVENT_HOUR,
  TIMEZONE_FRESHNESS_DAYS,
  chooseDigestTimezone,
  composeDigest,
  digestLocalDate,
  firstEventTimezone,
  splitDigestEntries,
} from "../../../src/server/notifications/digest.js";
import type {
  DigestChecklistItem,
  DigestEntry,
} from "../../../src/server/notifications/digest.js";
import { buildNotificationJson } from "../../../src/server/push/payload.js";
import { MAX_PUSH_PLAINTEXT_BYTES } from "../../../src/server/push/encrypt.js";

/**
 * Composition only — no database, no push service. Everything the digest
 * decides about a day is a pure function of rows and a zone, which is what
 * makes the two hardest cases (the previous-evening heads-up, and a stale
 * stored timezone) cheap enough to pin exhaustively rather than by sampling.
 */

/** Ava is in Boise; the trip is in Tokyo. The two never coincide. */
const BOISE = "America/Boise";
const TOKYO = "Asia/Tokyo";

function entry(overrides: Partial<DigestEntry> & { startsAt: string }): DigestEntry {
  return {
    bookingId: "b1",
    tripId: "t1",
    tripTitle: "Tokyo",
    kind: "flight",
    title: "NRT → BOI",
    location: "Narita",
    startsAtTz: TOKYO,
    ...overrides,
  };
}

function task(overrides: Partial<DigestChecklistItem> = {}): DigestChecklistItem {
  return { id: "c1", tripId: "t1", label: "Print boarding passes", dueOn: "2026-10-08", ...overrides };
}

describe("splitDigestEntries", () => {
  // 2026-10-08 in Tokyo: 09:00 local is 2026-10-08T00:00Z.
  const midMorning = entry({ startsAt: "2026-10-08T00:00:00Z", bookingId: "b-today" });
  // 2026-10-09 06:40 Tokyo local.
  const earlyTomorrow = entry({ startsAt: "2026-10-08T21:40:00Z", bookingId: "b-early" });
  // 2026-10-09 09:00 Tokyo local.
  const laterTomorrow = entry({ startsAt: "2026-10-09T00:00:00Z", bookingId: "b-later" });

  it("groups an event by the calendar day in its OWN zone, not in UTC", () => {
    // 2026-10-08T21:40Z is already the 9th in Tokyo even though it is still
    // the 8th in UTC and the 8th in Boise.
    const { today } = splitDigestEntries([midMorning, earlyTomorrow], "2026-10-08");
    expect(today.map((e) => e.bookingId)).toEqual(["b-today"]);
  });

  it("adds tomorrow's before-dawn event to today, as a heads-up", () => {
    const split = splitDigestEntries([midMorning, earlyTomorrow, laterTomorrow], "2026-10-08");
    expect(split.earlyTomorrow.map((e) => e.bookingId)).toEqual(["b-early"]);
  });

  it("leaves tomorrow's ordinary event for tomorrow's digest", () => {
    const split = splitDigestEntries([laterTomorrow], "2026-10-08");
    expect(split.today).toEqual([]);
    expect(split.earlyTomorrow).toEqual([]);
  });

  it("still lists the early event in its own day's digest — the heads-up is additive", () => {
    // Nothing is MOVED. The 06:40 flight appears the evening before AND on the
    // morning it departs, and its own reminder fires on top of both. There is
    // no suppression anywhere in this feature.
    const split = splitDigestEntries([earlyTomorrow], "2026-10-09");
    expect(split.today.map((e) => e.bookingId)).toEqual(["b-early"]);
  });

  it("treats the boundary hour itself as ordinary, not early", () => {
    const atSeven = entry({
      startsAt: "2026-10-08T22:00:00Z", // 07:00 on the 9th in Tokyo
      bookingId: "b-seven",
    });
    expect(EARLY_EVENT_HOUR).toBe(7);
    expect(splitDigestEntries([atSeven], "2026-10-08").earlyTomorrow).toEqual([]);
  });

  it("skips a row whose stored instant cannot be read instead of throwing", () => {
    const broken = entry({ startsAt: "not-a-timestamp", bookingId: "b-broken" });
    expect(splitDigestEntries([broken, midMorning], "2026-10-08").today.map((e) => e.bookingId))
      .toEqual(["b-today"]);
  });
});

describe("composeDigest", () => {
  const morning = entry({
    startsAt: "2026-10-07T23:20:00Z", // 08:20 on the 8th in Tokyo
    bookingId: "b-morning",
    title: "Shinkansen to Kyoto",
    kind: "train",
  });
  const evening = entry({
    startsAt: "2026-10-08T10:00:00Z", // 19:00 on the 8th in Tokyo
    bookingId: "b-evening",
    title: "Ryokan check-in",
    kind: "lodging",
  });
  const earlyTomorrow = entry({
    startsAt: "2026-10-08T21:40:00Z", // 06:40 on the 9th in Tokyo
    bookingId: "b-early",
    title: "NRT → BOI",
  });

  it("lists the day's plans in order, with each event's own local clock time", () => {
    const digest = composeDigest({
      localDate: "2026-10-08",
      entries: [evening, morning],
      checklist: [],
      sendAt: "2026-10-07T23:00:00Z",
    });
    expect(digest?.todayCount).toBe(2);
    expect(digest?.payload.title).toBe("Today: 2 plans");
    expect(digest?.payload.body).toBe("8:20 AM Shinkansen to Kyoto · 7:00 PM Ryokan check-in");
  });

  it("names the single plan rather than counting to one", () => {
    const digest = composeDigest({
      localDate: "2026-10-08",
      entries: [morning],
      checklist: [],
      sendAt: "2026-10-07T23:00:00Z",
    });
    expect(digest?.payload.title).toBe("Today: Shinkansen to Kyoto");
  });

  it("carries tomorrow's early departure, labelled as tomorrow's", () => {
    const digest = composeDigest({
      localDate: "2026-10-08",
      entries: [morning, earlyTomorrow],
      checklist: [],
      sendAt: "2026-10-07T23:00:00Z",
    });
    expect(digest?.earlyCount).toBe(1);
    expect(digest?.payload.body).toContain("Tomorrow 6:40 AM NRT → BOI");
  });

  it("is worth sending for an early departure alone, on a day with nothing else", () => {
    const digest = composeDigest({
      localDate: "2026-10-08",
      entries: [earlyTomorrow],
      checklist: [],
      sendAt: "2026-10-07T23:00:00Z",
    });
    expect(digest?.payload.title).toBe("Early start tomorrow");
    expect(digest?.todayCount).toBe(0);
    expect(digest?.earlyCount).toBe(1);
  });

  it("counts open checklist items without naming them all", () => {
    const digest = composeDigest({
      localDate: "2026-10-08",
      entries: [morning],
      checklist: [task(), task({ id: "c2", label: "Confirm the ryokan" })],
      sendAt: "2026-10-07T23:00:00Z",
    });
    expect(digest?.checklistCount).toBe(2);
    expect(digest?.payload.body).toContain("2 tasks due");
  });

  it("says nothing at all about an empty day", () => {
    // Silence, not a push reading "nothing today" — that is how people turn
    // digests off.
    expect(
      composeDigest({
        localDate: "2026-10-08",
        entries: [],
        checklist: [],
        sendAt: "2026-10-07T23:00:00Z",
      }),
    ).toBeNull();
  });

  it("deep-links to the day issue #60 made linkable", () => {
    const digest = composeDigest({
      localDate: "2026-10-08",
      entries: [morning],
      checklist: [],
      sendAt: "2026-10-07T23:00:00Z",
    });
    expect(digest?.payload.path).toBe("/trips/t1#days:2026-10-08");
  });

  it("collapses onto the previous day's digest rather than stacking", () => {
    const digest = composeDigest({
      localDate: "2026-10-08",
      entries: [morning],
      checklist: [],
      sendAt: "2026-10-07T23:00:00Z",
    });
    expect(digest?.payload.tag).toBe("d:2026-10-08");
  });

  /**
   * A push payload is stored by a third-party push service and rendered on a
   * lock screen. Asserting the key list exactly is what keeps a confirmation
   * number from ever being added to it by accident.
   */
  it("carries titles and times only, and fits the encrypted payload budget", () => {
    const digest = composeDigest({
      localDate: "2026-10-08",
      entries: [morning, evening, earlyTomorrow],
      checklist: [task()],
      sendAt: "2026-10-07T23:00:00Z",
    });
    expect(Object.keys(digest!.payload).sort()).toEqual([
      "body",
      "path",
      "tag",
      "timestamp",
      "title",
    ]);
    const json = buildNotificationJson(digest!.payload);
    expect(new TextEncoder().encode(json).length).toBeLessThanOrEqual(MAX_PUSH_PLAINTEXT_BYTES);
    expect(json).not.toContain("Narita");
  });

  it("clips a day with far too much in it instead of failing to send anything", () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      entry({
        startsAt: "2026-10-07T23:20:00Z",
        bookingId: `b${i}`,
        title: `A rather long booking title number ${i}`,
      }),
    );
    const digest = composeDigest({
      localDate: "2026-10-08",
      entries: many,
      checklist: [],
      sendAt: "2026-10-07T23:00:00Z",
    });
    expect(() => buildNotificationJson(digest!.payload)).not.toThrow();
    expect(digest!.payload.body!.length).toBeLessThanOrEqual(200);
  });
});

describe("chooseDigestTimezone", () => {
  const now = new Date("2026-10-08T14:00:00Z");
  const daysAgo = (n: number) => new Date(now.getTime() - n * 86_400_000).toISOString();

  it("trusts a recently confirmed stored zone over the trip's", () => {
    expect(
      chooseDigestTimezone({
        storedTimezone: BOISE,
        timezoneUpdatedAt: daysAgo(1),
        now,
        firstEventTimezone: TOKYO,
      }),
    ).toEqual({ timezone: BOISE, source: "stored" });
  });

  it("falls back to the zone of the day's first event once the stored one is stale", () => {
    // The whole point of storing `timezone_updated_at`: a zone last confirmed
    // months ago is a worse guess about where somebody is this morning than
    // the zone of the flight they are about to take.
    expect(
      chooseDigestTimezone({
        storedTimezone: BOISE,
        timezoneUpdatedAt: daysAgo(TIMEZONE_FRESHNESS_DAYS + 1),
        now,
        firstEventTimezone: TOKYO,
      }),
    ).toEqual({ timezone: TOKYO, source: "first-event" });
  });

  it("treats a zone that was never stamped as stale", () => {
    expect(
      chooseDigestTimezone({
        storedTimezone: BOISE,
        timezoneUpdatedAt: null,
        now,
        firstEventTimezone: TOKYO,
      }).source,
    ).toBe("first-event");
  });

  it("keeps the stored zone when there is no event to borrow one from", () => {
    expect(
      chooseDigestTimezone({
        storedTimezone: BOISE,
        timezoneUpdatedAt: daysAgo(400),
        now,
        firstEventTimezone: null,
      }),
    ).toEqual({ timezone: BOISE, source: "stored" });
  });

  it("uses the first event's zone when nothing usable is stored at all", () => {
    for (const stored of [null, "", "Mars/Olympus_Mons"]) {
      expect(
        chooseDigestTimezone({
          storedTimezone: stored,
          timezoneUpdatedAt: daysAgo(1),
          now,
          firstEventTimezone: TOKYO,
        }),
      ).toEqual({ timezone: TOKYO, source: "first-event" });
    }
  });

  it("changes which local date the digest is about", () => {
    // 2026-10-08T14:00Z is the 8th in Boise and already the 9th in Tokyo.
    expect(digestLocalDate("2026-10-08T14:00:00Z", BOISE)).toBe("2026-10-08");
    expect(digestLocalDate("2026-10-08T14:00:00Z", TOKYO)).toBe("2026-10-08");
    expect(digestLocalDate("2026-10-08T16:00:00Z", TOKYO)).toBe("2026-10-09");
  });
});

describe("firstEventTimezone", () => {
  it("picks the zone of the earliest event by instant, which needs no zone to decide", () => {
    expect(
      firstEventTimezone([
        entry({ startsAt: "2026-10-08T10:00:00Z", startsAtTz: BOISE }),
        entry({ startsAt: "2026-10-08T02:00:00Z", startsAtTz: TOKYO }),
      ]),
    ).toBe(TOKYO);
  });

  it("answers null for an empty day rather than inventing a zone", () => {
    expect(firstEventTimezone([])).toBeNull();
  });
});
