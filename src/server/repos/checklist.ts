import { TenantRepo, NotFoundError } from "./base.js";
import { newId } from "../ids.js";

export type ChecklistItem = {
  id: string;
  tripId: string;
  /** NULL means a family-wide task rather than an assigned one. */
  personId: string | null;
  label: string;
  dueOn: string | null;
  doneAt: string | null;
};

export type CreateChecklistInput = {
  tripId: string;
  label: string;
  personId?: string;
  dueOn?: string;
};

type Row = {
  id: string;
  trip_id: string;
  person_id: string | null;
  label: string;
  due_on: string | null;
  done_at: string | null;
};

export class ChecklistRepo extends TenantRepo {
  async create(input: CreateChecklistInput): Promise<ChecklistItem> {
    // Redundant with base.ts's own requireWrite() inside run()/insert() --
    // kept as explicit intent at the top of every mutating method, matching
    // TripRepo/BookingRepo/PersonRepo.
    this.requireWrite();

    // NotFoundError, not TenantScopeError: an id the caller supplied that
    // isn't in this household is a 404, exactly as TripRepo.addTraveler
    // treats it. TenantScopeError means "this repository is written wrong"
    // and mapError() deliberately answers 500 "Internal error" for it, which
    // would hide a perfectly ordinary bad-id request behind a server fault.
    const trip = await this.get<{ id: string }>(
      "SELECT id FROM trip WHERE {scope} AND id = ?2",
      input.tripId,
    );
    if (!trip) throw new NotFoundError("Trip not found in this household");

    if (input.personId) {
      await this.requireVisiblePerson(input.personId);
      const person = await this.get<{ id: string }>(
        "SELECT id FROM person WHERE {scope} AND id = ?2",
        input.personId,
      );
      if (!person) throw new NotFoundError("Person not found in this household");
    }

    const id = newId();
    await this.insert("checklist_item", {
      id,
      trip_id: input.tripId,
      person_id: input.personId ?? null,
      label: input.label,
      due_on: input.dueOn ?? null,
      done_at: null,
      created_at: new Date().toISOString(),
    });

    const created = await this.findById(id);
    if (!created) throw new Error("Checklist item disappeared immediately after creation");
    return created;
  }

  async findById(id: string): Promise<ChecklistItem | undefined> {
    const row = await this.get<Row>("SELECT * FROM checklist_item WHERE {scope} AND id = ?2", id);
    return row ? toItem(row) : undefined;
  }

  async listByTrip(tripId: string): Promise<ChecklistItem[]> {
    const rows = await this.all<Row>(
      `SELECT * FROM checklist_item
        WHERE {scope} AND trip_id = ?2
        ORDER BY done_at IS NOT NULL, due_on IS NULL, due_on, created_at`,
      tripId,
    );
    return rows.map(toItem);
  }

  /** Every open item across all trips — the cross-trip checklist route. */
  async listAll(): Promise<ChecklistItem[]> {
    const rows =
      this.ctx.role === "viewer"
        ? await this.all<Row>(
            `SELECT * FROM checklist_item
              WHERE {scope}
                AND trip_id IN (
                  SELECT trip_id FROM trip_member WHERE user_id = ?2
                )
              ORDER BY done_at IS NOT NULL, due_on IS NULL, due_on, created_at`,
            this.ctx.userId,
          )
        : await this.all<Row>(
            `SELECT * FROM checklist_item
              WHERE {scope}
              ORDER BY done_at IS NOT NULL, due_on IS NULL, due_on, created_at`,
          );
    return rows.map(toItem);
  }

  async setDone(id: string, done: boolean): Promise<void> {
    this.requireWrite();
    // Without this, an unknown id (or one belonging to another household)
    // matches zero rows, the UPDATE succeeds vacuously, and the route answers
    // 204 -- telling a client its write landed when nothing happened. Same
    // existence-check-then-act shape as BookingRepo.assignPerson.
    if (!(await this.findById(id))) {
      throw new NotFoundError("Checklist item not found in this household");
    }
    await this.run(
      "UPDATE checklist_item SET done_at = ?2 WHERE {scope} AND id = ?3",
      done ? new Date().toISOString() : null,
      id,
    );
  }
}

function toItem(r: Row): ChecklistItem {
  return {
    id: r.id,
    tripId: r.trip_id,
    personId: r.person_id,
    label: r.label,
    dueOn: r.due_on,
    doneAt: r.done_at,
  };
}
