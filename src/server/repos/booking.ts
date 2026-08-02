import { TenantRepo, NotFoundError, ValidationError } from "./base.js";
import type { HouseholdContext } from "./base.js";
import { Keyring, mask, assertNotMasked } from "../crypto/envelope.js";
import { openConfirmation } from "./confirmation.js";
import { newId } from "../ids.js";
import { BOOKING_KINDS, parseDetails } from "../schemas/booking-kinds.js";
import { assertBookingTiming, assertNonNegativeAmount } from "./validation.js";

/**
 * Exported as a value, not only a type: the status route's Zod enum and the
 * booking dialog's segmented control both need the list at runtime, and
 * writing it out a second time is how one of them ends up accepting a status
 * the CHECK constraint on `booking.status` rejects.
 */
export const BOOKING_STATUSES = ["draft", "planned", "booked", "cancelled"] as const;

export type BookingStatus = (typeof BOOKING_STATUSES)[number];

/**
 * Kept in sync by hand with the CHECK on `booking.reminder_mode`
 * (migrations/0017_notifications.sql). THREE states, not two: `0` is a
 * legitimate lead time meaning "remind me at the start", so it cannot double
 * as "never remind me" — `off` has to be its own word. `inherit` means the
 * booking has no opinion and follows the account's default, so changing that
 * default keeps moving every booking that was never customised.
 *
 * Declared here, next to BOOKING_STATUSES, rather than in
 * repos/notification.ts (which re-exports it): it is a column of `booking`,
 * and putting it there would make booking.ts import notification.ts, which
 * imports itinerary.ts, which imports booking.ts.
 */
export const REMINDER_MODES = ["inherit", "custom", "off"] as const;

export type ReminderMode = (typeof REMINDER_MODES)[number];

/**
 * Ceiling on a custom lead time: a week. Not arbitrary — it is what bounds
 * the candidate window the reminder sweep has to scan
 * (NotificationRepo.findDueReminders), so an unbounded lead here would be an
 * unbounded query there.
 */
export const MAX_REMINDER_LEAD_MINUTES = 7 * 24 * 60;

function assertReminderMode(mode: string): ReminderMode {
  if (!(REMINDER_MODES as readonly string[]).includes(mode)) {
    throw new ValidationError(`reminderMode must be one of ${REMINDER_MODES.join(", ")}`);
  }
  return mode as ReminderMode;
}

/**
 * 0 is legal and means "at the start" — the whole reason `off` is a separate
 * mode rather than a sentinel number. Negative is not: a reminder AFTER
 * departure is a bug in the caller, not a feature.
 */
function assertReminderLeadMinutes(value: number | null): number | null {
  if (value === null) return null;
  if (!Number.isInteger(value) || value < 0 || value > MAX_REMINDER_LEAD_MINUTES) {
    throw new ValidationError(
      `reminderLeadMinutes must be a whole number of minutes from 0 to ${MAX_REMINDER_LEAD_MINUTES}`,
    );
  }
  return value;
}

export type Booking = {
  id: string;
  tripId: string;
  sourceInboundEmailId: string | null;
  kind: string;
  title: string;
  location: string | null;
  startsAt: string | null;
  startsAtTz: string | null;
  endsAt: string | null;
  endsAtTz: string | null;
  confirmationNumberMasked: string | null;
  costCents: number | null;
  pointsUsed: number | null;
  pointsProgram: string | null;
  status: BookingStatus;
  /**
   * Per-booking override of the account's reminder lead time (#61).
   *
   * Optional in the TYPE, always present in anything `toBooking` produced.
   * `Booking` is re-exported to the client (src/client/api/types.ts) and is
   * therefore also the shape an optimistic update or a test fixture builds by
   * hand, and such a caller has no opinion about reminders. Absent means
   * exactly what 'inherit' means — follow the account default — so the two
   * spellings agree rather than the type forcing a fabricated answer.
   */
  reminderMode?: ReminderMode;
  /** Minutes before `startsAt`; meaningful only when reminderMode is 'custom'. */
  reminderLeadMinutes?: number | null;
  details: unknown;
  personIds: string[];
  /** Present only in itinerary responses when a booking spans several days. */
  itineraryPosition?: "start" | "ongoing" | "end";
};

