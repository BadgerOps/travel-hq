import { useState } from "react";
import type { api as defaultApi } from "../api/client.js";
import type { AcceptDraftResult, DraftBooking, Person, Trip } from "../api/types.js";
import { utcToZonedLocal } from "../lib/dates.js";
import { errorMessage } from "../lib/errors.js";
import { Dialog } from "../components/Dialog.js";
import { TravelerToggles } from "../components/TravelerToggles.js";

/**
 * The trip title a brand-new trip starts from. The draft's location is a
 * better trip name than its title (a trip is "Guerneville", not "Delta
 * 2214 BOI to STS"), but either is only a prefill — the field is editable.
 */
function suggestedTripTitle(draft: DraftBooking): string {
  const location = draft.location?.trim() ?? "";
  return location !== "" ? `Trip to ${location}` : draft.title;
}

/** The draft's timestamp as a calendar date IN ITS OWN ZONE, for startsOn/endsOn prefills. */
function localDateOf(at: string | null, tz: string | null): string {
  return at && tz ? utcToZonedLocal(at, tz).slice(0, 10) : "";
}

/**
 * Accept a draft onto a trip: an existing one, or a new one seeded from the
 * draft's dates/destination. Accepting several drafts onto the same trip is
 * how a burst of confirmation emails becomes one trip — accept the first as
 * a new trip, the rest onto it. Travellers picked here ride the same
 * assignPerson path as manual entry, so they land on the booking AND the
 * trip.
 */
export function AcceptDraftDialog({
  draft,
  trips,
  people,
  api,
  onAccepted,
  onClose,
}: {
  draft: DraftBooking;
  trips: Trip[];
  people: Person[];
  api: typeof defaultApi;
  onAccepted: (result: AcceptDraftResult) => void;
  onClose: () => void;
}) {
  const hasTrips = trips.length > 0;
  const [mode, setMode] = useState<"existing" | "new">(hasTrips ? "existing" : "new");
  const [tripId, setTripId] = useState(trips[0]?.id ?? "");
  const [title, setTitle] = useState(suggestedTripTitle(draft));
  const [destination, setDestination] = useState(draft.location ?? "");
  const [startsOn, setStartsOn] = useState(localDateOf(draft.startsAt, draft.startsAtTz));
  const [endsOn, setEndsOn] = useState(localDateOf(draft.endsAt, draft.endsAtTz));
  const [selected, setSelected] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function toggle(personId: string) {
    setSelected((prev) =>
      prev.includes(personId) ? prev.filter((id) => id !== personId) : [...prev, personId],
    );
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (mode === "existing" && tripId === "") {
      setError("Pick a trip.");
      return;
    }
    if (mode === "new" && title.trim() === "") {
      setError("A trip title is required.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await api.import.acceptDraft(draft.id, {
        ...(mode === "existing"
          ? { tripId }
          : {
              newTrip: {
                title: title.trim(),
                ...(destination.trim() === "" ? {} : { destination: destination.trim() }),
                ...(startsOn === "" ? {} : { startsOn }),
                ...(endsOn === "" ? {} : { endsOn }),
              },
            }),
        ...(selected.length === 0 ? {} : { personIds: selected }),
      });
      onAccepted(result);
    } catch (err) {
      // Never close on failure: a 400 (e.g. details that no longer fit the
      // kind) or a 403 must leave the reviewer's choices on screen.
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog title="Accept draft" subtitle={draft.title} onClose={onClose}>
      <form onSubmit={submit} style={{ display: "grid", gap: 14 }}>
        {error && (
          <p className="warning" role="alert" style={{ margin: 0 }}>
            {error}
          </p>
        )}

        {hasTrips && (
          <div className="seg" role="radiogroup" aria-label="Trip choice" style={{ width: "100%" }}>
            {(
              [
                { id: "existing", label: "Existing trip" },
                { id: "new", label: "New trip" },
              ] as const
            ).map(({ id, label }) => (
              <label key={id} className="seg-opt" style={{ flex: 1, justifyContent: "center" }}>
                <input
                  type="radio"
                  name="accept-trip-mode"
                  value={id}
                  checked={mode === id}
                  onChange={() => setMode(id)}
                />
                {label}
              </label>
            ))}
          </div>
        )}

        {mode === "existing" && (
          <div className="field">
            <label htmlFor="ad-trip">Trip</label>
            <select
              id="ad-trip"
              className="input"
              value={tripId}
              onChange={(e) => setTripId(e.target.value)}
            >
              {trips.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.title}
                </option>
              ))}
            </select>
          </div>
        )}

        {mode === "new" && (
          <>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <div className="field">
                <label htmlFor="ad-title">Trip title</label>
                <input
                  id="ad-title"
                  className="input"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                />
              </div>
              <div className="field">
                <label htmlFor="ad-destination">Destination</label>
                <input
                  id="ad-destination"
                  className="input"
                  value={destination}
                  onChange={(e) => setDestination(e.target.value)}
                />
              </div>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <div className="field">
                <label htmlFor="ad-starts-on">Starts on</label>
                <input
                  id="ad-starts-on"
                  className="input"
                  type="date"
                  value={startsOn}
                  onChange={(e) => setStartsOn(e.target.value)}
                />
              </div>
              <div className="field">
                <label htmlFor="ad-ends-on">Ends on</label>
                <input
                  id="ad-ends-on"
                  className="input"
                  type="date"
                  value={endsOn}
                  onChange={(e) => setEndsOn(e.target.value)}
                />
              </div>
            </div>
          </>
        )}

        {people.length > 0 && (
          <div className="field">
            <label htmlFor="ad-who">Who's on it</label>
            <div id="ad-who">
              <TravelerToggles people={people} selected={selected} onToggle={toggle} />
            </div>
          </div>
        )}

        <div className="dialog-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            Accept draft
          </button>
        </div>
      </form>
    </Dialog>
  );
}
