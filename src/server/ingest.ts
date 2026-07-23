import { HouseholdSettingsRepo } from "./repos/household-settings.js";
import { InboundEmailRepo } from "./repos/inbound-email.js";

/**
 * The slice of the Worker's bindings the email() handler needs. Deliberately
 * NOT the full AppBindings: ingest never touches auth or encryption.
 */
export type EmailIngestEnv = {
  DB: D1Database;
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
 * input beyond this many bytes is truncated while streaming, before the
 * whole message can occupy Worker memory or reach storage (confirmation emails
 * are far smaller; anything bigger is almost certainly inline-image padding
 * the extractor does not need). A byte limit, rather than a JavaScript string
 * length limit, keeps multi-byte UTF-8 mail under the D1 row limit too.
 */
export const MAX_RAW_BYTES = 1_000_000;
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
 *   allowlist AND a Cloudflare-authored Authentication-Results or
 *   ARC-Authentication-Results record must carry passing DMARC/SPF results.
 *   Anything less is stored as a metadata-only `rejected` row for auditability
 *   and forwarded to the fallback. Attacker-controlled raw bodies are never
 *   persisted for rejected mail.
 * - Storage: the verified message is stored raw (headers + body, truncated at
 *   MAX_RAW_BYTES) with parsed metadata as a `received` row — the durable
 *   record the extractor (#6) and review queue (#7) read. Storing raw before
 *   extraction makes a failed extraction retryable.
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
    // is nowhere to write a failed row — log, forward, done.
    console.error("[email-ingest] recipient resolution failed", err);
    await forwardToFallback(message, env);
    return;
  }

  if (!match) {
    // Unclaimed recipient: never write. A row keyed to no household would be
    // unreachable, and writing on unmatched mail would let any stranger who
    // guesses hostnames grow the database.
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

  try {
    const verdict = verifySender(message.from, message.headers, match.settings.senderAllowlist);
    if (!verdict.ok) {
      // Verify before reading the stream, and retain metadata only. The
      // forwarding address is public by design; storing up to 1 MB for every
      // rejected message lets any spammer exhaust D1 cheaply.
      await repo.create({ ...meta, raw: "", status: "rejected", error: verdict.reason });
      await forwardToFallback(message, env);
      return;
    }

    const raw = await readRawLimited(message.raw);
    await repo.create({ ...meta, raw, status: "received" });
  } catch (err) {
    console.error("[email-ingest] ingest failed; storing a failed row", err);
    try {
      // raw: "" — the stream may be what failed (or is already consumed);
      // metadata alone still gives the owner an auditable trace (#8).
      await repo.create({ ...meta, raw: "", status: "failed", error: describeError(err) });
    } catch (writeErr) {
      console.error("[email-ingest] could not store the failed row either", writeErr);
    }
    await forwardToFallback(message, env);
  }
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
 * Fail-safe reading of the authentication result header(s) produced by
 * Cloudflare Email Routing. Cloudflare documents its original-sender results
 * in ARC-Authentication-Results, while some deliveries/runtimes expose
 * Authentication-Results. Defensive on purpose:
 *
 * - No result authored by mx.cloudflare.net → unauthenticated. A sender may
 *   plant either header in the RFC 5322 message, so verdict text from any other
 *   authserv-id is untrusted even when it says pass.
 * - DMARC verdicts in trusted records → EVERY one must be pass.
 * - No DMARC verdict → fall back to SPF, same all-must-pass rule.
 * - Neither mechanism reported → unauthenticated.
 */
export function senderAuthenticated(headers: Headers): boolean {
  const results = trustedCloudflareResults(headers);
  if (results.length === 0) return false;
  const verdicts = (mechanism: string): string[] =>
    results.flatMap((result) =>
      [...result.matchAll(new RegExp(`\\b${mechanism}=([a-z0-9]+)`, "gi"))].map((m) =>
        m[1]!.toLowerCase(),
      ),
    );
  const dmarc = verdicts("dmarc");
  if (dmarc.length > 0) return dmarc.every((v) => v === "pass");
  const spf = verdicts("spf");
  if (spf.length > 0) return spf.every((v) => v === "pass");
  return false;
}

const CLOUDFLARE_AUTHSERV_ID = "mx.cloudflare.net";

/**
 * Headers combines repeated fields with commas. Split only at a comma followed
 * by the start of another Authentication-Results record so a comma inside a
 * diagnostic comment is not mistaken for a record boundary.
 */
function trustedCloudflareResults(headers: Headers): string[] {
  const records: string[] = [];
  for (const name of ["authentication-results", "arc-authentication-results"]) {
    const value = headers.get(name);
    if (!value) continue;
    for (const rawRecord of value.split(
      /,(?=\s*(?:i=\d+\s*;\s*)?[a-z0-9.-]+\s*;)/i,
    )) {
      const record = rawRecord.trim().replace(/^i=\d+\s*;\s*/i, "");
      const separator = record.indexOf(";");
      if (separator === -1) continue;
      const authservId = record.slice(0, separator).trim().toLowerCase();
      if (authservId === CLOUDFLARE_AUTHSERV_ID) {
        records.push(record.slice(separator + 1));
      }
    }
  }
  return records;
}

async function forwardToFallback(message: ForwardableEmailMessage, env: EmailIngestEnv): Promise<void> {
  if (!env.FALLBACK_FORWARD_TO) return;
  try {
    await message.forward(env.FALLBACK_FORWARD_TO);
  } catch (err) {
    // Best-effort only. An unverified destination or transient routing error
    // must not turn into a bounce.
    console.error("[email-ingest] fallback forward failed", err);
  }
}

async function readRawLimited(raw: ReadableStream<Uint8Array>): Promise<string> {
  const reader = raw.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      return decodeChunks(chunks, bytes);
    }

    const remaining = MAX_RAW_BYTES - bytes;
    if (value.byteLength > remaining) {
      if (remaining > 0) chunks.push(value.subarray(0, remaining));
      bytes += Math.max(0, remaining);
      await reader.cancel("travel-hq raw message limit reached");
      return decodeChunks(chunks, bytes) + TRUNCATION_MARKER;
    }
    chunks.push(value);
    bytes += value.byteLength;

    // At exactly the cap, one more read distinguishes an exact-size message
    // from a larger one without ever retaining bytes beyond the limit.
    if (bytes === MAX_RAW_BYTES) {
      const next = await reader.read();
      if (next.done) {
        return decodeChunks(chunks, bytes);
      }
      await reader.cancel("travel-hq raw message limit reached");
      return decodeChunks(chunks, bytes) + TRUNCATION_MARKER;
    }
  }
}

function decodeChunks(chunks: Uint8Array[], bytes: number): string {
  const joined = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(joined);
}

function describeError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return `Ingest failed: ${message}`.slice(0, MAX_ERROR_CHARS);
}
