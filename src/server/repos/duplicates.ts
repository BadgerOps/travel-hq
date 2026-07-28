import { NotFoundError, ValidationError } from "./base.js";
import { BookingAwareRepo, toBooking } from "./booking.js";
import type { Booking, BookingRow, BookingStatus } from "./booking.js";
import { openConfirmation } from "./confirmation.js";
import { findDuplicates, pairKey } from "../dedupe.js";
import type { DuplicateCandidate, DuplicateGroup } from "../dedupe.js";
import { parseDetails } from "../schemas/booking-kinds.js";

/**
 * A duplicate group as the trip page receives it: the matcher's verdict plus
 * the full (masked) bookings, so the review UI can show what actually differs
 * between them without a second round-trip.
 */
export type TripDuplicateGroup = {
  reason: DuplicateGroup["reason"];
  confidence: DuplicateGroup["confidence"];
  bookings: Booking[];
  /**
   * Which booking to keep, unless the human picks otherwise: the most complete
   * one. Merging fills the keeper's blanks from the others, so this only
   * decides which id survives and which title wins — but starting from the
   * fullest row means the common case needs no thought at all.
   */
  suggestedKeepId: string;
};

/** Status precedence when a merge collapses rows that disagree. */
const STATUS_RANK: Record<BookingStatus, number> = {
  cancelled: 0,
  draft: 1,
  planned: 2,
  booked: 3,
};

/**
 * Finds and resolves bookings in one trip that describe the same real event.
 *
 * The matching rules are in ../dedupe.ts and are pure; everything here is the
 * part that needs the database: household scoping, decrypting confirmation
 * numbers (the strongest signal in both directions, and unreadable in SQL),
 * and applying a merge atomically.
 */
export class DuplicateRepo extends BookingAwareRepo {
  async forTrip(tripId: string): Promise<TripDuplicateGroup[]> {
    const rows = await this.tripBookings(tripId);
    if (rows.length < 2) return [];

    const candidates: DuplicateCandidate[] = await Promise.all(
      rows.map(async (row) => ({
        id: row.id,
        kind: row.kind,
        title: row.title,
        location: row.location,
        startsAt: row.starts_at,
        // Decrypted for the comparison only. It is never put on a response:
        // the Bookings below carry the same masked value every other endpoint
        // returns, and unmasking stays behind the audited reveal route.
        confirmation: await openConfirmation(this.ring, row.confirmation_number),
      })),
    );

    const groups = findDuplicates(candidates, await this.dismissedPairs());
    if (groups.length === 0) return [];

    const peopleByBooking = await this.personIdsByBooking(rows.map((row) => row.id));
    const byId = new Map(rows.map((row) => [row.id, row]));

    const resolved: TripDuplicateGroup[] = [];
    for (const group of groups) {
      const bookings = await Promise.all(
        group.bookingIds.map((id) => {
          const row = byId.get(id)!;
          return toBooking(this.ring, row, peopleByBooking.get(id) ?? []);
        }),
      );
      resolved.push({
        reason: group.reason,
        confidence: group.confidence,
        bookings,
        suggestedKeepId: mostComplete(bookings).id,
      });
    }
    return resolved;
  }

