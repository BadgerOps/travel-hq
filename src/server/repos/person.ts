import { TenantRepo, TenantScopeError, NotFoundError, ValidationError } from "./base.js";
import type { HouseholdContext } from "./base.js";
import { Keyring, mask, assertNotMasked } from "../crypto/envelope.js";
import { newId } from "../ids.js";
import { assertCalendarDate } from "./validation.js";

export const DOCUMENT_FIELDS = [
  "passport_number",
  "known_traveler_number",
  "redress_number",
] as const;

export type DocumentField = (typeof DOCUMENT_FIELDS)[number];

export type Person = {
  id: string;
  displayName: string;
  dob: string | null;
  email: string | null;
  phone: string | null;
  notes: string | null;
  passportExpiry: string | null;
  passportCountry: string | null;
  passportNumberMasked: string | null;
  knownTravelerNumberMasked: string | null;
  redressNumberMasked: string | null;
};

export type CreatePersonInput = {
  displayName: string;
  dob?: string;
  email?: string;
  phone?: string;
  notes?: string;
  passportNumber?: string;
  passportExpiry?: string;
  passportCountry?: string;
  knownTravelerNumber?: string;
  redressNumber?: string;
};

/**
 * Every field is optional, and the document fields are deliberately
 * TRI-STATE:
 *
 *   absent / undefined -> leave the stored value exactly as it is
 *   null               -> clear the stored value
 *   string             -> encrypt this NEW plaintext and store it
 *
 * The middle and last cases are the only ways to touch an encrypted column.
 * An edit form that renders `passportNumberMasked` into an input and PUTs the
 * whole object back would otherwise overwrite a real passport number with
 * `••••2119`; see `rejectMasked` below for the second line of defence.
 */
export type UpdatePersonInput = {
  displayName?: string;
  dob?: string | null;
  email?: string | null;
  phone?: string | null;
  notes?: string | null;
  passportExpiry?: string | null;
  passportCountry?: string | null;
  passportNumber?: string | null;
  knownTravelerNumber?: string | null;
  redressNumber?: string | null;
};

/**
 * Input key -> column, for the plaintext columns. The column names come from
 * this fixed map and never from caller-supplied keys, so no request body can
 * reach `insert()`/`run()` with an identifier of its own choosing.
 */
const PLAIN_COLUMNS = {
  displayName: "display_name",
  dob: "dob",
  email: "email",
  phone: "phone",
  notes: "notes",
  passportExpiry: "passport_expiry",
  passportCountry: "passport_country",
} as const;

const ENCRYPTED_COLUMNS = {
  passportNumber: "passport_number",
  knownTravelerNumber: "known_traveler_number",
  redressNumber: "redress_number",
} as const;

/**
 * Adapts `crypto/envelope.ts`'s `assertNotMasked` — which throws a plain
 * `Error` because it sits below the repository layer and must not import
 * from it — into this layer's vocabulary.
 *
 * ValidationError (400), not TenantScopeError (500): a masked value arriving
 * as plaintext is a bad request, even though the only way to produce one is a
 * bug in a caller.
 */
function rejectMasked(field: string, value: string): void {
  try {
    assertNotMasked(field, value);
  } catch (err) {
    throw new ValidationError(err instanceof Error ? err.message : String(err));
  }
}

/**
 * The two calendar-date columns a person carries, validated identically on
 * create and update.
 *
 * Neither is decorative. `passportExpiry` is what the trip Overview tab reads
 * to warn that a passport lapses before (or within six months of) the trip's
 * own dates, and it does that by comparing the stored string against the
 * trip's `starts_on` — a comparison that is silently meaningless unless both
 * sides are exact YYYY-MM-DD. `dob` is stored for the same class of downstream
 * arithmetic (traveller age at the time of a booking). "2026-02-31" or
 * "next year" would compare as an ordinary string and quietly answer wrong.
 */
function assertPersonDates(input: {
  dob?: string | null;
  passportExpiry?: string | null;
}): void {
  assertCalendarDate("dob", input.dob);
  assertCalendarDate("passportExpiry", input.passportExpiry);
}

type PersonRow = {
  id: string;
  user_id: string | null;
  display_name: string;
  dob: string | null;
  email: string | null;
  phone: string | null;
  notes: string | null;
  passport_expiry: string | null;
  passport_country: string | null;
  passport_number: string | null;
  known_traveler_number: string | null;
  redress_number: string | null;
};

