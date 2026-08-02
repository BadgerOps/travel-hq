/**
 * The scheduled sweep: find what is due, claim it, send it, record what
 * happened. Issue #61.
 *
 * ── THE FOUR PROPERTIES THIS FILE EXISTS TO HOLD ──────────────────────────
 *
 * 1. IT QUERIES A RANGE, NEVER AN INSTANT. See window.ts. A five-minute cron
 *    asking for what is due "now" finds nothing, forever, silently.
 *
 * 2. IT CLAIMS BEFORE IT SENDS. `NotificationRepo.claim` inserts the ledger
 *    row first and lets the unique index arbitrate; only the winner sends.
 *    Recording the send afterwards instead would leave the window in which a
 *    retry, an overlapping tick or a redeploy mid-flight sends "your flight
 *    leaves in an hour" twice at 4am. Which is also why the deliberately
 *    OVERLAPPING window in window.ts is safe: a duplicate claim is a no-op.
 *
 * 3. IT IS FAIL-SOFT PER ITEM. Every unit of work below is wrapped so that a
 *    throw is logged and the loop continues. One household's corrupt row, one
 *    push service having a bad afternoon, one unparseable timezone — none of
 *    them may cost everybody else their reminders. `sendPush` already returns
 *    instead of throwing; the try/catch is for everything around it.
 *
 * 4. IT PRUNES DEAD ENDPOINTS. A `gone` result (404/410) deletes the
 *    subscription row. This is garbage collection with teeth, not hygiene:
 *    iOS drops a Web Push subscription when the PWA is removed from the home
 *    screen or simply goes unused, and a household that reinstalls twice a
 *    year accumulates dead endpoints forever — earning rate limits that hurt
 *    the live ones.
 *
 * ── WHAT IT DOES *NOT* DO ─────────────────────────────────────────────────
 * There is no quiet-hours rule and no suppression window anywhere in this
 * file. A 05:00 reminder before an 06:00 flight is the most valuable
 * notification the product can send. See the top of digest.ts.
 */

import { NotificationRepo } from "../repos/notification.js";
import type { DueDigest, DueReminder, NotificationClaim } from "../repos/notification.js";
import { NotificationDigestRepo } from "../repos/notification-digest.js";
import { log } from "../logging.js";
import type { Logger } from "../logging.js";
import { sendPush } from "../push/index.js";
import type { NotificationPayload, VapidConfig } from "../push/index.js";
import {
  chooseDigestTimezone,
  composeDigest,
  digestLocalDate,
  firstEventTimezone,
  splitDigestEntries,
} from "./digest.js";
import type { DigestEntry } from "./digest.js";
import { eventLocalDate } from "./format.js";
import { reminderPayload } from "./reminders.js";
import { isStale, sweepWindow } from "./window.js";
import type { SweepWindow } from "./window.js";

/**
 * The bindings the sweep needs. Everything optional is optional because the
 * Worker must still boot, serve and ingest mail when push is not configured —
 * see `resolveVapid`.
 */
export type SweepEnv = {
  DB: D1Database;
  VAPID_PUBLIC_KEY?: string;
  /** A `wrangler secret`, never a var. Absent on a Worker that has not set it. */
  VAPID_PRIVATE_KEY?: string;
  VAPID_SUBJECT?: string;
};

export type SweepOptions = {
  /** The instant the tick believes it is. Injected by tests; defaults to real now. */
  now?: Date;
  /** Overrides the derived window entirely. Tests use it; production does not. */
  window?: Partial<SweepWindow>;
  logger?: Logger;
  /** The test seam. Passed straight through to `sendPush`. */
  fetchImpl?: typeof fetch;
  /** Overrides the env-derived VAPID config. */
  vapid?: VapidConfig;
  /** See {@link DEFAULT_CONCURRENCY}. */
  concurrency?: number;
};

export type SweepStats = {
  windowFrom: string;
  windowTo: string;
  sendFrom: string;
  /** True when push is unconfigured and the sweep did nothing at all. */
  skipped: boolean;
  remindersDue: number;
  remindersSent: number;
  /** Lost the claim to another run — the expected, harmless outcome of overlap. */
  remindersDeduped: number;
  /** Past the catch-up bound: deliberately not sent. */
  remindersStale: number;
  remindersFailed: number;
  digestsDue: number;
  digestsSent: number;
  digestsDeduped: number;
  digestsStale: number;
  /** Claimed, composed, and found to have nothing worth saying. */
  digestsEmpty: number;
  digestsFailed: number;
  pushesSent: number;
  pushesPruned: number;
  pushesFailed: number;
  /** Items that threw. Non-zero means a bug, and the log lines say where. */
  errors: number;
};

