import { useEffect, useState } from "react";
import { UserPlus } from "@phosphor-icons/react";
import { api as defaultApi } from "../api/client.js";
import { useIdentity } from "../api/identity.js";
import type { HouseholdMember, HouseholdMemberStatus, InvitableRole } from "../api/types.js";
import { errorMessage } from "../lib/errors.js";
import "../pages/settings.css";
import "./household.css";

/**
 * How each roster state is presented, and — more to the point — what it means.
 *
 * The whole reason this section exists rather than a plain list of names is
 * that "invited but never signed in" is invisible everywhere else in the app.
 * An owner who has provisioned a teenager's row and is waiting for them to
 * turn up has no other way to tell that state from "they are here"; both look
 * like a person with an email. So the four states are spelled out, each with
 * a sentence saying what the household should do about it, and given distinct
 * tag treatments so the list can be scanned rather than read.
 *
 * `guest` is listed rather than hidden, and that is a deliberate choice. It is
 * what `TripAccessRepo.invite()` leaves behind: an account with household
 * access and no person row, created to share a single trip. Those are exactly
 * the people a household forgets it ever let in — nobody goes looking for a
 * weekend guest from two summers ago — which makes hiding them from the one
 * screen that answers "who can reach my household" the wrong call.
 */
const STATUS: Record<
  HouseholdMemberStatus,
  { label: string; tone: "accent" | "neutral" | "outline"; note: string }
> = {
  onboarded: {
    label: "Signed in",
    tone: "accent",
    note: "They have signed in and this record is theirs to edit.",
  },
  invited: {
    label: "Not signed in yet",
    tone: "outline",
    note: "Invited, but nobody has signed in as them yet. Cloudflare Access must allow the address before they can.",
  },
  unclaimed: {
    label: "No account",
    tone: "neutral",
    note: "A person the household tracks with no account behind them — a child, or someone who was never invited.",
  },
  guest: {
    label: "Trip guest",
    tone: "neutral",
    note: "Invited to a single shared trip, not to the household. They have no record of their own here.",
  },
};

const ROLE_LABEL: Record<string, string> = {
  owner: "Owner",
  admin: "Admin",
  viewer: "Viewer",
};

/**
 * The household roster, as a section of `/settings` — who is in this
 * household, what role they hold, and whether they have actually signed in
 * yet. It replaces the standalone `/people` page, because under the profile
 * design a person row IS the membership: provisioning one is how an owner
 * makes somebody part of the household.
 *
 * Everything that writes here is owner-only, and the affordances follow: an
 * admin reading this page sees the roster and no controls, because `invite`
 * and `setRole` both call `requireOwner()` and a button that can only ever 403
 * is a false offer (the same rule `useCanWrite` exists to keep elsewhere).
 * The server is still the thing enforcing it.
 */
