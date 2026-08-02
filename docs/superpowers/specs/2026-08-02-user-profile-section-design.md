# Your profile: per-user data ownership

**Date:** 2026-08-02
**Status:** approved, implementing
**Supersedes:** nothing. Extends the person model from #1 and the notification
settings from #61.

## The problem

Travel HQ stores a person's name, date of birth, email, phone, passport number
and expiry and country, known traveler number, and redress number. All of it is
editable today, and none of it belongs to anybody.

The permission model has exactly two states. A `viewer` writes nothing. An
`adult` or `owner` writes *everyone's* record. So a teenager cannot correct
their own phone number, and either parent can silently rewrite the other's
passport number. There is no expression of "this row is mine".

The server already knows which row is yours — `person.user_id`, unique per
household since migration 0012 — but nothing in the UI treats it as a
destination. `POST /api/people/me` exists and is called only to answer "which
traveler am I?" when assigning people to a booking.

Meanwhile the two halves of your own data sit in different places for reasons
that are historical rather than deliberate: personal details on `/people`, mixed
in with everyone else's, and notification preferences on `/settings`, next to
email-ingest and extraction-model settings that only an owner can change.

## What we are building

Your data is yours. The owner's job is provisioning.

1. **A pre-seeded person row is household membership.** The owner creates a
   person; when that email signs in, it links to their account. This is the
   onboarding gate.
2. **You may always edit your own row**, whatever your role — including
   `viewer`.
3. **Self-edit is purely additive.** Nothing is taken away from anybody — an
   admin still edits every other row in the household. Self-edit is a
   permission added, never one revoked.
4. **The owner can grant and revoke the admin role.** The middle tier becomes
   something you hand out, so it is renamed from `adult` to `admin`: what is
   being granted is the ability to edit everyone, which is a statement about
   trust rather than age.
5. **Every change is recorded, not just reveals.** `audit_log` becomes a rolling
   household activity log, readable at `/audit`.
6. **You may reveal your own document numbers**, whatever your role.
7. **`/me` is where your data lives** — details, documents, and notifications
   together.
8. **`/settings` is where the household is administered**, and gains the members
   list that `/people` used to be.

Explicitly **not** in this change: document photographs and on-device OCR. That
is a separate issue, because a passport image is more sensitive than the
passport number we already bother to encrypt, and the only existing R2 precedent
(trip cover photos) stores bytes in the clear.

## Decisions, and what they cost

### A pre-seeded row is membership

`PersonRepo.ensureCurrentUser()` currently does three things: return the row
linked to your user, else adopt an unlinked row matching your email, else
**create one from scratch**. That third branch is dropped.

The reason is `TripAccessRepo.invite()`. It provisions a `household_member` row
with role `viewer` for anyone invited to a single shared trip. A weekend guest
and a family teenager are the same role. If `ensureCurrentUser` keeps
auto-creating, "viewers may edit their own person" hands that guest a passport
field in a household they barely belong to.

Dropping the create branch makes the distinction structural rather than
role-based: the owner pre-seeding you is what makes you family. A trip guest has
no person row, so there is nothing for them to own. No new role, no migration of
existing `household_member` rows.

The cost: `ensureCurrentUser` can now return nothing, and two existing callers
(`BookingDetailDialog`, `TravelersTab`) assume a `Person`. Both must handle the
absence, and `/me` must render an honest "no profile yet — ask an owner to add
you" rather than an empty form that silently saves nowhere.

`requireWrite()` also comes off this method. A viewer resolving their own
profile is a read, and gating it on write is what makes their own row
unreachable.

### Additive, and a grantable admin role

`PersonRepo.update()` gates on `requireWrite()`. It gains one branch above it:

```
if person.user_id == ctx.userId  -> allow, any role     (new)
else                             -> requireWrite()      (exactly as today)
```

Nothing is taken away. An admin still edits every other row in the household,
and a two-admin household works exactly as it does now.

An earlier draft made onboarding a *handover* — once a row was linked, only that
user and the owner could edit it. It was rejected because it revoked a
capability people already rely on: in a household with two adults where only one
is the owner, the other would have lost the ability to fix their partner's
details. A profile section is not worth a regression in the thing the household
already does every week.

Instead, elevated access becomes something an owner **grants**. `setRole()`
promotes and demotes, owner-only, and that is what makes the middle tier's name
worth fixing: it is handed out on trust, not held by age.

Two guardrails, both learned from thinking about what cannot be undone.
Promoting to `owner` is refused outright — ownership transfer has different
consequences and is not in scope. And an owner cannot change **their own** row:
counting owners to check "is this the last one?" races, because two owners
demoting each other both read a count of two and both pass, leaving a household
nobody can administer. Refusing self-change needs no count and cannot race.

### Renaming `adult` to `admin`

Until now the middle role was set once at seeding and never changed, so its name
never had to answer for itself. Making it grantable changes that: what an owner
hands out is the ability to edit everyone, which is a claim about trust, not
age. A teenager can be the one who keeps everyone's passports current; a
grandparent along for one trip should not be.

Migration `0019` rebuilds `household_member` — SQLite cannot ALTER a CHECK — and
translates the value during the copy, since the new constraint would reject an
`adult` row on the way in. `owner` and `viewer` are untouched; only the
ambiguous one moves. The code side is compiler-enforced: the role is a string
literal union, so TypeScript finds every site.

### Revealing your own documents

`requireReveal()` refuses viewers outright. Once you own your row that rule
contradicts itself: you could store a passport number and never read back the
one you stored, seeing only `••••2119`, unable to tell a typo from a correct
entry.

