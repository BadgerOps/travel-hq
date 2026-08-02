import { createApp } from "./index.js";
import { handleInboundEmail } from "./ingest.js";
import type { EmailIngestEnv } from "./ingest.js";
import { runScheduledTasks } from "./notifications/cron.js";
import type { CronEnv } from "./notifications/cron.js";

// One app for the isolate; bindings arrive per request via env.
const app = createApp();

/**
 * Real ingest entry point (issue #4) — no longer the dormant stub.
 *
 * All logic lives in src/server/ingest.ts (handleInboundEmail): resolve the
 * household from the envelope recipient, verify the sender (allowlist plus a
 * Cloudflare DMARC/SPF verdict or the narrow independent DKIM fallback), and
 * store the raw message as an inbound_email row. Fail-soft by contract:
 * handleInboundEmail never throws and never calls setReject(), so a transient
 * internal error can never bounce a real confirmation email — the worst case
 * is a logged error plus a best-effort forward to env.FALLBACK_FORWARD_TO.
 *
 * Nothing reaches this handler until the Email Routing rule for
 * trips@badgerops.foo is switched from "Send to an email" to "Send to a
 * Worker" (owner action; see docs/cloudflare-github-setup.md, "Email ingest").
 */
async function email(
  message: ForwardableEmailMessage,
  env: EmailIngestEnv,
  _ctx: ExecutionContext,
): Promise<void> {
  await handleInboundEmail(message, env);
}

/**
 * The cron entry point (issue #61) — the first thing in this Worker that runs
 * without a human on the other end.
 *
 * It exists because two of this product's promises cannot be kept by a
 * request handler. "Tell me an hour before my flight" has to happen while
 * nobody has the app open, and "we delete your raw email after 30 days" has
 * to happen for a household that stopped logging in — which is exactly the
 * household most owed it. Both were previously either unimplemented or
 * opportunistic; `[triggers] crons` in wrangler.toml is what makes them real,
 * and this is the handler it calls.
 *
 * All logic lives in src/server/notifications/cron.ts (runScheduledTasks).
 * Fail-soft by contract, at two levels: each chore is wrapped there, and each
 * individual notification is wrapped again inside the sweep, so one broken
 * push subscription can never abort the sweep for everybody else. It returns
 * a summary rather than throwing, which is why nothing here re-raises.
 *
 * `ctx.waitUntil` is not used: `scheduled()` is awaited by the runtime, and
 * detaching the work would let the isolate be torn down mid-send.
 */
async function scheduled(
  event: ScheduledController,
  env: CronEnv,
  _ctx: ExecutionContext,
): Promise<void> {
  // `scheduledTime` rather than Date.now(): it is the moment the tick was
  // scheduled FOR, so a queued or slow-to-start invocation still sweeps the
  // window it was meant to sweep instead of quietly skipping the gap.
  await runScheduledTasks(env, { now: new Date(event.scheduledTime) });
}

export default { fetch: app.fetch, email, scheduled };