  /**
   * Collapses `mergeIds` into `keepId` and deletes them.
   *
   * Fill-the-blanks, never overwrite: a field the keeper already has wins,
   * and a field it lacks is taken from the first merged booking that has one.
   * That is the only rule under which merging cannot lose information the two
   * rows disagreed about — the alternative, letting the "newer" row win field
   * by field, silently discards a confirmation number or a cost the older
   * import got right. Timestamps and their zones move as pairs (a time without
   * its IANA zone renders every cross-timezone itinerary wrong), as do points
   * and their program.
   *
   * Travelers are unioned rather than replaced, the strongest status wins
   * (having booked one of two duplicate rows means the event is booked), and
   * any import draft that produced a merged booking is re-pointed at the
   * survivor so email provenance is not orphaned.
   */
  async merge(tripId: string, keepId: string, mergeIds: string[]): Promise<Booking> {
    this.requireWrite();

    const targets = [...new Set(mergeIds)].filter((id) => id !== keepId);
    if (targets.length === 0) {
      throw new ValidationError("Choose at least one other booking to merge in");
    }

    const rows = await this.tripBookings(tripId);
    const byId = new Map(rows.map((row) => [row.id, row]));
    const keeper = byId.get(keepId);
    if (!keeper) throw new NotFoundError("Booking not found in this trip");
    const merged = targets.map((id) => {
      const row = byId.get(id);
      if (!row) throw new NotFoundError("Booking not found in this trip");
      if (row.kind !== keeper.kind) {
        // Details are validated per kind, so a cross-kind merge would have to
        // either drop the details or write a shape parseDetails() rejects.
        // Neither is a merge; it is two different events the human should
        // handle by hand.
        throw new ValidationError("Only bookings of the same kind can be merged");
      }
      return row;
    });

    const patch = mergePatch(keeper, merged);
    const householdId = this.ctx.householdId;
    const placeholders = targets.map(() => "?").join(", ");

    const statements: { sql: string; params: unknown[] }[] = [
      {
        sql: `UPDATE booking
                 SET location = ?, starts_at = ?, starts_at_tz = ?,
                     ends_at = ?, ends_at_tz = ?, confirmation_number = ?,
                     cost_cents = ?, points_used = ?, points_program = ?,
                     source_inbound_email_id = ?, status = ?, details = ?
               WHERE id = ? AND household_id = ? AND trip_id = ?`,
        params: [
          patch.location,
          patch.startsAt,
          patch.startsAtTz,
          patch.endsAt,
          patch.endsAtTz,
          patch.confirmationNumber,
          patch.costCents,
          patch.pointsUsed,
          patch.pointsProgram,
          patch.sourceInboundEmailId,
          patch.status,
          patch.details,
          keepId,
          householdId,
          tripId,
        ],
      },
      // The travelers of every merged booking become travelers of the
      // survivor. Dropping them instead would quietly remove people from the
      // day view, which is the one thing this whole feature exists to keep
      // honest.
      {
        sql: `INSERT OR IGNORE INTO booking_person (booking_id, person_id)
              SELECT ?, person_id FROM booking_person
               WHERE booking_id IN (${placeholders})`,
        params: [keepId, ...targets],
      },
      // draft_booking.booking_id is ON DELETE SET NULL, so without this the
      // accepted draft that created a merged booking would keep its
      // `accepted` status pointing at nothing, and the source email behind the
      // surviving booking would be unrecoverable from that side.
      {
        sql: `UPDATE draft_booking
                 SET booking_id = ?
               WHERE household_id = ? AND booking_id IN (${placeholders})`,
        params: [keepId, householdId, ...targets],
      },
      {
        sql: `DELETE FROM booking
               WHERE household_id = ? AND trip_id = ? AND id IN (${placeholders})`,
        params: [householdId, tripId, ...targets],
      },
    ];

    await this.unscopedBatchRun(
      "atomic duplicate merge: fold prevalidated in-household bookings of one prevalidated in-household trip into one survivor; every statement re-asserts household_id",
      statements,
    );

    const result = await this.get<BookingRow>(
      "SELECT * FROM booking WHERE {scope} AND id = ?2",
      keepId,
    );
    if (!result) throw new Error("Merged booking disappeared immediately after the merge");
    return toBooking(this.ring, result, await this.personIdsFor(keepId));
  }

  /**
   * Records "these are not the same event" for every pair among `bookingIds`,
   * so the matcher stops reporting them. Idempotent: dismissing a pair twice
   * (or in the other order) is one row.
   */
  async dismiss(tripId: string, bookingIds: string[]): Promise<void> {
    this.requireWrite();
    const unique = [...new Set(bookingIds)];
    if (unique.length < 2) {
      throw new ValidationError("Dismissing a duplicate needs at least two bookings");
    }

    const rows = await this.tripBookings(tripId);
    const known = new Set(rows.map((row) => row.id));
    for (const id of unique) {
      if (!known.has(id)) throw new NotFoundError("Booking not found in this trip");
    }

    const now = new Date().toISOString();
    const statements: { sql: string; params: unknown[] }[] = [];
    for (let i = 0; i < unique.length; i++) {
      for (let j = i + 1; j < unique.length; j++) {
        const [lo, hi] = [unique[i]!, unique[j]!].sort();
        statements.push({
          sql: `INSERT OR IGNORE INTO booking_duplicate_dismissal
                  (household_id, booking_id_lo, booking_id_hi, dismissed_at)
                VALUES (?, ?, ?, ?)`,
          params: [this.ctx.householdId, lo, hi, now],
        });
      }
    }
    await this.unscopedBatchRun(
      "duplicate dismissal: one row per pair of prevalidated in-household bookings; household_id is bound from the context, never the caller",
      statements,
    );
  }

  /**
   * The trip's live bookings. Cancelled rows are excluded for the same reason
   * BookingRepo.listByTrip excludes them — they are not part of the trip, and
   * pairing a cancelled row with its replacement would report a duplicate on
   * every trip where a booking was rebooked.
   */
  private async tripBookings(tripId: string): Promise<BookingRow[]> {
    const trip = await this.get<{ id: string }>(
      "SELECT id FROM trip WHERE {scope} AND id = ?2",
      tripId,
    );
    if (!trip) throw new NotFoundError("Trip not found in this household");

    return this.all<BookingRow>(
      `SELECT * FROM booking
        WHERE {scope} AND trip_id = ?2
          AND status != 'cancelled'
        ORDER BY starts_at IS NULL, starts_at, id`,
      tripId,
    );
  }

