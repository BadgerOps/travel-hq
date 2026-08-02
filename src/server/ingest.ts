import { HouseholdSettingsRepo } from "./repos/household-settings.js";
import { InboundEmailRepo } from "./repos/inbound-email.js";
import type { InboundEmail } from "./repos/inbound-email.js";
import { extractInboundEmail } from "./ingest/extract.js";
import type { ExtractionAi } from "./ingest/extract.js";
import {
  resolveExtractionProvider,
} from "./ingest/providers.js";
import type { AnthropicClientFactory } from "./ingest/providers.js";
import { loadKeyring } from "./crypto/envelope.js";
import { resolveDnsTxt, verifyAlignedDkim } from "./ingest/dkim.js";
import type { DnsTxtResolver } from "./ingest/dkim.js";

/**
 * The slice of the Worker's bindings the email() handler needs.
 */
export type EmailIngestEnv = {
  DB: D1Database;
  /** Same keyring secret used by authenticated routes; decrypts provider keys. */
  ENCRYPTION_KEY?: string;
  /** Workers AI JSON-mode fallback for messages without calendar parts. */
  AI?: ExtractionAi;
  /** Test seam only; production uses the official SDK's client. */
  anthropicClientFactory?: AnthropicClientFactory;
  /** Test seam only; production resolves DKIM TXT keys through DNS over HTTPS. */
  dkimResolver?: DnsTxtResolver;
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

export type CloudflareAuthVerdict = "pass" | "fail" | "unavailable";
export type CloudflareAuthDiagnostic = {
  verdict: CloudflareAuthVerdict;
  trustedRecords: number;
  dmarc: string[];
  spf: string[];
};
export type SenderVerdict =
  | { decision: "accept"; source: "cloudflare" }
  | { decision: "verify-dkim" }
  | { decision: "reject"; reason: string };

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
 *   allowlist AND authenticated. A Cloudflare-authored DMARC/SPF pass is the
 *   primary path. When Email Routing omits those verdicts, an exact-address
 *   allowlist entry may use independent, aligned DKIM verification of the raw
 *   message. Anything less is stored as a metadata-only `rejected` row and
 *   forwarded to the fallback.
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
  let stored: InboundEmail;
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

  // Loaded before the row is written, not after: `raw` is sealed by the
  // repository at insert time, so the ring has to be in hand for create() —
  // storing plaintext first and encrypting later would leave exactly the
  // window this change exists to close. Extraction reuses the same ring
  // below. A missing or malformed secret is still fail-soft: the message is
  // stored as legacy plaintext rather than being lost.
  let ring;
  try {
    if (env.ENCRYPTION_KEY) ring = loadKeyring(env.ENCRYPTION_KEY);
  } catch (err) {
    console.warn("[email-ingest] encryption keyring unavailable", err);
  }

  const repo = InboundEmailRepo.forIngest(env.DB, match.householdId, ring);
  const meta = {
    from: message.from,
    to: message.to,
    subject: message.headers.get("subject"),
    messageId: message.headers.get("message-id"),
  };

  try {
    const authentication = cloudflareAuthenticationDiagnostic(message.headers);
    const verdict = verifySender(
      message.from,
      message.headers,
      match.settings.senderAllowlist,
      authentication.verdict,
    );
    console.info("[email-ingest] sender authentication evaluated", {
      verdict: authentication.verdict,
      trustedRecords: authentication.trustedRecords,
      dmarc: authentication.dmarc,
      spf: authentication.spf,
      decision: verdict.decision,
    });
    if (verdict.decision === "reject") {
      // Verify before reading the stream, and retain metadata only. The
      // forwarding address is public by design; storing up to 1 MB for every
      // rejected message lets any spammer exhaust D1 cheaply.
      await repo.create({ ...meta, raw: "", status: "rejected", error: verdict.reason });
      await forwardToFallback(message, env);
      return;
    }

    // Email Routing can redeliver the exact same RFC message. Message-ID is
    // scoped to the household; short-circuiting here avoids
    // rereading/re-extracting it in the normal case. A separately
    // forwarded copy has a different outer Message-ID and is handled later by
    // semantic booking deduplication during import review.
    if (meta.messageId && await repo.findByMessageId(meta.messageId)) {
      console.info("[email-ingest] ignored duplicate Message-ID");
      return;
    }

    const raw = await readRawLimited(message.raw);
    if (verdict.decision === "verify-dkim") {
      const dkim = await verifyAlignedDkim(
        raw,
        message.from,
        env.dkimResolver ?? resolveDnsTxt,
      );
      if (!dkim.ok) {
        console.warn("[email-ingest] independent DKIM fallback rejected message", dkim.reason);
        await repo.create({ ...meta, raw: "", status: "rejected", error: dkim.reason });
        await forwardToFallback(message, env);
        return;
      }
      console.info("[email-ingest] accepted via independent aligned DKIM fallback");
    }
    stored = await repo.create({ ...meta, raw, status: "received" });
  } catch (err) {
    // If a concurrent invocation stored this Message-ID first, this delivery
    // is complete—not a failed message to store or forward.
    if (meta.messageId) {
      try {
        if (await repo.findByMessageId(meta.messageId)) {
          console.info("[email-ingest] ignored concurrently duplicated Message-ID");
          return;
        }
      } catch {
        // Fall through to the normal fail-soft handling below.
      }
    }
    console.error("[email-ingest] ingest failed; storing a failed row", err);
    try {
      // raw: "" — the stream may be what failed (or is already consumed);
      // metadata alone still gives the owner an auditable trace (#8).
      await repo.create({ ...meta, raw: "", status: "failed", error: describeError(err) });
    } catch (writeErr) {
      console.error("[email-ingest] could not store the failed row either", writeErr);
    }
    await forwardToFallback(message, env);
    return;
  }

  // Extraction owns its own fail-soft status transitions. Keep it outside the
  // ingest catch so an unexpected extractor bug cannot create a second row for
  // a message that was already stored successfully.
  const provider = await resolveExtractionProvider({
    settings: match.settings,
    ai: env.AI,
    ring,
    anthropicClientFactory: env.anthropicClientFactory,
    logContext: `inbound email ${stored.id}`,
  });
  await extractInboundEmail(
    {
      db: env.DB,
      householdId: match.householdId,
      provider,
      extractionInstructions: match.settings.extractionInstructions,
    },
    stored,
  );

  // Delivery is finished; everything past here is housekeeping. This Worker
  // has no cron trigger, so arrival of new mail is one of the two moments the
  // retention sweep gets to run (the other is import review). Last, and
  // swallowed: an expired row that survives one more day is a triviality
  // compared with bouncing a real confirmation because a DELETE failed.
  try {
    const purged = await repo.purgeExpiredRaw();
    if (purged.length > 0) {
      console.info(`[email-ingest] purged raw from ${purged.length} expired inbound email(s)`);
    }
  } catch (err) {
    console.error("[email-ingest] retention sweep failed", err);
  }
}

