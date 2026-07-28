import { useState } from "react";
import { api as defaultApi, ApiError } from "../api/client.js";
import type {
  CreateTripFromDraftsInput,
  ImportReviewResult,
  PendingImportDraft,
} from "../api/types.js";
import { Dialog } from "../components/Dialog.js";
import { errorMessage } from "../lib/errors.js";

export function CreateImportedTripDialog({
  api = defaultApi,
  drafts,
  onCreated,
  onClose,
}: {
  api?: typeof defaultApi;
  drafts: PendingImportDraft[];
  onCreated: (result: ImportReviewResult) => void;
  onClose: () => void;
}) {
  const dates = combinedDates(drafts);
  const [title, setTitle] = useState(defaultTripTitle(drafts));
  const [destination, setDestination] = useState("");
  const [startsOn, setStartsOn] = useState(dates.startsOn);
  const [endsOn, setEndsOn] = useState(dates.endsOn);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /**
   * Armed by a 409: the selection repeats itself, and the second submit is the
   * reviewer answering that. Never set without them having seen the message —
   * the whole point of the refusal is that it is a question, not a hurdle.
   */
  const [allowDuplicates, setAllowDuplicates] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (title.trim() === "") {
      setError("A title is required.");
      return;
    }
    if (startsOn !== "" && endsOn !== "" && startsOn > endsOn) {
      setError("The end date cannot be before the start date.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const input = {
        draftIds: drafts.map((draft) => draft.id),
        title: title.trim(),
        ...(destination.trim() ? { destination: destination.trim() } : {}),
        ...(startsOn ? { startsOn } : {}),
        ...(endsOn ? { endsOn } : {}),
        ...(allowDuplicates ? { allowDuplicates: true } : {}),
      } satisfies CreateTripFromDraftsInput;
      onCreated(await api.imports.createTrip(input));
    } catch (err) {
      setError(errorMessage(err));
      if (err instanceof ApiError && err.status === 409) setAllowDuplicates(true);
      setBusy(false);
    }
  }

  return (
    <Dialog
      title="Create trip from imports"
      subtitle={`${drafts.length} selected`}
      onClose={onClose}
    >
      <form onSubmit={submit} style={{ display: "grid", gap: 14 }}>
        {error && (
          <p className="warning" role="alert" style={{ margin: 0 }}>{error}</p>
        )}
        <div className="field">
          <label htmlFor="import-trip-title">Title</label>
          <input
            id="import-trip-title"
            className="input"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="import-trip-destination">Destination</label>
          <input
            id="import-trip-destination"
            className="input"
            value={destination}
            onChange={(event) => setDestination(event.target.value)}
          />
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <div className="field">
            <label htmlFor="import-trip-starts">Starts on</label>
            <input
              id="import-trip-starts"
              className="input"
              type="date"
              value={startsOn}
              onChange={(event) => setStartsOn(event.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="import-trip-ends">Ends on</label>
            <input
              id="import-trip-ends"
              className="input"
              type="date"
              value={endsOn}
              onChange={(event) => setEndsOn(event.target.value)}
            />
          </div>
        </div>
        <div className="dialog-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy || drafts.length === 0}>
            {busy
              ? "Creating…"
              : allowDuplicates
                ? "Create anyway"
                : "Create trip and add bookings"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

function combinedDates(drafts: PendingImportDraft[]) {
  const starts = drafts.flatMap((draft) =>
    draft.localStartsOn ? [draft.localStartsOn] : [],
  );
  const ends = drafts.flatMap((draft) =>
    draft.localEndsOn ? [draft.localEndsOn] : [],
  );
  return {
    startsOn: starts.sort()[0] ?? "",
    endsOn: ends.sort().at(-1) ?? starts.sort().at(-1) ?? "",
  };
}

function defaultTripTitle(drafts: PendingImportDraft[]): string {
  const subject = drafts[0]?.source.subject?.trim();
  if (!subject) return "Imported trip";
  return subject
    .replace(/^fwd:\s*/i, "")
    .replace(/^file import:\s*/i, "")
    .slice(0, 120);
}