export type CreateBookingInput = {
  tripId: string;
  sourceInboundEmailId?: string | null;
  kind: string;
  title: string;
  location?: string;
  startsAt?: string;
  startsAtTz?: string;
  endsAt?: string;
  endsAtTz?: string;
  confirmationNumber?: string;
  costCents?: number;
  pointsUsed?: number;
  pointsProgram?: string;
  status?: BookingStatus;
  reminderMode?: ReminderMode;
  reminderLeadMinutes?: number | null;
  details: unknown;
};

/**
 * Every field is optional, and the nullable ones are TRI-STATE, exactly as
 * UpdateTripInput and UpdatePersonInput established:
 *
 *   absent / undefined -> leave the stored value exactly as it is
 *   null               -> clear the stored value
 *   value              -> store this new value
 *
 * `title`, `kind` and `status` are non-nullable: a booking must keep a title
 * and a kind, and "no status" is spelled `planned`, never NULL.
 *
 * `details` is NOT tri-state — it is the whole per-kind record, replaced
 * wholesale when supplied, because a deep merge would make it impossible to
 * remove a key that the extractor got wrong.
 *
 * `confirmationNumber` accepts plaintext only. A caller echoing back the
 * masked value it was shown is rejected (see assertNotMasked in create), and
 * `null` clears the stored ciphertext.
 */
export type UpdateBookingInput = {
  kind?: string;
  title?: string;
  location?: string | null;
  startsAt?: string | null;
  startsAtTz?: string | null;
  endsAt?: string | null;
  endsAtTz?: string | null;
  confirmationNumber?: string | null;
  costCents?: number | null;
  pointsUsed?: number | null;
  pointsProgram?: string | null;
  status?: BookingStatus;
  /** Non-nullable: "no reminder opinion" is spelled 'inherit', never NULL. */
  reminderMode?: ReminderMode;
  /** Tri-state as usual; null clears the custom lead back to unset. */
  reminderLeadMinutes?: number | null;
  details?: unknown;
};

/**
 * Input key -> column, for the SET clause. The column names come from this
 * fixed map and never from caller-supplied keys, so no request body can reach
 * run() with an identifier of its own choosing — the TripRepo.update pattern.
 *
 * `confirmationNumber` and `details` are deliberately absent: both need a
 * transformation (encryption, per-kind validation) before they can be bound,
 * so they are appended by hand in update().
 */
const UPDATE_COLUMNS = {
  kind: "kind",
  title: "title",
  location: "location",
  startsAt: "starts_at",
  startsAtTz: "starts_at_tz",
  endsAt: "ends_at",
  endsAtTz: "ends_at_tz",
  costCents: "cost_cents",
  pointsUsed: "points_used",
  pointsProgram: "points_program",
  status: "status",
  reminderMode: "reminder_mode",
  reminderLeadMinutes: "reminder_lead_minutes",
} as const;

/**
 * The raw shape of a `booking` row. Exported so ItineraryRepo can share it
 * rather than maintaining a byte-identical copy of its own — that
 * duplication is exactly what let a column silently vanish from the day
 * view (see `toBooking` below).
 */
export type BookingRow = {
  id: string;
  trip_id: string;
  source_inbound_email_id: string | null;
  kind: string;
  title: string;
  location: string | null;
  starts_at: string | null;
  starts_at_tz: string | null;
  ends_at: string | null;
  ends_at_tz: string | null;
  confirmation_number: string | null;
  cost_cents: number | null;
  points_used: number | null;
  points_program: string | null;
  status: BookingStatus;
  reminder_mode: ReminderMode;
  reminder_lead_minutes: number | null;
  details: string;
};

/**
 * Maps a raw `booking` row (plus its already-fetched person ids) to the
 * public `Booking` shape. This is THE mapping — BookingRepo and
 * ItineraryRepo both build `Booking`s from `booking` rows, so both call
 * this instead of each carrying their own copy of the same 15-field
 * literal, which is how a newly added column used to end up silently
 * missing from the day view but present in the booking list (or vice
 * versa) with no test failure and no type error.
 *
 * Async: unmasking a stored confirmation number decrypts through the
 * WebCrypto envelope (see `openConfirmation`), which is itself async.
 */
