import { useState } from "react";
import { api as defaultApi } from "../api/client.js";
import type { CreatePersonInput, Person, UpdatePersonInput } from "../api/types.js";
import { errorMessage } from "../lib/errors.js";
import { Dialog } from "./Dialog.js";
import { PersonDetailFields, PersonDocumentFields, usePersonFields } from "./PersonFields.js";

/**
 * Create when `person` is absent, edit when present. The household roster's
 * way of editing anybody.
 *
 * The fields themselves now live in `PersonFields`, shared with the profile
 * page, and so does the tri-state document handling that keeps a masked value
 * from being submitted as plaintext — read `usePersonFields` for what that
 * costs and why. This component keeps only what is specific to a roster
 * dialog: the create/edit split, `notes`, and the dialog chrome.
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

  const fields = usePersonFields(person);
  // Not in `usePersonFields`: an annotation the household keeps about a
  // person, which is a roster concern rather than part of anybody's profile.
  const [notes, setNotes] = useState(person?.notes ?? "");

  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const invalid = fields.validate();
    if (invalid) {
      setError(invalid);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const saved = editing
        ? await api.people.update(person.id, {
            ...fields.toUpdateInput(),
            notes: notes === "" ? null : notes,
          } satisfies UpdatePersonInput)
        : await api.people.create({
            ...fields.toCreateInput(),
            ...(notes === "" ? {} : { notes }),
          } satisfies CreatePersonInput);
      onSaved(saved);
    } catch (err) {
      // Never close on failure: a 403 (viewer editing somebody else) or the
      // server's masked-value 400 must leave the typed values on screen, not
      // discard them behind a dialog that vanished as if it had worked.
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

        <PersonDetailFields idPrefix="pf" fields={fields} />
        <PersonDocumentFields idPrefix="pf" fields={fields} person={person} />

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
