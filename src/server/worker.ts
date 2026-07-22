import { createApp } from "./index.js";

// One app for the isolate; bindings arrive per request via env.
const app = createApp();

/**
 * Stub `email()` handler.
 *
 * This is deliberately NOT real ingest. Real ingest (parse the message,
 * extract with Workers AI, write a draft via `InboundEmailRepo.create`) is
 * the deferred ingest plan (see
 * docs/superpowers/specs/2026-07-22-cloudflare-replatform-design.md,
 * "Ingest and extraction — DEFERRED"). Until that plan lands, this handler
 * does no parsing and no D1 writes — it only forwards the message to a
 * fallback mailbox if one is configured (`env.FALLBACK_FORWARD_TO`), else it
 * is a no-op.
 *
 * The interim path for `trips@badgerops.foo` is NOT this handler at all:
 * Cloudflare Email Routing forwards it directly to a real mailbox at the
 * dashboard level (see docs/cloudflare-github-setup.md, "Email forwarding
 * (interim)"). This export exists so the Worker has the correct shape ready
 * for when Email Routing is later pointed at the Worker instead, and so a
 * message that does land here isn't silently swallowed.
 */
async function email(
  message: ForwardableEmailMessage,
  env: { FALLBACK_FORWARD_TO?: string },
  _ctx: ExecutionContext,
): Promise<void> {
  if (env.FALLBACK_FORWARD_TO) {
    await message.forward(env.FALLBACK_FORWARD_TO);
  }
}

export default { fetch: app.fetch, email };