export async function toBooking(
  ring: Keyring,
  row: BookingRow,
  personIds: string[],
): Promise<Booking> {
  return {
    id: row.id,
    tripId: row.trip_id,
    sourceInboundEmailId: row.source_inbound_email_id,
    kind: row.kind,
    title: row.title,
    location: row.location,
    startsAt: row.starts_at,
    startsAtTz: row.starts_at_tz,
    endsAt: row.ends_at,
    endsAtTz: row.ends_at_tz,
    confirmationNumberMasked: mask(await openConfirmation(ring, row.confirmation_number)),
    costCents: row.cost_cents,
    pointsUsed: row.points_used,
    pointsProgram: row.points_program,
    status: row.status,
    // A stored mode the CHECK constraint could not have produced (a
    // hand-edited row, a future value read by an older deploy) falls back to
    // 'inherit' rather than throwing: an unreadable reminder preference must
    // degrade to the account default, never break the booking list.
    reminderMode: (REMINDER_MODES as readonly string[]).includes(row.reminder_mode)
      ? row.reminder_mode
      : "inherit",
    reminderLeadMinutes: row.reminder_lead_minutes,
    details: JSON.parse(row.details),
    personIds,
  };
}

/**
 * Shared base for repositories that read `booking` rows and need the
 * `booking_person` join table alongside them (BookingRepo itself, and
 * ItineraryRepo). Factored out so the join-table lookup — and the `ring`
 * every subclass needs to unmask a confirmation number — exist in exactly
 * one place instead of being copy-pasted per subclass.
 */
export abstract class BookingAwareRepo extends TenantRepo {
  constructor(
    db: D1Database,
    ctx: HouseholdContext,
    protected readonly ring: Keyring,
  ) {
    super(db, ctx);
  }

  /**
   * Unscoped by design: only ever called with a bookingId already proven to
   * be in this household by a scoped query in the calling subclass
   * (BookingRepo's findById/listByTrip/assignPerson, or ItineraryRepo's
   * forPerson/forTrip).
   */
  protected async personIdsFor(bookingId: string): Promise<string[]> {
    return (await this.personIdsByBooking([bookingId])).get(bookingId) ?? [];
  }

  /**
   * Fetches every booking-person edge for a scoped booking result in one
   * round-trip for normal trip sizes. Chunking stays below D1's bind-variable
   * ceiling for unusually large trips without falling back to one query per
   * booking.
   */
  protected async personIdsByBooking(
    bookingIds: string[],
  ): Promise<Map<string, string[]>> {
    const unique = [...new Set(bookingIds)];
    const byBooking = new Map(unique.map((id) => [id, [] as string[]]));
    const batchSize = 90;
    for (let offset = 0; offset < unique.length; offset += batchSize) {
      const batch = unique.slice(offset, offset + batchSize);
      const rows = await this.unscoped<{ booking_id: string; person_id: string }>(
        "read-only join lookup; every booking id comes from a household-scoped booking query",
        `SELECT booking_id, person_id
           FROM booking_person
          WHERE booking_id IN (${batch.map(() => "?").join(", ")})
          ORDER BY booking_id, person_id`,
        ...batch,
      );
      for (const row of rows) byBooking.get(row.booking_id)?.push(row.person_id);
    }
    return byBooking;
  }
}