/**
 * Prechecks the envelope sender before the raw stream is read. A trusted
 * Cloudflare pass accepts any allowlist shape. If Cloudflare omitted a usable
 * verdict, only an exact-address entry can proceed to independent DKIM
 * verification; a domain entry is intentionally too broad for that fallback.
 */
export function verifySender(
  from: string,
  headers: Headers,
  allowlist: string[],
  authentication = cloudflareAuthentication(headers),
): SenderVerdict {
  const allowed = senderAllowed(from, allowlist);

  if (!allowed) {
    const reasons = ["sender is not on the household allowlist"];
    if (authentication === "fail") {
      reasons.push("sender did not pass DMARC/SPF authentication");
    } else if (authentication === "unavailable") {
      reasons.push("Cloudflare authentication verdict unavailable");
    }
    return { decision: "reject", reason: reasons.join("; ") };
  }

  if (authentication === "pass") {
    return { decision: "accept", source: "cloudflare" };
  }
  if (authentication === "fail") {
    return { decision: "reject", reason: "sender did not pass DMARC/SPF authentication" };
  }
  if (exactSenderAllowed(from, allowlist)) {
    return { decision: "verify-dkim" };
  }
  return {
    decision: "reject",
    reason:
      "Cloudflare authentication verdict unavailable; aligned DKIM fallback requires an exact-address allowlist entry",
  };
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

function exactSenderAllowed(from: string, allowlist: string[]): boolean {
  const address = from.trim().toLowerCase();
  return address !== "" && allowlist.some((entry) => entry.includes("@") && entry === address);
}

/**
 * Fail-safe reading of the authentication result header(s) produced by
 * Cloudflare Email Routing. Cloudflare documents its original-sender results
 * in ARC-Authentication-Results, while some deliveries/runtimes expose
 * Authentication-Results. Defensive on purpose:
 *
 * - No DMARC/SPF result authored by mx.cloudflare.net → unavailable. A sender
 *   may plant either header in the RFC 5322 message, so verdict text from any
 *   other authserv-id is untrusted even when it says pass.
 * - DMARC verdicts in trusted records → EVERY one must be pass.
 * - No DMARC verdict → fall back to SPF, same all-must-pass rule.
 * - A reported non-pass is an explicit failure and never eligible for DKIM
 *   fallback.
 */
export function cloudflareAuthentication(headers: Headers): CloudflareAuthVerdict {
  return cloudflareAuthenticationDiagnostic(headers).verdict;
}

/**
 * Returns only bounded authentication status tokens and counts, making this
 * safe to emit to persistent observability without exposing message content,
 * addresses, or complete authentication headers.
 */
export function cloudflareAuthenticationDiagnostic(
  headers: Headers,
): CloudflareAuthDiagnostic {
  const results = trustedCloudflareResults(headers);
  const verdicts = (mechanism: string): string[] =>
    results.flatMap((result) =>
      [
        ...result.matchAll(
          new RegExp(`(?:^|;)\\s*${mechanism}=([a-z0-9]+)`, "gi"),
        ),
      ].map((match) => match[1]!.toLowerCase()),
    );
  const dmarc = verdicts("dmarc");
  const spf = verdicts("spf");
  let verdict: CloudflareAuthVerdict = "unavailable";
  if (dmarc.length > 0) {
    verdict = dmarc.every((value) => value === "pass") ? "pass" : "fail";
  } else if (spf.length > 0) {
    verdict = spf.every((value) => value === "pass") ? "pass" : "fail";
  }
  return {
    verdict,
    trustedRecords: results.length,
    dmarc: dmarc.slice(0, 10).map((value) => value.slice(0, 32)),
    spf: spf.slice(0, 10).map((value) => value.slice(0, 32)),
  };
}

/** Compatibility helper for callers that only need a passing/not-passing bit. */
export function senderAuthenticated(headers: Headers): boolean {
  return cloudflareAuthentication(headers) === "pass";
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
