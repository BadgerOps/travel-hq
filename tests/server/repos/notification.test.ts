import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import {
  NotificationRepo,
  DEFAULT_REMINDER_LEAD_MINUTES,
  defaultNotificationPreferences,
  digestSendInstant,
  effectiveReminderLeadMinutes,
  reminderSendAt,
  resolveSubscription,
} from "../../../src/server/repos/notification.js";
import { NotFoundError, ValidationError } from "../../../src/server/repos/base.js";
import type { HouseholdContext } from "../../../src/server/repos/base.js";

/**
 * Two households throughout, because the single most important property of
 * every table in migration 0017 is one it cannot express structurally: the
 * tables are keyed by user and carry no household_id, so "hh-b's owner cannot
 * subscribe to hh-a's flight" is enforced by NotificationRepo alone, and a
 * suite with one household could not tell whether it works.
 */
const ctxAva: HouseholdContext = { householdId: "hh-a", userId: "u-ava", role: "owner" };
const ctxBo: HouseholdContext = { householdId: "hh-a", userId: "u-bo", role: "adult" };
const ctxZed: HouseholdContext = { householdId: "hh-b", userId: "u-zed", role: "owner" };

/** Departs Tokyo; the recipients live in Boise. The two never coincide. */
const TOKYO_DEPARTURE = "2026-08-02T15:00:00Z";

beforeEach(async () => {
  for (const table of [
    "notification_log",
    "notification_subscription",
    "push_subscription",
    "notification_preference",
    "booking_person",
    "trip_person",
    "trip_member",
    "booking",
    "person",
    "trip",
    "household_member",
    "household",
    "user",
  ]) {
    await env.DB.exec(`DELETE FROM ${table}`);
  }

  const now = "2026-07-01T00:00:00.000Z";
  const household = env.DB.prepare("INSERT INTO household (id,name,created_at) VALUES (?,?,?)");
  await household.bind("hh-a", "A", now).run();
  await household.bind("hh-b", "B", now).run();

  const user = env.DB.prepare("INSERT INTO user (id,email,created_at) VALUES (?,?,?)");
  await user.bind("u-ava", "ava@example.com", now).run();
  await user.bind("u-bo", "bo@example.com", now).run();
  await user.bind("u-zed", "zed@example.com", now).run();

  const member = env.DB.prepare(
    "INSERT INTO household_member (household_id,user_id,role) VALUES (?,?,?)",
  );
  await member.bind("hh-a", "u-ava", "owner").run();
  await member.bind("hh-a", "u-bo", "adult").run();
  await member.bind("hh-b", "u-zed", "owner").run();

  const trip = env.DB.prepare("INSERT INTO trip (id,household_id,title,created_at) VALUES (?,?,?,?)");
  await trip.bind("t1", "hh-a", "Tokyo", now).run();
  await trip.bind("t2", "hh-b", "Elsewhere", now).run();

  const person = env.DB.prepare(
    "INSERT INTO person (id,household_id,display_name,user_id,created_at) VALUES (?,?,?,?,?)",
  );
  await person.bind("p-ava", "hh-a", "Ava", "u-ava", now).run();
  await person.bind("p-bo", "hh-a", "Bo", "u-bo", now).run();
  await person.bind("p-zed", "hh-b", "Zed", "u-zed", now).run();

  await insertBooking("b1", "hh-a", "t1", "NRT -> BOI", TOKYO_DEPARTURE, "Asia/Tokyo");
  await insertBooking("b-zed", "hh-b", "t2", "Somebody else's flight", TOKYO_DEPARTURE, "Asia/Tokyo");

  // Ava is travelling on b1; Bo is not. That asymmetry is what makes the
  // implicit-vs-explicit tests mean anything.
  await env.DB.prepare("INSERT INTO booking_person (booking_id,person_id) VALUES (?,?)")
    .bind("b1", "p-ava")
    .run();
});