export class BookingRepo extends BookingAwareRepo {
  async create(input: CreateBookingInput): Promise<Booking> {
    // Redundant with base.ts's own requireWrite() check inside run()/insert() —
    // kept as explicit, belt-and-braces intent at the top of every mutating
    // method, not as the sole enforcement.
    this.requireWrite();
    assertBookingTiming(input);
    // create() previously checked neither of these, while update() checked
    // that they were whole numbers — so the API accepted on POST exactly the
    // rows it refused on PUT. See assertNonNegativeAmount for why a negative
    // amount is a 400 rather than an adjustment.
    assertNonNegativeAmount("costCents", input.costCents);
    assertNonNegativeAmount("pointsUsed", input.pointsUsed);

    const trip = await this.get<{ id: string }>(
      "SELECT id FROM trip WHERE {scope} AND id = ?2",
      input.tripId,
    );
    if (!trip) throw new NotFoundError("Trip not found in this household");

    if (input.sourceInboundEmailId !== undefined && input.sourceInboundEmailId !== null) {
      const source = await this.get<{ id: string }>(
        "SELECT id FROM inbound_email WHERE {scope} AND id = ?2",
        input.sourceInboundEmailId,
      );
      if (!source) throw new NotFoundError("Source inbound email not found in this household");
    }

    if (input.confirmationNumber !== undefined && input.confirmationNumber !== null) {
      // `toBooking()` masks this column with the same `mask()` helper that
      // masks a passport number, so the identical round-trip destruction is
      // available here: a component that reconstructs a booking body from a
      // list response (Part B Task 14's DraftCard is exactly that) would
      // encrypt `••••WN88` over the real code. ValidationError (400), for the
      // same reason as PersonRepo.update.
      try {
        assertNotMasked("confirmationNumber", input.confirmationNumber);
      } catch (err) {
        throw new ValidationError(err instanceof Error ? err.message : String(err));
      }
    }

    const details = parseDetails(input.kind, input.details);
    const id = newId();
    await this.insert("booking", {
      id,
      trip_id: input.tripId,
      source_inbound_email_id: input.sourceInboundEmailId ?? null,
      kind: input.kind,
      title: input.title,
      location: input.location ?? null,
      starts_at: input.startsAt ?? null,
      starts_at_tz: input.startsAtTz ?? null,
      ends_at: input.endsAt ?? null,
      ends_at_tz: input.endsAtTz ?? null,
      confirmation_number: input.confirmationNumber
        ? await this.ring.encrypt(input.confirmationNumber)
        : null,
      cost_cents: input.costCents ?? null,
      points_used: input.pointsUsed ?? null,
      points_program: input.pointsProgram ?? null,
      status: input.status ?? "planned",
      reminder_mode: assertReminderMode(input.reminderMode ?? "inherit"),
      reminder_lead_minutes: assertReminderLeadMinutes(input.reminderLeadMinutes ?? null),
      details: JSON.stringify(details),
      created_at: new Date().toISOString(),
    });

    const created = await this.findById(id);
    if (!created) throw new Error("Booking disappeared immediately after creation");
    return created;
  }

