import { useState } from "react";
import type { api as defaultApi } from "../api/client.js";
import type { BookingKind, DraftBooking } from "../api/types.js";
import { utcToZonedLocal, zonedToUtc } from "../lib/dates.js";
import { errorMessage } from "../lib/errors.js";
import { zoneOptions } from "../lib/timezones.js";
import { Dialog } from "../components/Dialog.js";

/**
 * The kind list the reviewer can reclassify to. Unlike the booking dialog,
 * "other" IS offered: it is where .ics drafts arrive (a VEVENT does not say
 * what it is) and the escape hatch when the extracted details don't fit a
 * specific kind.
 */
const KIND_OPTIONS: { id: BookingKind; label: string }[] = [
  { id: "flight", label: "Flight" },
  { id: "lodging", label: "Stay" },
  { id: "car", label: "Car" },
  { id: "activity", label: "Activity" },
  { id: "other", label: "Other" },
];

/**
 * Edit-before-accept: extraction is a suggestion, not truth, so every
 * extracted field is editable — kind, title, location, confirmation number,
 * and both timestamp/timezone pairs. Timestamps prefill as the wall-clock
 * time in the DRAFT'S OWN zone (utcToZonedLocal), not the browser's, and
 * round-trip back through zonedToUtc on save.
 */
export function EditDraftDialog({
  draft,
  api,
  onSaved,
  onClose,
}: {
  draft: DraftBooking;
  api: typeof defaultApi;
  onSaved: (updated: DraftBooking) => void;
  onClose: () => void;
}) {
  const [kind, setKind] = useState<BookingKind>(draft.kind);
  const [title, setTitle] = useState(draft.title);
  const [location, setLocation] = useState(draft.location ?? "");
  const [confirmationNumber, setConfirmationNumber] = useState(draft.confirmationNumber ?? "");
  const [startsAt, setStartsAt] = useState(
    draft.startsAt && draft.startsAtTz ? utcToZonedLocal(draft.startsAt, draft.startsAtTz) : "",
  );
  const [startsAtTz, setStartsAtTz] = useState(draft.startsAtTz ?? "");
  const [endsAt, setEndsAt] = useState(
    draft.endsAt && draft.endsAtTz ? utcToZonedLocal(draft.endsAt, draft.endsAtTz) : "",
  );
  const [endsAtTz, setEndsAtTz] = useState(draft.endsAtTz ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // The draft's stored zones join the options even when the curated list
  // doesn't know them — see zoneOptions.
  const zones = zoneOptions(draft.startsAtTz, draft.endsAtTz);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (title.trim() === "") {
      setError("A title is required.");
      return;
    }
    // A timestamp without its zone is exactly what the server rejects —
    // catch it here, where the message can name the field.
    if (startsAt !== "" && startsAtTz === "") {
      setError("Pick a timezone for the start time.");
      return;
    }
    if (endsAt !== "" && endsAtTz === "") {
      setError("Pick a timezone for the end time.");
      return;
    }

    let startsUtc: string | null = null;
    let endsUtc: string | null = null;
    try {
      if (startsAt !== "") startsUtc = zonedToUtc(startsAt, startsAtTz);
      if (endsAt !== "") endsUtc = zonedToUtc(endsAt, endsAtTz);
    } catch (err) {
      setError(err instanceof RangeError ? err.message : errorMessage(err));
      return;
    }

    setBusy(true);
    setError(null);
    try {
      // Full replace on purpose: sending every field (null = clear) keeps
      // the form the single source of what the reviewer sees, rather than
      // diffing against the draft to decide which keys to include.
      const updated = await api.import.updateDraft(draft.id, {
        kind,
        title: title.trim(),
        location: location.trim() === "" ? null : location.trim(),
        confirmationNumber: confirmationNumber.trim() === "" ? null : confirmationNumber.trim(),
        startsAt: startsUtc,
        startsAtTz: startsUtc === null ? null : startsAtTz,
        endsAt: endsUtc,
        endsAtTz: endsUtc === null ? null : endsAtTz,
      });
      onSaved(updated);
    } catch (err) {
      // Keep whatever the reviewer typed — never blow away their input on a
      // rejected write. Same rule as Settings/TripForm/PersonForm.
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog title="Edit draft" subtitle={draft.title} onClose={onClose}>
      <form onSubmit={submit} style={{ display: "grid", gap: 14 }}>
        {error && (
          <p className="warning" role="alert" style={{ margin: 0 }}>
            {error}
          </p>
        )}

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <div className="field">
            <label htmlFor="ed-kind">Kind</label>
            <select
              id="ed-kind"
              className="input"
              value={kind}
              onChange={(e) => setKind(e.target.value as BookingKind)}
            >
              {KIND_OPTIONS.map(({ id, label }) => (
                <option key={id} value={id}>
                  {label}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="ed-conf">Confirmation #</label>
            <input
              id="ed-conf"
              className="input"
              autoComplete="off"
              value={confirmationNumber}
              onChange={(e) => setConfirmationNumber(e.target.value)}
            />
          </div>
        </div>

        <div className="field">
          <label htmlFor="ed-title">Title</label>
          <input
            id="ed-title"
            className="input"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </div>

        <div className="field">
          <label htmlFor="ed-location">Location</label>
          <input
            id="ed-location"
            className="input"
            value={location}
            onChange={(e) => setLocation(e.target.value)}
          />
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <div className="field">
            <label htmlFor="ed-starts">Departs / starts</label>
            <input
              id="ed-starts"
              className="input"
              type="datetime-local"
              value={startsAt}
              onChange={(e) => setStartsAt(e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="ed-starts-tz">Departs timezone</label>
            <select
              id="ed-starts-tz"
              className="input"
              value={startsAtTz}
              onChange={(e) => setStartsAtTz(e.target.value)}
            >
              <option value="">Pick a timezone…</option>
              {zones.map((z) => (
                <option key={z} value={z}>
                  {z}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <div className="field">
            <label htmlFor="ed-ends">Arrives / ends</label>
            <input
              id="ed-ends"
              className="input"
              type="datetime-local"
              value={endsAt}
              onChange={(e) => setEndsAt(e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="ed-ends-tz">Arrives timezone</label>
            <select
              id="ed-ends-tz"
              className="input"
              value={endsAtTz}
              onChange={(e) => setEndsAtTz(e.target.value)}
            >
              <option value="">Pick a timezone…</option>
              {zones.map((z) => (
                <option key={z} value={z}>
                  {z}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="dialog-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            Save draft
          </button>
        </div>
      </form>
    </Dialog>
  );
}
