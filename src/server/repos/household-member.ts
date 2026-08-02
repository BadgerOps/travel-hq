import { newId } from "../ids.js";
import { AuditRepo } from "./audit.js";
import {
  ForbiddenError,
  NotFoundError,
  TenantRepo,
  ValidationError,
  type HouseholdContext,
  type Role,
} from "./base.js";

/**
 * The roles an owner may hand out. `owner` is deliberately absent: promoting
 * someone to owner is a transfer of the household itself — it hands over the
 * audit trail, the ingest configuration, and the ability to demote whoever did
 * the promoting — and an invite form is not where that decision belongs. The
 * CHECK constraint on `household_member.role` accepts it; this list is what
 * refuses it, with a message a person can act on.
 */
export const INVITABLE_ROLES = ["admin", "viewer"] as const;
export type InvitableRole = (typeof INVITABLE_ROLES)[number];

/**
 * Where one row of the household roster stands, spelled out rather than left
 * to be inferred from a handful of nulls. Under this design a pre-seeded
 * `person` row IS the membership, so the interesting question is never "does
 * a row exist" but "has anyone actually turned up behind it":
 *
 *  - `onboarded` — `person.user_id` is set. They have signed in and the row is
 *    theirs; only they and the owner may edit it.
 *  - `invited` — a person row exists and an account exists for its email, but
 *    nobody has signed in yet. This is the state an owner most needs to see:
 *    it is the difference between "I invited them" and "they are here".
 *  - `unclaimed` — a person row with no account behind it at all. A child, or
 *    anyone the household tracks but never invited. Nobody can sign in as them.
 *  - `guest` — an account with household access but no person row. This is
 *    what `TripAccessRepo.invite()` leaves behind: a household `viewer` who
 *    exists only to see one shared trip. Listed rather than hidden, because
 *    an owner reviewing who can reach the household needs to see them.
 */
export type HouseholdMemberStatus = "onboarded" | "invited" | "unclaimed" | "guest";

export type HouseholdMember = {
  /** `person.id`, or null for a `guest` — an account with no person row. */
  personId: string | null;
  /** `person.display_name`, or null for a `guest`. */
  displayName: string | null;
  /** The account's email where there is an account, else the person's own. */
  email: string | null;
  /** The account behind this row, whether or not the person row is linked yet. */
  userId: string | null;
  /** `household_member.role`, or null for an `unclaimed` row with no account. */
  role: Role | null;
  /**
   * `person.user_id IS NOT NULL`: someone has signed in and taken ownership of
   * this row. Equivalent to `status === "onboarded"` and derived from the same
   * single check — it is duplicated because "have they actually onboarded" is
   * the one question the members list exists to answer, and a boolean is
   * harder to get wrong at a call site than a string comparison.
   */
  claimed: boolean;
  status: HouseholdMemberStatus;
};

export type InviteHouseholdMemberInput = {
  email: string;
  role: InvitableRole;
  /** Optional; an omitted name falls back to the email's local part. */
  displayName?: string;
};

/** Same bound and same shape as `TripAccessRepo`; invites share one notion of a valid address. */
const MAX_EMAIL_CHARS = 320;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type PersonRow = {
  id: string;
  user_id: string | null;
  display_name: string;
  email: string | null;
};

type AccountRow = {
  user_id: string;
  email: string;
  role: Role;
};

export class HouseholdMemberRepo extends TenantRepo {
  /**
   * Membership changes are audited from here rather than from the route, for
   * the same reason the role checks live here: a non-HTTP caller must not be
   * able to alter who is in a household without leaving a record of it.
   */
  private readonly audit: AuditRepo;

  constructor(db: D1Database, ctx: HouseholdContext) {
    super(db, ctx);
    this.audit = new AuditRepo(db, ctx);
  }

