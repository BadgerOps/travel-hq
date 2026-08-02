/**
 * What a push notification is allowed to say. Issue #61.
 *
 * ── THE RULE ──────────────────────────────────────────────────────────────
 * A push payload MUST NOT contain a confirmation number, a document number
 * (passport, KTN, redress), a person's date of birth, or any other value the
 * app masks in its own UI. Titles, times, and places only.
 *
 * This is not squeamishness. An encrypted push is stored, however briefly, on
 * a third-party push service (Google, Apple, Mozilla) that we have no
 * relationship with, and it is rendered on a LOCK SCREEN — visible to anyone
 * holding the phone, screenshotted into notification history, and read aloud
 * by car head units. It is the least private surface the product has. Issue #8
 * established that the same values are redacted from logs (see
 * src/server/logging.ts and its SENSITIVE_TOKENS list); a lock screen deserves
 * at least that much.
 *
 * ── HOW THE RULE IS ENFORCED, NOT JUST DOCUMENTED ─────────────────────────
 * 1. STRUCTURALLY. `NotificationPayload` has a closed set of fields and
 *    `buildNotificationJson` serializes ONLY those fields, by name, one at a
 *    time. It does not spread, does not `JSON.stringify` a caller's object,
 *    and does not copy unknown keys. A caller who passes
 *    `{ ...booking, title }` cannot leak `booking.confirmationNumber` through
 *    here, because the extra keys are never read. This is the guarantee that
 *    actually holds under future edits — a heuristic string scan is not.
 * 2. BY REJECTING MASKED VALUES. Everything this codebase considers secret is
 *    displayed as `••••1234` (crypto/envelope.ts `mask`). A masked string
 *    reaching a payload means someone plumbed a sensitive field in and it got
 *    as far as the UI-safe form; the plaintext form is one refactor away. So
 *    a payload containing the mask glyph is refused outright.
 * 3. BY LENGTH. Short fields leave no room for a smuggled document number in
 *    a free-text body, and keep the encrypted record inside the 4096-byte
 *    budget with room to spare.
 */

import { MASK_GLYPH } from "../crypto/envelope.js";
import { PushError } from "./bytes.js";
import { MAX_PUSH_PLAINTEXT_BYTES } from "./encrypt.js";

/**
 * The entire vocabulary of a Travel HQ push. Adding a field here is a policy
 * decision, not a refactor: read the rule at the top of this file first.
 */
export type NotificationPayload = {
  /** Lock-screen headline. e.g. "Check in for UA 231". */
  title: string;
  /** One supporting line. e.g. "Tomorrow, 6:40 AM from SEA". */
  body?: string;
  /**
   * Collapse key. Two notifications with the same tag replace each other on
   * the device rather than stacking — how a reminder that fires twice stays
   * one notification. Must be an opaque identifier, never content.
   */
  tag?: string;
  /**
   * Where a tap lands, as an app-relative path ("/trips/abc"). Absolute and
   * protocol-relative URLs are refused: a notification is a click target the
   * user cannot inspect before tapping, so it must not be able to point
   * off-origin.
   */
  path?: string;
  /** ISO 8601 instant the notification refers to (not when it was sent). */
  timestamp?: string;
};

const MAX_TITLE = 100;
const MAX_BODY = 200;
const MAX_TAG = 64;
const MAX_PATH = 256;

function assertClean(field: string, value: string, maxLength: number): void {
  if (value.length === 0) {
    throw new PushError("invalid_payload", `notification ${field} is empty`);
  }
  if (value.length > maxLength) {
    throw new PushError(
      "invalid_payload",
      `notification ${field} is ${value.length} characters; the limit is ${maxLength}`,
    );
  }
  if (value.includes(MASK_GLYPH)) {
    // See rule 2 above. The message deliberately does not echo the value.
    throw new PushError(
      "invalid_payload",
      `notification ${field} contains a masked secret; push payloads must carry no confirmation or document numbers`,
    );
  }
}

/**
 * Validate a payload and render the exact JSON the service worker will
 * receive. Throws {@link PushError} (`invalid_payload`) on anything the rule
 * above forbids.
 *
 * The output shape is deliberately the same field names as the input, so the
 * service worker's `event.data.json()` reads naturally; `undefined` fields are
 * omitted rather than serialized as null, keeping the record small.
 */
export function buildNotificationJson(payload: NotificationPayload): string {
  assertClean("title", payload.title, MAX_TITLE);

  // Built key by key. Never `{...payload}` — see rule 1.
  const out: Record<string, string> = { title: payload.title };

  if (payload.body !== undefined) {
    assertClean("body", payload.body, MAX_BODY);
    out.body = payload.body;
  }
  if (payload.tag !== undefined) {
    assertClean("tag", payload.tag, MAX_TAG);
    out.tag = payload.tag;
  }
  if (payload.path !== undefined) {
    assertClean("path", payload.path, MAX_PATH);
    if (!payload.path.startsWith("/") || payload.path.startsWith("//")) {
      throw new PushError(
        "invalid_payload",
        "notification path must be an app-relative path beginning with a single /",
      );
    }
    out.path = payload.path;
  }
  if (payload.timestamp !== undefined) {
    assertClean("timestamp", payload.timestamp, 40);
    if (Number.isNaN(Date.parse(payload.timestamp))) {
      throw new PushError("invalid_payload", "notification timestamp is not a valid ISO 8601 instant");
    }
    out.timestamp = payload.timestamp;
  }

  const json = JSON.stringify(out);
  // Checked here as well as in encryptPushPayload so a caller building a
  // payload gets a payload-shaped error, naming the field budget, instead of
  // a crypto-shaped one.
  const byteLength = new TextEncoder().encode(json).length;
  if (byteLength > MAX_PUSH_PLAINTEXT_BYTES) {
    throw new PushError(
      "invalid_payload",
      `notification payload is ${byteLength} bytes; the limit is ${MAX_PUSH_PLAINTEXT_BYTES}`,
    );
  }
  return json;
}
