import { useState } from "react";
import type { api as defaultApi } from "../api/client.js";
import type { Person } from "../api/types.js";
import { useCanWrite } from "../api/identity.js";
import { errorMessage } from "../lib/errors.js";
import { PersonCard } from "../components/PersonCard.js";

/**
 * A thin map over PersonCard. The expiry rule this used to own now lives in
 * `lib/passport.ts` and the markup in `components/PersonCard.tsx`, so this
 * tab and the People page cannot drift apart.
 *
 * No `onEdit`: editing a person from inside a trip is not a flow this app
 * builds, and design 1b does not show one.
 *
 * `tripId`/`onRemoved` are optional together: when both are supplied (the
 * trip-detail page) and the viewer can write, each person row offers
 * "Remove from trip" behind an inline confirm. The confirm names the real
 * consequence — the person also comes off this trip's bookings — because
 * DELETE /api/trips/:tripId/people/:personId unassigns both in one
 * transaction. A viewer's remove would be a guaranteed 403, so they are
 * offered nothing (the ChecklistTab rule).
 */
export function TravelersTab({
  people,
  arrivalOn,
  api,
  tripId,
  onRemoved,
  today = new Intl.DateTimeFormat("en-CA").format(new Date()),
}: {
  people: Person[];
  arrivalOn: string | null;
  api: typeof defaultApi;
  tripId?: string;
  onRemoved?: () => void;
  today?: string;
}) {
  const canWrite = useCanWrite();
  // The person whose remove is awaiting its confirm click, if any.
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const removable = canWrite && tripId !== undefined && onRemoved !== undefined;

  async function remove(person: Person) {
    if (tripId === undefined) return;
    setBusy(true);
    try {
      await api.trips.removeTraveler(tripId, person.id);
      setError(null);
      setConfirming(null);
      onRemoved?.();
    } catch (err) {
      // A 403 (role changed under us) or 404 must say so and leave the list
      // exactly as it was — never a silent no-op.
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  if (people.length === 0) {
    return <p className="text-muted">No travellers on this trip yet.</p>;
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {error && (
        <p className="warning" role="alert" style={{ margin: 0 }}>
          {error}
        </p>
      )}
      {people.map((p) => (
        <div key={p.id} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <PersonCard person={p} arrivalOn={arrivalOn} today={today} api={api} />
          {removable && confirming !== p.id && (
            <div className="card-meta">
              <button
                type="button"
                className="btn btn-ghost"
                style={{ fontSize: 11 }}
                onClick={() => setConfirming(p.id)}
              >
                Remove {p.displayName} from trip
              </button>
            </div>
          )}
          {removable && confirming === p.id && (
            <div className="card-meta warning" role="alert">
              <span>
                This also takes {p.displayName} off this trip's bookings. The bookings
                themselves stay.
              </span>
              <button
                type="button"
                className="btn btn-secondary"
                style={{ fontSize: 11 }}
                disabled={busy}
                onClick={() => void remove(p)}
              >
                Remove {p.displayName}
              </button>
              <button
                type="button"
                className="btn btn-ghost"
                style={{ fontSize: 11 }}
                onClick={() => setConfirming(null)}
              >
                Keep
              </button>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