  /**
   * The household roster: every person row, plus every account that can reach
   * this household, matched up with each other.
   *
   * Two queries rather than one join, because the two halves live in different
   * scoping worlds — `person` is household-scoped and goes through {scope},
   * while `household_member`/`user` do not — and because the interesting rows
   * are precisely the ones a join would drop: a person nobody has claimed, and
   * an account with no person row.
   */
  async list(): Promise<HouseholdMember[]> {
    await this.requireRosterRead();

    const people = await this.all<PersonRow>(
      `SELECT id, user_id, display_name, email
         FROM person
        WHERE {scope}
        ORDER BY lower(display_name)`,
    );
    const accounts = await this.listAccounts();

    const byUserId = new Map(accounts.map((account) => [account.user_id, account]));
    const byEmail = new Map(accounts.map((account) => [normalizeEmail(account.email), account]));
    const represented = new Set<string>();

    const members: HouseholdMember[] = people.map((person) => {
      // A linked row names its account outright. An unlinked one can only be
      // matched by email — which is exactly how `ensureCurrentUser` will link
      // it when its owner first signs in, so the two agree by construction.
      const account = person.user_id
        ? byUserId.get(person.user_id)
        : person.email
          ? byEmail.get(normalizeEmail(person.email))
          : undefined;
      if (account) represented.add(account.user_id);
      return toMember(person, account);
    });

    // Accounts with no person row of their own, appended after the household
    // itself. Ordered by email from the query above, so the whole list is
    // deterministic.
    for (const account of accounts) {
      if (!represented.has(account.user_id)) members.push(toMember(undefined, account));
    }
    return members;
  }

  /**
   * Invites one email into the household: an account to sign in with, the
   * membership row that grants the role, and the person row that — under this
   * design — IS the membership.
   *
   * CLOUDFLARE ACCESS IS A SEPARATE SYSTEM AND IS NOT TOUCHED HERE. This
   * method sends nothing and notifies nobody; it writes database rows. Access
   * decides who may authenticate at all, and an invited email that is not
   * permitted through the Access application reaches a login wall rather than
   * this app. Adding the address there is a manual step for the operator. Do
   * not "fix" this by calling an Access API from the request path: the invite
   * would then depend on a credential and a network hop that the rest of the
   * app does not have, and would fail in a way an owner could not undo.
   *
   * Idempotent in every direction. Inviting the same address twice reuses the
   * account, leaves the existing membership and person row alone, and returns
   * the state that actually exists rather than the state that was asked for.
   */
  async invite(input: InviteHouseholdMemberInput): Promise<HouseholdMember> {
    this.requireOwner();
    if (!INVITABLE_ROLES.includes(input.role)) {
      throw new ValidationError("Choose a role of admin or viewer");
    }
    const email = normalizeEmail(input.email);
    if (email.length > MAX_EMAIL_CHARS || !EMAIL_RE.test(email)) {
      throw new ValidationError("Enter a valid email address");
    }
    const displayName = input.displayName?.trim() || displayNameFromEmail(email);
    const now = new Date().toISOString();

    const user = await this.provisionUser(email, now);

    await this.unscopedBatchRun(
      "owner is provisioning one invited email: the household membership that carries its role and the person row that constitutes that membership must land together or not at all",
      [
        {
          // DO NOTHING, not DO UPDATE SET role: a second invite must never
          // rewrite a role that already exists. The address being re-invited
          // could be the household's own owner, and silently demoting the only
          // owner to `viewer` would lock the household out of its own
          // administration with no way back. Changing a role is a different
          // operation, and it is not this one.
          sql: `INSERT INTO household_member (household_id, user_id, role)
                VALUES (?, ?, ?)
                ON CONFLICT(household_id, user_id) DO NOTHING`,
          params: [this.ctx.householdId, user.id, input.role],
        },
        {
          // `user_id` is NULL on purpose. The row is a standing invitation
          // until its owner signs in and `PersonRepo.ensureCurrentUser` links
          // it by email — writing the id here would make the row read as
          // already-onboarded the moment it was created, erasing the one state
          // this list exists to show. It also keeps clear of migration 0012's
          // unique index on person(household_id, user_id) WHERE user_id IS NOT
          // NULL, which a concurrent invite could otherwise collide with.
          //
          // The NOT EXISTS guard rides inside the INSERT rather than being a
          // prior SELECT, so the check and the write are one statement and a
          // second invite cannot slip a duplicate person in between them.
          sql: `INSERT INTO person (id, household_id, user_id, display_name, email, created_at)
                SELECT ?, ?, NULL, ?, ?, ?
                 WHERE NOT EXISTS (
                   SELECT 1 FROM person
                    WHERE household_id = ?
                      AND (user_id = ? OR lower(trim(email)) = ?)
                 )`,
          params: [
            newId(),
            this.ctx.householdId,
            displayName,
            email,
            now,
            this.ctx.householdId,
            user.id,
            email,
          ],
        },
      ],
    );

    // Recorded after the rows land, never before: an entry written ahead of
    // the batch would claim an invitation that a failed write never made.
    // `subjectId` is the ACCOUNT id, because that is what identifies a
    // household_member row (the household half is the audit row's own).
    // `fields` names the column the invite decided and nothing else — the
    // address invited is a value, and values never enter this table.
    await this.audit.record({
      event: "member_invited",
      subjectType: "household_member",
      subjectId: user.id,
      selfService: false,
      fields: ["role"],
    });

    // Read back rather than echo the input. Both writes above are conditional,
    // so on a repeat invite the stored role and the stored display name are the
    // ones from the FIRST invite — reporting what was asked for would tell the
    // owner their change took effect when it did not.
    return this.memberForUser(user.id);
  }

