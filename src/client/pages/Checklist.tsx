import { useEffect, useState } from "react";
import { Plus } from "@phosphor-icons/react";
import { api as defaultApi } from "../api/client.js";
import type { ChecklistItem, Person, Trip } from "../api/types.js";
import { errorMessage } from "../lib/errors.js";
import { useCanWrite } from "../api/identity.js";
import { PersonChip } from "../components/PersonChip.js";
import { Dialog } from "../components/Dialog.js";

/**
 * Cross-trip checklist: every family task, across every trip, grouped by
 * trip so a family can see what's left on each one at a glance.
 *
 * Load vs. write failure are kept distinct on purpose — see ChecklistTab,
 * which is the pattern this page copies. A rejected setDone must not
 * unmount the whole page just because one toggle bounced.
 */
export function Checklist({
  api = defaultApi,
}: {
  api?: typeof defaultApi;
}) {
  const [trips, setTrips] = useState<Trip[] | null>(null);
  const [people, setPeople] = useState<Person[]>([]);
  const [items, setItems] = useState<ChecklistItem[] | null>(null);
  const [loadFailed, setLoadFailed] = useState<string | null>(null);
  const [writeError, setWriteError] = useState(false);
  const [adding, setAdding] = useState(false);
  const canWrite = useCanWrite();

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [t, p, c] = await Promise.all([
          api.trips.list(),
          api.people.list(),
          api.checklist.list(),
        ]);
        if (cancelled) return;
        setTrips(t);
        setPeople(p);
        setItems(c);
      } catch (err) {
        // Same rule as every other fetching page in this app: no silent
        // "Loading…" forever, and no unhandled rejection. A failed load
        // replaces the view; it must never look like "nothing to do".
        if (!cancelled) setLoadFailed(errorMessage(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api]);

  async function toggle(item: ChecklistItem) {
    const done = item.doneAt === null;
    setWriteError(false);
    try {
      await api.checklist.setDone(item.id, done);
    } catch {
      // Leave the list exactly as it was -- a transient write failure must
      // not unmount the page. See ChecklistTab Finding 1.
      setWriteError(true);
      return;
    }
    setItems((prev) =>
      (prev ?? []).map((i) =>
        i.id === item.id ? { ...i, doneAt: done ? new Date().toISOString() : null } : i,
      ),
    );
  }

  function onCreated(created: ChecklistItem) {
    setItems((prev) => [...(prev ?? []), created]);
    setAdding(false);
  }

  if (loadFailed) {
    return (
      <p className="warning" role="alert">
        {loadFailed}
      </p>
    );
  }

  const loading = trips === null || items === null;

  return (
    <>
      <header style={{ display: "flex", alignItems: "baseline", gap: 12, marginBottom: 20 }}>
        <div>
          <h3 style={{ marginBottom: 4 }}>Checklist</h3>
          <p className="text-muted" style={{ margin: 0 }}>
            Everything left to do, across every trip.
          </p>
        </div>
        {canWrite && trips !== null && trips.length > 0 && (
          <button
            type="button"
            className="btn btn-primary"
            style={{ marginLeft: "auto" }}
            onClick={() => setAdding(true)}
          >
            <Plus size={14} /> Add task
          </button>
        )}
      </header>

      {writeError && (
        <div className="card-meta warning" role="alert" style={{ marginBottom: 12 }}>
          <span>That change didn't save. Try again.</span>
          <button
            type="button"
            className="btn btn-secondary btn-icon"
            aria-label="dismiss"
            onClick={() => setWriteError(false)}
          >
            ×
          </button>
        </div>
      )}

      {loading && <p className="text-muted">Loading…</p>}

      {!loading && trips!.length === 0 && (
        <div className="card" style={{ alignItems: "flex-start", gap: 10 }}>
          <span className="card-title">No trips yet</span>
          <p className="card-body" style={{ margin: 0 }}>
            A checklist item has to belong to a trip. Create a trip first, then come back here to
            add tasks to it.
          </p>
        </div>
      )}

      {!loading && trips!.length > 0 && (
        <ChecklistGroups
          trips={trips!}
          items={items!}
          people={people}
          canWrite={canWrite}
          onToggle={toggle}
          onAdd={() => setAdding(true)}
        />
      )}

      {adding && (
        <AddTaskDialog
          trips={trips ?? []}
          people={people}
          api={api}
          onSaved={onCreated}
          onClose={() => setAdding(false)}
        />
      )}
    </>
  );
}

function ChecklistGroups({
  trips,
  items,
  people,
  canWrite,
  onToggle,
  onAdd,
}: {
  trips: Trip[];
  items: ChecklistItem[];
  people: Person[];
  canWrite: boolean;
  onToggle: (item: ChecklistItem) => void;
  onAdd: () => void;
}) {
  if (items.length === 0) {
    return (
      <div className="card" style={{ alignItems: "flex-start", gap: 10 }}>
        <span className="card-title">Nothing on the list yet</span>
        <p className="card-body" style={{ margin: 0 }}>
          Add a task to any trip to start tracking what's left to do.
        </p>
        {canWrite && (
          <button type="button" className="btn btn-primary" onClick={onAdd}>
            <Plus size={14} /> Add the first task
          </button>
        )}
      </div>
    );
  }

  // Soonest-scheduled trip first, matching Trips.tsx's own ordering; only
  // trips with at least one item get a section.
  const orderedTrips = trips
    .slice()
    .sort((a, b) => {
      if (a.startsOn === null) return b.startsOn === null ? 0 : 1;
      if (b.startsOn === null) return -1;
      return a.startsOn.localeCompare(b.startsOn);
    })
    .filter((t) => items.some((i) => i.tripId === t.id));

  return (
    <div style={{ display: "grid", gap: 24 }}>
      {orderedTrips.map((trip) => (
        <TripGroup
          key={trip.id}
          trip={trip}
          items={items.filter((i) => i.tripId === trip.id)}
          people={people}
          canWrite={canWrite}
          onToggle={onToggle}
        />
      ))}
    </div>
  );
}

