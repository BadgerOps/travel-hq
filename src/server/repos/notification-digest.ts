/**
 * What one person's day actually contains — the read side of the morning
 * digest (#61).
 *
 * ── WHY THIS IS A SECOND FILE AND NOT MORE OF notification.ts ─────────────
 * It belongs to the same cron seam documented there ("everything below is
 * static and takes a D1Database directly"), obeys the same rules, and would
 * read perfectly well at the bottom of that file. It is separate only because
 * notification.ts and the sweep were written concurrently by two authors, and
 * a new file is the one edit that cannot conflict. If the two are ever
 * consolidated, this is the half that moves.
 *
 * ── THE SAFETY ARGUMENT, RESTATED BECAUSE IT MUST BE ──────────────────────
 * These queries are unscoped by necessity: a cron has no household to bind,
 * and synthesising one per household would mean first listing every household
 * — a cross-tenant read by another name. What keeps them safe is that they
 * never accept a household, a trip or a booking from a caller. They take a
 * USER and two instants, and every row they return is one the SQL itself has
 * proved that user may see:
 *
 *   REACHABILITY — the account must still be a member of the booking's
 *   household or of its trip. Not "was, when the subscription was written":
 *   #61's criterion is about the moment of sending, and membership can be
 *   revoked in between. This is the re-check.
 *
 *   SUBSCRIPTION — the same precedence `resolveSubscription()` applies, and
 *   the same one findDueReminders' CASE expression applies: an explicit
 *   decision on the booking beats one on the trip, which beats the implicit
 *   default of "you are travelling on it".
 *
 * Neither query selects an encrypted column. A digest is titles and times;
 * there is deliberately nowhere in the returned shapes to put a confirmation
 * number, so the payload policy in push/payload.ts has nothing to catch.
 */

import type { DigestChecklistItem, DigestEntry } from "../notifications/digest.js";

/** `user.timezone` and how long ago it was last confirmed. */
export type DigestUserContext = {
  timezone: string | null;
  timezoneUpdatedAt: string | null;
};

type EntryRow = {
  booking_id: string;
  trip_id: string;
  trip_title: string;
  kind: string;
  title: string;
  location: string | null;
  starts_at: string;
  starts_at_tz: string | null;
};

type ChecklistRow = {
  id: string;
  trip_id: string;
  label: string;
  due_on: string;
};

export class NotificationDigestRepo {
  /**
   * The stored zone and its age. Two columns rather than one because the age
   * is what lets the digest tell a fresh answer from a stale one — see
   * `chooseDigestTimezone`.
   */
  static async userContext(db: D1Database, userId: string): Promise<DigestUserContext | undefined> {
    const row = await db
      .prepare("SELECT timezone, timezone_updated_at FROM user WHERE id = ?1")
      .bind(userId)
      .first<{ timezone: string | null; timezone_updated_at: string | null }>();
    if (row === null) return undefined;
    return { timezone: row.timezone, timezoneUpdatedAt: row.timezone_updated_at };
  }

