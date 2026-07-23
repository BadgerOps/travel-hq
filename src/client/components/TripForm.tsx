import { useState } from "react";
import { api as defaultApi } from "../api/client.js";
import type { Person, Trip, TripStatus, UpdateTripInput } from "../api/types.js";
import { errorMessage } from "../lib/errors.js";
import { Dialog } from "./Dialog.js";
import { TravelerToggles } from "./TravelerToggles.js";

/**
 * The status choices the form offers. `cancelled` is deliberately absent:
 * cancelling is an explicit action with its own confirm (the trip-detail
 * footer), not a value to stumble into while editing a title. "Auto" is the
 * stored `planning` default — the state derives from the dates until someone
 * forces it (see resolveTripState in lib/dates.ts).
 */
const STATUS_OPTIONS = [
  { value: "planning", label: "Auto (planning)" },
  { value: "active", label: "Active" },
  { value: "complete", label: "Complete" },
] as const satisfies readonly { value: TripStatus; label: string }[];

/**
 * Create when `trip` is absent, edit when present — the PersonForm
 * convention, including remount-per-trip via `key` at the call site.
 *
 * Creating a trip is two API calls: POST /api/trips, then one
 * PUT /api/trips/:tripId/people/:personId per selected traveller. There is no
 * bulk-roster endpoint and this plan does not add one — four PUTs for a
 * family of four is not worth an endpoint.
 *
 * `onSaved` is called with the created trip even if the roster calls fail,
 * and `onRosterError` reports the failure separately: the trip genuinely
 * exists once the POST returns, and hiding it would invite the operator to
 * create it a second time.
 *
 * Edit mode sends a partial PUT: emptied nullable fields go as explicit
 * `null` (clear), and `status` is included ONLY when the operator changed
 * the control — a cancelled trip's control seeds to Auto, and silently
 * sending `planning` with an unrelated title edit would un-cancel it.
 * The traveller toggles are create-only; the roster is managed from the
 * trip's Travelers tab.
 */
export function TripForm({
  people,
  trip,
  api = defaultApi,
  onSaved,
  onRosterError,
  onClose,
}: {
  people: Person[];
  trip?: Trip;
  api?: typeof defaultApi;
  onSaved: (trip: Trip) => void;
  onRosterError?: (message: string) => void;
  onClose: () => void;
}) {
  const editing = trip !== undefined;

  const [title, setTitle] = useState(trip?.title ?? "");
  const [destination, setDestination] = useState(trip?.destination ?? "");
  const [startsOn, setStartsOn] = useState(trip?.startsOn ?? "");
  const [endsOn, setEndsOn] = useState(trip?.endsOn ?? "");
  const [notes, setNotes] = useState(trip?.notes ?? "");
  // A cancelled trip seeds to Auto: the control cannot express `cancelled`.
  // `status` is sent only when the operator moved the control off its SEED —
  // comparing against the stored value instead would read a cancelled trip's
  // Auto seed as a change and un-cancel it on an unrelated title edit.
  const initialStatus: TripStatus =
    trip === undefined || trip.status === "cancelled" ? "planning" : trip.status;
  const [status, setStatus] = useState<TripStatus>(initialStatus);
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
    if (title.trim() === "") {
      setError("A title is required.");
      return;
    }
    if (startsOn !== "" && endsOn !== "" && endsOn < startsOn) {
      setError("The end date cannot be before the start date.");
      return;
    }
    setBusy(true);
    setError(null);

    if (editing) {
      try {
        const updated = await api.trips.update(trip.id, {
          title: title.trim(),
          destination: destination === "" ? null : destination,
          startsOn: startsOn === "" ? null : startsOn,
          endsOn: endsOn === "" ? null : endsOn,
          notes: notes === "" ? null : notes,
          ...(status !== initialStatus ? { status } : {}),
        } satisfies UpdateTripInput);
        onSaved(updated);
      } catch (err) {
        // Never close on failure: a 403 (viewer racing a role change) or a
        // 400 must leave the typed values on screen, not discard them behind
        // a dialog that vanished as if it had worked.
        setError(errorMessage(err));
      } finally {
        setBusy(false);
      }
      return;
    }

    let created: Trip;
    try {
      created = await api.trips.create({
        title: title.trim(),
        ...(destination === "" ? {} : { destination }),
        ...(startsOn === "" ? {} : { startsOn }),
        ...(endsOn === "" ? {} : { endsOn }),
        ...(notes === "" ? {} : { notes }),
      });
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
      return;
    }

    // The trip now exists. Roster failures are reported but never undo it.
    try {
      for (const personId of selected) {
        await api.trips.addTraveler(created.id, personId);
      }
    } catch (err) {
      onRosterError?.(
        `${created.title} was created, but its travellers could not be attached. ${errorMessage(err)}`,
      );
    }

    setBusy(false);
    onSaved(created);
  }

  return (
    <Dialog title={editing ? `Edit ${trip.title}` : "New trip"} onClose={onClose}>
      <form onSubmit={submit} style={{ display: "grid", gap: 14 }}>
        {error && (
          <p className="warning" role="alert" style={{ margin: 0 }}>
            {error}
          </p>
        )}

        <div className="field">
          <label htmlFor="tf-title">Title</label>
          <input
            id="tf-title"
            className="input"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </div>

        <div className="field">
          <label htmlFor="tf-destination">Destination</label>
          <input
            id="tf-destination"
            className="input"
            value={destination}
            onChange={(e) => setDestination(e.target.value)}
          />
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <div className="field">
            <label htmlFor="tf-starts">Starts on</label>
            <input
              id="tf-starts"
              className="input"
              type="date"
              value={startsOn}
              onChange={(e) => setStartsOn(e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="tf-ends">Ends on</label>
            <input
              id="tf-ends"
              className="input"
              type="date"
              value={endsOn}
              onChange={(e) => setEndsOn(e.target.value)}
            />
          </div>
        </div>

        <div className="field">
          <label htmlFor="tf-notes">Notes</label>
          <textarea
            id="tf-notes"
            className="input"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </div>

        {editing && (
          <div className="field">
            <label id="tf-status-label">Status</label>
            {/* The same native-radio segmented control the trip tabs use:
                arrow-key navigation and group semantics for free. */}
            <div className="seg" role="radiogroup" aria-labelledby="tf-status-label">
              {STATUS_OPTIONS.map(({ value, label }) => (
                <label key={value} className="seg-opt">
                  <input
                    type="radio"
                    name="tf-status"
                    value={value}
                    checked={status === value}
                    onChange={() => setStatus(value)}
                  />
                  {label}
                </label>
              ))}
            </div>
          </div>
        )}

        {!editing && (
          <div className="field">
            <label htmlFor="tf-travellers">Who's coming</label>
            <div id="tf-travellers">
              <TravelerToggles people={people} selected={selected} onToggle={toggle} />
            </div>
          </div>
        )}

        <div className="dialog-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {editing ? "Save changes" : "Save trip"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