function TripGroup({
  trip,
  items,
  people,
  canWrite,
  onToggle,
}: {
  trip: Trip;
  items: ChecklistItem[];
  people: Person[];
  canWrite: boolean;
  onToggle: (item: ChecklistItem) => void;
}) {
  // Incomplete first, then done; within each, soonest due date first and
  // undated items last.
  const ordered = items.slice().sort((a, b) => {
    const aDone = a.doneAt !== null;
    const bDone = b.doneAt !== null;
    if (aDone !== bDone) return aDone ? 1 : -1;
    if (a.dueOn === null) return b.dueOn === null ? 0 : 1;
    if (b.dueOn === null) return -1;
    return a.dueOn.localeCompare(b.dueOn);
  });
  const doneCount = items.filter((i) => i.doneAt !== null).length;

  return (
    <section>
      <h5 className="card-title" style={{ marginBottom: 4 }}>
        {trip.title}
      </h5>
      <h6 className="card-kicker" style={{ marginBottom: 10 }}>
        {doneCount} of {items.length} done
      </h6>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(min(320px, 100%), 1fr))",
          gap: 8,
        }}
      >
        {ordered.map((item) => {
          const assignee = people.find((p) => p.id === item.personId);
          const done = item.doneAt !== null;
          const content = (
            <>
              <span style={{ fontSize: 13 }}>{item.label}</span>
              {item.dueOn && <span className="card-meta">due {item.dueOn}</span>}
              <span style={{ marginLeft: "auto" }}>
                {assignee ? (
                  <PersonChip person={assignee} />
                ) : (
                  <span className="card-meta">Everyone</span>
                )}
              </span>
            </>
          );
          const style = {
            flexDirection: "row" as const,
            alignItems: "center" as const,
            gap: 10,
            textAlign: "left" as const,
            opacity: done ? 0.45 : 1,
            textDecoration: done ? "line-through" : "none",
          };

          // A viewer's write is a guaranteed 403, so no clickable affordance
          // — same rule as ChecklistTab and MaskedValue.
          if (!canWrite) {
            return (
              <div key={item.id} className="card" style={style}>
                {content}
              </div>
            );
          }

          return (
            <button
              key={item.id}
              type="button"
              onClick={() => onToggle(item)}
              className="card"
              style={{ ...style, cursor: "pointer" }}
            >
              {content}
            </button>
          );
        })}
      </div>
    </section>
  );
}

function AddTaskDialog({
  trips,
  people,
  api,
  onSaved,
  onClose,
}: {
  trips: Trip[];
  people: Person[];
  api: typeof defaultApi;
  onSaved: (item: ChecklistItem) => void;
  onClose: () => void;
}) {
  const [tripId, setTripId] = useState(trips[0]?.id ?? "");
  const [label, setLabel] = useState("");
  const [personId, setPersonId] = useState("");
  const [dueOn, setDueOn] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (tripId === "") {
      setError("A trip is required.");
      return;
    }
    if (label.trim() === "") {
      setError("A label is required.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const created = await api.checklist.create({
        tripId,
        label: label.trim(),
        ...(personId === "" ? {} : { personId }),
        ...(dueOn === "" ? {} : { dueOn }),
      });
      onSaved(created);
    } catch (err) {
      // Keep whatever the operator typed -- don't blow away their input on a
      // rejected write. Same rule TripForm/PersonForm follow.
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <Dialog title="Add task" onClose={onClose}>
      <form onSubmit={submit} style={{ display: "grid", gap: 14 }}>
        {error && (
          <p className="warning" role="alert" style={{ margin: 0 }}>
            {error}
          </p>
        )}

        <div className="field">
          <label htmlFor="ct-trip">Trip</label>
          <select
            id="ct-trip"
            className="input"
            value={tripId}
            onChange={(e) => setTripId(e.target.value)}
          >
            {trips.length === 0 && <option value="">No trips</option>}
            {trips.map((t) => (
              <option key={t.id} value={t.id}>
                {t.title}
              </option>
            ))}
          </select>
        </div>

        <div className="field">
          <label htmlFor="ct-label">Label</label>
          <input
            id="ct-label"
            className="input"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
          />
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <div className="field">
            <label htmlFor="ct-person">Assignee</label>
            <select
              id="ct-person"
              className="input"
              value={personId}
              onChange={(e) => setPersonId(e.target.value)}
            >
              <option value="">Everyone</option>
              {people.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.displayName}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="ct-due">Due on</label>
            <input
              id="ct-due"
              className="input"
              type="date"
              value={dueOn}
              onChange={(e) => setDueOn(e.target.value)}
            />
          </div>
        </div>

        <div className="dialog-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            Save task
          </button>
        </div>
      </form>
    </Dialog>
  );
}