  /**
   * Every booking starting in `[from, to)` that this user may see and has not
   * muted.
   *
   * A RANGE OF INSTANTS, not a local date, and the grouping into days happens
   * afterwards in TypeScript. That is not laziness: which day an event belongs
   * to depends on the event's own zone (`localDateOf`), which SQLite cannot
   * evaluate, and which day is "today" depends on a zone the digest has not
   * finished choosing yet — the fallback to the first event's zone is decided
   * from these very rows. Fetching by instant and grouping after is the only
   * order in which those two questions can both be answered.
   *
   * Callers therefore ask for a window wide enough to cover the local day plus
   * the following morning; `runNotificationSweep` uses −24h/+48h around the
   * send instant.
   */
  static async findEntries(
    db: D1Database,
    userId: string,
    from: Date,
    to: Date,
  ): Promise<DigestEntry[]> {
    const { results } = await db
      .prepare(
        `SELECT b.id            AS booking_id,
                b.trip_id       AS trip_id,
                t.title         AS trip_title,
                b.kind          AS kind,
                b.title         AS title,
                b.location      AS location,
                b.starts_at     AS starts_at,
                b.starts_at_tz  AS starts_at_tz
           FROM booking b
           JOIN trip t ON t.id = b.trip_id
           LEFT JOIN notification_subscription bsub
                  ON bsub.user_id = ?1 AND bsub.booking_id = b.id
           LEFT JOIN notification_subscription tsub
                  ON tsub.user_id = ?1 AND tsub.trip_id = b.trip_id
          WHERE b.starts_at IS NOT NULL
            AND b.status != 'cancelled'
            AND b.starts_at >= ?2
            AND b.starts_at < ?3
            AND (CASE
                   WHEN bsub.subscribed IS NOT NULL THEN bsub.subscribed
                   WHEN tsub.subscribed IS NOT NULL THEN tsub.subscribed
                   ELSE (SELECT COUNT(*)
                           FROM booking_person bp
                           JOIN person p ON p.id = bp.person_id
                          WHERE bp.booking_id = b.id AND p.user_id = ?1)
                 END) > 0
            AND (
                  EXISTS (SELECT 1 FROM household_member hm
                           WHERE hm.user_id = ?1 AND hm.household_id = b.household_id)
               OR EXISTS (SELECT 1 FROM trip_member tm
                           WHERE tm.user_id = ?1 AND tm.trip_id = b.trip_id)
                )
          ORDER BY b.starts_at, b.id`,
      )
      .bind(userId, from.toISOString(), to.toISOString())
      .all<EntryRow>();

    return results.map((row) => ({
      bookingId: row.booking_id,
      tripId: row.trip_id,
      tripTitle: row.trip_title,
      kind: row.kind,
      title: row.title,
      location: row.location,
      startsAt: row.starts_at,
      startsAtTz: row.starts_at_tz,
    }));
  }

  /**
   * Open checklist items due on or before `dueOnOrBefore`, on the given trips.
   *
   * ON OR BEFORE, not on: an item that was due yesterday and is still open is
   * more worth mentioning this morning than one due today, and a digest that
   * only ever names today's would let a missed task go quiet forever.
   *
   * Family-wide items (`person_id IS NULL`) count for everyone; an assigned
   * item counts only for the person it is assigned to. The trip ids come from
   * `findEntries`, which has already proved the user may see them — the
   * membership predicate is repeated here anyway, so this query is safe read
   * on its own terms rather than safe by virtue of its caller.
   */
  static async findChecklistItems(
    db: D1Database,
    userId: string,
    tripIds: readonly string[],
    dueOnOrBefore: string,
  ): Promise<DigestChecklistItem[]> {
    const unique = [...new Set(tripIds)].filter((id) => typeof id === "string" && id !== "");
    if (unique.length === 0) return [];
    // ?1 user, ?2 date, ?3.. the trip ids.
    const placeholders = unique.map((_, index) => `?${index + 3}`).join(",");

    const { results } = await db
      .prepare(
        `SELECT ci.id      AS id,
                ci.trip_id AS trip_id,
                ci.label   AS label,
                ci.due_on  AS due_on
           FROM checklist_item ci
          WHERE ci.done_at IS NULL
            AND ci.due_on IS NOT NULL
            AND ci.due_on <= ?2
            AND ci.trip_id IN (${placeholders})
            AND (
                  ci.person_id IS NULL
               OR EXISTS (SELECT 1 FROM person p
                           WHERE p.id = ci.person_id AND p.user_id = ?1)
                )
            AND (
                  EXISTS (SELECT 1 FROM household_member hm
                           WHERE hm.user_id = ?1 AND hm.household_id = ci.household_id)
               OR EXISTS (SELECT 1 FROM trip_member tm
                           WHERE tm.user_id = ?1 AND tm.trip_id = ci.trip_id)
                )
          ORDER BY ci.due_on, ci.id`,
      )
      .bind(userId, dueOnOrBefore, ...unique)
      .all<ChecklistRow>();

    return results.map((row) => ({
      id: row.id,
      tripId: row.trip_id,
      label: row.label,
      dueOn: row.due_on,
    }));
  }
}
