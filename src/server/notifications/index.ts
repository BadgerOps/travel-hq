/**
 * The scheduled half of push notifications (issue #61). Import from here.
 *
 * The split between window/format/reminders/digest/sweep/cron is an
 * implementation detail; the boundaries may move. What will not move:
 *
 *   - the sweep queries a RANGE and claims BEFORE it sends (sweep.ts),
 *   - "when" is arithmetic on the stored instant and the booking's zone
 *     reaches only the words (reminders.ts),
 *   - there is no quiet-hours suppression anywhere, and an early event is
 *     announced the evening before as well (digest.ts).
 */

export { runScheduledTasks } from "./cron.js";
export type { CronEnv, CronOptions, CronResult } from "./cron.js";

export {
  buildDigest,
  DEFAULT_CONCURRENCY,
  mapWithConcurrency,
  resolveVapid,
  runNotificationSweep,
} from "./sweep.js";
export type { BuiltDigest, DeliveryOutcome, SweepEnv, SweepOptions, SweepStats } from "./sweep.js";

export {
  CATCH_UP_MINUTES,
  CRON_INTERVAL_MINUTES,
  defaultSweepWindowOptions,
  isStale,
  STALE_LOOKBACK_MINUTES,
  sweepWindow,
} from "./window.js";
export type { SweepWindow, SweepWindowOptions } from "./window.js";

export {
  chooseDigestTimezone,
  composeDigest,
  digestLocalDate,
  digestTag,
  EARLY_EVENT_HOUR,
  firstEventTimezone,
  nextDate,
  splitDigestEntries,
  TIMEZONE_FRESHNESS_DAYS,
} from "./digest.js";
export type {
  ComposedDigest,
  DigestChecklistItem,
  DigestEntry,
  DigestSplit,
  DigestTimezoneChoice,
  DigestTimezoneSource,
} from "./digest.js";

export { reminderPayload, reminderTag } from "./reminders.js";

export {
  clip,
  dayPath,
  eventLocalDate,
  eventLocalHour,
  formatClock,
  formatEventTime,
  formatLead,
  formatZoneLabel,
  verbForKind,
} from "./format.js";