  /**
   * Partial update — the counterpart of TripRepo.update, and the reason the
   * "there is no PATCH/DELETE booking endpoint to fix it through the API"
   * warning in routes/trips.ts no longer holds.
   *
   * The SET clause is built from the provided keys only, so an absent key
   * never touches its column and the tri-state stays honest.
   *
   * Three things need the STORED row to validate and so cannot be checked at
   * the HTTP boundary:
   *
   *  - the timestamp/zone pairing, which must hold for the EFFECTIVE
   *    post-patch pair. Clearing `startsAtTz` while a stored `startsAt`
   *    remains is exactly as broken as posting a timestamp with no zone, and
   *    is what would put an unzoned instant in front of
   *    `ItineraryRepo.localDateOf()`;
   *  - `details` against the effective `kind`, including the case where the
   *    kind changes and the details do not;
   *  - nothing else may change while those are being decided, which is why
   *    every check runs before the single UPDATE.
   */
  async update(id: string, patch: UpdateBookingInput): Promise<Booking> {
    // Redundant with base.ts's own requireWrite() check inside run() — kept as
    // explicit, belt-and-braces intent at the top of every mutating method.
    this.requireWrite();

    const existing = await this.findById(id);
    if (!existing) throw new NotFoundError("Booking not found in this household");

    // Validated here as well as in the route's Zod enum, for the same reason
    // assertTimezonePaired is: a non-HTTP caller must not be able to move a
    // booking to a kind `parseDetails` will silently treat as freeform.
    const kind = patch.kind ?? existing.kind;
    if (patch.kind !== undefined && !(BOOKING_KINDS as readonly string[]).includes(patch.kind)) {
      throw new ValidationError(`kind must be one of ${BOOKING_KINDS.join(", ")}`);
    }

    assertBookingTiming({
      startsAt: patch.startsAt === undefined ? existing.startsAt : patch.startsAt,
      startsAtTz: patch.startsAtTz === undefined ? existing.startsAtTz : patch.startsAtTz,
      endsAt: patch.endsAt === undefined ? existing.endsAt : patch.endsAt,
      endsAtTz: patch.endsAtTz === undefined ? existing.endsAtTz : patch.endsAtTz,
    });

    let details: unknown;
    if (patch.details !== undefined) {
      details = parseDetails(kind, patch.details);
    } else if (patch.kind !== undefined && patch.kind !== existing.kind) {
      // The kind moved but the details did not. A flight's details are not a
      // valid lodging's, so re-validate rather than storing a record the new
      // kind's schema would reject on the next write.
      try {
        details = parseDetails(kind, existing.details);
      } catch {
        throw new ValidationError(
          `Changing this booking to ${kind} needs details that match that kind`,
        );
      }
    }

    let confirmation: string | null | undefined;
    if (patch.confirmationNumber !== undefined) {
      if (patch.confirmationNumber === null) {
        confirmation = null;
      } else {
        // `toBooking()` hands out a masked confirmation number; an edit form
        // that PUTs back what it was shown would otherwise encrypt "••••WN88"
        // over the real code. Same guard, same 400, as create().
        try {
          assertNotMasked("confirmationNumber", patch.confirmationNumber);
        } catch (err) {
          throw new ValidationError(err instanceof Error ? err.message : String(err));
        }
        confirmation = await this.ring.encrypt(patch.confirmationNumber);
      }
    }

    const sets: string[] = [];
    const params: unknown[] = [];
    // Caller param k (1-based) binds to ?(k+1); the household id owns ?1.
    let next = 2;

    for (const [key, column] of Object.entries(UPDATE_COLUMNS)) {
      const value = patch[key as keyof typeof UPDATE_COLUMNS];
      // `undefined` is "not supplied", which is the tri-state's whole point.
      // Reaching for `key in patch` instead would treat an explicitly-passed
      // `undefined` as a request to write NULL.
      if (value === undefined) continue;
      if (key === "title" && (typeof value !== "string" || value.trim() === "")) {
        throw new ValidationError("title must be a non-empty string");
      }
      if (key === "status" && !(BOOKING_STATUSES as readonly string[]).includes(value as string)) {
        throw new ValidationError(`status must be one of ${BOOKING_STATUSES.join(", ")}`);
      }
      if (key === "costCents" || key === "pointsUsed") {
        assertNonNegativeAmount(key, value as number | null);
      }
      if (key === "reminderMode") assertReminderMode(value as string);
      if (key === "reminderLeadMinutes") {
        assertReminderLeadMinutes(value as number | null);
      }
      sets.push(`${column} = ?${next++}`);
      params.push(value ?? null);
    }

    if (details !== undefined) {
      sets.push(`details = ?${next++}`);
      params.push(JSON.stringify(details));
    }
    if (confirmation !== undefined) {
      sets.push(`confirmation_number = ?${next++}`);
      params.push(confirmation);
    }

    if (sets.length > 0) {
      // The id is the last caller param, so it takes the next index.
      await this.run(
        `UPDATE booking SET ${sets.join(", ")} WHERE {scope} AND id = ?${next}`,
        ...params,
        id,
      );
    }

    const updated = await this.findById(id);
    if (!updated) throw new Error("Booking disappeared immediately after update");
    return updated;
  }

  async findById(id: string): Promise<Booking | undefined> {
    const row = await this.get<BookingRow>("SELECT * FROM booking WHERE {scope} AND id = ?2", id);
    return row ? toBooking(this.ring, row, await this.personIdsFor(row.id)) : undefined;
  }

