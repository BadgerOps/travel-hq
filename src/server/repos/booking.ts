import { TenantRepo, NotFoundError, ValidationError } from "./base.js";
import type { HouseholdContext } from "./base.js";
import { Keyring, mask, assertNotMasked } from "../crypto/envelope.js";
import { openConfirmation } from "./confirmation.js";
import { newId } from "../ids.js";
import { parseDetails } from "../schemas/booking-kinds.js";
import { isValidTimestamp, isValidTimezone } from "../time.js";

/**
 * Exported as a value, not only a type: the status route's Zod enum and the
 * booking dialog's segmented control both need the list at runtime, and
 * writing it out a second time is how one of them ends up accepting a status
 * the CHECK constraint on `booking.status` rejects.
 */
export const BOOKING_STATUSES = ["draft", "planned", "booked", "cancelled"] as const;

export type BookingStatus = (typeof BOOKING_STATUSES)[number];

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
  details: unknown;
  personIds: string[];
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
  details: unknown;
};

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
    assertTimezonePaired(input);

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
      details: JSON.stringify(details),
      created_at: new Date().toISOString(),
    });

    const created = await this.findById(id);
    if (!created) throw new Error("Booking disappeared immediately after creation");
    return created;
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

    // Unscoped by design: booking_person carries no household_id of its own,
    // but both ids above were already confirmed to be in this household by
    // the scoped get() calls immediately above — that's what makes this
    // write safe despite bypassing {scope}.
    await this.unscopedRun(
      "join-table write; both bookingId and personId already confirmed in-household by get() above",
      "INSERT OR IGNORE INTO booking_person (booking_id, person_id) VALUES (?, ?)",
      bookingId,
      personId,
    );

    // Being on a booking for a trip means being on that trip — the data
    // model must not allow the two to diverge. Without this, a person can be
    // assigned to a booking without ever being added via PUT
    // /api/trips/:tripId/people/:personId, which leaves them visible in
    // Overview (which reads bookings.personIds) but invisible in the day
    // view and Travelers tab (which both read trip_person via
    // TripRepo.travelers()) — see TripRepo.addTraveler for the identical
    // idempotent-insert pattern this mirrors.
    await this.unscopedRun(
      "join-table write; both tripId (from the scoped booking row above) and personId already confirmed in-household",
      "INSERT OR IGNORE INTO trip_person (trip_id, person_id) VALUES (?, ?)",
      booking.trip_id,
      personId,
    );
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
   */
  async revealConfirmation(bookingId: string): Promise<string | null> {
    this.requireReveal();
    const row = await this.get<{ value: string | null }>(
      "SELECT confirmation_number AS value FROM booking WHERE {scope} AND id = ?2",
      bookingId,
    );
    if (!row) throw new NotFoundError("Booking not found in this household");
    return openConfirmation(this.ring, row.value);
  }
}

/**
 * A timestamp without its IANA zone renders every cross-timezone itinerary
 * wrong, which is most flights. Reject the unpaired case at the boundary rather
 * than discovering it in the UI.
 *
 * C1: also rejects a timestamp `Date.parse` can't understand and a
 * timezone `Intl.DateTimeFormat` doesn't recognize. This mirrors
 * `createBookingSchema`'s refinements in routes/trips.ts at the repo level,
 * so a non-HTTP caller (e.g. a future email-ingestion job constructing
 * bookings directly) gets the same guarantee the HTTP boundary gives an API
 * client — an unparseable timestamp must never reach `localDateOf()` in
 * ItineraryRepo, where it would throw on every future read of that trip's
 * day view.
 */
function assertTimezonePaired(input: CreateBookingInput): void {
  if (input.startsAt) {
    if (!input.startsAtTz) {
      throw new ValidationError("startsAt requires startsAtTz (an IANA timezone)");
    }
    if (!isValidTimestamp(input.startsAt)) {
      throw new ValidationError("startsAt must be a parseable timestamp");
    }
    if (!isValidTimezone(input.startsAtTz)) {
      throw new ValidationError("startsAtTz must be a valid IANA timezone");
    }
  }
  if (input.endsAt) {
    if (!input.endsAtTz) {
      throw new ValidationError("endsAt requires endsAtTz (an IANA timezone)");
    }
    if (!isValidTimestamp(input.endsAt)) {
      throw new ValidationError("endsAt must be a parseable timestamp");
    }
    if (!isValidTimezone(input.endsAtTz)) {
      throw new ValidationError("endsAtTz must be a valid IANA timezone");
    }
  }
}

// isValidTimestamp/isValidTimezone live in ../time.js, shared with
// routes/trips.ts and ingest/extracted.ts -- see that module's doc comment
// for why the three must never drift apart.
