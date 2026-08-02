import { TenantRepo, TenantScopeError, NotFoundError, ValidationError } from "./base.js";
import type { HouseholdContext } from "./base.js";
import { AuditRepo } from "./audit.js";
import { Keyring, mask, assertNotMasked } from "../crypto/envelope.js";
import { newId } from "../ids.js";
import { assertCalendarDate } from "./validation.js";

/**
 * base.ts keeps these module-private, so they are restated here for the single
 * statement `runOwnRow()` has to expand itself. If they ever disagree with
 * base.ts the expansion stops matching what run() produces, which is why
 * runOwnRow() is written so the SAME sql string also goes through run() for
 * every non-viewer role — any drift fails the ordinary tests first.
 */
const SCOPE_TOKEN = "{scope}";
const SCOPE_SQL = "household_id = ?1";

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

/**
 * The plaintext of one document field, plus whether the person who asked for
 * it was asking about their own record.
 *
 * `selfService` is returned rather than left for the route to work out because
 * the repository is the only layer that has seen `person.user_id`, and the
 * audit row that records the reveal has to say which kind of reveal it was at
 * the moment it happens (see migrations/0018).
 */
export type RevealedDocument = {
  value: string | null;
  selfService: boolean;
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
  /**
   * A second handle on the same D1 binding, for two things base.ts's private
   * handle cannot do: `runOwnRow()` below, which must skip base's ROLE gate,
   * and constructing the AuditRepo this repo records its own changes through.
   *
   * Preparing a statement from it is within the architecture test's allowlist
   * -- this file is the tenancy layer -- but it happens in exactly one method,
   * which explains itself at length.
   */
  private readonly rawDb: D1Database;

  constructor(
    db: D1Database,
    ctx: HouseholdContext,
    private readonly ring: Keyring,
  ) {
    super(db, ctx);
    this.rawDb = db;
  }

  /**
   * The activity log this repo writes its own changes to.
   *
   * WHY HERE AND NOT IN THE ROUTE, where the reveal entries are written: this
   * is the only layer that knows which COLUMNS an edit actually touched. A
   * route sees the request body's camelCase keys and would have to re-derive
   * the column mapping to name them, giving the same fact two definitions that
   * could disagree. It also means a person cannot be changed by any future
   * caller, HTTP or not, without the change being recorded.
   *
   * Reveals stay in the routes because that is where the booking reveal in
   * routes/trips.ts records too, and where the correlated structured log line
   * is emitted. The split is by what each layer knows, not by taste.
   */
  private audit(): AuditRepo {
    return new AuditRepo(this.rawDb, this.ctx);
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
    // After the write, never before: an entry written first would claim a
    // person that a failed insert never produced. The tradeoff in the other
    // direction is real and accepted -- D1 has no interactive transaction to
    // put both in, so a failing audit write surfaces as a 500 on a person who
    // does now exist. Loud and recoverable beats an unrecorded change.
    await this.audit().record({
      event: "person_created",
      subjectType: "person",
      subjectId: id,
      fields: providedColumns(input),
    });
    return created;
  }

  /**
   * The person row representing the signed-in account, or `undefined` when
   * this account has none.
   *
   * LINK OR NOTHING. It returns the row already linked to this user, else
   * adopts an unlinked row whose email matches the authenticated one, else
   * gives up. It NEVER creates a row, and that is the load-bearing part.
   *
   * Why: `TripAccessRepo.invite()` provisions a `household_member` with role
   * `viewer` for anyone invited to a single shared trip. A weekend guest and a
   * family teenager are the same role, so "viewers may edit their own person"
   * would, if this method still auto-created, hand that guest a passport field
   * in a household they barely belong to. Refusing to create makes the
   * distinction structural rather than role-based: the owner pre-seeding a
   * person row is what constitutes membership, and a trip guest has no row, so
   * there is nothing for them to own. No new role, and no migration of the
   * `household_member` rows that already exist.
   *
   * `undefined` rather than `null` for absence, matching `findById()`; there
   * is nothing to be gained from this repository signalling "nothing" two
   * different ways.
   *
   * No `requireWrite()`. Resolving your own profile is a READ, and gating it
   * on write permission is precisely what made a viewer's own row unreachable.
   * The adopt branch below does write, and says how it is allowed to.
   */
  async ensureCurrentUser(email: string): Promise<Person | undefined> {
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
    if (!row) return undefined;

    // Onboarding: this row was pre-seeded for this email and nobody has
    // claimed it. `user_id IS NULL` in the WHERE clause makes the claim a
    // compare-and-set, so two concurrent first sign-ins cannot both link, and
    // a row claimed between the SELECT and here is left alone.
    await this.runOwnRow(
      "UPDATE person SET user_id = ?2 WHERE {scope} AND id = ?3 AND user_id IS NULL",
      this.ctx.userId,
      row.id,
    );
    const linked = await this.findById(row.id);
    if (!linked) throw new Error("Current user profile disappeared after linking");
    return linked;
  }

  async update(id: string, input: UpdatePersonInput): Promise<Person> {
    // The same call create() makes. Unlike a trip's date range there is
    // nothing here that depends on the stored row — each date stands alone —
    // so the check needs no effective-pair reconstruction, only the same rule.
    assertPersonDates(input);

    // NotFoundError, not TenantScopeError: an id that isn't in this household
    // is an ordinary bad id, exactly as TripRepo.addTraveler treats it.
    //
    // This lookup now runs BEFORE the permission check, which is what keeps a
    // cross-household id answering 404 for every role rather than 403 for
    // some: a 403 on an id from another household would confirm the row
    // exists somewhere, and the whole point of scoping the SELECT is that a
    // caller cannot tell an unknown id from someone else's.
    const existing = await this.get<{ id: string; user_id: string | null }>(
      "SELECT id, user_id FROM person WHERE {scope} AND id = ?2",
      id,
    );
    if (!existing) throw new NotFoundError("Person not found in this household");

    /**
     * The self-edit rule, and it is ADDITIVE:
     *
     *   the row is yours -> allowed, whatever your role (new)
     *   anything else    -> requireWrite(), exactly as before (unchanged)
     *
     * The only thing this grants is the ability to edit your own record, which
     * is what makes a viewer's own profile reachable at all -- a teenager
     * correcting their own phone number was previously impossible. Nothing is
     * taken away from anybody: an adult still edits every other row in the
     * household, linked or not, which is what keeps children, pre-seeded rows,
     * and a two-adult household working exactly as they do today.
     */
    const selfService = this.isOwnRow(existing.user_id);
    if (!selfService) this.requireWrite();

    const sets: string[] = [];
    const params: unknown[] = [];
    // The COLUMN names this edit touches, for the activity log. Names only --
    // `params` alongside holds the values, and the two must never meet.
    const changed: string[] = [];
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
      changed.push(column);
    }

    for (const [key, column] of Object.entries(ENCRYPTED_COLUMNS)) {
      const value = input[key as keyof typeof ENCRYPTED_COLUMNS];
      if (value === undefined) continue;
      changed.push(column);
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
      await this.runOwnRow(
        `UPDATE person SET ${sets.join(", ")} WHERE {scope} AND id = ?${next}`,
        ...params,
        id,
      );
    }

    if (changed.length > 0) {
      // Only when something actually changed: a PUT that supplied no editable
      // key wrote nothing, and an entry for it would be an event that did not
      // happen. Recorded after the write, for the reason create() gives.
      await this.audit().record({
        event: "person_updated",
        subjectType: "person",
        subjectId: id,
        selfService,
        fields: changed,
      });
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
   * Returns the plaintext of a single document field, and whether it was the
   * caller's own. Callers must log the access — see routes/people.ts.
   *
   * I3: viewers may see a masked document field but must not be able to
   * unmask SOMEBODY ELSE'S. Their own is now allowed, because the alternative
   * is a write-only field: you could store a passport number and never read
   * back the one you stored, seeing only `••••2119` and unable to tell a typo
   * from a correct entry. The threat this accepts is that a compromised
   * viewer session yields a real passport number rather than a mask — judged
   * acceptable, because that person is normally holding the document.
   *
   * I5: a personId that doesn't exist (or belongs to another household)
   * throws NotFoundError, distinct from "this person exists but the field is
   * unset", which still resolves to `null`. The role check moved BELOW that
   * lookup for the reason given in update(): a 403 on an id from another
   * household would be a membership oracle.
   */
  async revealDocument(personId: string, field: DocumentField): Promise<RevealedDocument> {
    if (!DOCUMENT_FIELDS.includes(field)) {
      // Not client input at this point — the route validates `field` against
      // DOCUMENT_FIELDS before ever calling this method. An invalid value
      // reaching here means a caller inside our own code passed a bad
      // constant: a developer bug, not a 404 or a permission problem. Per
      // TenantScopeError's contract, the message names no field/column value
      // — log the offending field separately if this ever needs debugging.
      throw new TenantScopeError("revealDocument() called with a field outside DOCUMENT_FIELDS");
    }
    const row = await this.get<{ user_id: string | null; value: string | null }>(
      `SELECT user_id, ${field} AS value FROM person WHERE {scope} AND id = ?2`,
      personId,
    );
    if (!row) throw new NotFoundError("Person not found in this household");

    // The same additive shape as update(): your own row is always revealable,
    // and every other row keeps exactly the rule it had.
    const selfService = this.isOwnRow(row.user_id);
    if (!selfService) this.requireReveal();
    return {
      value: row.value === null ? null : await this.ring.decrypt(row.value),
      selfService,
    };
  }

  /** True when the row is linked to the account making this request. */
  private isOwnRow(rowUserId: string | null): boolean {
    return rowUserId !== null && rowUserId === this.ctx.userId;
  }

  /**
   * A write to a person row the caller has ALREADY been shown to own.
   *
   * base.ts's run() asks "may this ROLE write?", and for the two statements
   * that reach here that is the wrong question. Claiming the row an owner
   * pre-seeded for you, and editing it once claimed, are exactly what a viewer
   * is now permitted to do; requireWrite() refuses both and leaves a viewer's
   * own profile permanently unreachable, which is the bug this change exists
   * to fix.
   *
   * unscopedRun() is NOT the escape hatch for this. It applies the very same
   * requireWrite() to any write statement, so it refuses these for the same
   * reason run() does — the documented hatch is for escaping the tenancy
   * SCOPE, and the scope is not what is in the way here. The bypass is
   * therefore local, and as narrow as it can be made:
   *
   *  - Only a viewer takes it. Every other role goes through run(), so the SQL
   *    text below is the same text base.ts validates on the owner/adult path,
   *    exercised by the same tests.
   *  - {scope} is expanded to base.ts's own predicate and the household id is
   *    bound first, exactly as run() does. The statement stays tenant-scoped.
   *  - Both call sites pin `id` to a single row, and have already established
   *    that this account owns it: update() via `person.user_id`, and
   *    ensureCurrentUser() via an email match against the AUTHENTICATED
   *    address plus `user_id IS NULL`.
   *
   * This method authorizes nothing on its own. Its callers do that first.
   */
  private async runOwnRow(sql: string, ...params: unknown[]): Promise<void> {
    if (this.ctx.role !== "viewer") return this.run(sql, ...params);
    // Guard rather than a silent no-op replace: a template that lost its token
    // would otherwise run unscoped across every household.
    if (sql.split(SCOPE_TOKEN).length !== 2) {
      throw new TenantScopeError(`runOwnRow() requires exactly one ${SCOPE_TOKEN} token`);
    }
    await this.rawDb
      .prepare(sql.replace(SCOPE_TOKEN, SCOPE_SQL))
      .bind(this.ctx.householdId, ...(params as never[]))
      .run();
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

/**
 * The COLUMN names a create() call actually supplied, for the activity log.
 * `display_name` is unconditional -- create() requires it -- and every other
 * column appears only when the caller passed a value for it, so an entry says
 * what was filled in rather than listing the whole table.
 *
 * Derived from the same two maps update() uses, so a column added to a map is
 * audited without a second edit here.
 */
function providedColumns(input: CreatePersonInput): string[] {
  const columns = ["display_name"];
  for (const [key, column] of Object.entries({ ...PLAIN_COLUMNS, ...ENCRYPTED_COLUMNS })) {
    if (column === "display_name") continue;
    if (input[key as keyof CreatePersonInput] !== undefined) columns.push(column);
  }
  return columns;
}
