/**
 * `sendPush` — one POST to one push endpoint. Issue #61.
 *
 * ── WHY THIS RETURNS INSTEAD OF THROWS ────────────────────────────────────
 * The only caller shape that makes sense for push is a sweep: "for every
 * reminder due in the next minute, for every device that household has
 * registered, send one". That is dozens to thousands of independent calls in
 * one scheduled invocation, over a network we do not control, to services
 * that are down often enough to matter. If a dead subscription or a 502 from
 * FCM threw, one bad row would abort the sweep and nobody's reminders would
 * go out. So every expected outcome is a value, and the function is written
 * so that nothing escapes it — see the catch-all at the bottom.
 *
 * ── WHY `gone` IS ITS OWN OUTCOME ─────────────────────────────────────────
 * 404 and 410 mean the subscription no longer exists and never will again;
 * the caller MUST delete the row. This is load-bearing rather than tidy: iOS
 * silently drops a Web Push subscription when the PWA is removed from the
 * home screen, when the user hasn't opened it in a long while, or on some OS
 * updates. A household that reinstalls accumulates dead subscriptions
 * forever, and a sweep that keeps POSTing to them earns rate limits that hurt
 * the live ones. Pruning on `gone` is the entire garbage collection story.
 *
 * ── WHAT MAY BE LOGGED ────────────────────────────────────────────────────
 * Not the payload plaintext. Not the auth secret or p256dh. NOT THE FULL
 * ENDPOINT URL: an endpoint is a bearer capability — anyone holding it can
 * push to that device (VAPID identifies us, it does not authorize us) — so it
 * belongs in the database and nowhere else. Only the endpoint's host is
 * logged, which is `fcm.googleapis.com`-grade information. This mirrors the
 * logging rules from issue #8 in src/server/logging.ts.
 */

import { log } from "../logging.js";
import type { Logger } from "../logging.js";
import { PushError } from "./bytes.js";
import type { PushErrorCode } from "./bytes.js";
import { encryptPushPayload } from "./encrypt.js";
import type { SubscriptionKeys } from "./encrypt.js";
import { buildNotificationJson } from "./payload.js";
import type { NotificationPayload } from "./payload.js";
import { createVapidAuthorization } from "./vapid.js";
import type { VapidConfig } from "./vapid.js";

/** A stored browser subscription, in the shape `PushSubscription.toJSON()` gives. */
export type WebPushSubscription = {
  /** The push service URL. A bearer capability: never log it, never expose it. */
  endpoint: string;
  keys: SubscriptionKeys;
};

/**
 * RFC 8030 §5.3. `normal` is the default and the right answer for a trip
 * reminder; `high` is for something the user would want to wake the screen
 * for. `very-low`/`low` let a battery-saving device batch delivery.
 */
export type PushUrgency = "very-low" | "low" | "normal" | "high";

export type PushResult =
  /** Accepted by the push service. Delivery to the device is still not guaranteed. */
  | { outcome: "sent"; status: number }
  /** 404/410 — the subscription is dead. The caller MUST delete it. */
  | { outcome: "gone"; status: number }
  /**
   * 429/408/5xx or a transport failure. Worth trying again later; `status` is
   * null when the request never got an HTTP response at all.
   */
  | {
      outcome: "retryable";
      status: number | null;
      /** Parsed from `Retry-After` (delta-seconds or HTTP-date), when present. */
      retryAfterSeconds: number | null;
      reason: string;
    }
  /** A 4xx we cannot fix by retrying (bad VAPID, malformed request, 413). */
  | { outcome: "failed"; status: number | null; reason: string }
  /**
   * We refused to send: unusable subscription keys, an oversized payload, a
   * payload that violated the no-secrets rule, or a broken VAPID config. No
   * request was made. `code` says which, so a sweep can prune a corrupt row
   * (`invalid_subscription`) but alert on a config problem
   * (`invalid_vapid_key`).
   */
  | { outcome: "invalid"; code: PushErrorCode; reason: string };

export type SendPushOptions = {
  subscription: WebPushSubscription;
  /**
   * The notification, or a pre-rendered JSON string. Prefer the object form —
   * it is validated against the payload policy in payload.ts. A raw string
   * bypasses that validation and the caller takes on the obligation itself.
   */
  payload: NotificationPayload | string;
  vapid: VapidConfig;
  /**
   * How long the push service may hold the message for a device that is
   * offline, in seconds (RFC 8030 §5.2). Default one hour: a "leave for the
   * airport" nudge delivered four hours late is worse than not delivered.
   */
  ttlSeconds?: number;
  urgency?: PushUrgency;
  /**
   * RFC 8030 §5.4 collapse key. A later message with the same topic REPLACES
   * an undelivered earlier one on the push service. Restricted by the RFC to
   * at most 32 base64url characters.
   */
  topic?: string;
  /** Injected for tests. */
  now?: number;
  fetchImpl?: typeof fetch;
  /** Request-scoped logger; falls back to the process logger. */
  logger?: Logger;
  /**
   * Extra correlation fields for the log line — ids only, e.g.
   * `{ subscriptionId, householdId }`. Scrubbed by the logger like any other
   * fields, but do not put content here.
   */
  logFields?: Record<string, unknown>;
  /** Abort and treat as retryable after this many ms. */
  timeoutMs?: number;
};

const DEFAULT_TTL_SECONDS = 60 * 60;
const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * `Retry-After` is either delta-seconds or an HTTP-date (RFC 9110 §10.2.3).
 * Push services send both in the wild. Returns null for anything unparseable
 * rather than guessing — a caller's own backoff is a better default than a
 * misread header.
 */
