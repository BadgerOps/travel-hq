import { useState } from "react";
import { api as defaultApi } from "../api/client.js";
import type { Person, Trip } from "../api/types.js";
import { errorMessage } from "../lib/errors.js";
import { Dialog } from "./Dialog.js";
import { TravelerToggles } from "./TravelerToggles.js";

/**
 * Creating a trip is two API calls: POST /api/trips, then one
 * PUT /api/trips/:tripId/people/:personId per selected traveller. There is no
 * bulk-roster endpoint and this plan does not add one — four PUTs for a
 * family of four is not worth an endpoint.
 *
 * `onSaved` is called with the created trip even if the roster calls fail,
 * and `onRosterError` reports the failure separately: the trip genuinely
 * exists once the POST returns, and hiding it would invite the operator to
 * create it a second time.
 */
export function TripForm({
  people,
  api = defaultApi,
  onSaved,
  onRosterError,
  onClose,
}: {
  people: Person[];
  api?: typeof defaultApi;
  onSaved: (trip: Trip) => void;
  onRosterError: (message: string) => void;
  onClose: () => void;
}) {
  const [title, setTitle] = useState("");
  const [destination, setDestination] = useState("");
  const [startsOn, setStartsOn] = useState("");
  const [endsOn, setEndsOn] = useState("");
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

    let trip: Trip;
    try {
      trip = await api.trips.create({
        title: title.trim(),
        ...(destination === "" ? {} : { destination }),
        ...(startsOn === "" ? {} : { startsOn }),
        ...(endsOn === "" ? {} : { endsOn }),
      });
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
      return;
    }

    // The trip now exists. Roster failures are reported but never undo it.
    try {
      for (const personId of selected) {
        await api.trips.addTraveler(trip.id, personId);
      }
    } catch (err) {
      onRosterError(
        `${trip.title} was created, but its travellers could not be attached. ${errorMessage(err)}`,
      );
    }

    setBusy(false);
    onSaved(trip);
  }

  return (
    <Dialog title="New trip" onClose={onClose}>
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
          <label htmlFor="tf-travellers">Who's coming</label>
          <div id="tf-travellers">
            <TravelerToggles people={people} selected={selected} onToggle={toggle} />
          </div>
        </div>

        <div className="dialog-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            Save trip
          </button>
        </div>
      </form>
    </Dialog>
  );
}
