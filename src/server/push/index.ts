/**
 * Web Push delivery (issue #61). The public face of src/server/push/.
 *
 * Import from here, not from the individual modules — the split between
 * bytes/encrypt/vapid/payload/send is an implementation detail and the file
 * boundaries may move.
 *
 * Typical use from a scheduled sweep:
 *
 *   const result = await sendPush({
 *     subscription: { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } },
 *     payload: { title: "Check in for UA 231", body: "Tomorrow, 6:40 AM", path: "/trips/abc" },
 *     vapid: { publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY,
 *              subject: env.VAPID_SUBJECT },
 *     logger,
 *     logFields: { subscriptionId: row.id },
 *   });
 *   if (result.outcome === "gone") await subscriptions.delete(row.id);
 *
 * `sendPush` never throws. Read the `outcome` union in send.ts before writing
 * the sweep, and read the payload policy in payload.ts before writing a
 * notification: no confirmation numbers, no document numbers, ever.
 */

export { PushError } from "./bytes.js";
export type { PushErrorCode } from "./bytes.js";

export {
  encryptPushPayload,
  MAX_PUSH_BODY_BYTES,
  MAX_PUSH_PLAINTEXT_BYTES,
} from "./encrypt.js";
export type { SubscriptionKeys, EncryptPushPayloadOptions } from "./encrypt.js";

export {
  createVapidAuthorization,
  generateVapidKeys,
  importVapidPrivateKey,
  vapidAudience,
  verifyVapidKeys,
  MAX_VAPID_EXPIRY_SECONDS,
} from "./vapid.js";
export type { VapidConfig, VapidKeys, VapidHeaderOptions } from "./vapid.js";

export { buildNotificationJson } from "./payload.js";
export type { NotificationPayload } from "./payload.js";

export { classifyStatus, parseRetryAfter, sendPush } from "./send.js";
export type { PushResult, PushUrgency, SendPushOptions, WebPushSubscription } from "./send.js";