  /**
   * Promotes or demotes an existing member. "Admin" is this app's word for an
   * administrator: they may edit everyone's records, not only their own.
   *
   * `owner` is not settable here, in either direction of intent. Making someone
   * an owner hands over the audit trail, the ingest configuration, and the
   * power to demote whoever granted it — a transfer, not a permission tweak,
   * and a different operation from this one.
   */
  async setRole(userId: string, role: InvitableRole): Promise<HouseholdMember> {
    this.requireOwner();
    if (!INVITABLE_ROLES.includes(role)) {
      throw new ValidationError("Choose a role of admin or viewer");
    }
    // THE CHECK IS "YOURSELF", NOT "THE LAST OWNER", and deliberately so.
    //
    // Counting owners and refusing only when the count would reach zero is the
    // more permissive rule, and it is the one that can still fail: two owners
    // demoting each other at the same moment both read a count of two, both
    // pass, and the household is left with none. This rule needs no count and
    // has no race — an owner may never change their own row, so the caller is
    // still an owner when the statement finishes, and a household therefore
    // always retains at least one.
    //
    // The cost is that one of two co-owners cannot step down unaided. That is a
    // rare action with an obvious workaround (the other owner does it), traded
    // against a failure mode with none: a household locked out of its own
    // administration cannot be repaired from inside the app at all.
    if (userId === this.ctx.userId) {
      throw new ValidationError(
        "You cannot change your own role. Another owner has to do it, so a household is never left without one.",
      );
    }

    const membership = (await this.listAccounts(userId))[0];
    // NotFoundError, never ForbiddenError: an unknown user id and one that
    // belongs to a household the caller cannot see must be indistinguishable,
    // or the difference between the two answers becomes a membership oracle.
    if (!membership) throw new NotFoundError("Member not found in this household");

    await this.unscopedRun(
      "household_member is keyed by household and user rather than carrying a scoped repository of its own; the household id below comes from the caller's context, never from an argument",
      "UPDATE household_member SET role = ? WHERE household_id = ? AND user_id = ?",
      role,
      this.ctx.householdId,
      userId,
    );

    // Same shape as the invite entry, and for the stronger reason: this is the
    // one action that changes what somebody else is allowed to see and edit,
    // so "who granted this, and when" has to survive the next role change.
    // The new role is not written into `fields` — that column takes names.
    await this.audit.record({
      event: "member_role_changed",
      subjectType: "household_member",
      subjectId: userId,
      selfService: false,
      fields: ["role"],
    });

    return this.memberForUser(userId);
  }

  /** One member, assembled from the account row and whichever person row it answers to. */
  private async memberForUser(userId: string): Promise<HouseholdMember> {
    const account = (await this.listAccounts(userId))[0];
    // Both callers have just written or verified this row inside the same
    // request. Its absence is a broken invariant, not a bad argument.
    if (!account) throw new Error("Household membership disappeared after being written");
    const person = await this.get<PersonRow>(
      `SELECT id, user_id, display_name, email
         FROM person
        WHERE {scope}
          AND (user_id = ?2 OR (user_id IS NULL AND lower(trim(email)) = ?3))
        ORDER BY (user_id IS NULL)
        LIMIT 1`,
      userId,
      normalizeEmail(account.email),
    );
    return toMember(person, account);
  }