/**
 * How many push requests may be in flight at once.
 *
 * Eight. Not one (a household with four devices and forty reminders would
 * serialise into minutes of wall clock inside a scheduled invocation with a
 * CPU and duration budget), and not unbounded (a thousand simultaneous
 * `fetch`es to `fcm.googleapis.com` is how a Worker earns a 429 that then
 * costs the *live* subscriptions their delivery, and workerd caps concurrent
 * subrequests anyway). Eight keeps a realistic sweep — tens of pushes — inside
 * a second or two while staying far below anything a push service would treat
 * as abuse.
 *
 * Applied at BOTH levels: across due notifications, and across the devices of
 * one user. The worst case is therefore bounded at 8 × 8 in-flight requests.
 */
export const DEFAULT_CONCURRENCY = 8;

/** How far either side of the send instant the digest reads for content. */
const DIGEST_LOOKBEHIND_MS = 24 * 3_600_000;
const DIGEST_LOOKAHEAD_MS = 48 * 3_600_000;

/**
 * Run one tick. Returns what it did, so the caller can log a single summary
 * line and a test can assert on counts rather than on log text.
 *
 * Never throws for anything a real database can contain: the top-level
 * queries are the only unguarded awaits, and a failure there is a failure of
 * the whole tick, which is the one case worth propagating to the platform's
 * own error reporting.
 */
export async function runNotificationSweep(
  env: SweepEnv,
  options: SweepOptions = {},
): Promise<SweepStats> {
  const logger = options.logger ?? log;
  const now = options.now ?? new Date();
  const derived = sweepWindow(now);
  const window: SweepWindow = {
    from: options.window?.from ?? derived.from,
    sendFrom: options.window?.sendFrom ?? derived.sendFrom,
    to: options.window?.to ?? derived.to,
  };
  const stats = emptyStats(window);

  const vapid = options.vapid ?? resolveVapid(env);
  if (vapid === null) {
    // Deliberately not an error: a Worker deployed before the operator has run
    // `wrangler secret put VAPID_PRIVATE_KEY` is misconfigured, not broken,
    // and it must not take claims it cannot honour. One line per tick is
    // enough to notice; taking and failing every claim would be much worse,
    // because a claim is permanent and the reminders would never re-arm.
    logger.warn("notification_sweep_unconfigured", {
      reason: "VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY / VAPID_SUBJECT are not all set",
    });
    stats.skipped = true;
    return stats;
  }

  const concurrency = normalizeConcurrency(options.concurrency);
  const send = (userId: string, payload: NotificationPayload) =>
    deliverToUser(env.DB, userId, payload, vapid, { ...options, logger, concurrency }, stats);

  const reminders = await NotificationRepo.findDueReminders(env.DB, window.from, window.to);
  stats.remindersDue = reminders.length;
  await mapWithConcurrency(reminders, concurrency, async (due) => {
    try {
      await handleReminder(env.DB, due, window, send, logger, stats);
    } catch (err) {
      // Property 3. One booking's failure is one booking's failure.
      stats.errors += 1;
      logger.error("notification_reminder_error", {
        userId: due.userId,
        bookingId: due.bookingId,
        tripId: due.tripId,
        reason: describe(err),
      });
    }
  });

  const digests = await NotificationRepo.findDueDigests(env.DB, window.from, window.to);
  stats.digestsDue = digests.length;
  await mapWithConcurrency(digests, concurrency, async (due) => {
    try {
      await handleDigest(env.DB, due, window, send, logger, stats);
    } catch (err) {
      stats.errors += 1;
      logger.error("notification_digest_error", {
        userId: due.userId,
        localDate: due.localDate,
        reason: describe(err),
      });
    }
  });

  logger.info("notification_sweep", { ...stats });
  return stats;
}

// ------------------------------------------------------------------ reminders