  /**
   * I5: existence-checks the trip itself, distinct from "trip exists but has
   * no bookings" — both used to return `200 []`, indistinguishable to a
   * caller that followed a stale or mistyped trip id.
   *
   * WARNING — asymmetric with ItineraryRepo.group() by omission: this list
   * (and RollupRepo.forTrip's SQL) has no notion of an unparseable IANA
   * zone and will happily return/count a row that ItineraryRepo.group()
   * silently skips from the day view. Unreachable today because
   * assertTimezonePaired validates every row at write time; becomes live
   * the moment a write path bypasses it (e.g. a future email-import
   * insert). See the matching WARNING on ItineraryRepo.group() and
   * docs/BACKLOG.md — do not fix this asymmetry piecemeal here, it belongs
   * with that import work.
   */
  async listByTrip(tripId: string): Promise<Booking[]> {
    const trip = await this.get<{ id: string }>("SELECT id FROM trip WHERE {scope} AND id = ?2", tripId);
    if (!trip) throw new NotFoundError("Trip not found in this household");

    const rows = await this.all<BookingRow>(
      `SELECT * FROM booking
        WHERE {scope} AND trip_id = ?2
          AND status != 'cancelled'
        ORDER BY starts_at IS NULL, starts_at`,
      tripId,
    );

    const peopleByBooking = await this.personIdsByBooking(rows.map((row) => row.id));
    const converted = await Promise.all(rows.map(async (row): Promise<Booking | null> => {
      try {
        return await toBooking(this.ring, row, peopleByBooking.get(row.id) ?? []);
      } catch (err) {
        // A single row that can't be unmasked/formatted (e.g. an envelope
        // encrypted under a key no longer in the keyring) must not take
        // down the whole list — degrade that one row and keep going. See
        // ItineraryRepo.group() for the same policy applied to the day view.
        console.error(`[BookingRepo] skipping booking ${row.id} in listByTrip: unreadable row`, err);
        return null;
      }
    }));
    return converted.filter((booking): booking is Booking => booking !== null);
  }

  async assignPerson(bookingId: string, personId: string): Promise<void> {
    // Redundant with base.ts's own requireWrite() check inside run()/insert() —
    // kept as explicit, belt-and-braces intent at the top of every mutating
    // method, not as the sole enforcement.
    this.requireWrite();
    await this.requireVisiblePerson(personId);
    const booking = await this.get<{ id: string; trip_id: string }>(
      "SELECT id, trip_id FROM booking WHERE {scope} AND id = ?2",
      bookingId,
    );
    if (!booking) throw new NotFoundError("Booking not found in this household");

    const person = await this.get<{ id: string }>(
      "SELECT id FROM person WHERE {scope} AND id = ?2",
      personId,
    );
    if (!person) throw new NotFoundError("Person not found in this household");

    // Both rows in ONE batch, not two sequential writes. Being on a booking
    // for a trip means being on that trip — the data model must not allow the
    // two to diverge. Without the trip_person row a person is visible in
    // Overview (which reads bookings.personIds) but invisible in the day view
    // and Travelers tab (which both read trip_person via TripRepo.travelers()),
    // and two separate calls leave exactly that split behind whenever the
    // second one fails: a request that returned an error having still half
    // happened. D1's batch is a single implicit transaction, so the pair now
    // either both land or neither does. See TripRepo.addTraveler for the
    // idempotent-insert pattern each statement mirrors.
    //
    // Unscoped by design: neither join table carries a household_id of its
    // own, but the booking (and therefore its trip_id) and the person were
    // both confirmed in-household by the scoped get() calls above — that is
    // what makes these writes safe despite bypassing {scope}.
    await this.unscopedBatchRun(
      "join-table writes that must not diverge; bookingId, its trip_id, and personId all confirmed in-household by the get() calls above",
      [
        {
          sql: "INSERT OR IGNORE INTO booking_person (booking_id, person_id) VALUES (?, ?)",
          params: [bookingId, personId],
        },
        {
          sql: "INSERT OR IGNORE INTO trip_person (trip_id, person_id) VALUES (?, ?)",
          params: [booking.trip_id, personId],
        },
      ],
    );
  }

  async unassignPerson(bookingId: string, personId: string): Promise<void> {
    this.requireWrite();
    await this.requireVisiblePerson(personId);
    const booking = await this.get<{ id: string }>(
      "SELECT id FROM booking WHERE {scope} AND id = ?2",
      bookingId,
    );
    if (!booking) throw new NotFoundError("Booking not found in this household");

    const person = await this.get<{ id: string }>(
      "SELECT id FROM person WHERE {scope} AND id = ?2",
      personId,
    );
    if (!person) throw new NotFoundError("Person not found in this household");

    // This removes only the event edge. The person remains a traveler on the
    // trip: they may still be assigned to another booking, or may have been
    // added to the trip before any booking existed.
    await this.unscopedRun(
      "join-table delete; both bookingId and personId already confirmed in-household by get() above",
      "DELETE FROM booking_person WHERE booking_id = ? AND person_id = ?",
      bookingId,
      personId,
    );
  }

