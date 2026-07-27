import { useEffect, useMemo, useState } from "react";
import { ArrowClockwise, Check, Plus, Trash } from "@phosphor-icons/react";
import { Link } from "wouter";
import { api as defaultApi } from "../api/client.js";
import type {
  ExtractedBooking,
  ImportReviewResult,
  PendingImportDraft,
  Trip,
} from "../api/types.js";
import { DraftBookingCard } from "../components/DraftBookingCard.js";
import { errorMessage } from "../lib/errors.js";
import { CreateImportedTripDialog } from "./CreateImportedTripDialog.js";

type SourceGroup = {
  inboundEmailId: string;
  from: string;
  subject: string | null;
  receivedAt: string;
  drafts: PendingImportDraft[];
};

export function ImportReviewQueue({
  api = defaultApi,
  refreshToken = 0,
}: {
  api?: typeof defaultApi;
  refreshToken?: number;
}) {
  const [drafts, setDrafts] = useState<PendingImportDraft[]>([]);
  const [trips, setTrips] = useState<Trip[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [tripId, setTripId] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<ImportReviewResult | null>(null);
  const [creating, setCreating] = useState(false);

  async function load(signal?: AbortSignal) {
    setLoading(true);
    setError(null);
    try {
      const [pendingResult, tripsResult] = await Promise.allSettled([
        api.imports.pending(),
        api.trips.list(),
      ]);
      if (pendingResult.status === "rejected") throw pendingResult.reason;
      if (signal?.aborted) return;
      const pending = pendingResult.value;
      setDrafts(pending);
      setTrips(
        tripsResult.status === "fulfilled"
          ? tripsResult.value.filter((trip) => trip.status !== "cancelled")
          : [],
      );
      setSelected((current) =>
        current.filter((id) => pending.some((draft) => draft.id === id)),
      );
    } catch (err) {
      if (!signal?.aborted) setError(errorMessage(err));
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
    // A completed upload increments refreshToken so its drafts appear here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, refreshToken]);

  const groups = useMemo(() => groupBySource(drafts), [drafts]);
  const selectedDrafts = drafts.filter((draft) => selected.includes(draft.id));

  function toggle(id: string) {
    setSelected((current) =>
      current.includes(id)
        ? current.filter((selectedId) => selectedId !== id)
        : [...current, id],
    );
  }

  function removeResolved(ids: string[]) {
    setDrafts((current) => current.filter((draft) => !ids.includes(draft.id)));
    setSelected((current) => current.filter((id) => !ids.includes(id)));
  }

  async function accept(draftIds: string[], tripId: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await api.imports.accept(draftIds, tripId);
      removeResolved(result.acceptedDraftIds);
      setNotice(result);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function dismissSelected() {
    if (
      !globalThis.confirm(
        `Dismiss ${selected.length} selected ${selected.length === 1 ? "import" : "imports"}?`,
      )
    ) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await api.imports.dismiss(selected);
      removeResolved(result.dismissedDraftIds);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  function created(result: ImportReviewResult) {
    removeResolved(result.acceptedDraftIds);
    setNotice(result);
    setCreating(false);
  }

  return (
    <section aria-labelledby="import-review-title" style={{ marginTop: 32, maxWidth: 760 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
          marginBottom: 12,
        }}
      >
        <div>
          <h4 id="import-review-title" style={{ margin: 0 }}>Pending review</h4>
          <p className="text-muted" style={{ margin: "4px 0 0" }}>
            Accept suggested matches or combine selected imports into a new trip.
          </p>
        </div>
        <button
          type="button"
          className="btn btn-secondary"
          disabled={loading || busy}
          onClick={() => void load()}
        >
          <ArrowClockwise size={14} />
          Refresh
        </button>
      </div>

      {error && (
        <p className="warning" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p role="status">
          Added {notice.acceptedDraftIds.length}{" "}
          {notice.acceptedDraftIds.length === 1 ? "booking" : "bookings"} to{" "}
          <Link href={`/trips/${notice.trip.id}`}>{notice.trip.title}</Link>.
        </p>
      )}
      {loading ? (
        <p className="text-muted" role="status">Loading pending imports…</p>
      ) : drafts.length === 0 ? (
        <div className="card" style={{ alignItems: "flex-start" }}>
          <span className="card-title">All caught up</span>
          <p className="card-body">Forwarded emails and uploaded files will appear here.</p>
        </div>
      ) : (
        <div style={{ display: "grid", gap: 16 }}>
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              alignItems: "center",
              gap: 8,
            }}
          >
            <label style={{ display: "inline-flex", alignItems: "center", gap: 7 }}>
              <input
                type="checkbox"
                aria-label="Select all pending imports"
                checked={selected.length === drafts.length}
                ref={(node) => {
                  if (node) {
                    node.indeterminate =
                      selected.length > 0 && selected.length < drafts.length;
                  }
                }}
                onChange={() =>
                  setSelected(
                    selected.length === drafts.length
                      ? []
                      : drafts.map((draft) => draft.id),
                  )
                }
              />
              {selected.length === 0
                ? `${drafts.length} pending`
                : `${selected.length} selected`}
            </label>
            <button
              type="button"
              className="btn btn-primary"
              disabled={selected.length === 0 || busy}
              onClick={() => setCreating(true)}
            >
              <Plus size={14} />
              Create new trip
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              disabled={selected.length === 0 || busy}
              onClick={() => void dismissSelected()}
            >
              <Trash size={14} />
              Dismiss selected
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
                  disabled={selected.length === 0 || tripId === "" || busy}
                  onClick={() => void accept(selected, tripId)}
                >
                  Add to trip
                </button>
              </>
            )}
          </div>

          {groups.map((group) => {
            const suggested = oneGroupSuggestion(group);
            return (
              <article
                key={group.inboundEmailId}
                className="card"
                style={{ alignItems: "stretch", gap: 12 }}
              >
                <header>
                  <span className="card-kicker">
                    {group.from === "file-import@travel-hq.invalid"
                      ? "File upload"
                      : "Inbound email"}
                  </span>
                  <strong className="card-title" style={{ display: "block", marginTop: 3 }}>
                    {group.subject || "Untitled import"}
                  </strong>
                  <span className="card-meta">
                    From {group.from} · {formatReceivedAt(group.receivedAt)}
                  </span>
                </header>

                {suggested && (
                  <div
                    style={{
                      display: "flex",
                      flexWrap: "wrap",
                      alignItems: "center",
                      gap: 8,
                    }}
                  >
                    <span className="tag tag-accent">
                      Suggested trip: {suggested.title}
                    </span>
                    <button
                      type="button"
                      className="btn btn-primary"
                      disabled={busy}
                      onClick={() =>
                        void accept(
                          group.drafts.map((draft) => draft.id),
                          suggested.id,
                        )
                      }
                    >
                      <Check size={14} />
                      Accept all into {suggested.title}
                    </button>
                  </div>
                )}

                <div style={{ display: "grid", gap: 10 }}>
                  {group.drafts.map((draft) => (
                    <div
                      key={draft.id}
                      style={{
                        display: "grid",
                        gridTemplateColumns: "auto minmax(0, 1fr)",
                        gap: 10,
                        alignItems: "start",
                      }}
                    >
                      <input
                        type="checkbox"
                        aria-label={`Select ${draft.title}`}
                        checked={selected.includes(draft.id)}
                        disabled={busy}
                        onChange={() => toggle(draft.id)}
                        style={{ marginTop: 18 }}
                      />
                      <div>
                        <DraftBookingCard booking={asExtractedBooking(draft)} />
                        <div
                          style={{
                            display: "flex",
                            flexWrap: "wrap",
                            alignItems: "center",
                            gap: 8,
                            marginTop: 6,
                          }}
                        >
                          {draft.suggestedTrip ? (
                            <>
                              <span className="tag tag-accent">
                                Matches {draft.suggestedTrip.title}
                              </span>
                              {!suggested && (
                                <button
                                  type="button"
                                  className="btn btn-ghost"
                                  disabled={busy}
                                  onClick={() =>
                                    void accept([draft.id], draft.suggestedTrip!.id)
                                  }
                                >
                                  <Check size={14} />
                                  Accept into {draft.suggestedTrip.title}
                                </button>
                              )}
                            </>
                          ) : (
                            <span className="tag tag-neutral">Needs a trip</span>
                          )}
                          {draft.localStartsOn && (
                            <span className="card-meta">
                              Local dates {draft.localStartsOn}
                              {draft.localEndsOn &&
                              draft.localEndsOn !== draft.localStartsOn
                                ? ` – ${draft.localEndsOn}`
                                : ""}
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </article>
            );
          })}
        </div>
      )}

      {creating && (
        <CreateImportedTripDialog
          api={api}
          drafts={selectedDrafts}
          onCreated={created}
          onClose={() => setCreating(false)}
        />
      )}
    </section>
  );
}

function groupBySource(drafts: PendingImportDraft[]): SourceGroup[] {
  const groups = new Map<string, SourceGroup>();
  for (const draft of drafts) {
    const group = groups.get(draft.inboundEmailId);
    if (group) {
      group.drafts.push(draft);
      continue;
    }
    groups.set(draft.inboundEmailId, {
      inboundEmailId: draft.inboundEmailId,
      from: draft.source.from,
      subject: draft.source.subject,
      receivedAt: draft.source.receivedAt,
      drafts: [draft],
    });
  }
  return [...groups.values()];
}

function oneGroupSuggestion(group: SourceGroup) {
  const first = group.drafts[0]?.suggestedTrip;
  return first && group.drafts.every((draft) => draft.suggestedTrip?.id === first.id)
    ? first
    : null;
}

function asExtractedBooking(draft: PendingImportDraft): ExtractedBooking {
  return {
    kind: draft.kind,
    title: draft.title,
    location: draft.location,
    startsAt: draft.startsAt,
    startsAtTz: draft.startsAtTz,
    endsAt: draft.endsAt,
    endsAtTz: draft.endsAtTz,
    confirmationNumber: draft.confirmationNumber,
    costCents: null,
    details: {},
  };
}

function formatReceivedAt(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString();
}
