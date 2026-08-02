import { useEffect, useMemo, useState } from "react";
import {
  ArrowClockwise,
  Check,
  EnvelopeOpen,
  PencilSimple,
  Plus,
  Trash,
} from "@phosphor-icons/react";
import { Link } from "wouter";
import { api as defaultApi, ApiError } from "../api/client.js";
import { useCanWrite } from "../api/identity.js";
import type {
  ExtractedBooking,
  ImportReviewResult,
  PendingImportDraft,
  Trip,
} from "../api/types.js";
import { DraftBookingCard } from "../components/DraftBookingCard.js";
import { errorMessage } from "../lib/errors.js";
import { BookingDialog } from "../trip/BookingDialog.js";
import { combineRanges, rankTrips } from "../../shared/trip-match.js";
import type { DateRange, ImportSelection } from "../../shared/trip-match.js";
import { CreateImportedTripDialog } from "./CreateImportedTripDialog.js";
import { DuplicateNotice } from "./DuplicateNotice.js";
// Queue styles ship with the Import page sheet (2b anatomy).
import "../pages/import.css";

/**
 * Stands in for "the current selection" in `confirmingDismiss`, which otherwise
 * holds a draft id. Draft ids are UUIDs, so nothing can collide with it.
 */
const BULK_DISMISS = "selection";

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
  /**
   * The draft being corrected, if any. Extraction is a suggestion, not truth:
   * a wrong time or confirmation number is fixed HERE, while it is still a
   * draft, rather than by accepting it and repairing the booking afterwards —
   * which would mean the wrong value really was the household's data for a
   * while, on the day view and in the rollups and on everyone else's screen.
   */
  const [editing, setEditing] = useState<PendingImportDraft | null>(null);
  /** The accept a 409 refused, kept so "Import anyway" can repeat it. */
  const [conflict, setConflict] = useState<{ draftIds: string[]; tripId: string } | null>(null);
  /**
   * The dismiss waiting on its second click: a draft id for a row, or
   * BULK_DISMISS for the toolbar. Null when nothing is being confirmed.
   *
   * Inline rather than `globalThis.confirm()`, which is what this used to be.
   * The native dialog blocks the whole tab, cannot say WHICH import is about
   * to go (only a count), and reads as a browser malfunction rather than as
   * part of the page. Turning the button itself into the confirmation keeps
   * the row you are acting on visible while you decide, which is the entire
   * point of asking.
   */
  const [confirmingDismiss, setConfirmingDismiss] = useState<string | null>(null);
  const canWrite = useCanWrite();

  async function load(signal?: AbortSignal) {
    setLoading(true);
    setError(null);
    // A reload can retire the very draft a dismiss was armed against; the
    // question it was asking no longer has a subject.
    setConfirmingDismiss(null);
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

  /**
   * The "Existing trip" options, best fit first, each carrying the reason it
   * sits where it does. The ranking is scored against the CURRENT SELECTION —
   * the union of its dates and the places it names — because that is the
   * question the control answers: "which trip do these belong on?".
   *
   * With nothing selected there is nothing to score against, so every trip
   * ties and the stable sort leaves the API's own order alone. The picker is
   * unusable in that state anyway (Add to trip is disabled until something is
   * selected), and a list that reshuffled itself as you ticked the first
   * checkbox would be worse than one that simply waits.
   */
  const rankedTrips = useMemo(
    () => rankTrips(trips, importSelection(drafts.filter((draft) => selected.includes(draft.id)))),
    [trips, drafts, selected],
  );

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

  async function accept(draftIds: string[], tripId: string, allowDuplicates = false) {
    setBusy(true);
    setError(null);
    setNotice(null);
    setConflict(null);
    try {
      const result = await api.imports.accept(draftIds, tripId, allowDuplicates);
      removeResolved(result.acceptedDraftIds);
      setNotice(result);
    } catch (err) {
      setError(errorMessage(err));
      // A 409 is not a failure to report and forget: the server is asking a
      // question only the reviewer can answer, so keep what was attempted and
      // offer to send it again with the override.
      if (err instanceof ApiError && err.status === 409) {
        setConflict({ draftIds, tripId });
      }
    } finally {
      setBusy(false);
    }
  }

  async function dismiss(draftIds: string[]) {
    setConfirmingDismiss(null);
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await api.imports.dismiss(draftIds);
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
    <section aria-labelledby="import-review-title" className="import-queue">
      <div className="import-queue-head">
        <div>
          <h4 id="import-review-title">Pending review</h4>
          <p className="text-muted">
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
          {conflict && (
            <button
              type="button"
              className="btn btn-ghost"
              style={{ marginLeft: 8 }}
              disabled={busy}
              onClick={() => void accept(conflict.draftIds, conflict.tripId, true)}
            >
              Import anyway
            </button>
          )}
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
        // A failed load renders the alert above instead — never this empty
        // state, so an outage can't masquerade as "nothing to review".
        error ? null : (
          <div className="import-queue-empty">
            <EnvelopeOpen size={18} aria-hidden="true" />
            <div>
              <strong>All caught up</strong>
              {/*
                Says how mail gets here AND points at the one place it can be
                set up. An empty state that only reports emptiness leaves a
                household that has never configured forwarding waiting for
                something that will never arrive.
              */}
              <p>
                Forward a confirmation to your household address, or upload a PDF
                or EML above, and it will appear here as a draft.{" "}
                <Link href="/settings">Set up email forwarding in Settings</Link>.
              </p>
            </div>
          </div>
        )
      ) : (
        <div className="import-queue-body">
          {/*
            Every control in here resolves a draft, and the checkboxes exist
            only to feed them, so the whole bar is a write affordance. A viewer
            never reaches this component today (pages/Import.tsx swaps the page
            out, and GET /api/imports/pending is a 403 besides) — this is the
            belt to that pair of braces, and it keeps "all actions are
            useCanWrite()-gated" literally true of the queue rather than true
            only because of where it happens to be mounted.
          */}
          {canWrite && (
            <div className="import-bulkbar">
              <label className="import-select-all">
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
              <DismissControl
                text="Dismiss selected"
                label={`Dismiss selected ${selected.length === 1 ? "import" : "imports"}`}
                confirmLabel={`Dismiss ${selected.length} ${
                  selected.length === 1 ? "import" : "imports"
                }?`}
                disabled={selected.length === 0 || busy}
                confirming={confirmingDismiss === BULK_DISMISS}
                onArm={() => setConfirmingDismiss(BULK_DISMISS)}
                onCancel={() => setConfirmingDismiss(null)}
                onConfirm={() => void dismiss(selected)}
              />
              {trips.length > 0 && (
                <>
                  <label className="field">
                    <span className="card-meta">Existing trip</span>
                    <select
                      className="input"
                      aria-label="Existing trip for selected imports"
                      value={tripId}
                      onChange={(event) => setTripId(event.target.value)}
                    >
                      <option value="">Choose a trip</option>
                      {rankedTrips.map(({ trip, match }) => (
                        <option key={trip.id} value={trip.id}>
                          {match.label === "" ? trip.title : `${trip.title} — ${match.label}`}
                        </option>
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
          )}

          {groups.map((group) => {
            const suggested = oneGroupSuggestion(group);
            return (
              <article
                key={group.inboundEmailId}
                className="card import-source-card"
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
                  <div className="import-suggest-row">
                    <span className="tag tag-accent">
                      Suggested trip: {suggested.title}
                    </span>
                    {canWrite && (
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
                    )}
                  </div>
                )}

                <div className="import-draft-rows">
                  {group.drafts.map((draft) => (
                    <div key={draft.id} className="import-draft-row">
                      {canWrite && (
                        <input
                          type="checkbox"
                          aria-label={`Select ${draft.title}`}
                          checked={selected.includes(draft.id)}
                          disabled={busy}
                          onChange={() => toggle(draft.id)}
                        />
                      )}
                      <div>
                        <DraftBookingCard
                          booking={asExtractedBooking(draft)}
                          source={draft.extractionSource}
                        />
                        <div className="import-draft-row-tags">
                          {canWrite && (
                            <button
                              type="button"
                              className="btn btn-ghost"
                              aria-label={`Edit ${draft.title}`}
                              disabled={busy}
                              onClick={() => setEditing(draft)}
                            >
                              <PencilSimple size={14} />
                              Edit
                            </button>
                          )}
                          {canWrite && (
                            <DismissControl
                              label={`Dismiss ${draft.title}`}
                              confirmLabel={`Dismiss ${draft.title}?`}
                              disabled={busy}
                              confirming={confirmingDismiss === draft.id}
                              onArm={() => setConfirmingDismiss(draft.id)}
                              onCancel={() => setConfirmingDismiss(null)}
                              onConfirm={() => void dismiss([draft.id])}
                            />
                          )}
                          {draft.suggestedTrip ? (
                            <>
                              <span className="tag tag-accent">
                                Matches {draft.suggestedTrip.title}
                              </span>
                              {canWrite && !suggested && (
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
                          <DuplicateNotice duplicates={draft.duplicates ?? []} />
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

      {/*
        The SAME dialog as "Add booking" and "Edit booking", in its draft mode
        — not a second form that could disagree with it about what a car
        rental has. `people` is empty because a draft has no travellers of its
        own yet; the dialog hides that section in this mode.

        Reloading rather than patching the row in place: an edit can change
        which trip the server suggests and what the draft looks like a
        duplicate of, and both are computed across the whole queue.
      */}
      {editing && (
        <BookingDialog
          api={api}
          draft={editing}
          people={[]}
          onSaved={() => {
            setEditing(null);
            void load();
          }}
          onClose={() => setEditing(null)}
        />
      )}
    </section>
  );
}

/**
 * A dismiss button that becomes its own confirmation.
 *
 * One click arms it, the second commits, and "Keep" backs out — so the
 * destructive step always takes two deliberate clicks without a modal stealing
 * the page. The armed button names what is about to go ("Dismiss DL 162?"),
 * which the native dialog it replaced could not do, and it stays in the row so
 * the reviewer can still read the booking they are deciding about.
 *
 * The accessible name changes with the state on purpose: a screen reader user
 * who has armed the control hears the question, not the verb they just pressed.
 */
function DismissControl({
  text = "Dismiss",
  label,
  confirmLabel,
  disabled,
  confirming,
  onArm,
  onCancel,
  onConfirm,
}: {
  /** Visible wording. The toolbar says "Dismiss selected"; a row says "Dismiss". */
  text?: string;
  label: string;
  confirmLabel: string;
  disabled: boolean;
  confirming: boolean;
  onArm: () => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  if (!confirming) {
    return (
      <button
        type="button"
        className="btn btn-ghost"
        aria-label={label}
        disabled={disabled}
        onClick={onArm}
      >
        <Trash size={14} />
        {text}
      </button>
    );
  }
  return (
    <span className="import-dismiss-confirm">
      <button
        type="button"
        className="btn btn-secondary"
        aria-label={confirmLabel}
        disabled={disabled}
        onClick={onConfirm}
      >
        <Trash size={14} />
        Confirm dismiss
      </button>
      <button type="button" className="btn btn-ghost" onClick={onCancel}>
        Keep
      </button>
    </span>
  );
}

/** What the trip picker ranks against: the selection's dates and its places. */
function importSelection(drafts: PendingImportDraft[]): ImportSelection {
  return {
    range: combineRanges(drafts.map(draftRange)),
    locations: drafts.map((draft) => draft.location ?? ""),
  };
}

/**
 * A draft's LOCAL dates — the server already resolved each instant into the
 * calendar day it falls on in its own zone, which is the only comparison a
 * trip's `starts_on`/`ends_on` can honestly be made against. A draft dated at
 * one end only (a hotel with a check-in and no check-out) counts as that one
 * day rather than as undated.
 */
function draftRange(draft: PendingImportDraft): DateRange | null {
  if (!draft.localStartsOn) return null;
  return {
    startsOn: draft.localStartsOn,
    endsOn: draft.localEndsOn ?? draft.localStartsOn,
  };
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
    costCents: draft.costCents,
    travelerNames: draft.travelerNames,
    travelerEmails: draft.travelerEmails,
    details: draft.details,
  };
}

function formatReceivedAt(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString();
}
