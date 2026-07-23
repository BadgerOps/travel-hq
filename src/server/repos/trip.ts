import { TenantRepo, NotFoundError, ValidationError } from "./base.js";
import { newId } from "../ids.js";

/**
 * Exported as a value, not only a type: the update route's Zod enum and the
 * repo's own validation both need the list at runtime, and writing it out a
 * second time is how one of them ends up accepting a status the CHECK
 * constraint on `trip.status` rejects — the same reasoning as
 * BOOKING_STATUSES. (The client's edit form deliberately offers only a
 * subset — cancelled is reached via the Cancel action — and the client may
 * only import types from server modules, so it does not share this value.)
 */
export const TRIP_STATUSES = ["planning", "active", "complete", "cancelled"] as const;

export type TripStatus = (typeof TRIP_STATUSES)[number];

export type Trip = {
  id: string;
  title: string;
  destination: string | null;
  startsOn: string | null;
  endsOn: string | null;
  status: TripStatus;
  notes: string | null;
};

export type CreateTripInput = {
  title: string;
  destination?: string;
  startsOn?: string;
  endsOn?: string;
  notes?: string;
};

/**
 * Every field is optional, and the nullable fields are deliberately
 * TRI-STATE, exactly as UpdatePersonInput established:
 *
 *   absent / undefined -> leave the stored value exactly as it is
 *   null               -> clear the stored value
 *   value              -> store this new value
 *
 * `title` is non-nullable (a trip must keep a title) and `status` is the
 * enum with no null — "no status" is spelled `planning`, the schema default,
 * never NULL.
 */
export type UpdateTripInput = {
  title?: string;
  destination?: string | null;
  startsOn?: string | null;
  endsOn?: string | null;
  status?: TripStatus;
  notes?: string | null;
};

/**
 * Input key -> column, for the SET clause. The column names come from this
 * fixed map and never from caller-supplied keys, so no request body can
 * reach run() with an identifier of its own choosing — the PersonRepo.update
 * pattern.
 */
const UPDATE_COLUMNS = {
  title: "title",
  destination: "destination",
  startsOn: "starts_on",
  endsOn: "ends_on",
  status: "status",
  notes: "notes",
} as const;

/**
 * A calendar date must be the exact `YYYY-MM-DD` the schema stores and the
 * client's string comparisons (isActiveOn, ordering) assume. `Date.parse`
 * would accept far more than that; the round-trip check rejects a
 * well-shaped impossibility like 2026-02-31, which Date.UTC would silently
 * roll into March.
 */
function isValidCalendarDate(value: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return false;
  const [, y, mo, d] = m;
  const date = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d)));
  return (
    date.getUTCFullYear() === Number(y) &&
    date.getUTCMonth() === Number(mo) - 1 &&
    date.getUTCDate() === Number(d)
  );
}

type TripRow = {
  id: string;
  title: string;
  destination: string | null;
  starts_on: string | null;
  ends_on: string | null;
  status: TripStatus;
  notes: string | null;
};

export class TripRepo extends TenantRepo {
  async create(input: CreateTripInput): Promise<Trip> {
    // Redundant with base.ts's own requireWrite() check inside run()/insert() —
    // kept as explicit, belt-and-braces intent at the top of every mutating
    // method, not as the sole enforcement.
    this.requireWrite();
    const id = newId();
    await this.insert("trip", {
      id,
      title: input.title,
      destination: input.destination ?? null,
      starts_on: input.startsOn ?? null,
      ends_on: input.endsOn ?? null,
      status: "planning",
      notes: input.notes ?? null,
      created_at: new Date().toISOString(),
    });
    const created = await this.findById(id);
    if (!created) throw new Error("Trip disappeared immediately after creation");
    return created;
  }

  /**
   * Partial update. The SET clause is built from the provided keys only —
   * an absent key never touches its column — which is what makes the
   * tri-state honest: `undefined` is "not supplied", `null` is "clear".
   *
   * Validation mirrors updateTripSchema at the repo level (belt and braces
   * for any non-HTTP caller): `title`/`status` reject null, dates must be
   * well-formed YYYY-MM-DD, and the EFFECTIVE post-patch pair must satisfy
   * startsOn <= endsOn — patching only endsOn below a stored startsOn is
   * just as inverted a range as sending both.
   */
  async update(id: string, patch: UpdateTripInput): Promise<Trip> {
    // Redundant with base.ts's own requireWrite() check inside run() —
    // kept as explicit, belt-and-braces intent at the top of every mutating
    // method, not as the sole enforcement.
    this.requireWrite();

    const existing = await this.findById(id);
    if (!existing) throw new NotFoundError("Trip not found in this household");

    for (const key of ["startsOn", "endsOn"] as const) {
      const value = patch[key];
      if (value === undefined || value === null) continue;
      if (typeof value !== "string" || !isValidCalendarDate(value)) {
        throw new ValidationError(`${key} must be a well-formed YYYY-MM-DD date`);
      }
    }
    const startsOn = patch.startsOn === undefined ? existing.startsOn : patch.startsOn;
    const endsOn = patch.endsOn === undefined ? existing.endsOn : patch.endsOn;
    if (startsOn !== null && endsOn !== null && startsOn > endsOn) {
      throw new ValidationError("startsOn must be on or before endsOn");
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
      if (key === "status" && !TRIP_STATUSES.includes(value as TripStatus)) {
        throw new ValidationError(`status must be one of ${TRIP_STATUSES.join(", ")}`);
      }
      sets.push(`${column} = ?${next++}`);
      params.push(value ?? null);
    }

    if (sets.length > 0) {
      // The id is the last caller param, so it takes the next index.
      await this.run(
        `UPDATE trip SET ${sets.join(", ")} WHERE {scope} AND id = ?${next}`,
        ...params,
        id,
      );
    }

    const updated = await this.findById(id);
    if (!updated) throw new Error("Trip disappeared immediately after update");
    return updated;
  }