export function HouseholdMembers({
  api = defaultApi,
  /** Test seam. In the app the role comes from `/api/me` via IdentityProvider. */
  role,
}: {
  api?: typeof defaultApi;
  role?: string;
}) {
  const identity = useIdentity();
  const isOwner = (role ?? identity?.role) === "owner";

  const [members, setMembers] = useState<HouseholdMember[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.household.members().then(
      (rows) => {
        if (!cancelled) setMembers(rows);
      },
      // An empty household and a failed fetch must never look the same; without
      // this the section sits on "Loading…" forever and the rejection goes
      // unhandled.
      (err) => {
        if (!cancelled) setError(errorMessage(err));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [api]);

  /**
   * Replace by account id where there is one, else by person id. A re-invite
   * returns the member that already existed rather than a new one, so the row
   * has to be matched and swapped instead of appended — otherwise inviting the
   * same address twice shows the same person twice.
   */
  function upsert(member: HouseholdMember) {
    setMembers((current) => {
      const rows = current ?? [];
      const same = (row: HouseholdMember) =>
        member.userId !== null ? row.userId === member.userId : row.personId === member.personId;
      return rows.some(same) ? rows.map((row) => (same(row) ? member : row)) : [...rows, member];
    });
  }

  return (
    <section className="card settings-form" aria-label="Household members" id="members">
      <h4 style={{ margin: 0 }}>Members</h4>
      <p className="text-muted field-hint" style={{ margin: 0 }}>
        Everyone who is in this household or can reach it. Adding somebody here is what makes them
        part of it — their travel documents live on their own profile.
      </p>

      {error && (
        <p className="warning" role="alert">
          {error}
        </p>
      )}

      {!error && members === null && (
        <p className="text-muted" style={{ margin: 0 }}>
          Loading…
        </p>
      )}

      {!error && members !== null && members.length === 0 && (
        <p className="text-muted" style={{ margin: 0 }}>
          Nobody here yet. Nothing else in Travel HQ works until the family is entered — trips need
          travellers and bookings need people to be on them.
        </p>
      )}

      {!error && members !== null && members.length > 0 && (
        <ul className="member-list" aria-label="Household roster">
          {members.map((member) => (
            <MemberRow
              key={member.userId ?? member.personId ?? member.email}
              member={member}
              api={api}
              isOwner={isOwner}
              onChanged={upsert}
            />
          ))}
        </ul>
      )}

      {isOwner && <InviteForm api={api} onInvited={upsert} />}
    </section>
  );
}

function MemberRow({
  member,
  api,
  isOwner,
  onChanged,
}: {
  member: HouseholdMember;
  api: typeof defaultApi;
  isOwner: boolean;
  onChanged: (member: HouseholdMember) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const status = STATUS[member.status];
  const name = member.displayName ?? member.email ?? "Unnamed";

  /**
   * The role select is offered only where changing it is a coherent request:
   * an owner may not be demoted here (that is a transfer of the household, and
   * the server refuses it), and a row with no account behind it has nothing to
   * set a role ON — an `unclaimed` person is not a member of anything yet.
   */
  const settable = isOwner && member.userId !== null && member.role !== "owner";

  async function setRole(next: InvitableRole) {
    if (!member.userId) return;
    setBusy(true);
    setError(null);
    try {
      onChanged(await api.household.setRole(member.userId, next));
    } catch (err) {
      // The server's own sentence, verbatim. The one that matters most is the
      // refusal to change your own role — it explains WHY (a household must
      // never be left without an owner) and what to do instead (ask the other
      // owner), and replacing it with "that didn't work" would throw both away.
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className={`member-row member-row--${member.status}`} data-status={member.status}>
      <span className="member-identity">
        <span className="member-name">{name}</span>
        {/* Only when it says something the name did not. A `guest` has no
            person row and therefore no display name, so the address IS the
            name — printing it twice would make the row look like it holds two
            different facts about somebody. */}
        {member.email && member.email !== name && (
          <span className="member-email">{member.email}</span>
        )}
      </span>

      <span className="member-state">
        <span className={`tag tag-${status.tone}`}>{status.label}</span>
        {settable ? (
          // Named per person rather than "Role": there is one of these on
          // every row, and "Role" alone would give a screen-reader user five
          // identically-named controls and no way to tell whose is whose.
          <select
            className="member-role"
            value={member.role ?? "viewer"}
            disabled={busy}
            aria-label={`Role for ${name}`}
            onChange={(event) => void setRole(event.target.value as InvitableRole)}
          >
            <option value="admin">Admin</option>
            <option value="viewer">Viewer</option>
          </select>
        ) : (
          member.role && <span className="tag tag-neutral">{ROLE_LABEL[member.role] ?? member.role}</span>
        )}
      </span>

      <p className="member-note text-muted">{status.note}</p>
      {error && (
        <p className="warning member-error" role="alert">
          {error}
        </p>
      )}
    </li>
  );
}

function InviteForm({
  api,
  onInvited,
}: {
  api: typeof defaultApi;
  onInvited: (member: HouseholdMember) => void;
}) {
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [role, setRole] = useState<InvitableRole>("viewer");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [invited, setInvited] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    setInvited(null);
    try {
      const member = await api.household.invite({
        email: email.trim(),
        role,
        ...(displayName.trim() ? { displayName: displayName.trim() } : {}),
      });
      onInvited(member);
      setInvited(member.email ?? email.trim());
      setEmail("");
      setDisplayName("");
    } catch (err) {
      // "Enter a valid email address" and "Choose a role of admin or viewer"
      // are sentences the server wrote for whoever is looking at this form;
      // errors.ts hands the 400 body back verbatim for exactly that reason.
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="hr" />
      <h5 className="section-kicker" style={{ margin: 0 }}>
        Invite someone
      </h5>

      {/* THE SENTENCE THIS FORM CANNOT DO WITHOUT.
          Inviting writes database rows and sends nothing. Cloudflare Access is
          a separate system that decides who may authenticate at all, and an
          address Access does not admit reaches a login wall rather than Travel
          HQ. Without saying so, the owner invites their partner, nothing
          arrives, the partner cannot get in, and the feature looks broken when
          it worked exactly as designed. Adding the address to Access is a
          manual step for whoever runs this. */}
      <p className="member-invite-note" role="note">
        This does not send anything. It creates their record here — you still have to add the
        address to Cloudflare Access yourself, or they will hit a login wall instead of Travel HQ.
      </p>

      <div className="member-invite-form">
        <label className="field">
          <span>Email</span>
          <input
            type="email"
            value={email}
            placeholder="traveler@example.com"
            onChange={(event) => setEmail(event.target.value)}
          />
        </label>
        <label className="field">
          <span>Name (optional)</span>
          <input
            value={displayName}
            placeholder="From the email if left blank"
            onChange={(event) => setDisplayName(event.target.value)}
          />
        </label>
        <label className="field">
          <span>Role</span>
          <select value={role} onChange={(event) => setRole(event.target.value as InvitableRole)}>
            <option value="viewer">Viewer — sees the household, changes nothing</option>
            <option value="admin">Admin — edits everyone's records</option>
          </select>
        </label>
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy || email.trim() === ""}
          onClick={() => void submit()}
        >
          <UserPlus size={14} /> Invite
        </button>
      </div>

      {error && (
        <p className="warning" role="alert">
          {error}
        </p>
      )}
      {invited && (
        <p className="text-muted field-hint" style={{ margin: 0 }} role="status">
          {invited} is in the household. Add them to Cloudflare Access so they can sign in.
        </p>
      )}
    </>
  );
}
