/**
 * What a single-booking reminder says. Issue #61.
 *
 * ── THE ONE THING THIS FILE IS NOT ALLOWED TO DO ──────────────────────────
 * Decide WHEN. That decision is `reminderSendAt` in repos/notification.ts and
 * it is pure arithmetic on the stored instant — `starts_at − lead_minutes` —
 * with no device zone and no comparison against anybody's local clock. This
 * file only turns an already-due `DueReminder` into words, and the booking's
 * `starts_at_tz` reaches only those words. See tests/server/notifications/
 * reminders.test.ts, which pins a booking whose zone differs from the
 * recipient's on both counts at once.
 *
 * ── AND WHAT IT MUST NOT SAY ──────────────────────────────────────────────
 * `DueReminder` deliberately carries no confirmation or document numbers, so
 * there is nothing here to leak even by accident; the payload is then built
 * through `buildNotificationJson`, which serializes a closed set of fields by
 * name. Both halves of that are load-bearing — see the rule at the top of
 * src/server/push/payload.ts.
 */

import type { DueReminder } from "../repos/notification.js";
import type { NotificationPayload } from "../push/index.js";
import {
  clip,
  dayPath,
  eventLocalDate,
  formatEventTime,
  formatLead,
  verbForKind,
} from "./format.js";

/** Payload field budgets, mirrored from push/payload.ts so `clip` can fit them. */
const MAX_TITLE = 100;
const MAX_BODY = 200;

/**
 * The collapse key. Keyed on the BOOKING and not on the occurrence, on
 * purpose: when a flight moves, the reminder for the new departure should
 * REPLACE the card describing the old one on the device rather than sit next
 * to it. That is safe only because it is not what prevents a double send —
 * `notification_log`'s claim is, and its key does include the instant, which
 * is why a moved flight correctly notifies again at all.
 *
 * Kept short because the tag budget is 64 characters and an id is 36 of them.
 */
export function reminderTag(bookingId: string): string {
  return `r:${bookingId}`;
}

/**
 * The lock-screen line for one due reminder.
 *
 * Never throws for ordinary data: an unformattable time degrades to a shorter
 * body, and an over-long title is clipped rather than rejected. A notification
 * that says slightly less is worth having; one that fails validation is not.
 */
export function reminderPayload(due: DueReminder): NotificationPayload {
  const when = formatEventTime(due.startsAt, due.startsAtTz);
  const parts = [formatLead(due.leadMinutes)];
  if (when !== "") parts.push(`${verbForKind(due.kind)} ${when}`);
  if (due.location !== null && due.location.trim() !== "") parts.push(due.location.trim());

  const day = eventLocalDate(due.startsAt, due.startsAtTz);
  const payload: NotificationPayload = {
    title: clip(due.title.trim() === "" ? due.tripTitle : due.title, MAX_TITLE),
    body: clip(parts.join(" · "), MAX_BODY),
    tag: reminderTag(due.bookingId),
    // Falls back to the trip rather than to nothing: a corrupt `starts_at`
    // costs the day anchor, not the tap target.
    path: day === null ? `/trips/${due.tripId}` : dayPath(due.tripId, day),
  };
  // The instant the notification is ABOUT, not the instant it was sent — which
  // is what lets a device that delivers late still render "6:40 AM". Omitted
  // rather than invented when the stored instant will not parse;
  // buildNotificationJson rejects a timestamp that is not ISO 8601.
  if (!Number.isNaN(Date.parse(due.startsAt))) payload.timestamp = due.startsAt;
  return payload;
}