  /**
   * Hard delete, the counterpart of trips.delete for a single row: the
   * schema's cascades take `booking_person` and any duplicate dismissal with
   * it, and `draft_booking.booking_id` (ON DELETE SET NULL) keeps the accepted
   * draft rather than resurrecting it in the review queue.
   *
   * Cancelling is the softer option and stays the default in the UI — this
   * exists because a duplicate is not a cancelled booking. A cancelled row is
   * a real event that stopped happening, and leaving one behind per bad import
   * turns "cancelled" into a junk drawer nobody can read.
   */
  async delete(bookingId: string): Promise<void> {
    this.requireWrite();
    const booking = await this.get<{ id: string }>(
      "SELECT id FROM booking WHERE {scope} AND id = ?2",
      bookingId,
    );
    if (!booking) throw new NotFoundError("Booking not found in this household");
    await this.run("DELETE FROM booking WHERE {scope} AND id = ?2", bookingId);
  }

  async setStatus(bookingId: string, status: BookingStatus): Promise<void> {
    // Redundant with base.ts's own requireWrite() inside run() -- kept as
    // explicit intent at the top of every mutating method, matching
    // create()/assignPerson().
    this.requireWrite();

    // Existence-checked before the UPDATE. Without this the UPDATE simply
    // matches zero rows and the route answers 204 for an id that does not
    // exist, or belongs to another household. Both must be 404.
    const booking = await this.get<{ id: string }>(
      "SELECT id FROM booking WHERE {scope} AND id = ?2",
      bookingId,
    );
    if (!booking) throw new NotFoundError("Booking not found in this household");

    await this.run("UPDATE booking SET status = ?2 WHERE {scope} AND id = ?3", status, bookingId);
  }

  /**
   * I3: viewers may see a masked confirmation number but must not be able to
   * unmask it.
   *
   * I5: a bookingId that doesn't exist (or belongs to another household) now
   * throws NotFoundError, distinct from "this booking exists but has no
   * confirmation number", which still resolves to `null`.
   *
   * Issue #19: `tripId` is the PARENT the reveal is being performed under, and
   * it is part of the lookup, not a decoration. The HTTP surface is a nested
   * resource (POST /api/trips/:tripId/bookings/:bookingId/reveal); before this
   * argument existed the :tripId segment was read and discarded, so any
   * booking in the household could be revealed under any other trip's URL. The
   * disclosure boundary was never crossed (household scoping saw to that), but
   * the audit record that reveal now writes would have named a trip that had
   * nothing to do with the booking -- a wrong answer to "where did this
   * happen", which is worse than no answer.
   *
   * Optional so a non-nested caller (a repo-level test, a future job with no
   * trip in hand) is not forced to invent one; passing it is what the nested
   * route does, and a mismatch is a 404 -- the same answer as a booking that
   * genuinely is not there, disclosing nothing about which trips exist.
   */
  async revealConfirmation(bookingId: string, tripId?: string): Promise<string | null> {
    this.requireReveal();
    const row = tripId
      ? await this.get<{ value: string | null }>(
          "SELECT confirmation_number AS value FROM booking WHERE {scope} AND id = ?2 AND trip_id = ?3",
          bookingId,
          tripId,
        )
      : await this.get<{ value: string | null }>(
          "SELECT confirmation_number AS value FROM booking WHERE {scope} AND id = ?2",
          bookingId,
        );
    if (!row) throw new NotFoundError("Booking not found on this trip in this household");
    return openConfirmation(this.ring, row.value);
  }
}

// `assertBookingTiming` (the timestamp/zone pairing and the start-before-end
// ordering) used to live here as two private functions. It moved to
// ./validation.js the day `DraftBookingRepo.update` needed the identical rule:
// a reviewer correcting an extracted time before accepting it must be held to
// exactly what BookingRepo.create would accept, or the accept silently drops
// the value they just typed. Same rules, same messages, one implementation —
// see that module's doc comment, and ../time.js beneath it.