export class PersonRepo extends TenantRepo {
  constructor(
    db: D1Database,
    ctx: HouseholdContext,
    private readonly ring: Keyring,
  ) {
    super(db, ctx);
  }

  async create(input: CreatePersonInput): Promise<Person> {
    // Redundant with base.ts's own requireWrite() check inside run()/insert() —
    // kept as explicit, belt-and-braces intent at the top of every mutating
    // method, not as the sole enforcement.
    this.requireWrite();
    assertPersonDates(input);
    const id = newId();
    await this.insert("person", {
      id,
      display_name: input.displayName,
      dob: input.dob ?? null,
      email: input.email ?? null,
      phone: input.phone ?? null,
      notes: input.notes ?? null,
      passport_expiry: input.passportExpiry ?? null,
      passport_country: input.passportCountry ?? null,
      passport_number: await this.seal(input.passportNumber),
      known_traveler_number: await this.seal(input.knownTravelerNumber),
      redress_number: await this.seal(input.redressNumber),
      created_at: new Date().toISOString(),
    });
    const created = await this.findById(id);
    if (!created) throw new Error("Person disappeared immediately after creation");
    return created;
  }

  /**
   * Returns the profile representing the signed-in account, creating or
   * linking it once when older households predate user-backed people.
   */
  async ensureCurrentUser(email: string): Promise<Person> {
    this.requireWrite();
    let row = await this.get<PersonRow>(
      "SELECT * FROM person WHERE {scope} AND user_id = ?2 LIMIT 1",
      this.ctx.userId,
    );
    if (row) return this.toPerson(row);

    row = await this.get<PersonRow>(
      `SELECT * FROM person
        WHERE {scope} AND user_id IS NULL AND lower(trim(email)) = lower(trim(?2))
        LIMIT 1`,
      email,
    );
    if (row) {
      await this.run(
        "UPDATE person SET user_id = ?2 WHERE {scope} AND id = ?3 AND user_id IS NULL",
        this.ctx.userId,
        row.id,
      );
      const linked = await this.findById(row.id);
      if (!linked) throw new Error("Current user profile disappeared after linking");
      return linked;
    }

    const id = newId();
    await this.insert("person", {
      id,
      user_id: this.ctx.userId,
      display_name: displayNameFromEmail(email),
      dob: null,
      email,
      phone: null,
      notes: null,
      passport_expiry: null,
      passport_country: null,
      passport_number: null,
      known_traveler_number: null,
      redress_number: null,
      created_at: new Date().toISOString(),
    });
    const created = await this.findById(id);
    if (!created) throw new Error("Current user profile disappeared after creation");
    return created;
  }

  async update(id: string, input: UpdatePersonInput): Promise<Person> {
    this.requireWrite();
    // The same call create() makes. Unlike a trip's date range there is
    // nothing here that depends on the stored row — each date stands alone —
    // so the check needs no effective-pair reconstruction, only the same rule.
    assertPersonDates(input);

    // NotFoundError, not TenantScopeError: an id that isn't in this household
    // is an ordinary bad id, exactly as TripRepo.addTraveler treats it.
    const existing = await this.get<{ id: string }>(
      "SELECT id FROM person WHERE {scope} AND id = ?2",
      id,
    );
    if (!existing) throw new NotFoundError("Person not found in this household");

    const sets: string[] = [];
    const params: unknown[] = [];
    // Caller param k (1-based) binds to ?(k+1); the household id owns ?1.
    let next = 2;

    for (const [key, column] of Object.entries(PLAIN_COLUMNS)) {
      const value = input[key as keyof typeof PLAIN_COLUMNS];
      // `undefined` is "not supplied", which is the tri-state's whole point.
      // Reaching for `key in input` instead would treat an explicitly-passed
      // `undefined` as a request to write NULL.
      if (value === undefined) continue;
      if (key === "displayName" && (typeof value !== "string" || value.trim() === "")) {
        throw new ValidationError("displayName must be a non-empty string");
      }
      sets.push(`${column} = ?${next++}`);
      params.push(value ?? null);
    }

    for (const [key, column] of Object.entries(ENCRYPTED_COLUMNS)) {
      const value = input[key as keyof typeof ENCRYPTED_COLUMNS];
      if (value === undefined) continue;
      if (value === null) {
        sets.push(`${column} = ?${next++}`);
        params.push(null);
        continue;
      }
      rejectMasked(key, value);
      sets.push(`${column} = ?${next++}`);
      params.push(await this.ring.encrypt(value));
    }

    if (sets.length > 0) {
      // The id is the last caller param, so it takes the next index.
      await this.run(
        `UPDATE person SET ${sets.join(", ")} WHERE {scope} AND id = ?${next}`,
        ...params,
        id,
      );
    }

    const updated = await this.findById(id);
    if (!updated) throw new Error("Person disappeared immediately after update");
    return updated;
  }