  /**
   * Hard delete. The schema's ON DELETE CASCADE removes the trip's bookings
   * (and, through them, their booking_person rows), checklist items, and
   * trip_person rows — one scoped DELETE is the whole operation.
   */
  async delete(id: string): Promise<void> {
    // Redundant with base.ts's own requireWrite() check inside run() —
    // explicit intent, matching every other mutating method.
    this.requireWrite();
    // Existence-checked before the DELETE. Without this the DELETE simply
    // matches zero rows and the route answers 204 for an id that does not
    // exist, or belongs to another household. Both must be 404.
    if (!(await this.findById(id))) {
      throw new NotFoundError("Trip not found in this household");
    }
    await this.run("DELETE FROM trip WHERE {scope} AND id = ?2", id);
  }

  /**
   * Unassigns a person from this trip: their booking_person rows for this
   * trip's bookings, then their trip_person row, in ONE transaction (a D1
   * batch) so a failure between the two cannot leave someone off the roster
   * but still on its bookings. Unassign only — no booking is cancelled or
   * deleted. Idempotent: removing someone who is not on the trip succeeds
   * and changes nothing.
   */
  async removeTraveler(tripId: string, personId: string): Promise<void> {
    // Redundant with base.ts's own requireWrite() check inside
    // unscopedBatchRun() — explicit intent, matching addTraveler.
    this.requireWrite();
    if (!(await this.findById(tripId))) {
      throw new NotFoundError("Trip not found in this household");
    }
    const person = await this.get<{ id: string }>(
      "SELECT id FROM person WHERE {scope} AND id = ?2",
      personId,
    );
    if (!person) {
      throw new NotFoundError("Person not found in this household");
    }
    // Unscoped by design: booking_person and trip_person carry no
    // household_id of their own, but both ids above were already confirmed
    // to be in this household by the scoped findById()/get() calls — the
    // same justification as addTraveler's unscopedRun. The booking subquery
    // reaches only bookings of the already-confirmed trip.
    await this.unscopedBatchRun(
      "join-table writes; tripId and personId already confirmed in-household by findById/get above; batched so the two deletes are atomic",
      [
        {
          sql: `DELETE FROM booking_person
                 WHERE person_id = ?
                   AND booking_id IN (SELECT id FROM booking WHERE trip_id = ?)`,
          params: [personId, tripId],
        },
        {
          sql: "DELETE FROM trip_person WHERE trip_id = ? AND person_id = ?",
          params: [tripId, personId],
        },
      ],
    );
  }

  async list(): Promise<Trip[]> {
    const rows = await this.all<TripRow>(
      "SELECT * FROM trip WHERE {scope} ORDER BY starts_on IS NULL, starts_on",
    );
    return rows.map(toTrip);
  }

  async findById(id: string): Promise<Trip | undefined> {
    const row = await this.get<TripRow>("SELECT * FROM trip WHERE {scope} AND id = ?2", id);
    return row ? toTrip(row) : undefined;
  }

  async addTraveler(tripId: string, personId: string): Promise<void> {
    // Redundant with base.ts's own requireWrite() check inside run()/insert() —
    // kept as explicit, belt-and-braces intent at the top of every mutating
    // method, not as the sole enforcement.
    this.requireWrite();
    if (!(await this.findById(tripId))) {
      throw new NotFoundError("Trip not found in this household");
    }
    const person = await this.get<{ id: string }>(
      "SELECT id FROM person WHERE {scope} AND id = ?2",
      personId,
    );
    if (!person) {
      throw new NotFoundError("Person not found in this household");
    }
    // Unscoped by design: trip_person carries no household_id of its own, but
    // both ids above were already confirmed to be in this household by the
    // scoped findById()/get() calls immediately above — that's what makes
    // this write safe despite bypassing {scope}.
    await this.unscopedRun(
      "join-table write; both tripId and personId already confirmed in-household by findById/get above",
      "INSERT OR IGNORE INTO trip_person (trip_id, person_id) VALUES (?, ?)",
      tripId,
      personId,
    );
  }

  async travelers(tripId: string): Promise<string[]> {
    const rows = await this.all<{ person_id: string }>(
      `SELECT tp.person_id
         FROM trip_person tp
         JOIN trip t ON t.id = tp.trip_id
        WHERE {scope} AND tp.trip_id = ?2
        ORDER BY tp.person_id`,
      tripId,
    );
    return rows.map((r) => r.person_id);
  }
}

function toTrip(r: TripRow): Trip {
  return {
    id: r.id,
    title: r.title,
    destination: r.destination,
    startsOn: r.starts_on,
    endsOn: r.ends_on,
    status: r.status,
    notes: r.notes,
  };
}