  private async dismissedPairs(): Promise<Set<string>> {
    const rows = await this.all<{ booking_id_lo: string; booking_id_hi: string }>(
      "SELECT booking_id_lo, booking_id_hi FROM booking_duplicate_dismissal WHERE {scope}",
    );
    return new Set(rows.map((row) => pairKey(row.booking_id_lo, row.booking_id_hi)));
  }
}

type MergePatch = {
  location: string | null;
  startsAt: string | null;
  startsAtTz: string | null;
  endsAt: string | null;
  endsAtTz: string | null;
  confirmationNumber: string | null;
  costCents: number | null;
  pointsUsed: number | null;
  pointsProgram: string | null;
  sourceInboundEmailId: string | null;
  status: BookingStatus;
  details: string;
};

/**
 * The survivor's post-merge column values. Every scalar is "the keeper's, or
 * the first merged row that has one" — see merge()'s doc comment for why
 * fill-the-blanks is the only lossless rule here.
 */
function mergePatch(keeper: BookingRow, merged: BookingRow[]): MergePatch {
  const ordered = [keeper, ...merged];
  const firstOf = <K extends keyof BookingRow>(column: K): BookingRow[K] | null =>
    ordered.find((row) => row[column] !== null && row[column] !== "")?.[column] ?? null;

  // A timestamp and its IANA zone are one value in two columns: taking the
  // start from one row and its zone from another would produce a time that
  // renders in the wrong place. Take the pair from the first row that has both.
  const start = ordered.find((row) => row.starts_at !== null && row.starts_at_tz !== null);
  const end = ordered.find((row) => row.ends_at !== null && row.ends_at_tz !== null);

  const points = ordered.find((row) => row.points_used !== null);

  return {
    location: firstOf("location"),
    startsAt: start?.starts_at ?? null,
    startsAtTz: start?.starts_at_tz ?? null,
    endsAt: end?.ends_at ?? null,
    endsAtTz: end?.ends_at_tz ?? null,
    // Copied as the stored envelope, not re-encrypted: the plaintext is never
    // needed to move a confirmation number from one row to another.
    confirmationNumber: firstOf("confirmation_number"),
    costCents: ordered.find((row) => row.cost_cents !== null)?.cost_cents ?? null,
    pointsUsed: points?.points_used ?? null,
    pointsProgram: points?.points_program ?? null,
    sourceInboundEmailId: firstOf("source_inbound_email_id"),
    status: ordered.reduce(
      (best, row) => (STATUS_RANK[row.status] > STATUS_RANK[best] ? row.status : best),
      keeper.status,
    ),
    details: JSON.stringify(mergeDetails(keeper, merged)),
  };
}

/**
 * Per-kind details, filled in the same direction as the columns: a key the
 * keeper is missing (or has empty) is taken from a merged row. Re-validated
 * through parseDetails so a merge can never write a shape the kind's schema
 * rejects — if the fill produces something invalid, the keeper's own details
 * stand.
 */
function mergeDetails(keeper: BookingRow, merged: BookingRow[]): unknown {
  const own = safeParseJson(keeper.details);
  if (!isRecord(own)) return own;

  const filled: Record<string, unknown> = { ...own };
  for (const row of merged) {
    const other = safeParseJson(row.details);
    if (!isRecord(other)) continue;
    for (const [key, value] of Object.entries(other)) {
      const current = filled[key];
      if (current === undefined || current === null || current === "") {
        filled[key] = value;
      }
    }
  }

  try {
    return parseDetails(keeper.kind, filled);
  } catch {
    return own;
  }
}

/**
 * The group's default keeper: the row carrying the most information, so the
 * merge has the least left to fill in. Ties break on status (a booked row is
 * the one someone has actually acted on) and then on id, so the suggestion is
 * stable across reloads rather than depending on row order.
 */
function mostComplete(bookings: Booking[]): Booking {
  const score = (b: Booking): number =>
    [
      b.location,
      b.startsAt,
      b.endsAt,
      b.confirmationNumberMasked,
      b.costCents,
      b.pointsUsed,
    ].filter((value) => value !== null && value !== "").length + b.personIds.length;

  return [...bookings].sort((a, b) => {
    const byScore = score(b) - score(a);
    if (byScore !== 0) return byScore;
    const byStatus = STATUS_RANK[b.status] - STATUS_RANK[a.status];
    if (byStatus !== 0) return byStatus;
    return a.id < b.id ? -1 : 1;
  })[0]!;
}

function safeParseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
