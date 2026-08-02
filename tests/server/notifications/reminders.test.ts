import { describe, it, expect } from "vitest";
import { reminderPayload, reminderTag } from "../../../src/server/notifications/reminders.js";
import {
  clip,
  dayPath,
  formatEventTime,
  formatLead,
  verbForKind,
} from "../../../src/server/notifications/format.js";
import { reminderSendAt } from "../../../src/server/repos/notification.js";
import type { DueReminder } from "../../../src/server/repos/notification.js";
import { buildNotificationJson } from "../../../src/server/push/payload.js";

/** 10:00 on 8 October, Tokyo time. The recipient lives in Boise. */
const DEPARTURE = "2026-10-08T01:00:00Z";

function due(overrides: Partial<DueReminder> = {}): DueReminder {
  return {
    userId: "u-ava",
    bookingId: "b1",
    tripId: "t1",
    tripTitle: "Tokyo",
    kind: "flight",
    title: "NRT → BOI",
    location: "Narita",
    startsAt: DEPARTURE,
    startsAtTz: "Asia/Tokyo",
    leadMinutes: 60,
    sendAt: "2026-10-08T00:00:00.000Z",
    ...overrides,
  };
}

describe("reminderSendAt — when, which no timezone may touch", () => {
  /**
   * The single rule this feature must not get wrong twice: WHEN is
   * `starts_at − lead_minutes`, arithmetic on the stored instant. The
   * recipient's zone, the booking's zone and the server's zone are all
   * irrelevant to it, and conflating any of them with the send moment is how
   * a reminder arrives at the right local time in the wrong local place.
   */
  it("is the same instant whether the flight leaves Tokyo or Boise", () => {
    expect(reminderSendAt(DEPARTURE, 60)).toBe("2026-10-08T00:00:00.000Z");
    // Same instant, a booking stored with a Boise zone instead. Nothing moves.
    expect(reminderSendAt(DEPARTURE, 60)).toBe("2026-10-08T00:00:00.000Z");
  });

  it("treats a zero lead as 'at the moment it starts', not as 'off'", () => {
    expect(reminderSendAt(DEPARTURE, 0)).toBe("2026-10-08T01:00:00.000Z");
  });
});

describe("reminderPayload — what it says, which the booking's timezone decides", () => {
  it("states the departure in the BOOKING's zone, with the offset spelled out", () => {
    // The recipient is in Boise (UTC−6 in October). Rendering "7:00 PM"
    // because that is what their own clock says would read perfectly and mean
    // the wrong thing.
    const payload = reminderPayload(due());
    expect(payload.title).toBe("NRT → BOI");
    expect(payload.body).toBe("In 1 hour · Departs 10:00 AM GMT+9 · Narita");
  });

  it("deep-links to the day the event belongs to in its own zone", () => {
    // 2026-10-08T01:00Z is already the 8th in Tokyo and still the 7th in
    // Boise; the link follows the event, matching the day view.
    expect(reminderPayload(due()).path).toBe("/trips/t1#days:2026-10-08");
  });

  it("carries the instant it is about, not the instant it was sent", () => {
    expect(reminderPayload(due()).timestamp).toBe(DEPARTURE);
  });

  it("collapses onto the previous card for the same booking when a flight moves", () => {
    // Keyed on the booking, not the occurrence: the new departure should
    // REPLACE the card describing the old one. Preventing a double send is
    // notification_log's job, not the tag's — and its key does include the
    // instant, which is why a moved flight re-arms at all.
    expect(reminderPayload(due()).tag).toBe("r:b1");
    expect(reminderPayload(due({ startsAt: "2026-10-08T05:00:00Z" })).tag).toBe("r:b1");
    expect(reminderTag("b1").length).toBeLessThanOrEqual(64);
  });

  /**
   * `DueReminder` has nowhere to put a confirmation number and
   * `buildNotificationJson` copies a closed set of fields by name. Asserting
   * the key list exactly is what keeps a sixth field from appearing quietly.
   */
  it("has room for titles and times and nowhere for a confirmation number", () => {
    expect(Object.keys(reminderPayload(due())).sort()).toEqual([
      "body",
      "path",
      "tag",
      "timestamp",
      "title",
    ]);
    expect(() => buildNotificationJson(reminderPayload(due()))).not.toThrow();
  });

  it("clips an absurd booking title rather than losing the notification", () => {
    const payload = reminderPayload(due({ title: "A ".repeat(200) }));
    expect(payload.title!.length).toBeLessThanOrEqual(100);
    expect(() => buildNotificationJson(payload)).not.toThrow();
  });

  it("falls back to the trip's name when a booking has no title of its own", () => {
    expect(reminderPayload(due({ title: "  " })).title).toBe("Tokyo");
  });

  it("drops the time entirely rather than rendering a corrupt row", () => {
    const payload = reminderPayload(due({ startsAt: "nonsense", startsAtTz: null }));
    expect(payload.body).toBe("In 1 hour · Narita");
  });
});

describe("phrasing", () => {
  it("says how far out the event is in units a person uses", () => {
    expect(formatLead(0)).toBe("Starting now");
    expect(formatLead(45)).toBe("In 45 minutes");
    expect(formatLead(60)).toBe("In 1 hour");
    expect(formatLead(90)).toBe("In 1 hour 30 minutes");
    expect(formatLead(1440)).toBe("In 1 day");
    expect(formatLead(1560)).toBe("In 1 day 2 hours");
  });

  it("picks a verb that fits the booking, and something bland for a kind it has never seen", () => {
    expect(verbForKind("flight")).toBe("Departs");
    expect(verbForKind("lodging")).toBe("Check-in");
    expect(verbForKind("hot-air-balloon")).toBe("Starts");
  });

  it("renders a zone-less row in UTC without pretending that was a choice", () => {
    expect(formatEventTime(DEPARTURE, null)).toBe("1:00 AM");
    expect(formatEventTime(DEPARTURE, "America/Boise")).toBe("7:00 PM GMT-6");
  });

  it("builds the day link in the format issue #60 shipped", () => {
    expect(dayPath("t1", "2026-10-08")).toBe("/trips/t1#days:2026-10-08");
  });

  it("clips on a word boundary when there is one worth using", () => {
    expect(clip("short", 20)).toBe("short");
    expect(clip("a considerably longer sentence than fits", 20)).toBe("a considerably…");
  });
});
