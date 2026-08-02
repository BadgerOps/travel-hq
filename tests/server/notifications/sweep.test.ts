import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import {
  buildDigest,
  runNotificationSweep,
} from "../../../src/server/notifications/sweep.js";
import type { SweepStats } from "../../../src/server/notifications/sweep.js";
import { runScheduledTasks } from "../../../src/server/notifications/cron.js";
import { CATCH_UP_MINUTES } from "../../../src/server/notifications/window.js";
import { generateVapidKeys } from "../../../src/server/push/vapid.js";
import type { VapidConfig } from "../../../src/server/push/vapid.js";
import { createLogger } from "../../../src/server/logging.js";
import type { LogLevel, Logger } from "../../../src/server/logging.js";

/**
 * The sweep end to end, against a real D1: the query, the claim, the fan-out
 * and the bookkeeping. `sendPush`'s `fetchImpl` seam stands in for the push
 * service, so every assertion here is about what WOULD go out and what the
 * database looks like afterwards — no network, and no fake of our own code.
 *
 * Two households throughout, for the reason NotificationRepo's own suite
 * gives: the notification tables carry no household_id, so "an account is
 * never notified about a trip it cannot see" is enforced by SQL alone and a
 * one-household suite could not tell whether it works.
 */

/** 10:00 on 8 October, Tokyo time. Everyone reading about it lives in Boise. */
const DEPARTURE = "2026-10-08T01:00:00Z";
/** DEPARTURE minus the 60-minute default lead. */
const DUE_AT = "2026-10-08T00:00:00.000Z";
/** A tick two minutes after the reminder came due — an equality finds nothing here. */
const TICK = new Date("2026-10-08T00:02:00Z");

const AVA_PHONE = "https://updates.push.services.mozilla.com/wpush/v2/ava-phone";
const AVA_LAPTOP = "https://updates.push.services.mozilla.com/wpush/v2/ava-laptop";
const BO_PHONE = "https://updates.push.services.mozilla.com/wpush/v2/bo-phone";
const ZED_PHONE = "https://updates.push.services.mozilla.com/wpush/v2/zed-phone";

let vapid: VapidConfig;

const toB64url = (bytes: Uint8Array): string => {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

/** A real P-256 keypair, so the payload actually encrypts instead of being faked. */
async function subscriptionKeys(): Promise<{ p256dh: string; auth: string }> {
  const pair = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
    "deriveBits",
  ])) as CryptoKeyPair;
  const raw = new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer);
  return { p256dh: toB64url(raw), auth: toB64url(crypto.getRandomValues(new Uint8Array(16))) };
}

type Reply = number | (() => never);

/** A push service stand-in: records every endpoint POSTed to, answers per endpoint. */
function stubPush(replies: Record<string, Reply> = {}) {
  const posted: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = String(input);
    posted.push(url);
    const reply = replies[url] ?? 201;
    if (typeof reply === "function") reply();
    return new Response(null, { status: reply as number });
  }) as unknown as typeof fetch;
  return { fetchImpl, posted };
}

function capturingLogger(): { lines: { level: LogLevel; line: string }[]; logger: Logger } {
  const lines: { level: LogLevel; line: string }[] = [];
  return { lines, logger: createLogger({}, (level, line) => lines.push({ level, line })) };
}

function sweep(options: {
  now: Date;
  fetchImpl?: typeof fetch;
  logger?: Logger;
}): Promise<SweepStats> {
  return runNotificationSweep({ DB: env.DB }, { ...options, vapid });
}

async function insertBooking(fields: {
  id: string;
  householdId: string;
  tripId: string;
  title: string;
  startsAt: string;
  startsAtTz: string | null;
  kind?: string;
  location?: string | null;
}): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO booking (id,household_id,trip_id,kind,title,location,starts_at,starts_at_tz,status,created_at)
     VALUES (?,?,?,?,?,?,?,?,'booked',?)`,
  )
    .bind(
      fields.id,
      fields.householdId,
      fields.tripId,
      fields.kind ?? "flight",
      fields.title,
      fields.location ?? null,
      fields.startsAt,
      fields.startsAtTz,
      "2026-09-01T00:00:00.000Z",
    )
    .run();
}

async function addSubscription(id: string, userId: string, endpoint: string): Promise<void> {
  const keys = await subscriptionKeys();
  await env.DB.prepare(
    `INSERT INTO push_subscription (id,user_id,endpoint,p256dh,auth,created_at,failure_count)
     VALUES (?,?,?,?,?,?,0)`,
  )
    .bind(id, userId, endpoint, keys.p256dh, keys.auth, "2026-09-01T00:00:00.000Z")
    .run();
}

async function enableDigest(userId: string, sendTime: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO notification_preference
       (user_id,digest_enabled,digest_send_time,reminders_enabled,reminder_lead_minutes,created_at,updated_at)
     VALUES (?,1,?,1,60,?,?)`,
  )
    .bind(userId, sendTime, "2026-09-01T00:00:00.000Z", "2026-09-01T00:00:00.000Z")
    .run();
}