async function handleReminder(
  db: D1Database,
  due: DueReminder,
  window: SweepWindow,
  send: Delivery,
  logger: Logger,
  stats: SweepStats,
): Promise<void> {
  const key: NotificationClaim = {
    userId: due.userId,
    kind: "reminder",
    // The instant is half the claim key on purpose: keyed on the booking
    // alone, a rescheduled flight would be "already notified" forever.
    subjectId: due.bookingId,
    eventInstant: due.startsAt,
  };

  if (isStale(due.sendAt, window)) {
    await dropStale(db, key, due.sendAt, window, logger, {
      userId: due.userId,
      bookingId: due.bookingId,
      tripId: due.tripId,
    });
    stats.remindersStale += 1;
    return;
  }

  if (!(await NotificationRepo.claim(db, key))) {
    stats.remindersDeduped += 1;
    return;
  }

  const outcome = await send(due.userId, reminderPayload(due));
  if (outcome.sent > 0) {
    await NotificationRepo.markSent(db, key);
    stats.remindersSent += 1;
  } else {
    await NotificationRepo.markFailed(db, key, outcome.reason);
    stats.remindersFailed += 1;
  }
}

// -------------------------------------------------------------------- digests

async function handleDigest(
  db: D1Database,
  due: DueDigest,
  window: SweepWindow,
  send: Delivery,
  logger: Logger,
  stats: SweepStats,
): Promise<void> {
  const key: NotificationClaim = {
    userId: due.userId,
    kind: "digest",
    // A digest has no subject row; the empty string IS its subject. The column
    // is NOT NULL precisely so the unique index can see it.
    subjectId: "",
    eventInstant: due.localDate,
  };

  if (isStale(due.sendAt, window)) {
    await dropStale(db, key, due.sendAt, window, logger, {
      userId: due.userId,
      localDate: due.localDate,
    });
    stats.digestsStale += 1;
    return;
  }

  if (!(await NotificationRepo.claim(db, key))) {
    stats.digestsDeduped += 1;
    return;
  }

  const composed = await buildDigest(db, due);
  if (composed === null) {
    // Closed out rather than left open, so the next tick does not rebuild the
    // same empty day. An empty day should produce silence, not a push saying
    // "nothing today" — that is how people turn digests off.
    await NotificationRepo.markFailed(db, key, "empty");
    stats.digestsEmpty += 1;
    return;
  }

  logger.info("notification_digest_composed", {
    userId: due.userId,
    localDate: composed.localDate,
    timezoneSource: composed.timezoneSource,
    todayCount: composed.todayCount,
    earlyCount: composed.earlyCount,
    checklistCount: composed.checklistCount,
  });

  const outcome = await send(due.userId, composed.payload);
  if (outcome.sent > 0) {
    await NotificationRepo.markSent(db, key);
    stats.digestsSent += 1;
  } else {
    await NotificationRepo.markFailed(db, key, outcome.reason);
    stats.digestsFailed += 1;
  }
}

export type BuiltDigest = {
  payload: NotificationPayload;
  localDate: string;
  timezone: string;
  timezoneSource: "stored" | "first-event";
  todayCount: number;
  earlyCount: number;
  checklistCount: number;
};

/**
 * Assemble one user's day. Exported so a test can assert on the composed
 * payload — including the previous-evening heads-up and the stale-timezone
 * fallback — without going anywhere near a push service.
 *
 * The order of the three decisions matters and is not interchangeable:
 * fetch by INSTANT (the only thing SQLite can compare), then choose the ZONE
 * (which needs those rows, because the fallback donor is the day's first
 * event), then choose the DATE (which needs the zone).
 */
