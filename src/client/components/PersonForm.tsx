import { useState } from "react";
import { api as defaultApi } from "../api/client.js";
import type { CreatePersonInput, Person, UpdatePersonInput } from "../api/types.js";
import { errorMessage } from "../lib/errors.js";
import { Dialog } from "./Dialog.js";

/**
 * The three encrypted columns, in the order they appear on the form. Keyed by
 * the API's input-field name so the request body is assembled from this list
 * rather than from three near-identical hand-written branches.
 */
const DOCUMENTS = [
  { key: "passportNumber", label: "Passport number", masked: "passportNumberMasked" },
  { key: "knownTravelerNumber", label: "Known Traveler number", masked: "knownTravelerNumberMasked" },
  { key: "redressNumber", label: "Redress number", masked: "redressNumberMasked" },
] as const;

type DocumentKey = (typeof DOCUMENTS)[number]["key"];

/**
 * Create when `person` is absent, edit when present.
 *
 * The document inputs start EMPTY in both modes and are never seeded from
 * `person`. `PersonRepo.list()` returns document numbers masked
 * (`••••2119`), so seeding an input from the loaded person and submitting the
 * whole object would encrypt the mask over the real passport number — a
 * silent, unrecoverable data loss with a 200 response. Instead:
 *
 *   typed nothing  -> the key is omitted     -> server leaves it alone
 *   pressed Clear  -> the key is null        -> server clears it
 *   typed a value  -> the key is that string -> server replaces it
 *
 * The server also rejects any document value containing the mask glyph
 * (`PersonRepo.update`), so this is belt and braces rather than the sole
 * defence — but it is the layer that means the bad request is never made.
 */