async function insertBooking(
  id: string,
  householdId: string,
  tripId: string,
  title: string,
  startsAt: string | null,
  startsAtTz: string | null,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO booking (id,household_id,trip_id,kind,title,location,starts_at,starts_at_tz,status,created_at)
     VALUES (?,?,?,'flight',?,?,?,?,'booked',?)`,
  )
    .bind(id, householdId, tripId, title, "Narita", startsAt, startsAtTz, "2026-07-01T00:00:00.000Z")
    .run();
}

const claim = (userId: string, subjectId: string, eventInstant: string) => ({
  userId,
  kind: "reminder" as const,
  subjectId,
  eventInstant,
});

/**
 * The reminder rule as a pure function. These tests need no database at all,
 * which is the point of it being pure: the cron sweep applies this to every
 * candidate pair, and it has to be cheap enough to pin exhaustively.
 */
describe("effectiveReminderLeadMinutes", () => {
  const base = { remindersEnabled: true, userLeadMinutes: 90 };

  it("follows the account default when the booking inherits", () => {
    expect(
      effectiveReminderLeadMinutes({ ...base, bookingMode: "inherit", bookingLeadMinutes: null }),
    ).toBe(90);
  });

  it("prefers the booking's own lead when it is custom", () => {
    expect(
      effectiveReminderLeadMinutes({ ...base, bookingMode: "custom", bookingLeadMinutes: 15 }),
    ).toBe(15);
  });

  /**
   * The entire reason `reminder_mode` is a tri-state. A custom lead of zero
   * means "tell me when it starts"; if it collapsed to "off", there would be
   * no way to ask for that at all, and no way back once asked.
   */
  it("treats a custom lead of 0 as 'at start', NOT as off", () => {
    expect(
      effectiveReminderLeadMinutes({ ...base, bookingMode: "custom", bookingLeadMinutes: 0 }),
    ).toBe(0);
    expect(
      effectiveReminderLeadMinutes({ ...base, bookingMode: "off", bookingLeadMinutes: 0 }),
    ).toBeNull();
  });

  it("sends nothing for a booking switched off, whatever lead it remembers", () => {
    expect(
      effectiveReminderLeadMinutes({ ...base, bookingMode: "off", bookingLeadMinutes: 30 }),
    ).toBeNull();
  });

  it("sends nothing at all when the account has reminders turned off", () => {
    for (const bookingMode of ["inherit", "custom", "off"] as const) {
      expect(
        effectiveReminderLeadMinutes({
          remindersEnabled: false,
          userLeadMinutes: 90,
          bookingMode,
          bookingLeadMinutes: 5,
        }),
      ).toBeNull();
    }
  });

  it("falls back to the account default rather than throwing on nonsense stored values", () => {
    expect(
      effectiveReminderLeadMinutes({
        ...base,
        bookingMode: "sometimes" as never,
        bookingLeadMinutes: null,
      }),
    ).toBe(90);
    expect(
      effectiveReminderLeadMinutes({ ...base, bookingMode: "custom", bookingLeadMinutes: -5 }),
    ).toBe(DEFAULT_REMINDER_LEAD_MINUTES);
    expect(
      effectiveReminderLeadMinutes({
        remindersEnabled: true,
        userLeadMinutes: Number.NaN,
        bookingMode: "inherit",
        bookingLeadMinutes: null,
      }),
    ).toBe(DEFAULT_REMINDER_LEAD_MINUTES);
  });
});

describe("reminderSendAt", () => {
  /**
   * "An hour before" is an hour before, in Tokyo or in Boise. The send moment
   * comes from the stored instant and the lead, and nothing else touches it —
   * a zone anywhere in this calculation is how a reminder ends up firing at
   * the right local time in the wrong local place.
   */
  it("is computed from the stored instant alone, ignoring every timezone in play", () => {
    expect(reminderSendAt(TOKYO_DEPARTURE, 60)).toBe("2026-08-02T14:00:00.000Z");
    // Same instant written with a Tokyo offset instead of Z: same answer.
    expect(reminderSendAt("2026-08-03T00:00:00+09:00", 60)).toBe("2026-08-02T14:00:00.000Z");
  });

  it("returns the event itself for a lead of zero", () => {
    expect(reminderSendAt(TOKYO_DEPARTURE, 0)).toBe("2026-08-02T15:00:00.000Z");
  });

  it("returns null for an unparseable stored instant instead of throwing", () => {
    expect(reminderSendAt("not a time", 60)).toBeNull();
  });
});

describe("resolveSubscription", () => {
  it("lets an explicit booking decision beat the trip decision and the implicit default", () => {
    expect(resolveSubscription({ implicit: true, bookingChoice: false, tripChoice: true })).toBe(false);
    expect(resolveSubscription({ implicit: false, bookingChoice: true, tripChoice: false })).toBe(true);
  });

  it("falls back to the trip decision, then to travelling on it", () => {
    expect(resolveSubscription({ implicit: true, bookingChoice: null, tripChoice: false })).toBe(false);
    expect(resolveSubscription({ implicit: false, bookingChoice: null, tripChoice: true })).toBe(true);
    expect(resolveSubscription({ implicit: true, bookingChoice: null, tripChoice: null })).toBe(true);
    expect(resolveSubscription({ implicit: false, bookingChoice: null, tripChoice: null })).toBe(false);
  });
});

describe("NotificationRepo preferences", () => {
  it("returns the documented defaults for an account that has never saved any", async () => {
    const prefs = await new NotificationRepo(env.DB, ctxAva).getPreferences();
    expect(prefs).toEqual(defaultNotificationPreferences());
    expect(prefs.reminderLeadMinutes).toBe(60);
    expect(prefs.remindersEnabled).toBe(true);
    expect(prefs.digestEnabled).toBe(false);
  });

  it("leaves absent fields unchanged and keeps exactly one row per account", async () => {
    const repo = new NotificationRepo(env.DB, ctxAva);
    await repo.updatePreferences({ digestEnabled: true, digestSendTime: "08:00" });
    await repo.updatePreferences({ reminderLeadMinutes: 15 });
    expect(await repo.getPreferences()).toEqual({
      digestEnabled: true,
      digestSendTime: "08:00",
      remindersEnabled: true,
      reminderLeadMinutes: 15,
    });
    const count = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM notification_preference WHERE user_id = ?",
    ).bind("u-ava").first<{ n: number }>();
    expect(count?.n).toBe(1);
  });

  it("clears the digest send time with null and accepts a lead of zero", async () => {
    const repo = new NotificationRepo(env.DB, ctxAva);
    await repo.updatePreferences({ digestSendTime: "08:00", reminderLeadMinutes: 0 });
    const prefs = await repo.updatePreferences({ digestSendTime: null });
    expect(prefs.digestSendTime).toBeNull();
    expect(prefs.reminderLeadMinutes).toBe(0);
  });

  it("rejects a send time that is not a wall clock, and an impossible lead", async () => {
    const repo = new NotificationRepo(env.DB, ctxAva);
    for (const digestSendTime of ["8am", "24:00", "8:00", "2026-08-02T08:00:00Z"]) {
      await expect(repo.updatePreferences({ digestSendTime })).rejects.toThrow(ValidationError);
    }
    for (const reminderLeadMinutes of [-1, 1.5, 60 * 24 * 8]) {
      await expect(repo.updatePreferences({ reminderLeadMinutes })).rejects.toThrow(ValidationError);
    }
  });

  it("keeps one account's preferences invisible to another", async () => {
    await new NotificationRepo(env.DB, ctxAva).updatePreferences({ reminderLeadMinutes: 5 });
    expect(await new NotificationRepo(env.DB, ctxBo).getPreferences()).toEqual(
      defaultNotificationPreferences(),
    );
    expect(await new NotificationRepo(env.DB, ctxZed).getPreferences()).toEqual(
      defaultNotificationPreferences(),
    );
  });

  it("reads a corrupt stored send time as 'not chosen' rather than throwing", async () => {
    await env.DB.prepare(
      `INSERT INTO notification_preference (user_id, digest_enabled, digest_send_time, created_at, updated_at)
       VALUES (?,1,?,?,?)`,
    ).bind("u-ava", "half past eight", "2026-07-01T00:00:00Z", "2026-07-01T00:00:00Z").run();
    expect((await new NotificationRepo(env.DB, ctxAva).getPreferences()).digestSendTime).toBeNull();
  });

  /**
   * Was the opposite assertion until the HTTP layer went in, and the flip is
   * the point rather than a relaxation. `requireWrite()` denies the household
   * `viewer` role because a viewer may not change HOUSEHOLD data — and a
   * preference row keyed by `user_id` is not household data. Every shared-trip
   * account is a household viewer (trip-authorization.ts), so the old rule
   * meant the parent following a kid's connection — #61's motivating example —
   * could not set their own lead time. See the note at the top of
   * repos/notification.ts.
   */
  it("lets a household viewer set their OWN preferences: this is not household data", async () => {
    const viewer = new NotificationRepo(env.DB, { ...ctxAva, role: "viewer" });
    expect(await viewer.updatePreferences({ reminderLeadMinutes: 5 })).toMatchObject({
      reminderLeadMinutes: 5,
    });
  });
});

describe("NotificationRepo timezone", () => {
  it("stores an IANA name with its provenance and refuses a fixed offset", async () => {
    const repo = new NotificationRepo(env.DB, ctxAva);
    const stored = await repo.setTimezone({ timezone: "America/Boise", source: "device" });
    expect(stored).toMatchObject({ timezone: "America/Boise", source: "device" });
    expect(stored.updatedAt).not.toBeNull();
    await expect(repo.setTimezone({ timezone: "-08:00", source: "manual" })).rejects.toThrow(
      ValidationError,
    );
    await expect(repo.setTimezone({ timezone: "Mars/Olympus", source: "manual" })).rejects.toThrow(
      ValidationError,
    );
  });

  /**
   * The client re-posts the device zone on open and on every
   * `visibilitychange`, so a pin that auto-updates could clobber it is a pin
   * that survives until the app is next backgrounded. Ava pinned Boise; a
   * layover in Amsterdam must not move her morning digest to CET.
   */
  it("keeps a manual pin through an automatic device report", async () => {
    const repo = new NotificationRepo(env.DB, ctxAva);
    await repo.setTimezone({ timezone: "America/Boise", source: "manual" });
    const afterAutoUpdate = await repo.setTimezone({
      timezone: "Europe/Amsterdam",
      source: "device",
    });
    expect(afterAutoUpdate).toMatchObject({ timezone: "America/Boise", source: "manual" });
  });

  it("lets a deliberate manual choice replace an earlier one", async () => {
    const repo = new NotificationRepo(env.DB, ctxAva);
    await repo.setTimezone({ timezone: "America/Boise", source: "manual" });
    expect(await repo.setTimezone({ timezone: "Europe/Amsterdam", source: "manual" })).toMatchObject(
      { timezone: "Europe/Amsterdam", source: "manual" },
    );
  });

  /** Clearing the value clears the pin, so the next device report is taken. */
  it("resets to automatic when the pin is cleared", async () => {
    const repo = new NotificationRepo(env.DB, ctxAva);
    await repo.setTimezone({ timezone: "America/Boise", source: "manual" });
    expect(await repo.setTimezone({ timezone: null, source: "device" })).toEqual({
      timezone: null,
      source: null,
      updatedAt: null,
    });
    expect(await repo.setTimezone({ timezone: "Europe/Amsterdam", source: "device" })).toMatchObject(
      { timezone: "Europe/Amsterdam", source: "device" },
    );
  });

  it("reads an unrecognised stored zone as no zone at all", async () => {
    await env.DB.prepare("UPDATE user SET timezone = ?, timezone_source = ? WHERE id = ?")
      .bind("Mars/Olympus", "manual", "u-ava")
      .run();
    expect(await new NotificationRepo(env.DB, ctxAva).getTimezone()).toEqual({
      timezone: null,
      source: null,
      updatedAt: null,
    });
  });

  it("sets only the calling account's zone", async () => {
    await new NotificationRepo(env.DB, ctxAva).setTimezone({
      timezone: "America/Boise",
      source: "manual",
    });
    expect((await new NotificationRepo(env.DB, ctxBo).getTimezone()).timezone).toBeNull();
  });
});

describe("NotificationRepo push subscriptions", () => {
  const device = {
    endpoint: "https://push.example/ava-phone",
    p256dh: "phone-key",
    auth: "phone-auth",
  };

  it("upserts on the endpoint so a re-subscribing device is not duplicated", async () => {
    const repo = new NotificationRepo(env.DB, ctxAva);
    const first = await repo.registerPushSubscription(device);
    expect(first).toMatchObject({ userId: "u-ava", endpoint: device.endpoint, failureCount: 0 });

    await repo.registerPushSubscription({ ...device, p256dh: "rotated", auth: "rotated-auth" });
    const all = await repo.listPushSubscriptions();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ p256dh: "rotated", auth: "rotated-auth" });
  });

  it("keeps a phone and a laptop as two independent endpoints", async () => {
    const repo = new NotificationRepo(env.DB, ctxAva);
    await repo.registerPushSubscription(device);
    await repo.registerPushSubscription({
      endpoint: "https://push.example/ava-laptop",
      p256dh: "laptop-key",
      auth: "laptop-auth",
    });
    expect(await repo.listPushSubscriptions()).toHaveLength(2);
    expect(await NotificationRepo.listPushSubscriptionsForUser(env.DB, "u-ava")).toHaveLength(2);
  });

  it("lists and deletes only the calling account's own devices", async () => {
    const ava = new NotificationRepo(env.DB, ctxAva);
    const bo = new NotificationRepo(env.DB, ctxBo);
    const mine = await ava.registerPushSubscription(device);
    await bo.registerPushSubscription({
      endpoint: "https://push.example/bo-phone",
      p256dh: "k",
      auth: "a",
    });

    expect(await bo.listPushSubscriptions()).toHaveLength(1);
    await expect(bo.deletePushSubscription(mine.id)).rejects.toThrow(NotFoundError);
    await ava.deletePushSubscription(mine.id);
    expect(await ava.listPushSubscriptions()).toHaveLength(0);
  });

  it("prunes an endpoint the push service says is gone, and counts the ones that only failed", async () => {
    const repo = new NotificationRepo(env.DB, ctxAva);
    await repo.registerPushSubscription(device);
    await NotificationRepo.recordPushFailure(env.DB, device.endpoint);
    expect((await repo.listPushSubscriptions())[0]).toMatchObject({ failureCount: 1 });
    await NotificationRepo.recordPushSuccess(env.DB, device.endpoint);
    expect((await repo.listPushSubscriptions())[0]?.failureCount).toBe(0);

    expect(await NotificationRepo.pruneEndpoint(env.DB, device.endpoint)).toBe(true);
    expect(await NotificationRepo.pruneEndpoint(env.DB, device.endpoint)).toBe(false);
    expect(await repo.listPushSubscriptions()).toHaveLength(0);
  });

  it("rejects a blank endpoint or key rather than storing an unusable device", async () => {
    const repo = new NotificationRepo(env.DB, ctxAva);
    await expect(repo.registerPushSubscription({ ...device, endpoint: "  " })).rejects.toThrow(
      ValidationError,
    );
    await expect(repo.registerPushSubscription({ ...device, auth: "" })).rejects.toThrow(
      ValidationError,
    );
  });
});

describe("NotificationRepo subscriptions", () => {
  it("notifies whoever is travelling on a booking without any row at all", async () => {
    const state = await new NotificationRepo(env.DB, ctxAva).getBookingSubscriptionState("b1");
    expect(state).toMatchObject({
      implicit: true,
      bookingChoice: null,
      tripChoice: null,
      subscribed: true,
    });
  });

  it("lets somebody follow a booking they are not on", async () => {
    const bo = new NotificationRepo(env.DB, ctxBo);
    expect(await bo.getBookingSubscriptionState("b1")).toMatchObject({
      implicit: false,
      subscribed: false,
    });
    expect(await bo.subscribeToBooking("b1")).toMatchObject({
      implicit: false,
      bookingChoice: true,
      subscribed: true,
    });
  });

  /** The direction a presence-means-subscribed design cannot express. */
  it("lets somebody mute a booking they are literally travelling on", async () => {
    const ava = new NotificationRepo(env.DB, ctxAva);
    expect(await ava.unsubscribeFromBooking("b1")).toMatchObject({
      implicit: true,
      bookingChoice: false,
      subscribed: false,
    });
    expect(await ava.clearBookingSubscription("b1")).toMatchObject({
      bookingChoice: null,
      subscribed: true,
    });
  });

  /**
   * The reason a trip subscription is ONE row naming the trip rather than a
   * fan-out across its bookings: the booking below did not exist when Bo
   * subscribed, and must still be covered.
   */
  it("covers a booking added to the trip after the trip was subscribed", async () => {
    const bo = new NotificationRepo(env.DB, ctxBo);
    await bo.subscribeToTrip("t1");
    await insertBooking("b-late", "hh-a", "t1", "Added later", "2026-08-03T01:00:00Z", "Asia/Tokyo");
    expect(await bo.getBookingSubscriptionState("b-late")).toMatchObject({
      implicit: false,
      tripChoice: true,
      subscribed: true,
    });
  });

  it("lets a per-booking decision override the trip-wide one in both directions", async () => {
    const bo = new NotificationRepo(env.DB, ctxBo);
    await bo.subscribeToTrip("t1");
    expect(await bo.unsubscribeFromBooking("b1")).toMatchObject({
      tripChoice: true,
      bookingChoice: false,
      subscribed: false,
    });

    const ava = new NotificationRepo(env.DB, ctxAva);
    await ava.unsubscribeFromTrip("t1");
    expect(await ava.getBookingSubscriptionState("b1")).toMatchObject({
      implicit: true,
      tripChoice: false,
      subscribed: false,
    });
    expect(await ava.subscribeToBooking("b1")).toMatchObject({ subscribed: true });
    await ava.clearTripSubscription("t1");
    expect(await ava.getBookingSubscriptionState("b1")).toMatchObject({ tripChoice: null });
  });

  /**
   * The acceptance criterion the unscoped tables cannot enforce themselves.
   * Every one of these goes through a household-scoped SELECT first, so an
   * id from another household is indistinguishable from a nonexistent one.
   */
  it("refuses to subscribe an account to a booking or trip in another household", async () => {
    const zed = new NotificationRepo(env.DB, ctxZed);
    await expect(zed.subscribeToBooking("b1")).rejects.toThrow(NotFoundError);
    await expect(zed.unsubscribeFromBooking("b1")).rejects.toThrow(NotFoundError);
    await expect(zed.clearBookingSubscription("b1")).rejects.toThrow(NotFoundError);
    await expect(zed.subscribeToTrip("t1")).rejects.toThrow(NotFoundError);
    await expect(zed.unsubscribeFromTrip("t1")).rejects.toThrow(NotFoundError);
    await expect(zed.clearTripSubscription("t1")).rejects.toThrow(NotFoundError);
    await expect(zed.getBookingSubscriptionState("b1")).rejects.toThrow(NotFoundError);
    await expect(zed.effectiveReminderLeadFor("b1")).rejects.toThrow(NotFoundError);
    const rows = await env.DB.prepare("SELECT COUNT(*) AS n FROM notification_subscription")
      .first<{ n: number }>();
    expect(rows?.n).toBe(0);
  });

  it("resolves the lead time for a real (account, booking) pair", async () => {
    const ava = new NotificationRepo(env.DB, ctxAva);
    expect(await ava.effectiveReminderLeadFor("b1")).toBe(60);

    await env.DB.prepare(
      "UPDATE booking SET reminder_mode = 'custom', reminder_lead_minutes = 0 WHERE id = ?",
    ).bind("b1").run();
    expect(await ava.effectiveReminderLeadFor("b1")).toBe(0);

    await env.DB.prepare("UPDATE booking SET reminder_mode = 'off' WHERE id = ?").bind("b1").run();
    expect(await ava.effectiveReminderLeadFor("b1")).toBeNull();

    await env.DB.prepare("UPDATE booking SET reminder_mode = 'inherit' WHERE id = ?").bind("b1").run();
    await ava.updatePreferences({ remindersEnabled: false });
    expect(await ava.effectiveReminderLeadFor("b1")).toBeNull();
  });
});

/**
 * The cron seam. Every method here takes a D1Database directly and is
 * deliberately unscoped, following InboundEmailRepo.purgeExpiredRawEverywhere.
 */
describe("NotificationRepo.findDueReminders", () => {
  /** One minute wide, ending at Ava's 60-minute lead for the Tokyo flight. */
  const from = new Date("2026-08-02T14:00:00Z");
  const to = new Date("2026-08-02T14:01:00Z");

  it("finds the flight an hour out for the person travelling on it", async () => {
    const due = await NotificationRepo.findDueReminders(env.DB, from, to);
    expect(due).toHaveLength(1);
    expect(due[0]).toMatchObject({
      userId: "u-ava",
      bookingId: "b1",
      tripId: "t1",
      tripTitle: "Tokyo",
      title: "NRT -> BOI",
      startsAt: TOKYO_DEPARTURE,
      startsAtTz: "Asia/Tokyo",
      leadMinutes: 60,
      sendAt: "2026-08-02T14:00:00.000Z",
    });
  });

  /**
   * A push payload is stored by a third-party push service and rendered on a
   * lock screen. Asserting the key list exactly is what keeps a confirmation
   * number from ever being added to it by accident.
   */
  it("returns titles and times only, with nowhere to put a confirmation number", async () => {
    const due = await NotificationRepo.findDueReminders(env.DB, from, to);
    expect(Object.keys(due[0] ?? {}).sort()).toEqual([
      "bookingId",
      "kind",
      "leadMinutes",
      "location",
      "sendAt",
      "startsAt",
      "startsAtTz",
      "title",
      "tripId",
      "tripTitle",
      "userId",
    ]);
  });

  /**
   * The recipient is in Boise, the flight leaves Tokyo, and the window is in
   * UTC. None of those three zones may shift the answer: the send moment is
   * the stored instant minus the lead.
   */
  it("fires at the same instant whatever timezone the recipient is pinned to", async () => {
    for (const timezone of ["America/Boise", "Asia/Tokyo", "Pacific/Kiritimati"]) {
      await new NotificationRepo(env.DB, ctxAva).setTimezone({ timezone, source: "manual" });
      const due = await NotificationRepo.findDueReminders(env.DB, from, to);
      expect(due.map((d) => d.sendAt)).toEqual(["2026-08-02T14:00:00.000Z"]);
    }
  });

  it("moves the send moment when the account changes its own lead", async () => {
    await new NotificationRepo(env.DB, ctxAva).updatePreferences({ reminderLeadMinutes: 15 });
    expect(await NotificationRepo.findDueReminders(env.DB, from, to)).toHaveLength(0);
    const due = await NotificationRepo.findDueReminders(
      env.DB,
      new Date("2026-08-02T14:45:00Z"),
      new Date("2026-08-02T14:46:00Z"),
    );
    expect(due.map((d) => d.leadMinutes)).toEqual([15]);
  });

  it("honours a booking that opts out, and one that asks for the moment of departure", async () => {
    await env.DB.prepare("UPDATE booking SET reminder_mode = 'off' WHERE id = ?").bind("b1").run();
    expect(await NotificationRepo.findDueReminders(env.DB, from, to)).toHaveLength(0);

    await env.DB.prepare(
      "UPDATE booking SET reminder_mode = 'custom', reminder_lead_minutes = 0 WHERE id = ?",
    ).bind("b1").run();
    const atStart = await NotificationRepo.findDueReminders(
      env.DB,
      new Date("2026-08-02T15:00:00Z"),
      new Date("2026-08-02T15:01:00Z"),
    );
    expect(atStart.map((d) => d.leadMinutes)).toEqual([0]);
  });

  it("skips an account that turned reminders off, and a cancelled booking", async () => {
    await new NotificationRepo(env.DB, ctxAva).updatePreferences({ remindersEnabled: false });
    expect(await NotificationRepo.findDueReminders(env.DB, from, to)).toHaveLength(0);

    await new NotificationRepo(env.DB, ctxAva).updatePreferences({ remindersEnabled: true });
    await env.DB.prepare("UPDATE booking SET status = 'cancelled' WHERE id = ?").bind("b1").run();
    expect(await NotificationRepo.findDueReminders(env.DB, from, to)).toHaveLength(0);
  });

  it("adds an explicit subscriber who is not travelling, and drops an explicit mute who is", async () => {
    await new NotificationRepo(env.DB, ctxBo).subscribeToBooking("b1");
    expect((await NotificationRepo.findDueReminders(env.DB, from, to)).map((d) => d.userId).sort())
      .toEqual(["u-ava", "u-bo"]);

    await new NotificationRepo(env.DB, ctxAva).unsubscribeFromBooking("b1");
    expect((await NotificationRepo.findDueReminders(env.DB, from, to)).map((d) => d.userId))
      .toEqual(["u-bo"]);
  });

  it("covers a booking added after a trip-wide subscribe, and lets a booking mute override it", async () => {
    await new NotificationRepo(env.DB, ctxBo).subscribeToTrip("t1");
    await insertBooking("b-late", "hh-a", "t1", "Added later", TOKYO_DEPARTURE, "Asia/Tokyo");
    expect(
      (await NotificationRepo.findDueReminders(env.DB, from, to))
        .filter((d) => d.bookingId === "b-late")
        .map((d) => d.userId),
    ).toEqual(["u-bo"]);

    await new NotificationRepo(env.DB, ctxBo).unsubscribeFromBooking("b-late");
    expect(
      (await NotificationRepo.findDueReminders(env.DB, from, to)).filter(
        (d) => d.bookingId === "b-late",
      ),
    ).toHaveLength(0);
  });

  /**
   * A subscription is reachability-checked when it is written, but membership
   * can be revoked afterwards and #61's criterion is about the moment of
   * sending. Removing Bo from the household must silence the push even though
   * the subscription row survives.
   */
  it("silences an account that has since left the household, subscription row and all", async () => {
    await new NotificationRepo(env.DB, ctxBo).subscribeToBooking("b1");
    await env.DB.prepare("DELETE FROM household_member WHERE user_id = ?").bind("u-bo").run();
    expect((await NotificationRepo.findDueReminders(env.DB, from, to)).map((d) => d.userId))
      .toEqual(["u-ava"]);
  });

  it("never surfaces another household's flight", async () => {
    const due = await NotificationRepo.findDueReminders(env.DB, from, to);
    expect(due.map((d) => d.bookingId)).not.toContain("b-zed");
  });

  it("stops offering a reminder once it has been claimed", async () => {
    expect(await NotificationRepo.claim(env.DB, claim("u-ava", "b1", TOKYO_DEPARTURE))).toBe(true);
    expect(await NotificationRepo.findDueReminders(env.DB, from, to)).toHaveLength(0);
  });

  /**
   * Keying the claim on the event instant, not the booking id, is what makes
   * this work: the departure moved, so the claim key moved with it and the
   * reminder re-arms instead of being suppressed forever.
   */
  it("re-arms when the flight moves", async () => {
    await NotificationRepo.claim(env.DB, claim("u-ava", "b1", TOKYO_DEPARTURE));
    await env.DB.prepare("UPDATE booking SET starts_at = ? WHERE id = ?")
      .bind("2026-08-02T19:00:00Z", "b1")
      .run();
    const due = await NotificationRepo.findDueReminders(
      env.DB,
      new Date("2026-08-02T18:00:00Z"),
      new Date("2026-08-02T18:01:00Z"),
    );
    expect(due.map((d) => d.startsAt)).toEqual(["2026-08-02T19:00:00Z"]);
  });
});

describe("NotificationRepo.claim", () => {
  it("lets exactly one of two concurrent runs own the send", async () => {
    const key = claim("u-ava", "b1", TOKYO_DEPARTURE);
    const outcomes = await Promise.all([
      NotificationRepo.claim(env.DB, key),
      NotificationRepo.claim(env.DB, key),
    ]);
    expect(outcomes.filter(Boolean)).toHaveLength(1);
    const rows = await env.DB.prepare("SELECT COUNT(*) AS n FROM notification_log")
      .first<{ n: number }>();
    expect(rows?.n).toBe(1);
  });

  it("returns false rather than throwing when a later run finds the claim taken", async () => {
    const key = claim("u-ava", "b1", TOKYO_DEPARTURE);
    expect(await NotificationRepo.claim(env.DB, key)).toBe(true);
    expect(await NotificationRepo.claim(env.DB, key)).toBe(false);
  });

  it("keeps one account's claim from blocking another's for the same flight", async () => {
    expect(await NotificationRepo.claim(env.DB, claim("u-ava", "b1", TOKYO_DEPARTURE))).toBe(true);
    expect(await NotificationRepo.claim(env.DB, claim("u-bo", "b1", TOKYO_DEPARTURE))).toBe(true);
  });

  /** A digest has no subject row, so its claim key is the empty string. */
  it("dedupes a digest per account per local day", async () => {
    const digest = { userId: "u-ava", kind: "digest" as const, subjectId: "", eventInstant: "2026-08-02" };
    expect(await NotificationRepo.claim(env.DB, digest)).toBe(true);
    expect(await NotificationRepo.claim(env.DB, digest)).toBe(false);
    expect(
      await NotificationRepo.claim(env.DB, { ...digest, eventInstant: "2026-08-03" }),
    ).toBe(true);
  });

  it("records the verdict without ever letting the occurrence be claimed again", async () => {
    const key = claim("u-ava", "b1", TOKYO_DEPARTURE);
    await NotificationRepo.claim(env.DB, key);
    await NotificationRepo.markSent(env.DB, key, new Date("2026-08-02T14:00:05Z"));
    expect(
      await env.DB.prepare("SELECT sent_at, outcome FROM notification_log WHERE subject_id = ?")
        .bind("b1").first(),
    ).toMatchObject({ sent_at: "2026-08-02T14:00:05.000Z", outcome: "sent" });

    const other = claim("u-bo", "b1", TOKYO_DEPARTURE);
    await NotificationRepo.claim(env.DB, other);
    await NotificationRepo.markFailed(env.DB, other, "410 gone");
    const failed = await env.DB.prepare(
      "SELECT sent_at, outcome FROM notification_log WHERE user_id = ?",
    ).bind("u-bo").first<{ sent_at: string | null; outcome: string }>();
    // sent_at stays NULL: the row is the record that this occurrence was
    // attempted, which is what stops a retry loop resending it forever.
    expect(failed).toMatchObject({ sent_at: null, outcome: "410 gone" });
    expect(await NotificationRepo.claim(env.DB, other)).toBe(false);
  });

  it("rejects a claim with no key to be keyed on", async () => {
    await expect(
      NotificationRepo.claim(env.DB, { ...claim("u-ava", "b1", ""), kind: "reminder" }),
    ).rejects.toThrow(ValidationError);
    await expect(
      NotificationRepo.claim(env.DB, { ...claim("u-ava", "b1", "x"), kind: "telegram" as never }),
    ).rejects.toThrow(ValidationError);
  });
});

describe("NotificationRepo.findDueDigests", () => {
  async function enableDigest(ctx: HouseholdContext, timezone: string, at: string): Promise<void> {
    const repo = new NotificationRepo(env.DB, ctx);
    await repo.setTimezone({ timezone, source: "manual" });
    await repo.updatePreferences({ digestEnabled: true, digestSendTime: at });
  }

  it("fires when the account's own wall clock crosses its chosen time", async () => {
    await enableDigest(ctxAva, "America/Boise", "08:00");
    // 08:00 in Boise on 2 August 2026 (MDT, UTC-6) is 14:00 UTC.
    const due = await NotificationRepo.findDueDigests(
      env.DB,
      new Date("2026-08-02T14:00:00Z"),
      new Date("2026-08-02T14:01:00Z"),
    );
    expect(due).toEqual([
      {
        userId: "u-ava",
        timezone: "America/Boise",
        localDate: "2026-08-02",
        sendTime: "08:00",
        sendAt: "2026-08-02T14:00:00.000Z",
      },
    ]);
  });

  it("gives two accounts in different zones the same wall clock at different instants", async () => {
    await enableDigest(ctxAva, "America/Boise", "08:00");
    await enableDigest(ctxBo, "Asia/Tokyo", "08:00");
    const boise = await NotificationRepo.findDueDigests(
      env.DB,
      new Date("2026-08-02T14:00:00Z"),
      new Date("2026-08-02T14:01:00Z"),
    );
    const tokyo = await NotificationRepo.findDueDigests(
      env.DB,
      new Date("2026-08-01T23:00:00Z"),
      new Date("2026-08-01T23:01:00Z"),
    );
    expect(boise.map((d) => d.userId)).toEqual(["u-ava"]);
    // 08:00 in Tokyo is 23:00 UTC the PREVIOUS day, and the digest is about
    // the Tokyo day, not the UTC one.
    expect(tokyo.map((d) => [d.userId, d.localDate])).toEqual([["u-bo", "2026-08-02"]]);
  });

  it("ignores an account with the digest off, no send time, or no stored zone", async () => {
    const window: [Date, Date] = [
      new Date("2026-08-02T14:00:00Z"),
      new Date("2026-08-02T14:01:00Z"),
    ];
    await enableDigest(ctxAva, "America/Boise", "08:00");
    await new NotificationRepo(env.DB, ctxAva).updatePreferences({ digestEnabled: false });
    expect(await NotificationRepo.findDueDigests(env.DB, ...window)).toHaveLength(0);

    await new NotificationRepo(env.DB, ctxAva).updatePreferences({
      digestEnabled: true,
      digestSendTime: null,
    });
    expect(await NotificationRepo.findDueDigests(env.DB, ...window)).toHaveLength(0);

    await new NotificationRepo(env.DB, ctxAva).updatePreferences({ digestSendTime: "08:00" });
    await env.DB.prepare("UPDATE user SET timezone = NULL WHERE id = ?").bind("u-ava").run();
    expect(await NotificationRepo.findDueDigests(env.DB, ...window)).toHaveLength(0);
  });

  it("does not fire outside the window", async () => {
    await enableDigest(ctxAva, "America/Boise", "08:00");
    expect(
      await NotificationRepo.findDueDigests(
        env.DB,
        new Date("2026-08-02T13:00:00Z"),
        new Date("2026-08-02T13:01:00Z"),
      ),
    ).toHaveLength(0);
  });
});

describe("digestSendInstant", () => {
  it("resolves a wall clock in a zone to the instant it actually happens", () => {
    expect(digestSendInstant("2026-08-02", "08:00", "America/Boise")).toBe(
      "2026-08-02T14:00:00.000Z",
    );
    // Winter: the same wall clock is an hour later in UTC once MDT ends.
    expect(digestSendInstant("2026-12-02", "08:00", "America/Boise")).toBe(
      "2026-12-02T15:00:00.000Z",
    );
  });

  it("returns null for a wall clock that does not exist that morning", () => {
    // 02:30 on the US spring-forward Sunday never happens.
    expect(digestSendInstant("2026-03-08", "02:30", "America/Boise")).toBeNull();
    expect(digestSendInstant("2026-08-02", "8am", "America/Boise")).toBeNull();
    expect(digestSendInstant("2026-08-02", "08:00", "Mars/Olympus")).toBeNull();
  });
});