export async function buildDigest(db: D1Database, due: DueDigest): Promise<BuiltDigest | null> {
  const sendAt = new Date(due.sendAt);
  const entries = await NotificationDigestRepo.findEntries(
    db,
    due.userId,
    new Date(sendAt.getTime() - DIGEST_LOOKBEHIND_MS),
    new Date(sendAt.getTime() + DIGEST_LOOKAHEAD_MS),
  );

  const context = await NotificationDigestRepo.userContext(db, due.userId);
  const choice = chooseDigestTimezone({
    storedTimezone: context?.timezone ?? due.timezone,
    timezoneUpdatedAt: context?.timezoneUpdatedAt ?? null,
    now: sendAt,
    firstEventTimezone: donorZone(entries, due.localDate),
  });
  const localDate = digestLocalDate(due.sendAt, choice.timezone);

  const split = splitDigestEntries(entries, localDate);
  const tripIds = [...split.today, ...split.earlyTomorrow].map((entry) => entry.tripId);
  const checklist = await NotificationDigestRepo.findChecklistItems(
    db,
    due.userId,
    tripIds,
    localDate,
  );

  const composed = composeDigest({ localDate, entries, checklist, sendAt: due.sendAt });
  if (composed === null) return null;
  return {
    payload: composed.payload,
    localDate,
    timezone: choice.timezone,
    timezoneSource: choice.source,
    todayCount: composed.todayCount,
    earlyCount: composed.earlyCount,
    checklistCount: composed.checklistCount,
  };
}

/**
 * The zone the fallback borrows: the first event of the day as the STORED
 * zone reckons it, falling back to the first event in the whole fetched
 * window. Provisional by necessity — the day is what the zone is being chosen
 * to decide — but it only ever has to name the right *place*, and a window
 * that spans one person's trip agrees about that whichever day it picks.
 */
function donorZone(entries: readonly DigestEntry[], provisionalDate: string): string | null {
  const sameDay = entries.filter(
    (entry) => eventLocalDate(entry.startsAt, entry.startsAtTz) === provisionalDate,
  );
  return firstEventTimezone(sameDay.length > 0 ? sameDay : entries);
}

// ------------------------------------------------------------------- delivery

type Delivery = (userId: string, payload: NotificationPayload) => Promise<DeliveryOutcome>;

export type DeliveryOutcome = {
  /** How many endpoints accepted it. Zero means the notification did not land. */
  sent: number;
  pruned: number;
  failed: number;
  /** A short reason for `markFailed`, meaningful only when `sent === 0`. */
  reason: string;
};

/**
 * Push one payload to EVERY device the user has registered. Several is the
 * normal case, not the exotic one: `push_subscription` is keyed per browser,
 * and a phone plus a laptop is two endpoints that should both ring.
 */
async function deliverToUser(
  db: D1Database,
  userId: string,
  payload: NotificationPayload,
  vapid: VapidConfig,
  options: SweepOptions & { logger: Logger; concurrency: number },
  stats: SweepStats,
): Promise<DeliveryOutcome> {
  const subscriptions = await NotificationRepo.listPushSubscriptionsForUser(db, userId);
  if (subscriptions.length === 0) {
    return { sent: 0, pruned: 0, failed: 0, reason: "no-subscriptions" };
  }

  const outcome: DeliveryOutcome = { sent: 0, pruned: 0, failed: 0, reason: "" };
  const reasons: string[] = [];

  await mapWithConcurrency(subscriptions, options.concurrency, async (subscription) => {
    // sendPush never throws; this guard is for the bookkeeping writes around it.
    try {
      const result = await sendPush({
        subscription: {
          endpoint: subscription.endpoint,
          keys: { p256dh: subscription.p256dh, auth: subscription.auth },
        },
        payload,
        vapid,
        now: options.now?.getTime(),
        fetchImpl: options.fetchImpl,
        logger: options.logger,
        logFields: { subscriptionId: subscription.id, userId },
      });

      switch (result.outcome) {
        case "sent":
          await NotificationRepo.recordPushSuccess(db, subscription.endpoint, options.now);
          outcome.sent += 1;
          stats.pushesSent += 1;
          return;
        case "gone":
          // Property 4. The push service has told us this row is dead; the
          // only correct response is to delete it.
          await NotificationRepo.pruneEndpoint(db, subscription.endpoint);
          outcome.pruned += 1;
          stats.pushesPruned += 1;
          reasons.push("gone");
          options.logger.info("push_subscription_pruned", {
            subscriptionId: subscription.id,
            userId,
            status: result.status,
          });
          return;
        case "invalid":
          // A config problem (`invalid_vapid_key`, `invalid_payload`) is OUR
          // bug and must not be charged to the subscription's failure streak;
          // `invalid_subscription` genuinely is the row's fault.
          if (result.code === "invalid_subscription") {
            await NotificationRepo.recordPushFailure(db, subscription.endpoint);
          } else {
            options.logger.error("push_send_misconfigured", {
              subscriptionId: subscription.id,
              code: result.code,
            });
          }
          outcome.failed += 1;
          stats.pushesFailed += 1;
          reasons.push(result.code);
          return;
        default:
          // retryable / failed. Counted, not pruned: a 502 from a push service
          // is not evidence the subscription is dead.
          await NotificationRepo.recordPushFailure(db, subscription.endpoint);
          outcome.failed += 1;
          stats.pushesFailed += 1;
          reasons.push(result.outcome);
      }
    } catch (err) {
      outcome.failed += 1;
      stats.pushesFailed += 1;
      stats.errors += 1;
      reasons.push("error");
      options.logger.error("push_send_error", {
        subscriptionId: subscription.id,
        userId,
        reason: describe(err),
      });
    }
  });

  outcome.reason = outcome.sent > 0 ? "sent" : (reasons[0] ?? "failed");
  return outcome;
}

