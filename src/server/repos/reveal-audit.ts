import { TenantRepo, ForbiddenError, TenantScopeError, ValidationError } from "./base.js";
import { DOCUMENT_FIELDS } from "./person.js";
import type { DocumentField } from "./person.js";
import { newId } from "../ids.js";

/**
 * One successful document reveal: who (the authenticated user), what (which
 * person, which field), when. NEVER the revealed value — the plaintext must
 * not exist anywhere outside its encrypted envelope and the one-off reveal
 * response.
 *
 * personName is joined at read time for the UI and is null when the person
 * row no longer exists: the audit row deliberately outlives the person it
 * names (see migrations/0006_reveal_audit.sql).
 */
export type RevealAuditEntry = {
  id: string;
  userId: string;
  userEmail: string;
  personId: string;
  personName: string | null;
  field: DocumentField;
  revealedAt: string;
};

export type RecordRevealInput = {
  /** From the authenticated Identity — HouseholdContext carries no email. */
  userEmail: string;
  personId: string;
  field: DocumentField;
};

type Row = {
  id: string;
  user_id: string;
  user_email: string;
  person_id: string;
  field: DocumentField;
  revealed_at: string;
};

const MAX_LIST_LIMIT = 200;

export class RevealAuditRepo extends TenantRepo {
  /**
   * Writes the audit row for one reveal. The caller (routes/people.ts) does
   * this BEFORE returning the plaintext, so a failed write fails the reveal
   * — there is no unaudited reveal response.
   *
   * Adults may write here (they may reveal, so their reveals must be
   * recorded); a viewer cannot reach this in practice because
   * requireReveal() already denied the reveal itself, and insert()'s
   * requireWrite() backstops that.
   */
  async record(input: RecordRevealInput): Promise<void> {
    this.requireWrite();
    if (!DOCUMENT_FIELDS.includes(input.field)) {
      // Mirrors PersonRepo.revealDocument: the route validates the field
      // before either method runs, so a bad value here is a caller bug in
      // our own code, not client input. Per TenantScopeError's contract the
      // message names no field value.
      throw new TenantScopeError("record() called with a field outside DOCUMENT_FIELDS");
    }
    await this.insert("reveal_audit", {
      id: newId(),
      user_id: this.ctx.userId,
      user_email: input.userEmail,
      person_id: input.personId,
      field: input.field,
      revealed_at: new Date().toISOString(),
    });
  }

  /**
   * The household's reveal trail, newest first. OWNER-only — stricter than
   * household settings' owner/adult gate: the trail reports on the adults
   * themselves (who looked at whose passport number), so an adult reading it
   * would let the watched watch the watcher. requireWrite()/requireReveal()
   * express neither of those; this is its own rule.
   *
   * Person names are resolved with a second scoped query rather than a JOIN:
   * both tables carry household_id, and {scope} expands to a bare
   * `household_id = ?1` that a two-table FROM would make ambiguous.
   */
  async list(limit = 100): Promise<RevealAuditEntry[]> {
    this.requireOwner();
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT) {
      throw new ValidationError(`list requires an integer limit between 1 and ${MAX_LIST_LIMIT}`);
    }
    const rows = await this.all<Row>(
      "SELECT * FROM reveal_audit WHERE {scope} ORDER BY revealed_at DESC, id DESC LIMIT ?2",
      limit,
    );
    const people = await this.all<{ id: string; display_name: string }>(
      "SELECT id, display_name FROM person WHERE {scope}",
    );
    const names = new Map(people.map((p) => [p.id, p.display_name]));
    return rows.map((r) => ({
      id: r.id,
      userId: r.user_id,
      userEmail: r.user_email,
      personId: r.person_id,
      personName: names.get(r.person_id) ?? null,
      field: r.field,
      revealedAt: r.revealed_at,
    }));
  }

  private requireOwner(): void {
    if (this.ctx.role !== "owner") {
      throw new ForbiddenError("Only the household owner may view the reveal audit trail");
    }
  }
}
