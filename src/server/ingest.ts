import { HouseholdSettingsRepo } from "./repos/household-settings.js";
import { InboundEmailRepo } from "./repos/inbound-email.js";
import type { InboundEmail } from "./repos/inbound-email.js";
import { extractInboundEmail } from "./ingest/extract.js";
import type { ExtractionAi } from "./ingest/extract.js";
import { logEvent, errorMessage } from "./logging.js";

/**
 * The slice of the Worker's bindings the email() handler needs. Deliberately
 * NOT the full AppBindings: ingest never touches auth or encryption.
 */
export type EmailIngestEnv = {
  DB: D1Database;
  /**
   * The Workers AI binding ([ai] in wrangler.toml), used by the inline
   * extractor (#6) for mail without a calendar attachment. Structurally
   * typed so tests stub it as `{ run: async () => ... }`; the real `Ai`
   * binding satisfies the shape. Optional because a stripped env without it
   * must degrade to storage-only ingest (rows queue as `received`), never
   * crash or bounce.
   */
  AI?: ExtractionAi;
  /**
   * Optional Email Routing destination address. Every message that is NOT
   * stored as `received` (unclaimed recipient, rejected sender, internal
   * failure) is forwarded here best-effort so mail is never silently lost.
   * Must be a verified destination address in Email Routing or forward()
   * itself fails (which is logged and swallowed — still fail-soft).
   */
  FALLBACK_FORWARD_TO?: string;
};

/**
 * D1 caps a row at ~2 MB; Email Routing allows messages up to 25 MiB. Raw
 * text beyond this many characters is truncated before storage (confirmation
 * emails are far smaller; anything bigger is almost certainly inline-image
 * padding the extractor does not need). Mostly-ASCII mail at this cap stays
 * comfortably under the row limit; a pathological multi-byte message that
 * still overflows fails the insert and falls into the fail-soft path.
 */
export const MAX_RAW_CHARS = 1_000_000;
const TRUNCATION_MARKER = "\n[truncated by travel-hq ingest]";

/** Keep stored reasons short and single-purpose; #8 renders them verbatim. */
const MAX_ERROR_CHARS = 500;

export type SenderVerdict = { ok: true } | { ok: false; reason: string };

/**
 * Real ingest for the email() handler (issue #4). Fail-soft end to end: this
 * function never throws and never calls setReject(), so the sender is never
 * bounced by an internal problem.
 *
 * - Recipient → household: the envelope To: is matched against
 *   household_settings.forward_address. No match → forward to the fallback
 *   (if configured) and NEVER write — an unclaimed address must not be able
 *   to create rows anywhere.
 * - Sender verification: the envelope From: must be on the household's
 *   allowlist AND the message must carry passing DMARC/SPF results
 *   (Authentication-Results, added by Email Routing). Anything less is stored
 *   as a `rejected` row for auditability and forwarded to the fallback.
 * - Storage: the verified message is stored raw (headers + body, truncated at
 *   MAX_RAW_CHARS) with parsed metadata as a `received` row — the durable
 *   record the extractor (#6) and review queue (#7) read. Storing raw before
 *   extraction makes a failed extraction retryable.
 * - Extraction (#6) runs INLINE after the row is stored: .ics-first, then
 *   Workers AI JSON Mode (model from household settings), writing pending
 *   draft_booking rows and transitioning received → extracted|failed.
 *   extractInboundEmail never throws by contract, so an extraction problem
 *   can only ever mark the stored row failed — the mail itself is safe.
 * - Any error after the household is known is recorded as a `failed` row
 *   (best-effort) and the message is forwarded to the fallback.
 */
