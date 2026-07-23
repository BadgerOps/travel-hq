import { createApp } from "./index.js";
import { handleInboundEmail } from "./ingest.js";
import type { EmailIngestEnv } from "./ingest.js";

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

export default { fetch: app.fetch, email };