async function setTimezone(userId: string, zone: string, updatedAt: string): Promise<void> {
  await env.DB.prepare(
    "UPDATE user SET timezone = ?, timezone_source = 'manual', timezone_updated_at = ? WHERE id = ?",
  )
    .bind(zone, updatedAt, userId)
    .run();
}

const logRows = () =>
  env.DB.prepare(
    "SELECT user_id, kind, subject_id, event_instant, sent_at, outcome FROM notification_log ORDER BY user_id, event_instant",
  ).all<{
    user_id: string;
    kind: string;
    subject_id: string;
    event_instant: string;
    sent_at: string | null;
    outcome: string | null;
  }>();

beforeEach(async () => {
  vapid ??= { ...(await generateVapidKeys()), subject: "mailto:ops@example.com" };

  for (const table of [
    "notification_log",
    "notification_subscription",
    "push_subscription",
    "notification_preference",
    "checklist_item",
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

  const created = "2026-09-01T00:00:00.000Z";
  const household = env.DB.prepare("INSERT INTO household (id,name,created_at) VALUES (?,?,?)");
  await household.bind("hh-a", "A", created).run();
  await household.bind("hh-b", "B", created).run();

  const user = env.DB.prepare("INSERT INTO user (id,email,created_at) VALUES (?,?,?)");
  await user.bind("u-ava", "ava@example.com", created).run();
  await user.bind("u-bo", "bo@example.com", created).run();
  await user.bind("u-zed", "zed@example.com", created).run();

  const member = env.DB.prepare(
    "INSERT INTO household_member (household_id,user_id,role) VALUES (?,?,?)",
  );
  await member.bind("hh-a", "u-ava", "owner").run();
  await member.bind("hh-a", "u-bo", "adult").run();
  await member.bind("hh-b", "u-zed", "owner").run();

  const trip = env.DB.prepare(
    "INSERT INTO trip (id,household_id,title,created_at) VALUES (?,?,?,?)",
  );
  await trip.bind("t1", "hh-a", "Tokyo", created).run();
  await trip.bind("t2", "hh-b", "Elsewhere", created).run();

  const person = env.DB.prepare(
    "INSERT INTO person (id,household_id,display_name,user_id,created_at) VALUES (?,?,?,?,?)",
  );
  await person.bind("p-ava", "hh-a", "Ava", "u-ava", created).run();
  await person.bind("p-bo", "hh-a", "Bo", "u-bo", created).run();
  await person.bind("p-zed", "hh-b", "Zed", "u-zed", created).run();

  await insertBooking({
    id: "b1",
    householdId: "hh-a",
    tripId: "t1",
    title: "NRT → BOI",
    startsAt: DEPARTURE,
    startsAtTz: "Asia/Tokyo",
    location: "Narita",
  });
  await insertBooking({
    id: "b-zed",
    householdId: "hh-b",
    tripId: "t2",
    title: "Somebody else's flight",
    startsAt: DEPARTURE,
    startsAtTz: "Asia/Tokyo",
  });

  const traveller = env.DB.prepare(
    "INSERT INTO booking_person (booking_id,person_id) VALUES (?,?)",
  );
  await traveller.bind("b1", "p-ava").run();
  // Zed is deliberately NOT put on their own flight here. The access-scoping
  // test below adds that row itself, so every other test in this file starts
  // from exactly one due reminder and its counts mean what they say.

  await addSubscription("s-ava-phone", "u-ava", AVA_PHONE);
});

describe("runNotificationSweep — reminders", () => {
  it("sends a reminder that came due between two ticks, which an equality on 'now' never would", async () => {
    // The row says 00:00:00 and the cron fired at 00:02:00. This is the whole
    // reason the sweep queries a range; an equality would find nothing here,
    // forever, with nothing failing to show for it.
    const { fetchImpl, posted } = stubPush();
    const stats = await sweep({ now: TICK, fetchImpl });

    expect(stats.remindersDue).toBe(1);
    expect(stats.remindersSent).toBe(1);
    expect(posted).toEqual([AVA_PHONE]);

    const { results } = await logRows();
    expect(results).toEqual([
      {
        user_id: "u-ava",
        kind: "reminder",
        subject_id: "b1",
        event_instant: DEPARTURE,
        sent_at: expect.any(String),
        outcome: "sent",
      },
    ]);
  });

  it("rings every device the account has registered, not just the newest", async () => {
    await addSubscription("s-ava-laptop", "u-ava", AVA_LAPTOP);
    const { fetchImpl, posted } = stubPush();

    await sweep({ now: TICK, fetchImpl });

    expect(posted.sort()).toEqual([AVA_LAPTOP, AVA_PHONE].sort());
  });

  it("never sends the same reminder twice, even when two runs' windows overlap", async () => {
    const { fetchImpl, posted } = stubPush();
    await sweep({ now: TICK, fetchImpl });
    // Two minutes later. The windows overlap by design — the claim is what
    // makes that safe, and this is the assertion that says so.
    const second = await sweep({ now: new Date(TICK.getTime() + 120_000), fetchImpl });

    expect(posted).toHaveLength(1);
    expect(second.remindersSent).toBe(0);
    // Two layers, and the outer one is why this run sees nothing at all:
    // findDueReminders excludes anything the ledger already names. The claim
    // underneath is what settles a genuine race -- see the next test.
    expect(second.remindersDue).toBe(0);
  });

  it("lets exactly one of two simultaneous runs send, when both see the same due row", async () => {
    // The race the claim exists for: two ticks overlapping in flight, both
    // having already read the row before either wrote the ledger. A duplicate
    // "your flight leaves in an hour" at 4am is worse than a missed one.
    const { fetchImpl, posted } = stubPush();
    const [first, second] = await Promise.all([
      sweep({ now: TICK, fetchImpl }),
      sweep({ now: TICK, fetchImpl }),
    ]);

    expect(posted).toHaveLength(1);
    expect(first.remindersSent + second.remindersSent).toBe(1);
    expect(first.remindersDeduped + second.remindersDeduped).toBe(1);
  });

  it("re-arms the reminder when the departure moves, because the claim names the instant", async () => {
    const { fetchImpl, posted } = stubPush();
    await sweep({ now: TICK, fetchImpl });

    // The flight slips three hours. Keyed on the booking alone, this would be
    // "already notified" forever — the exact moment a traveller most needs it.
    const moved = "2026-10-08T04:00:00Z";
    await env.DB.prepare("UPDATE booking SET starts_at = ? WHERE id = 'b1'").bind(moved).run();
    const second = await sweep({ now: new Date("2026-10-08T03:02:00Z"), fetchImpl });

    expect(second.remindersSent).toBe(1);
    expect(posted).toHaveLength(2);
    const { results } = await logRows();
    expect(results.map((r) => r.event_instant)).toEqual([DEPARTURE, moved]);
  });

  it("picks up a reminder a missed run left a few minutes overdue", async () => {
    const { fetchImpl, posted } = stubPush();
    const stats = await sweep({
      now: new Date(Date.parse(DUE_AT) + (CATCH_UP_MINUTES - 5) * 60_000),
      fetchImpl,
    });

    expect(stats.remindersSent).toBe(1);
    expect(posted).toEqual([AVA_PHONE]);
  });

  it("refuses one that is staler than the catch-up bound, and says so rather than going quiet", async () => {
    // A reminder for a flight that left is worse than silence. But the
    // decision has to be visible: "we chose not to send this" and "there was
    // nothing to send" must not look identical in the log stream.
    const { fetchImpl, posted } = stubPush();
    const { lines, logger } = capturingLogger();
    const stats = await sweep({
      now: new Date(Date.parse(DUE_AT) + (CATCH_UP_MINUTES + 15) * 60_000),
      fetchImpl,
      logger,
    });

    expect(stats.remindersStale).toBe(1);
    expect(stats.remindersSent).toBe(0);
    expect(posted).toEqual([]);

    const dropped = lines.filter((l) => l.line.includes("notification_dropped_stale"));
    expect(dropped).toHaveLength(1);
    expect(dropped[0]!.level).toBe("warn");
    expect(JSON.parse(dropped[0]!.line)).toMatchObject({
      event: "notification_dropped_stale",
      bookingId: "b1",
      overdueMinutes: CATCH_UP_MINUTES + 15,
    });

    const { results } = await logRows();
    expect(results[0]).toMatchObject({ sent_at: null, outcome: "stale" });
  });

  it("records the stale decision so the next tick does not rediscover and re-log it", async () => {
    const late = new Date(Date.parse(DUE_AT) + (CATCH_UP_MINUTES + 15) * 60_000);
    const { fetchImpl } = stubPush();
    await sweep({ now: late, fetchImpl });

    const { lines, logger } = capturingLogger();
    const second = await sweep({ now: new Date(late.getTime() + 300_000), fetchImpl, logger });

    expect(second.remindersDue).toBe(0);
    expect(lines.filter((l) => l.line.includes("notification_dropped_stale"))).toEqual([]);
  });

  it("deletes a subscription the push service reports gone, rather than retrying it forever", async () => {
    // iOS drops a Web Push subscription when the PWA is removed or goes
    // unused. Without this, dead endpoints accumulate for the life of the
    // account and earn rate limits that hurt the live ones.
    const { fetchImpl } = stubPush({ [AVA_PHONE]: 410 });
    const stats = await sweep({ now: TICK, fetchImpl });

    expect(stats.pushesPruned).toBe(1);
    const { results } = await env.DB.prepare("SELECT id FROM push_subscription").all();
    expect(results).toEqual([]);
    const log = await logRows();
    expect(log.results[0]).toMatchObject({ sent_at: null, outcome: "gone" });
  });

  it("keeps a subscription a push service merely failed on, and counts the failure", async () => {
    const { fetchImpl } = stubPush({ [AVA_PHONE]: 503 });
    const stats = await sweep({ now: TICK, fetchImpl });

    expect(stats.pushesPruned).toBe(0);
    expect(stats.pushesFailed).toBe(1);
    const row = await env.DB.prepare(
      "SELECT failure_count FROM push_subscription WHERE endpoint = ?",
    )
      .bind(AVA_PHONE)
      .first<{ failure_count: number }>();
    expect(row?.failure_count).toBe(1);
  });

  it("finishes the sweep for everyone else when one account's send blows up", async () => {
    // Bo is on the same flight and has their own device. Ava's push service
    // throws outright; Bo's reminder must still go out.
    await env.DB.prepare("INSERT INTO booking_person (booking_id,person_id) VALUES ('b1','p-bo')")
      .run();
    await addSubscription("s-bo-phone", "u-bo", BO_PHONE);
    const { fetchImpl, posted } = stubPush({
      [AVA_PHONE]: () => {
        throw new Error("connection reset");
      },
    });

    const stats = await sweep({ now: TICK, fetchImpl });

    expect(posted.sort()).toEqual([AVA_PHONE, BO_PHONE].sort());
    expect(stats.remindersSent).toBe(1);
    expect(stats.remindersFailed).toBe(1);
    const { results } = await logRows();
    expect(results.map((r) => [r.user_id, r.outcome])).toEqual([
      ["u-ava", "retryable"],
      ["u-bo", "sent"],
    ]);
  });

  it("closes the claim with a reason when an account has no device registered at all", async () => {
    await env.DB.exec("DELETE FROM push_subscription");
    const { fetchImpl, posted } = stubPush();
    const stats = await sweep({ now: TICK, fetchImpl });

    expect(posted).toEqual([]);
    expect(stats.remindersFailed).toBe(1);
    const { results } = await logRows();
    expect(results[0]).toMatchObject({ outcome: "no-subscriptions" });
  });

  it("never notifies an account about a trip in a household it no longer belongs to", async () => {
    // Zed is still on the booking_person row for their own flight, and still
    // has a device. Revoking the membership must stop the notification: the
    // criterion is about the moment of SENDING, not the moment the row was
    // written.
    await env.DB.prepare(
      "INSERT INTO booking_person (booking_id,person_id) VALUES ('b-zed','p-zed')",
    ).run();
    await addSubscription("s-zed-phone", "u-zed", ZED_PHONE);
    const withAccess = stubPush();
    expect((await sweep({ now: TICK, fetchImpl: withAccess.fetchImpl })).remindersDue).toBe(2);

    await env.DB.exec("DELETE FROM notification_log");
    await env.DB.exec("DELETE FROM household_member WHERE user_id = 'u-zed'");
    const revoked = stubPush();
    const stats = await sweep({ now: TICK, fetchImpl: revoked.fetchImpl });

    expect(stats.remindersDue).toBe(1);
    expect(revoked.posted).toEqual([AVA_PHONE]);
  });

  it("never notifies a housemate who is not travelling and never asked to be", async () => {
    await addSubscription("s-bo-phone", "u-bo", BO_PHONE);
    const { fetchImpl, posted } = stubPush();
    await sweep({ now: TICK, fetchImpl });
    expect(posted).toEqual([AVA_PHONE]);
  });

  it("does nothing at all — not even take a claim — when VAPID is not configured", async () => {
    // A claim is permanent. Taking one the Worker cannot honour would mean
    // those reminders never re-arm once the secret is finally set.
    const { lines, logger } = capturingLogger();
    const stats = await runNotificationSweep({ DB: env.DB }, { now: TICK, logger });

    expect(stats.skipped).toBe(true);
    expect(stats.remindersDue).toBe(0);
    expect((await logRows()).results).toEqual([]);
    expect(lines.some((l) => l.line.includes("notification_sweep_unconfigured"))).toBe(true);
  });
});

describe("runNotificationSweep — the digest", () => {
  /** 07:00 in Tokyo on 8 October. */
  const DIGEST_AT = new Date("2026-10-07T22:00:00Z");

  beforeEach(async () => {
    await enableDigest("u-ava", "07:00");
    await setTimezone("u-ava", "Asia/Tokyo", "2026-10-06T00:00:00.000Z");
  });

  it("sends one digest for the local day and claims it under that date", async () => {
    const { fetchImpl, posted } = stubPush();
    const stats = await sweep({ now: new Date(DIGEST_AT.getTime() + 60_000), fetchImpl });

    expect(stats.digestsSent).toBe(1);
    expect(posted).toEqual([AVA_PHONE]);
    const { results } = await logRows();
    expect(results).toEqual([
      {
        user_id: "u-ava",
        kind: "digest",
        subject_id: "",
        event_instant: "2026-10-08",
        sent_at: expect.any(String),
        outcome: "sent",
      },
    ]);
  });

  it("sends it once, however many ticks fall inside the window", async () => {
    const { fetchImpl, posted } = stubPush();
    await sweep({ now: new Date(DIGEST_AT.getTime() + 60_000), fetchImpl });
    const second = await sweep({ now: new Date(DIGEST_AT.getTime() + 360_000), fetchImpl });

    expect(posted).toHaveLength(1);
    expect(second.digestsDeduped).toBe(1);
  });

  it("stays silent about a day with nothing in it, and records that it did", async () => {
    await env.DB.exec("DELETE FROM booking_person");
    const { fetchImpl, posted } = stubPush();
    const stats = await sweep({ now: new Date(DIGEST_AT.getTime() + 60_000), fetchImpl });

    expect(stats.digestsEmpty).toBe(1);
    expect(posted).toEqual([]);
    const { results } = await logRows();
    expect(results[0]).toMatchObject({ outcome: "empty" });
  });
});

describe("buildDigest — what a day actually contains", () => {
  const dueDigest = (overrides: Partial<Parameters<typeof buildDigest>[1]> = {}) => ({
    userId: "u-ava",
    timezone: "Asia/Tokyo",
    localDate: "2026-10-08",
    sendTime: "07:00",
    sendAt: "2026-10-07T22:00:00.000Z",
    ...overrides,
  });

  beforeEach(async () => {
    await enableDigest("u-ava", "07:00");
  });

  it("lists the day's bookings with each event's own local clock time", async () => {
    await setTimezone("u-ava", "Asia/Tokyo", "2026-10-06T00:00:00.000Z");
    const digest = await buildDigest(env.DB, dueDigest());

    expect(digest?.todayCount).toBe(1);
    expect(digest?.payload.title).toBe("Today: NRT → BOI");
    expect(digest?.payload.body).toBe("10:00 AM NRT → BOI");
    expect(digest?.payload.path).toBe("/trips/t1#days:2026-10-08");
  });

  it("brings tomorrow's before-dawn departure into tonight's digest as well", async () => {
    // 06:40 on the 9th, Tokyo time. The digest that would otherwise mention it
    // arrives after the traveller needed to be awake. There is no suppression
    // rule anywhere in this feature — this is purely additive.
    await setTimezone("u-ava", "Asia/Tokyo", "2026-10-06T00:00:00.000Z");
    await insertBooking({
      id: "b-early",
      householdId: "hh-a",
      tripId: "t1",
      title: "Airport transfer",
      startsAt: "2026-10-08T21:40:00Z",
      startsAtTz: "Asia/Tokyo",
      kind: "car",
    });
    await env.DB.prepare(
      "INSERT INTO booking_person (booking_id,person_id) VALUES ('b-early','p-ava')",
    ).run();

    const digest = await buildDigest(env.DB, dueDigest());
    expect(digest?.earlyCount).toBe(1);
    expect(digest?.payload.body).toContain("Tomorrow 6:40 AM Airport transfer");
  });

  it("falls back to the zone of the day's first event once the stored one is stale", async () => {
    // Ava pinned Boise months ago and has been in Tokyo since Tuesday. The
    // stored zone is not wrong so much as out of date, and `timezone_updated_at`
    // is what lets the digest tell the difference.
    await setTimezone("u-ava", "America/Boise", "2026-06-01T00:00:00.000Z");
    const digest = await buildDigest(
      env.DB,
      dueDigest({ timezone: "America/Boise", sendAt: "2026-10-08T13:00:00.000Z" }),
    );

    expect(digest?.timezoneSource).toBe("first-event");
    expect(digest?.timezone).toBe("Asia/Tokyo");
    expect(digest?.localDate).toBe("2026-10-08");
    expect(digest?.todayCount).toBe(1);
  });

  it("keeps a freshly confirmed stored zone even when the trip disagrees", async () => {
    await setTimezone("u-ava", "America/Boise", "2026-10-07T12:00:00.000Z");
    const digest = await buildDigest(
      env.DB,
      dueDigest({ timezone: "America/Boise", sendAt: "2026-10-08T13:00:00.000Z" }),
    );
    expect(digest?.timezoneSource).toBe("stored");
    expect(digest?.timezone).toBe("America/Boise");
  });

  it("counts an open checklist item that is due, and skips one already done", async () => {
    await setTimezone("u-ava", "Asia/Tokyo", "2026-10-06T00:00:00.000Z");
    const item = env.DB.prepare(
      `INSERT INTO checklist_item (id,household_id,trip_id,person_id,label,due_on,done_at,created_at)
       VALUES (?,?,?,?,?,?,?,?)`,
    );
    await item
      .bind("c1", "hh-a", "t1", null, "Print boarding passes", "2026-10-08", null, "2026-09-01T00:00:00.000Z")
      .run();
    await item
      .bind("c2", "hh-a", "t1", null, "Book the shuttle", "2026-10-08", "2026-10-01T00:00:00.000Z", "2026-09-01T00:00:00.000Z")
      .run();

    const digest = await buildDigest(env.DB, dueDigest());
    expect(digest?.checklistCount).toBe(1);
    expect(digest?.payload.body).toContain("1 task due");
  });

  it("never puts another household's trip in the digest", async () => {
    await setTimezone("u-ava", "Asia/Tokyo", "2026-10-06T00:00:00.000Z");
    const digest = await buildDigest(env.DB, dueDigest());
    expect(digest?.payload.body).not.toContain("Somebody else's flight");
    expect(digest?.todayCount).toBe(1);
  });

  it("never puts a booking the account explicitly muted in the digest", async () => {
    await setTimezone("u-ava", "Asia/Tokyo", "2026-10-06T00:00:00.000Z");
    await env.DB.prepare(
      `INSERT INTO notification_subscription (id,user_id,booking_id,trip_id,subscribed,created_at)
       VALUES ('ns1','u-ava','b1',NULL,0,?)`,
    )
      .bind("2026-09-01T00:00:00.000Z")
      .run();

    expect(await buildDigest(env.DB, dueDigest())).toBeNull();
  });
});

describe("runScheduledTasks", () => {
  it("sweeps notifications and purges expired raw email in the same tick", async () => {
    // docs/email-retention.md asked for exactly this once a [triggers] block
    // existed: purging used to ride on ingest, so a household that stopped
    // using Travel HQ stopped being swept.
    await env.DB.exec("DELETE FROM inbound_email");
    await env.DB.prepare(
      `INSERT INTO inbound_email
         (id,household_id,from_address,to_address,subject,message_id,raw,raw_encryption,status,received_at)
       VALUES ('ie1','hh-a','old@example.com','trips@badgerops.foo',NULL,NULL,'Subject: Old','plaintext','received',?)`,
    )
      .bind("2026-01-01T00:00:00.000Z")
      .run();

    const { fetchImpl } = stubPush();
    const result = await runScheduledTasks({ DB: env.DB }, { now: TICK, fetchImpl });

    expect(result.purgedRawEmails).toBe(1);
    // No VAPID in this env, so the sweep declines rather than half-sending.
    expect(result.sweep?.skipped).toBe(true);
  });
});