`revealDocument()` takes the same shape as `update()`: your own row is always
revealable; everyone else's stays behind `requireReveal()`.

The threat this accepts: a compromised viewer session now yields a real passport
number rather than a mask. Judged acceptable because the person is normally
holding the physical document, and because a write-only field is a trap.

**Self-reveals are marked in the audit trail.** The log exists so an owner can
ask "who looked at someone else's documents". A family of five checking their
own passport numbers would bury that signal. `audit_log` gains a `self_service`
flag, written at reveal time rather than derived later — the log has to outlive
the row it describes, so it cannot depend on `person.user_id` still being set,
or the person still existing.

### Household members and invites

`/people` becomes a section of `/settings`. It gains the ability to invite,
following `TripAccessRepo.invite()`: provision a `user` row from a normalized
email, insert a `household_member` row, and — new here — create the person row
that constitutes membership.

Two differences from the trip-level invite. The role is chosen (`admin` or
`viewer`) rather than hardcoded to `viewer`. And the person row is created in
the same batch, because under this design the row *is* the membership.

**Cloudflare Access is a separate system and is out of scope.** An invite writes
database rows; Access decides who may authenticate at all. An invited email that
is not permitted through the Access application reaches a login wall, not the
app. The invite UI says so, because otherwise it looks broken. The operator
handles Access by hand.

The members list shows role and whether the row has been claimed, because
"pre-seeded but not yet onboarded" is the state an owner most needs to see —
it is the difference between "I invited them" and "they are actually here".

## Shape

### Migrations

`0018_audit_activity.sql` rebuilds `audit_log`: adds `self_service` and a
`detail` column holding field NAMES, and widens the `event` and `subject_type`
CHECKs. `self_service` defaults to 0, which is right for history rather than
merely convenient — every reveal recorded before this change happened under a
rule that refused viewers outright and had no concept of a self-reveal.

`0019_role_admin.sql` rebuilds `household_member` for the role rename.

### Server

| Unit | Change |
| --- | --- |
| `PersonRepo.ensureCurrentUser` | no `requireWrite()`; link-or-nothing, never create. Returns `Person \| null`. |
| `PersonRepo.update` | self-edit branch above `requireWrite()`; emits `person_updated` |
| `PersonRepo.revealDocument` | self-reveal allowed at any role; reports whether it was self |
| `AuditRepo.recordReveal` | accepts and stores `selfService` |
| `HouseholdMemberRepo` (new) | `list()`, `invite({email, role, displayName})`, owner-only |
| `GET /api/people/me` | new read-only shape; 204 when no profile |
| `GET/POST /api/household/members` | list and invite |

`POST /api/people/me` keeps working for the two existing callers, but stops
creating.

### Client

| Route | Contents |
| --- | --- |
| `/me` | Your details · Your documents · Your notifications |
| `/settings` | Household: members + invite, email ingest, extraction, retention |
| `/people` | redirect to `/settings#members` |

`PersonForm` is a `Dialog` with hardcoded `pf-*` element ids, so it cannot be
dropped onto a page and two instances would collide ids. Its fields are
extracted into `PersonFields`, taking an id prefix, and used by both the roster
dialog and the profile page. This codebase is explicit elsewhere that it does
not want a second form that could disagree with the first.

`NotificationsCard` moves out of `Settings.tsx` into its own module and is
rendered by `/me`. It is already `memo`-wrapped and self-contained.

Navigation: the desktop nav and the mobile tab bar lose **People** and gain
**You**; the avatar menu gains **Your profile**. This also fixes a live problem
— notification setup was unreachable from the mobile tab bar, which is where
someone actually enables notifications on the phone they want them on.

## Testing

The permission matrix is the part where a mistake is a security bug rather than
a layout annoyance, so it is tested exhaustively rather than representatively:

- viewer edits own row → allowed
- viewer edits another's row → 403
- admin edits own row → allowed
- admin edits unlinked pre-seeded row → allowed
- admin edits another **onboarded** row → allowed *(pinned: this is the
  capability the rejected handover would have taken away, so it is asserted
  rather than left to be inferred from the absence of a test)*
- owner edits any row → allowed
- viewer reveals own document → allowed, audit row has `self_service = 1`
- viewer reveals another's document → 403
- owner reveals another's document → allowed, `self_service = 0`
- `ensureCurrentUser` with no matching row → returns nothing, **creates nothing**
- `ensureCurrentUser` adopts an unlinked row matching email, once
- cross-household person id → 404, never 403, for **every** role and both verbs
- invite is owner-only; admin and viewer both 403
- invite creates user + household_member + person in one batch
- invite twice with the same email is idempotent, and does not change the
  stored role
- promote and demote are owner-only; promoting to `owner` is refused; an owner
  changing their own role is refused
- a role change for a non-member → 404
- every change writes an audit row naming the fields, and **no audit row ever
  contains a value** — asserted directly against the stored `detail`

Client: `/me` renders the absent-profile state; a viewer sees editable own
fields; notification settings render on `/me` and no longer on `/settings`;
`/people` redirects.

Regression guard: the existing people, booking, and traveler-assignment suites
must pass untouched except where the stewardship rule deliberately changes an
outcome, and every such change is asserted rather than deleted.

## Version

Minor bump to **0.9.0** — this adds capability rather than fixing behaviour, and
the architecture test requires `package.json` and the newest `CHANGELOG.md`
heading to agree.