  /**
   * Finds or creates the account for a normalized email.
   *
   * Outside the batch, unlike everything it feeds: the membership and person
   * rows both need the user id, and an `ON CONFLICT DO NOTHING` insert does not
   * report which id won when the row already existed. Reading it back is the
   * only way to know. Same sequence as `TripAccessRepo.invite()`.
   */
  private async provisionUser(email: string, now: string): Promise<{ id: string }> {
    const find = async () =>
      (
        await this.unscoped<{ id: string }>(
          "user accounts are globally keyed by case-insensitive email and belong to no single household",
          "SELECT id FROM user WHERE lower(email) = ?",
          email,
        )
      )[0];

    const existing = await find();
    if (existing) return existing;

    await this.unscopedRun(
      "user accounts are globally keyed by normalized email; owner is provisioning an invited account",
      `INSERT INTO user (id, email, created_at)
       VALUES (?, ?, ?)
       ON CONFLICT DO NOTHING`,
      newId(),
      email,
      now,
    );
    const created = await find();
    if (!created) throw new Error("Invited user disappeared after provisioning");
    return created;
  }

  /** The accounts that can reach this household, optionally narrowed to one. */
  private async listAccounts(userId?: string): Promise<AccountRow[]> {
    const reason =
      "user carries no household of its own and household_member is a join table; both halves are pinned to the caller's household by the explicit predicate below";
    return userId
      ? this.unscoped<AccountRow>(
          reason,
          `SELECT hm.user_id, u.email, hm.role
             FROM household_member hm
             JOIN user u ON u.id = hm.user_id
            WHERE hm.household_id = ? AND hm.user_id = ?`,
          this.ctx.householdId,
          userId,
        )
      : this.unscoped<AccountRow>(
          reason,
          `SELECT hm.user_id, u.email, hm.role
             FROM household_member hm
             JOIN user u ON u.id = hm.user_id
            WHERE hm.household_id = ?
            ORDER BY lower(u.email)`,
          this.ctx.householdId,
        );
  }

  /**
   * The roster is readable by everyone the household considers family, and by
   * nobody else.
   *
   * Owner and admin already see every person through `PersonRepo.list()`, so
   * this discloses nothing new to them. A `viewer` is the delicate case,
   * because that role covers two very different people: a family member the
   * owner pre-seeded, and a weekend guest invited to a single shared trip by
   * `TripAccessRepo.invite()`. `PersonRepo.list()` deliberately shows the
   * second one only the travelers on their own trips; handing that same account
   * the household's full roster of names and email addresses here would undo
   * that in a different URL.
   *
   * The design's own distinction settles it: a person row is what makes you
   * family. A viewer who has one reads the roster; a trip guest, who by
   * construction has none, does not.
   */
  private async requireRosterRead(): Promise<void> {
    if (this.ctx.role !== "viewer") return;
    const own = await this.get<{ id: string }>(
      "SELECT id FROM person WHERE {scope} AND user_id = ?2",
      this.ctx.userId,
    );
    if (!own) {
      throw new ForbiddenError("Only household members may view the household roster");
    }
  }

  private requireOwner(): void {
    if (this.ctx.role !== "owner") {
      throw new ForbiddenError("Only household owners may invite members");
    }
  }
}

function toMember(person: PersonRow | undefined, account: AccountRow | undefined): HouseholdMember {
  const claimed = Boolean(person?.user_id);
  return {
    personId: person?.id ?? null,
    displayName: person?.display_name ?? null,
    // The account's address wins where there is one: it is what they actually
    // authenticate with, and the person row's own email is free text an owner
    // may have since edited.
    email: account?.email ?? person?.email ?? null,
    userId: account?.user_id ?? person?.user_id ?? null,
    role: account?.role ?? null,
    claimed,
    status: !person ? "guest" : claimed ? "onboarded" : account ? "invited" : "unclaimed",
  };
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * A readable stand-in when an invite carries no name, so the members list
 * never renders a blank row next to a real role. Purely cosmetic — the owner
 * edits the person afterwards, and nothing keys off this string.
 */
function displayNameFromEmail(email: string): string {
  const words = email.split("@")[0]!.split(/[._+-]+/).filter(Boolean);
  const value = words.map((word) => word[0]!.toUpperCase() + word.slice(1)).join(" ");
  return value || email;
}
