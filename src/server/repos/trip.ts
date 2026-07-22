import { TenantRepo, NotFoundError } from "./base.js";
import { newId } from "../ids.js";

export type TripStatus = "planning" | "active" | "complete" | "cancelled";

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
