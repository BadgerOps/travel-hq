/**
 * Which slice of time one cron tick is responsible for. Issue #61.
 *
 * ── WHY A WINDOW AND NEVER AN EQUALITY ────────────────────────────────────
 * A reminder is due at an INSTANT ("15:00:00Z, being an hour before the
 * 16:00 departure"); the sweep runs on a CADENCE (every five minutes, and
 * Cloudflare makes no promise about the second). Asking the database for the
 * reminders due "now" therefore finds nothing, essentially always — the tick
 * lands at 15:02:11 and the row says 15:00:00. Every single notification
 * would be silently missed, on a code path with no user-visible error to
 * complain about. Querying a RANGE is the whole correctness story of this
 * file, and `tests/server/notifications/window.test.ts` pins it.
 *
 * ── WHERE THE RANGE'S START COMES FROM ────────────────────────────────────
 * There is no stored "last run" cursor, and adding one would buy less than it
 * costs. A cursor is a second piece of mutable state that can be corrupted,
 * lost on a database restore, or left stale by a redeploy — and each of those
 * failures is silent in exactly the same way. Instead the start is DERIVED,
 * from two constants that are already true: the cron cadence, and how far
 * back a missed run may reach.
 *
 * The derived window deliberately OVERLAPS the previous run's:
 *
 *     from = now − (CATCH_UP_MINUTES + CRON_INTERVAL_MINUTES)
 *
 * Overlap is the correct failure mode to pick, and it is only safe because
 * claiming is idempotent (`NotificationRepo.claim` — the unique index on
 * notification_log decides who sends). Under overlap, the worst case is a
 * claim that loses and a row that is skipped. Under the alternative — a
 * window that starts exactly where the last one ended — the worst case is a
 * gap, and a gap is a notification nobody ever gets and nobody can see was
 * missed. Duplicate suppression we have; missed-send detection we do not.
 *
 * ── AND WHY IT REACHES FURTHER BACK THAN IT WILL SEND ─────────────────────
 * Three bounds, not two:
 *
 *     from ............ how far back the QUERY looks
 *     sendFrom ........ the oldest thing still worth SENDING
 *     to (= now) ...... the exclusive upper bound of both
 *
 * `sendFrom` is `now − CATCH_UP_MINUTES` because a reminder for a flight that
 * left forty minutes ago is worse than silence: it is a notification that can
 * only make someone feel worse about something they can no longer act on.
 *
 * `from` reaches back much further, and everything in `[from, sendFrom)` is
 * dropped — but LOGGED and recorded as `stale` on its claim, rather than
 * quietly dropping out of a narrower query. That distinction is the reason
 * for the third bound: after an outage, "we chose not to send 340 reminders"
 * and "there was nothing to send" must not look identical in the log stream.
 */

/**
 * The cron cadence, mirrored by hand from `[triggers] crons` in wrangler.toml.
 *
 * Five minutes, not one. Cloudflare's minimum is one minute, which would cost
 * 1,440 invocations a day against a database that changes a handful of times
 * an hour — and buys nothing a traveller can perceive: the reminders this app
 * sends have leads measured in tens of minutes, so ±5 minutes on a 60-minute
 * lead is inside the noise of when someone actually looks at their phone.
 * Anything that genuinely needs second-accuracy is not a cron job.
 */
export const CRON_INTERVAL_MINUTES = 5;

/**
 * How overdue a notification may be and still be worth sending, in minutes.
 *
 * This is the bound on catch-up after a missed run (a deploy, an outage, a
 * cron that simply did not fire). Thirty minutes is chosen so that "your
 * flight leaves in an hour" arriving as "…in 30 minutes" is still actionable;
 * beyond that the message has stopped describing the world.
 */
export const CATCH_UP_MINUTES = 30;

/**
 * How far back the query reaches purely so that what it refuses to send can
 * be counted and logged. Six hours: longer than any deploy, shorter than an
 * outage somebody has not already noticed.
 *
 * Cheap despite the width, because both `findDueReminders` and the claim
 * ledger exclude anything already claimed — in steady state this window
 * returns the same handful of rows a five-minute window would.
 */
export const STALE_LOOKBACK_MINUTES = 6 * 60;

export type SweepWindowOptions = {
  intervalMinutes: number;
  catchUpMinutes: number;
  staleLookbackMinutes: number;
};

export type SweepWindow = {
  /** Inclusive lower bound of the DATABASE QUERY. */
  from: Date;
  /** Exclusive upper bound of everything — the moment the tick believes it is. */
  to: Date;
  /**
   * Inclusive lower bound of what may actually be SENT. Anything due in
   * `[from, sendFrom)` is too stale: dropped, logged, and closed out on its
   * claim so the next tick does not rediscover and re-log it.
   */
  sendFrom: Date;
};

const MINUTE_MS = 60_000;

export function defaultSweepWindowOptions(): SweepWindowOptions {
  return {
    intervalMinutes: CRON_INTERVAL_MINUTES,
    catchUpMinutes: CATCH_UP_MINUTES,
    staleLookbackMinutes: STALE_LOOKBACK_MINUTES,
  };
}

/**
 * The window one tick at `now` owns. Pure, total, and exported so the
 * arithmetic can be tested without a database, a clock, or a Worker.
 *
 * Negative or non-finite options are clamped rather than rejected: a bad
 * constant must not be able to turn the sweep off, and the safe direction for
 * every one of these is "look at least as far as the cadence".
 */
export function sweepWindow(now: Date, options: Partial<SweepWindowOptions> = {}): SweepWindow {
  const defaults = defaultSweepWindowOptions();
  const interval = clampMinutes(options.intervalMinutes, defaults.intervalMinutes);
  const catchUp = clampMinutes(options.catchUpMinutes, defaults.catchUpMinutes);
  const lookback = Math.max(
    clampMinutes(options.staleLookbackMinutes, defaults.staleLookbackMinutes),
    catchUp + interval,
  );

  const at = now.getTime();
  return {
    from: new Date(at - lookback * MINUTE_MS),
    sendFrom: new Date(at - catchUp * MINUTE_MS),
    to: new Date(at),
  };
}

/**
 * True when something due at `sendAt` is past the catch-up bound and must be
 * dropped instead of sent. A `sendAt` that will not parse counts as stale:
 * the alternative is sending at an unknown time, and a corrupt row should
 * cost one notification, loudly, not produce one at random.
 */
export function isStale(sendAt: string, window: SweepWindow): boolean {
  const at = Date.parse(sendAt);
  if (Number.isNaN(at)) return true;
  return at < window.sendFrom.getTime();
}

function clampMinutes(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value < 0) return fallback;
  return value;
}
