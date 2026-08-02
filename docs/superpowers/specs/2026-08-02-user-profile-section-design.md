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
3. **Onboarding hands over stewardship.** Once a row is linked to a user, only
   that user and the owner may edit it. Adults keep full control of unlinked,
   pre-seeded rows.
4. **You may reveal your own document numbers**, whatever your role.
5. **`/me` is where your data lives** — details, documents, and notifications
   together.
6. **`/settings` is where the household is administered**, and gains the members
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

### Stewardship, not shared custody

`PersonRepo.update()` gates on `requireWrite()`. It gains a rule that runs
first:

```
if person.user_id == ctx.userId        -> allow, any role
else if person.user_id is not null     -> owner only
else                                   -> requireWrite() as today
```

An adult loses the ability to edit another *onboarded* adult. That is the point,
and it is a real regression for a two-adult household where only one is owner —
the owner is the escape hatch, so nothing is unrecoverable.

Unlinked rows keep today's behaviour exactly, which is what keeps children and
pre-seeding working.

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

Two differences from the trip-level invite. The role is chosen (`adult` or
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

### Migration `0018_audit_self_service.sql`

```sql
ALTER TABLE audit_log
  ADD COLUMN self_service INTEGER NOT NULL DEFAULT 0;
```

Default 0 is right for existing rows: every reveal recorded before this change
was made under a rule that refused viewers, so none of them was a self-reveal by
a person who could not otherwise have looked.

### Server

| Unit | Change |
| --- | --- |
| `PersonRepo.ensureCurrentUser` | no `requireWrite()`; link-or-nothing, never create. Returns `Person \| null`. |
| `PersonRepo.update` | stewardship rule above `requireWrite()` |
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
- adult edits own row → allowed
- adult edits unlinked pre-seeded row → allowed
- adult edits another **onboarded** row → 403 *(the regression, pinned)*
- owner edits any row → allowed
- viewer reveals own document → allowed, audit row has `self_service = 1`
- viewer reveals another's document → 403
- owner reveals another's document → allowed, `self_service = 0`
- `ensureCurrentUser` with no matching row → returns nothing, **creates nothing**
- `ensureCurrentUser` adopts an unlinked row matching email, once
- cross-household person id → 404, never 403 (no membership oracle)
- invite is owner-only; adult and viewer both 403
- invite creates user + household_member + person in one batch
- invite twice with the same email is idempotent

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