// -------------------------------------------------------------------- shared

/**
 * Close out something too old to send: claim it (so no later tick rediscovers
 * it), mark it `stale`, and say so once.
 *
 * The claim is the point. Dropping without claiming would mean re-finding and
 * re-logging the same dead reminder on every tick for as long as the lookback
 * window reaches — and would leave no record of the decision. `outcome =
 * 'stale'` in `notification_log` is that record: whoever asks "why was I not
 * told about my 6am flight" gets an answer instead of an absence.
 */
async function dropStale(
  db: D1Database,
  key: NotificationClaim,
  sendAt: string,
  window: SweepWindow,
  logger: Logger,
  fields: Record<string, unknown>,
): Promise<void> {
  const overdueMinutes = Math.round((window.to.getTime() - Date.parse(sendAt)) / 60_000);
  if (await NotificationRepo.claim(db, key)) {
    await NotificationRepo.markFailed(db, key, "stale");
  }
  logger.warn("notification_dropped_stale", {
    ...fields,
    kind: key.kind,
    dueAt: sendAt,
    overdueMinutes: Number.isFinite(overdueMinutes) ? overdueMinutes : null,
    catchUpEndedAt: window.sendFrom.toISOString(),
  });
}

/**
 * A VAPID config, or null when the Worker has not been given one. All three
 * values or none: a keypair without a subject is refused by push services,
 * and half a config is worse than an absent one because it fails at the point
 * of delivery rather than at the point of configuration.
 */
export function resolveVapid(env: SweepEnv): VapidConfig | null {
  const publicKey = (env.VAPID_PUBLIC_KEY ?? "").trim();
  const privateKey = (env.VAPID_PRIVATE_KEY ?? "").trim();
  const subject = (env.VAPID_SUBJECT ?? "").trim();
  if (publicKey === "" || privateKey === "" || subject === "") return null;
  return { publicKey, privateKey, subject };
}

/**
 * Run `worker` over `items` with at most `limit` in flight.
 *
 * Deliberately not `Promise.all(items.map(...))`: that is unbounded fan-out,
 * and the whole reason a concurrency limit exists here is that the work is
 * network calls to somebody else's service. Also deliberately not a queue
 * library — this is nine lines and one shared cursor.
 */
export async function mapWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  if (items.length === 0) return;
  const width = Math.max(1, Math.min(limit, items.length));
  let cursor = 0;
  const lanes = Array.from({ length: width }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      await worker(items[index]!);
    }
  });
  await Promise.all(lanes);
}

function normalizeConcurrency(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value < 1) return DEFAULT_CONCURRENCY;
  return Math.floor(value);
}

function emptyStats(window: SweepWindow): SweepStats {
  return {
    windowFrom: window.from.toISOString(),
    windowTo: window.to.toISOString(),
    sendFrom: window.sendFrom.toISOString(),
    skipped: false,
    remindersDue: 0,
    remindersSent: 0,
    remindersDeduped: 0,
    remindersStale: 0,
    remindersFailed: 0,
    digestsDue: 0,
    digestsSent: 0,
    digestsDeduped: 0,
    digestsStale: 0,
    digestsEmpty: 0,
    digestsFailed: 0,
    pushesSent: 0,
    pushesPruned: 0,
    pushesFailed: 0,
    errors: 0,
  };
}

function describe(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}
