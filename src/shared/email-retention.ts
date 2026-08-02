import type { InboundEmailStatus } from "../server/repos/inbound-email.js";

/**
 * How long Travel HQ keeps the raw RFC 5322 text of a forwarded message.
 *
 * Raw mail is kept at all for exactly one reason: extraction is fallible. A
 * model that returned nothing useful has to be retried against the original
 * message, and "the hotel booking it imported has the wrong date" is
 * unanswerable without the message it came from. Nothing else in the product
 * reads raw — the drafts, the bookings and the activity feed are all derived
 * data that survive the purge — so the windows are sized to that one reason
 * and to nothing else:
 *
 * - RAW_RETENTION_EXTRACTED_DAYS — extraction already produced drafts. The
 *   owner still needs to read the message while reviewing those drafts, and
 *   for a little while after accepting them (the booking dialog's "source
 *   email" view reads raw). A week covers "I'll deal with this next weekend"
 *   without turning D1 into a second mailbox.
 * - RAW_RETENTION_UNRESOLVED_DAYS — extraction failed, or never ran, or the
 *   message was rejected. This is the debugging window, and it is longer
 *   because the loop is human: someone has to notice the failure, report it,
 *   and have it reproduced. It is also the OUTER bound on any raw message
 *   whatever its status — after this many days nothing readable is left.
 *
 * Both are counted from `received_at` rather than from the moment the row
 * reached its status. That is the timestamp the row actually has (there is no
 * `extracted_at`), and it is the one the owner is shown in Settings, so
 * measuring from anything else would make the promise unverifiable.
 *
 * These live in src/shared/ because both sides need the same numbers:
 * InboundEmailRepo enforces them and Settings explains them. Importing them
 * from src/server/repos/ would drag the whole tenancy layer into the browser
 * bundle; duplicating them is how the UI ends up promising 7 days while the
 * sweep quietly keeps 90.
 */
export const RAW_RETENTION_EXTRACTED_DAYS = 7;
export const RAW_RETENTION_UNRESOLVED_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

/** The window that applies to a row in this status, in whole days. */
export function rawRetentionDays(status: InboundEmailStatus): number {
  return status === "extracted" ? RAW_RETENTION_EXTRACTED_DAYS : RAW_RETENTION_UNRESOLVED_DAYS;
}

/**
 * The ISO instant at which this row's raw becomes eligible for the sweep —
 * what the detail view shows as "kept until". Returns null for an
 * unparseable received_at rather than an Invalid Date string, so a corrupt
 * timestamp reads as "unknown" instead of as a date in 1970.
 */
export function rawRetentionExpiresAt(
  status: InboundEmailStatus,
  receivedAt: string,
): string | null {
  const received = Date.parse(receivedAt);
  if (Number.isNaN(received)) return null;
  return new Date(received + rawRetentionDays(status) * DAY_MS).toISOString();
}

/**
 * The two `received_at` cutoffs the sweep compares against: a row is eligible
 * when it arrived at or before the cutoff for its status. Returned as ISO
 * strings because that is how received_at is stored, and ISO-8601 UTC with
 * milliseconds sorts identically as text and as time.
 */
export function rawRetentionCutoffs(now: Date): { extracted: string; unresolved: string } {
  return {
    extracted: new Date(now.getTime() - RAW_RETENTION_EXTRACTED_DAYS * DAY_MS).toISOString(),
    unresolved: new Date(now.getTime() - RAW_RETENTION_UNRESOLVED_DAYS * DAY_MS).toISOString(),
  };
}