export function PersonForm({
  person,
  api = defaultApi,
  onSaved,
  onClose,
}: {
  person?: Person;
  api?: typeof defaultApi;
  onSaved: (person: Person) => void;
  onClose: () => void;
}) {
  const editing = person !== undefined;

  const [displayName, setDisplayName] = useState(person?.displayName ?? "");
  const [dob, setDob] = useState(person?.dob ?? "");
  const [email, setEmail] = useState(person?.email ?? "");
  const [phone, setPhone] = useState(person?.phone ?? "");
  const [passportExpiry, setPassportExpiry] = useState(person?.passportExpiry ?? "");
  const [passportCountry, setPassportCountry] = useState(person?.passportCountry ?? "");
  const [notes, setNotes] = useState(person?.notes ?? "");

  // Typed replacements, keyed by document. Empty string means "untouched".
  const [documents, setDocuments] = useState<Record<DocumentKey, string>>({
    passportNumber: "",
    knownTravelerNumber: "",
    redressNumber: "",
  });
  // Documents the operator explicitly asked to clear.
  const [cleared, setCleared] = useState<Record<DocumentKey, boolean>>({
    passportNumber: false,
    knownTravelerNumber: false,
    redressNumber: false,
  });

  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /**
   * The document keys to send, as the tri-state: absent (untouched), a string
   * (replace), or — edit mode only — `null` (clear).
   *
   * The mode parameter is not cosmetic, it is what makes this typecheck.
   * `CreatePersonInput`'s document fields are `string | undefined`;
   * `UpdatePersonInput`'s are `string | null | undefined`. Spreading one
   * `string | null`-valued patch into both object literals fails
   * `satisfies CreatePersonInput` with TS1360 ("Type 'string | null |
   * undefined' is not assignable to type 'string | undefined'"). Two return
   * types, selected by the caller, keeps both branches honest.
   *
   * Runtime never hit this: the Clear button renders only when
   * `stored !== null`, which is never true in create mode. But `npm run
   * typecheck` would have.
   */
  function documentPatch(mode: "create"): Partial<Record<DocumentKey, string>>;
  function documentPatch(mode: "edit"): Partial<Record<DocumentKey, string | null>>;
  function documentPatch(
    mode: "create" | "edit",
  ): Partial<Record<DocumentKey, string | null>> {
    const patch: Partial<Record<DocumentKey, string | null>> = {};
    for (const { key } of DOCUMENTS) {
      const typed = documents[key].trim();
      // Order matters: a typed value wins over a stale Clear press, and an
      // untouched field contributes NO key at all rather than `undefined`.
      if (typed !== "") patch[key] = typed;
      // A clear is only expressible against a stored value, which only exists
      // in edit mode. In create mode the key is simply omitted.
      else if (mode === "edit" && cleared[key]) patch[key] = null;
    }
    return patch;
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (displayName.trim() === "") {
      setError("A name is required.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const saved = editing
        ? await api.people.update(person.id, {
            displayName: displayName.trim(),
            dob: dob === "" ? null : dob,
            email: email.trim() === "" ? null : email.trim(),
            phone: phone.trim() === "" ? null : phone.trim(),
            passportExpiry: passportExpiry === "" ? null : passportExpiry,
            passportCountry: passportCountry === "" ? null : passportCountry,
            notes: notes === "" ? null : notes,
            ...documentPatch("edit"),
          } satisfies UpdatePersonInput)
        : await api.people.create({
            displayName: displayName.trim(),
            ...(dob === "" ? {} : { dob }),
            ...(email.trim() === "" ? {} : { email: email.trim() }),
            ...(phone.trim() === "" ? {} : { phone: phone.trim() }),
            ...(passportExpiry === "" ? {} : { passportExpiry }),
            ...(passportCountry === "" ? {} : { passportCountry }),
            ...(notes === "" ? {} : { notes }),
            ...documentPatch("create"),
          } satisfies CreatePersonInput);
      onSaved(saved);
    } catch (err) {
      // Never close on failure: a 403 (viewer) or the server's masked-value
      // 400 must leave the typed values on screen, not discard them behind a
      // dialog that vanished as if it had worked.
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      title={editing ? `Edit ${person.displayName}` : "Add person"}
      onClose={onClose}
    >
      <form onSubmit={submit} style={{ display: "grid", gap: 14 }}>
        {error && (
          <p className="warning" role="alert" style={{ margin: 0 }}>
            {error}
          </p>
        )}

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <div className="field">
            <label htmlFor="pf-name">Name</label>
            <input
              id="pf-name"
              className="input"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="pf-dob">Date of birth</label>
            <input
              id="pf-dob"
              className="input"
              type="date"
              value={dob}
              onChange={(e) => setDob(e.target.value)}
            />
          </div>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <div className="field">
            <label htmlFor="pf-email">Email</label>
            <input
              id="pf-email"
              className="input"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="pf-phone">Phone</label>
            <input
              id="pf-phone"
              className="input"
              type="tel"
              autoComplete="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
            />
          </div>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <div className="field">
            <label htmlFor="pf-expiry">Passport expiry</label>
            <input
              id="pf-expiry"
              className="input"
              type="date"
              value={passportExpiry}
              onChange={(e) => setPassportExpiry(e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="pf-country">Passport country</label>
            <input
              id="pf-country"
              className="input"
              value={passportCountry}
              onChange={(e) => setPassportCountry(e.target.value)}
            />
          </div>
        </div>

        {DOCUMENTS.map(({ key, label, masked }) => {
          const stored = person?.[masked] ?? null;
          return (
            <div className="field" key={key}>
              <label htmlFor={`pf-${key}`}>
                {label}{" "}
                <span className="text-muted" style={{ fontSize: 11 }}>
                  · stored encrypted
                </span>
              </label>
              {stored !== null && (
                <div className="card-meta" style={{ marginBottom: 5 }}>
                  <span>currently <strong>{stored}</strong></span>
                  <button
                    type="button"
                    className="btn btn-ghost"
                    style={{ fontSize: 11 }}
                    aria-label={`Clear stored ${label.toLowerCase()}`}
                    aria-pressed={cleared[key]}
                    onClick={() => setCleared((c) => ({ ...c, [key]: !c[key] }))}
                  >
                    {cleared[key] ? "Will be cleared — undo" : "Clear"}
                  </button>
                </div>
              )}
              <input
                id={`pf-${key}`}
                className="input"
                autoComplete="off"
                // Never seeded from `person`. See the component docstring.
                value={documents[key]}
                placeholder={stored === null ? "" : "unchanged"}
                onChange={(e) => setDocuments((d) => ({ ...d, [key]: e.target.value }))}
              />
            </div>
          );
        })}

        <div className="field">
          <label htmlFor="pf-notes">Notes</label>
          <textarea
            id="pf-notes"
            className="input"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </div>

        <div className="dialog-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            Save
          </button>
        </div>
      </form>
    </Dialog>
  );
}