export function parseRetryAfter(header: string | null, nowMs: number): number | null {
  if (!header) return null;
  const trimmed = header.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return null;
  return Math.max(0, Math.round((date - nowMs) / 1000));
}

/**
 * The status → outcome table, extracted so it can be tested directly against
 * every status a push service is documented to return.
 */
export function classifyStatus(status: number): "sent" | "gone" | "retryable" | "failed" {
  if (status >= 200 && status < 300) return "sent";
  // 404: the endpoint was never valid or has been reaped. 410 Gone: the
  // subscription was explicitly unsubscribed. Both mean delete the row.
  if (status === 404 || status === 410) return "gone";
  // 429 is the documented rate-limit signal; 408 is a server-side timeout of
  // our own request; anything 5xx is the push service having a bad day.
  if (status === 429 || status === 408 || status >= 500) return "retryable";
  return "failed";
}

/**
 * Response bodies are read for diagnostics but capped hard: some services
 * echo request details, and an unbounded body from a misbehaving host has no
 * business in memory or in a caller's log line.
 */
const MAX_REASON_BYTES = 200;

async function readReason(response: Response): Promise<string> {
  try {
    const text = await response.text();
    return text.slice(0, MAX_REASON_BYTES);
  } catch {
    /* c8 ignore next -- a body that cannot be read is not worth a failure. */
    return "";
  }
}

function assertTopic(topic: string): void {
  if (topic.length > 32 || !/^[A-Za-z0-9\-_]+$/.test(topic)) {
    throw new PushError(
      "invalid_payload",
      "push topic must be 1-32 base64url characters (RFC 8030 §5.4)",
    );
  }
}

/**
 * Send one notification. Never throws.
 */
export async function sendPush(options: SendPushOptions): Promise<PushResult> {
  const logger = options.logger ?? log;
  const nowMs = options.now ?? Date.now();
  const doFetch = options.fetchImpl ?? fetch;

  // Host only, never the path — the path is the capability. Computed early
  // and defensively so the log line survives a malformed endpoint.
  let endpointHost = "unparseable";
  try {
    endpointHost = new URL(options.subscription.endpoint).host;
  } catch {
    return { outcome: "invalid", code: "invalid_subscription", reason: "endpoint is not a valid URL" };
  }

  let body: Uint8Array<ArrayBuffer>;
  let authorization: string;
  try {
    const plaintext =
      typeof options.payload === "string"
        ? options.payload
        : buildNotificationJson(options.payload);
    if (options.topic !== undefined) assertTopic(options.topic);

    body = await encryptPushPayload(plaintext, options.subscription.keys);
    authorization = await createVapidAuthorization(options.subscription.endpoint, options.vapid, {
      nowMs,
    });
  } catch (error) {
    if (error instanceof PushError) {
      // .message is written to be log-safe: no key material, no plaintext.
      logger.warn("push_refused", { endpointHost, code: error.code, reason: error.message });
      return { outcome: "invalid", code: error.code, reason: error.message };
    }
    /* c8 ignore start -- a non-PushError here is a bug in this module; it must
       still not take a sweep down with it. */
    const reason = error instanceof Error ? error.name : "unknown error";
    logger.error("push_prepare_failed", { endpointHost, reason });
    return { outcome: "failed", status: null, reason: `could not prepare push: ${reason}` };
    /* c8 ignore stop */
  }

  const headers: Record<string, string> = {
    Authorization: authorization,
    "Content-Encoding": "aes128gcm",
    "Content-Type": "application/octet-stream",
    TTL: String(options.ttlSeconds ?? DEFAULT_TTL_SECONDS),
  };
  if (options.urgency) headers.Urgency = options.urgency;
  if (options.topic) headers.Topic = options.topic;

  let response: Response;
  try {
    response = await doFetch(options.subscription.endpoint, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
  } catch (error) {
    // DNS failure, TLS failure, timeout: no HTTP answer at all. Always worth
    // another attempt later; never a reason to prune a subscription.
    const reason = error instanceof Error ? `${error.name}: ${error.message}` : "network error";
    logger.warn("push_send_failed", { endpointHost, ...options.logFields, reason });
    return { outcome: "retryable", status: null, retryAfterSeconds: null, reason };
  }

  const status = response.status;
  const classification = classifyStatus(status);
  const bytes = body.length;

  if (classification === "sent") {
    // Note what is NOT here: no endpoint, no payload, no title.
    logger.info("push_sent", { endpointHost, status, bytes, ...options.logFields });
    return { outcome: "sent", status };
  }

  const reason = await readReason(response);

  if (classification === "gone") {
    logger.info("push_subscription_gone", { endpointHost, status, ...options.logFields });
    return { outcome: "gone", status };
  }

  if (classification === "retryable") {
    const retryAfterSeconds = parseRetryAfter(response.headers.get("Retry-After"), nowMs);
    logger.warn("push_retryable", { endpointHost, status, retryAfterSeconds, ...options.logFields });
    return { outcome: "retryable", status, retryAfterSeconds, reason };
  }

  // A permanent 4xx. Usually a VAPID mismatch (403), a malformed request
  // (400), or a payload the service considers too large (413) — all of which
  // are our bug, not the subscription's, so the row is left alone. The
  // response text is deliberately kept out of the log line: some services
  // echo the endpoint back in it.
  logger.error("push_rejected", { endpointHost, status, ...options.logFields });
  return { outcome: "failed", status, reason };
}