  async list(): Promise<Person[]> {
    const rows =
      this.ctx.role === "viewer"
        ? await this.all<PersonRow>(
            `SELECT * FROM person
              WHERE {scope}
                AND id IN (
                  SELECT tp.person_id
                    FROM trip_person tp
                    JOIN trip_member tm ON tm.trip_id = tp.trip_id
                   WHERE tm.user_id = ?2
                  UNION
                  SELECT bp.person_id
                    FROM booking_person bp
                    JOIN booking b ON b.id = bp.booking_id
                    JOIN trip_member tm ON tm.trip_id = b.trip_id
                   WHERE tm.user_id = ?2
                )
              ORDER BY display_name`,
            this.ctx.userId,
          )
        : await this.all<PersonRow>(
            "SELECT * FROM person WHERE {scope} ORDER BY display_name",
          );
    const people: Person[] = [];
    for (const row of rows) {
      try {
        people.push(await this.toPerson(row));
      } catch (err) {
        // A single row whose envelope can't be decrypted (wrong/rotated-out
        // key, corruption) must not take down the whole list -- degrade that
        // one row and keep going, the same policy applied to booking lists
        // and the day view (see BookingRepo.listByTrip, ItineraryRepo.group).
        console.error(`[PersonRepo] skipping person ${row.id} in list(): unreadable row`, err);
      }
    }
    return people;
  }

  async findById(id: string): Promise<Person | undefined> {
    const row = await this.get<PersonRow>("SELECT * FROM person WHERE {scope} AND id = ?2", id);
    return row ? this.toPerson(row) : undefined;
  }

  /**
   * Returns the plaintext of a single document field. Callers must log the
   * access — see routes/people.ts.
   *
   * I3: viewers may see a masked document field but must not be able to
   * unmask it.
   *
   * I5: a personId that doesn't exist (or belongs to another household) now
   * throws NotFoundError, distinct from "this person exists but the field is
   * unset", which still resolves to `null`.
   */
  async revealDocument(personId: string, field: DocumentField): Promise<string | null> {
    this.requireReveal();
    if (!DOCUMENT_FIELDS.includes(field)) {
      // Not client input at this point — the route validates `field` against
      // DOCUMENT_FIELDS before ever calling this method. An invalid value
      // reaching here means a caller inside our own code passed a bad
      // constant: a developer bug, not a 404 or a permission problem. Per
      // TenantScopeError's contract, the message names no field/column value
      // — log the offending field separately if this ever needs debugging.
      throw new TenantScopeError("revealDocument() called with a field outside DOCUMENT_FIELDS");
    }
    const row = await this.get<{ value: string | null }>(
      `SELECT ${field} AS value FROM person WHERE {scope} AND id = ?2`,
      personId,
    );
    if (!row) throw new NotFoundError("Person not found in this household");
    return row.value === null ? null : this.ring.decrypt(row.value);
  }

  private async seal(plaintext: string | undefined): Promise<string | null> {
    return plaintext ? this.ring.encrypt(plaintext) : null;
  }

  private async unsealAndMask(envelope: string | null): Promise<string | null> {
    return envelope === null ? null : mask(await this.ring.decrypt(envelope));
  }

  private async toPerson(r: PersonRow): Promise<Person> {
    return {
      id: r.id,
      displayName: r.display_name,
      dob: r.dob,
      email: r.email,
      phone: r.phone,
      notes: r.notes,
      passportExpiry: r.passport_expiry,
      passportCountry: r.passport_country,
      passportNumberMasked: await this.unsealAndMask(r.passport_number),
      knownTravelerNumberMasked: await this.unsealAndMask(r.known_traveler_number),
      redressNumberMasked: await this.unsealAndMask(r.redress_number),
    };
  }
}

function displayNameFromEmail(email: string): string {
  const words = email.split("@")[0]!.split(/[._+-]+/).filter(Boolean);
  const value = words.map((word) => word[0]!.toUpperCase() + word.slice(1)).join(" ");
  return value || "Me";
}