export async function handleInboundEmail(
  message: ForwardableEmailMessage,
  env: EmailIngestEnv,
): Promise<void> {
  let match;
  try {
    match = await HouseholdSettingsRepo.findHouseholdByForwardAddress(env.DB, message.to);
  } catch (err) {
    // Even resolution can fail (D1 outage). No household is known, so there
    // is nowhere to write a failed row — log, forward, done. The reason is
    // D1's error text, never anything from the message itself.
    logEvent("email_ingest", { outcome: "resolution_failed", reason: errorMessage(err) });
    await forwardToFallback(message, env);
    return;
  }

  if (!match) {
    // Unclaimed recipient: never write. A row keyed to no household would be
    // unreachable, and writing on unmatched mail would let any stranger who
    // guesses hostnames grow the database. The log line carries the outcome
    // and nothing else on purpose — the addresses of unmatched mail are
    // exactly the strangers'-emails case the no-PII rule exists for (#8);
    // the message itself is preserved by the fallback forward.
    logEvent("email_ingest", { outcome: "unmatched_recipient" });
    await forwardToFallback(message, env);
    return;
  }

  const repo = InboundEmailRepo.forIngest(env.DB, match.householdId);
  const meta = {
    from: message.from,
    to: message.to,
    subject: message.headers.get("subject"),
    messageId: message.headers.get("message-id"),
  };

  let stored: InboundEmail;
  try {
    const raw = truncateRaw(await new Response(message.raw).text());

    const verdict = verifySender(message.from, message.headers, match.settings.senderAllowlist);
    if (!verdict.ok) {
      const rejected = await repo.create({ ...meta, raw, status: "rejected", error: verdict.reason });
      // The reason names which verification leg(s) failed — never the sender
      // address itself; that lives on the row, which the owner-gated
      // Settings activity feed (#8) serves.
      logEvent("email_ingest", {
        outcome: "rejected",
        householdId: match.householdId,
        emailId: rejected.id,
        reason: verdict.reason,
      });
      await forwardToFallback(message, env);
      return;
    }

    stored = await repo.create({ ...meta, raw, status: "received" });
  } catch (err) {
    const reason = describeError(err);
    // emailId stays null when even the failed row could not be written —
    // that second failure gets its own line so it is never silent.
    let failedRowId: string | null = null;
    try {
      // raw: "" — the stream may be what failed (or is already consumed);
      // metadata alone still gives the owner an auditable trace (#8).
      const failed = await repo.create({ ...meta, raw: "", status: "failed", error: reason });
      failedRowId = failed.id;
    } catch (writeErr) {
      logEvent("email_ingest_error", {
        householdId: match.householdId,
        reason: `could not store the failed row: ${errorMessage(writeErr)}`,
      });
    }
    logEvent("email_ingest", {
      outcome: "failed",
      householdId: match.householdId,
      emailId: failedRowId,
      reason,
    });
    await forwardToFallback(message, env);
    return;
  }

  // Outside the try above on purpose: extractInboundEmail never throws by
  // contract (it marks the row failed instead), and keeping it out of that
  // catch means a bug in it can never create a SECOND, duplicate failed row
  // for a message that was already stored.
  await extractInboundEmail(
    { db: env.DB, ai: env.AI, householdId: match.householdId, aiModel: match.settings.aiModel },
    stored,
  );
}

/**
 * A sender is acceptable only when BOTH hold: on the household's allowlist
 * and authenticated by DMARC/SPF. No implicit trust — an empty allowlist
 * rejects everyone, and missing auth results reject even allowlisted senders.
 * The reason names every failed leg so the owner can fix the right one (#8).
 */
export function verifySender(
  from: string,
  headers: Headers,
  allowlist: string[],
): SenderVerdict {
  const reasons: string[] = [];
  if (!senderAllowed(from, allowlist)) {
    reasons.push("sender is not on the household allowlist");
  }
  if (!senderAuthenticated(headers)) {
    reasons.push("sender did not pass DMARC/SPF authentication");
  }
  return reasons.length === 0 ? { ok: true } : { ok: false, reason: reasons.join("; ") };
}

/**
 * Matches the envelope sender against allowlist entries: a full address
 * (contains @) must match exactly; a bare domain matches that domain and its
 * subdomains on a dot boundary (airlines routinely send from e.g.
 * bounce.airline.com while the owner allowlists airline.com). Everything is
 * compared lowercased, mirroring how HouseholdSettingsRepo normalizes entries.
 */
export function senderAllowed(from: string, allowlist: string[]): boolean {
  const address = from.trim().toLowerCase();
  if (address === "") return false;
  const domain = address.split("@")[1] ?? "";
  return allowlist.some((entry) => {
    if (entry.includes("@")) return entry === address;
    return domain === entry || domain.endsWith("." + entry);
  });
}

/**
 * Fail-safe reading of the Authentication-Results header(s) Email Routing
 * stamps on the message. Defensive on purpose:
 *
 * - No header at all → unauthenticated.
 * - DMARC verdicts present → EVERY one must be pass. A message can carry a
 *   forged Authentication-Results header planted by the sender alongside the
 *   real one added at the Cloudflare edge; requiring all-pass means a planted
 *   `dmarc=pass` cannot outvote a genuine `dmarc=fail`.
 * - No DMARC verdict → fall back to SPF, same all-must-pass rule.
 * - Neither mechanism reported → unauthenticated.
 */
export function senderAuthenticated(headers: Headers): boolean {
  const results = headers.get("authentication-results");
  if (!results) return false;
  const verdicts = (mechanism: string): string[] =>
    [...results.matchAll(new RegExp(`\\b${mechanism}=([a-z0-9]+)`, "gi"))].map((m) =>
      m[1]!.toLowerCase(),
    );
  const dmarc = verdicts("dmarc");
  if (dmarc.length > 0) return dmarc.every((v) => v === "pass");
  const spf = verdicts("spf");
  if (spf.length > 0) return spf.every((v) => v === "pass");
  return false;
}

async function forwardToFallback(message: ForwardableEmailMessage, env: EmailIngestEnv): Promise<void> {
  if (!env.FALLBACK_FORWARD_TO) return;
  try {
    await message.forward(env.FALLBACK_FORWARD_TO);
  } catch (err) {
    // Best-effort only. An unverified destination or transient routing error
    // must not turn into a bounce.
    logEvent("email_ingest_error", { reason: `fallback forward failed: ${errorMessage(err)}` });
  }
}

function truncateRaw(raw: string): string {
  if (raw.length <= MAX_RAW_CHARS) return raw;
  return raw.slice(0, MAX_RAW_CHARS) + TRUNCATION_MARKER;
}

function describeError(err: unknown): string {
  return `Ingest failed: ${errorMessage(err)}`.slice(0, MAX_ERROR_CHARS);
}
