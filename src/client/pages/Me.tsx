import { useEffect, useState } from "react";
import { FloppyDisk, UserCircle } from "@phosphor-icons/react";
import { api as defaultApi } from "../api/client.js";
import type { Person } from "../api/types.js";
import { errorMessage } from "../lib/errors.js";
import {
  PersonDetailFields,
  PersonDocumentFields,
  usePersonFields,
} from "../components/PersonFields.js";
import { NotificationsCard } from "../settings/NotificationsCard.js";
import "./settings.css";
import "./me.css";

/**
 * Loading is a state with four honest endings, and lumping any two of them
 * together is what this page exists to avoid:
 *
 *   loading  — nothing decided yet
 *   none     — you have no person row, which is a real answer, not an error
 *   ready    — your row
 *   failed   — the request itself did not land
 *
 * `none` and `failed` in particular must never look the same: one is "ask an
 * owner to add you", the other is "try again".
 */
type Load =
  | { status: "loading" }
  | { status: "none" }
  | { status: "ready"; person: Person }
  | { status: "failed"; message: string };

/**
 * `/me` — your details, your documents, your notifications.
 *
 * The two things this page gets to be, that the roster never could:
 *
 * 1. It is editable at ANY role. `PersonRepo.update` allows a row linked to
 *    the caller's own account before it consults the role at all, so gating
 *    the form on `useCanWrite()` would hide a form the server would happily
 *    accept — and it is exactly a viewer (a teenager, a shared-trip parent)
 *    for whom this is the only way to correct their own phone number.
 * 2. Its document numbers are revealable at any role, for the same reason
 *    (`PersonRepo.revealDocument`), because a number you can store and never
 *    read back is a trap: you cannot tell a typo from a correct entry.
 */
export function Me({ api = defaultApi }: { api?: typeof defaultApi }) {
  const [load, setLoad] = useState<Load>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    api.people.me().then(
      (person) => {
        if (cancelled) return;
        // undefined, not an error: GET /api/people/me answers 204 when nobody
        // has pre-seeded a row for this address. See the "none" branch below.
        setLoad(person ? { status: "ready", person } : { status: "none" });
      },
      (err: unknown) => {
        if (!cancelled) setLoad({ status: "failed", message: errorMessage(err) });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [api]);

  return (
    <>
      <header className="page-header">
        <div className="page-title-group">
          <h3>You</h3>
          <p className="page-subline">
            Your own details and travel documents, and the notifications this account
            receives. Only you and a household admin can edit this.
          </p>
        </div>
      </header>

      <div className="me-main">
        {load.status === "loading" && <p className="text-muted">Loading…</p>}
        {load.status === "failed" && (
          <p className="warning" role="alert">
            {load.message}
          </p>
        )}
        {load.status === "none" && <NoProfile />}
        {load.status === "ready" && (
          <MeProfile
            // Remount if the row is ever replaced: the fields seed from this
            // prop once, exactly as PersonForm does on the roster.
            key={load.person.id}
            person={load.person}
            api={api}
            onSaved={(person) => setLoad({ status: "ready", person })}
          />
        )}

        {/*
          Rendered in every state, including "no profile". Notification
          settings are keyed by the signed-in ACCOUNT, not by a person row, so
          a shared-trip guest with nothing else on this page can still register
          their phone — and that guest is precisely the account the
          notifications feature was built for.
        */}
        <NotificationsCard api={api} />
      </div>
    </>
  );
}

/**
 * No person row for this account.
 *
 * An empty form would be the tempting thing to render, and it would be a lie:
 * `ensureCurrentUser` no longer creates a row, so every field would save
 * nowhere. This state has a real cause and a real remedy, and both are worth
 * saying out loud — a pre-seeded row IS household membership, and a
 * shared-trip guest legitimately does not have one.
 */
function NoProfile() {
  return (
    <div className="card" style={{ alignItems: "flex-start", gap: 10 }}>
      <span className="card-title">
        <UserCircle size={16} style={{ marginRight: 6, verticalAlign: "-2px" }} />
        No profile yet
      </span>
      <p className="card-body" style={{ margin: 0 }}>
        Nobody in this household has added you as a person yet, so there is nothing here
        to edit. Ask a household owner to add you from Settings — once they do, this page
        becomes yours to keep up to date.
      </p>
      <p className="card-body text-muted" style={{ margin: 0 }}>
        If you were invited to a single shared trip, this is expected: you can see that
        trip without being part of the household. Your notification settings below still
        work either way.
      </p>
    </div>
  );
}

/**
 * The editable half. One form over two cards, and one Save: the details and
 * the documents are the same database row, and two buttons writing to the same
 * row is how a half-saved profile happens.
 */
function MeProfile({
  person,
  api,
  onSaved,
}: {
  person: Person;
  api: typeof defaultApi;
  onSaved: (person: Person) => void;
}) {
  const fields = usePersonFields(person);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setSaved(false);
    const invalid = fields.validate();
    if (invalid) {
      setError(invalid);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      // `toUpdateInput()` is where the tri-state lives: an untouched document
      // contributes no key at all, so the masked value on screen is never sent
      // back as plaintext. That is the whole reason the fields are shared with
      // PersonForm rather than rewritten here.
      onSaved(await api.people.update(person.id, fields.toUpdateInput()));
      setSaved(true);
    } catch (err) {
      // A ValidationError from the repository arrives as a 400 with no
      // `details`, which lib/errors.ts surfaces verbatim — "dob must be a
      // calendar date" is the server's sentence and it is better than any
      // paraphrase this form could offer.
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form noValidate onSubmit={submit} className="me-form">
      {error && (
        <p className="warning" role="alert" style={{ margin: 0 }}>
          {error}
        </p>
      )}
      {saved && (
        <p className="text-muted" role="status" style={{ margin: 0 }}>
          Your profile is saved.
        </p>
      )}

      <section className="card settings-form" aria-label="Your details">
        <h4>Your details</h4>
        <PersonDetailFields idPrefix="me" fields={fields} />
      </section>

      <section className="card settings-form" aria-label="Your documents">
        <h4>Your documents</h4>
        <p className="text-muted" style={{ margin: 0 }}>
          Numbers are stored encrypted and shown masked. Revealing one is recorded in the
          household activity log, marked as your own.
        </p>
        <PersonDocumentFields
          idPrefix="me"
          fields={fields}
          person={person}
          onReveal={async (field) => (await api.people.reveal(person.id, field)).value}
        />
      </section>

      <div>
        <button type="submit" className="btn btn-primary" disabled={busy}>
          <FloppyDisk size={14} /> Save your profile
        </button>
      </div>
    </form>
  );
}
