import { useEffect, useState } from "react";
import type { CSSProperties } from "react";
import { Plus, Tray } from "@phosphor-icons/react";
import { Link } from "wouter";
import { api as defaultApi } from "../api/client.js";
import { useCanWrite } from "../api/identity.js";
import type {
  ImportReviewResult,
  PendingImportDraft,
  Trip,
} from "../api/types.js";
import { errorMessage } from "../lib/errors.js";
import { CreateImportedTripDialog } from "./CreateImportedTripDialog.js";

export function PendingImportCard({
  api = defaultApi,
  onTripCreated,
  style,
}: {
  api?: typeof defaultApi;
  onTripCreated?: (trip: Trip) => void;
  style?: CSSProperties;
}) {
  const canWrite = useCanWrite();
  const [drafts, setDrafts] = useState<PendingImportDraft[] | null>(null);
  const [trips, setTrips] = useState<Trip[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [tripId, setTripId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  async function load(signal?: AbortSignal) {
    setError(null);
    try {
      const [pendingResult, tripsResult] = await Promise.allSettled([
        api.imports.pending(),
        api.trips.list(),
      ]);
      if (pendingResult.status === "rejected") throw pendingResult.reason;
      if (!signal?.aborted) {
        setDrafts(pendingResult.value);
        setTrips(
          tripsResult.status === "fulfilled"
            ? tripsResult.value.filter((trip) => trip.status !== "cancelled")
            : [],
        );
      }
    } catch (err) {
      if (!signal?.aborted) setError(errorMessage(err));
    }
  }

  useEffect(() => {
    if (!canWrite) return;
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, canWrite]);

  if (!canWrite) return null;
  if (drafts === null) {
    return error ? (
      <article className="card" style={{ alignItems: "flex-start" }}>
        <span className="card-title">Pending imports unavailable</span>
        <p className="warning" role="alert" style={{ margin: 0 }}>{error}</p>
        <button type="button" className="btn btn-secondary" onClick={() => void load()}>
          Try again
        </button>
      </article>
    ) : null;
  }
  if (drafts.length === 0) return null;

  const selectedDrafts = drafts.filter((draft) => selected.includes(draft.id));

  function toggle(id: string) {
    setSelected((current) =>
      current.includes(id)
        ? current.filter((selectedId) => selectedId !== id)
        : [...current, id],
    );
  }

  function created(result: ImportReviewResult) {
    setDrafts((current) =>
      current?.filter((draft) => !result.acceptedDraftIds.includes(draft.id)) ?? [],
    );
    setSelected([]);
    setCreating(false);
    setTrips((current) => [...current, result.trip]);
    onTripCreated?.(result.trip);
  }

  async function addToTrip() {
    if (selected.length === 0 || tripId === "") return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.imports.accept(selected, tripId);
      setDrafts((current) =>
        current?.filter((draft) => !result.acceptedDraftIds.includes(draft.id)) ?? [],
      );
      setSelected([]);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <article
        className="card"
        data-testid="pending-import-card"
        style={{ alignItems: "stretch", gap: 12, ...style }}
      >
        <header style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
          <Tray size={20} aria-hidden="true" />
          <div>
            <span className="card-kicker">Action needed</span>
            <strong className="card-title" style={{ display: "block", marginTop: 3 }}>
              {drafts.length} pending {drafts.length === 1 ? "import" : "imports"}
            </strong>
            <p className="card-body" style={{ marginTop: 4 }}>
              Select the reservations that belong together, then create their trip.
            </p>
          </div>
        </header>

        <div
          style={{
            display: "grid",
            gap: 8,
            maxHeight: 250,
            overflowY: "auto",
          }}
        >
          {drafts.map((draft) => (
            <label
              key={draft.id}
              style={{
                display: "grid",
                gridTemplateColumns: "auto minmax(0, 1fr) auto",
                alignItems: "center",
                gap: 9,
                cursor: "pointer",
              }}
            >
              <input
                type="checkbox"
                checked={selected.includes(draft.id)}
                onChange={() => toggle(draft.id)}
                aria-label={`Select pending import ${draft.title}`}
              />
              <span style={{ minWidth: 0 }}>
                <strong style={{ display: "block", fontSize: 13 }}>{draft.title}</strong>
                <span className="card-meta">
                  {draft.source.subject || draft.source.from}
                  {draft.localStartsOn ? ` · ${formatRange(draft)}` : ""}
                </span>
              </span>
              <span className={`tag ${draft.suggestedTrip ? "tag-accent" : "tag-neutral"}`}>
                {draft.suggestedTrip ? `Matches ${draft.suggestedTrip.title}` : "Needs trip"}
              </span>
            </label>
          ))}
        </div>

        <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
          {error && (
            <p className="warning" role="alert" style={{ flexBasis: "100%", margin: 0 }}>
              {error}
            </p>
          )}
          <button
            type="button"
            className="btn btn-primary"
            disabled={selected.length === 0}
            onClick={() => setCreating(true)}
          >
            <Plus size={14} />
            Create trip from selected
          </button>
          {trips.length > 0 && (
            <>
              <label className="field" style={{ minWidth: 180 }}>
                <span className="card-meta">Existing trip</span>
                <select
                  className="input"
                  aria-label="Existing trip for selected imports"
                  value={tripId}
                  onChange={(event) => setTripId(event.target.value)}
                >
                  <option value="">Choose a trip</option>
                  {trips.map((trip) => (
                    <option key={trip.id} value={trip.id}>{trip.title}</option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                className="btn btn-secondary"
                disabled={busy || selected.length === 0 || tripId === ""}
                onClick={() => void addToTrip()}
              >
                Add to trip
              </button>
            </>
          )}
          <Link href="/import" className="btn btn-ghost">
            Review all imports
          </Link>
          <span className="card-meta" style={{ marginLeft: "auto" }}>
            {selected.length} selected
          </span>
        </div>
      </article>

      {creating && (
        <CreateImportedTripDialog
          api={api}
          drafts={selectedDrafts}
          onCreated={created}
          onClose={() => setCreating(false)}
        />
      )}
    </>
  );
}

function formatRange(draft: PendingImportDraft): string {
  return draft.localEndsOn && draft.localEndsOn !== draft.localStartsOn
    ? `${draft.localStartsOn} – ${draft.localEndsOn}`
    : draft.localStartsOn ?? "";
}
