/**
 * Everything one cron tick does. Issue #61.
 *
 * The Worker's `scheduled()` export is deliberately three lines that call
 * this, matching how `email()` delegates to `handleInboundEmail`: the entry
 * point says WHY it exists, the module says what happens.
 *
 * Two chores, in this order and for this reason:
 *
 *   1. THE NOTIFICATION SWEEP. Time-critical — a reminder is worth less every
 *      minute it is late — so it goes first and is never made to wait behind
 *      housekeeping.
 *
 *   2. THE RAW-EMAIL RETENTION PURGE. `docs/email-retention.md` has said since
 *      issue #22 that `InboundEmailRepo.purgeExpiredRawEverywhere` should be
 *      wired to a `scheduled()` handler "once a `[triggers]` block is added to
 *      wrangler.toml". This is that moment. Until now purging was purely
 *      opportunistic — it rode on ingest and the import-review writes — which
 *      meant a household that stopped using Travel HQ stopped being swept, and
 *      its expired raw messages sat there indefinitely. A cron sweeps them
 *      whether or not anybody logs in, which is the promise the Settings copy
 *      actually makes.
 *
 * Both are independently fail-soft. A push service outage must not stop the
 * retention purge, and a retention purge that hits a locked table must not
 * cost anybody their reminders.
 */

import { InboundEmailRepo } from "../repos/inbound-email.js";
import { log } from "../logging.js";
import type { Logger } from "../logging.js";
import { runNotificationSweep } from "./sweep.js";
import type { SweepEnv, SweepStats } from "./sweep.js";

export type CronEnv = SweepEnv;

export type CronOptions = {
  now?: Date;
  logger?: Logger;
  fetchImpl?: typeof fetch;
};

export type CronResult = {
  /** Null when the sweep itself threw; the log line has the reason. */
  sweep: SweepStats | null;
  /** Rows redacted by the retention purge, or null if it threw. */
  purgedRawEmails: number | null;
};

export async function runScheduledTasks(
  env: CronEnv,
  options: CronOptions = {},
): Promise<CronResult> {
  const logger = options.logger ?? log;
  const now = options.now ?? new Date();
  const result: CronResult = { sweep: null, purgedRawEmails: null };

  try {
    result.sweep = await runNotificationSweep(env, {
      now,
      logger,
      fetchImpl: options.fetchImpl,
    });
  } catch (err) {
    logger.error("notification_sweep_failed", { reason: describe(err) });
  }

  try {
    result.purgedRawEmails = await InboundEmailRepo.purgeExpiredRawEverywhere(env.DB, now);
    if (result.purgedRawEmails > 0) {
      logger.info("raw_email_purge", { rows: result.purgedRawEmails, source: "cron" });
    }
  } catch (err) {
    // Same policy the opportunistic callers already apply: a housekeeping
    // chore that fails is logged and swallowed. An expired row that survives
    // one more tick is a triviality.
    logger.error("raw_email_purge_failed", { reason: describe(err) });
  }

  return result;
}

function describe(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}
