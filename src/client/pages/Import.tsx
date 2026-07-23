import { useEffect, useState } from "react";
import {
  AirplaneTakeoff,
  Bed,
  Car,
  Confetti,
  EnvelopeSimple,
  ForkKnife,
} from "@phosphor-icons/react";
import { api as defaultApi } from "../api/client.js";
import type {
  AcceptDraftResult,
  DraftBooking,
  ImportQueueEmail,
  ImportQueueGroup,
  Person,
  Trip,
} from "../api/types.js";
import { formatBookingWhen } from "../lib/dates.js";
import { errorMessage } from "../lib/errors.js";
import { formatMoney } from "../lib/money.js";
import { useCanWrite } from "../api/identity.js";
import { AcceptDraftDialog } from "../import/AcceptDraftDialog.js";
import { EditDraftDialog } from "../import/EditDraftDialog.js";
import { OriginalEmailDialog } from "../import/OriginalEmailDialog.js";

const ICONS: Record<string, typeof AirplaneTakeoff> = {
  flight: AirplaneTakeoff,
  lodging: Bed,
  car: Car,
  activity: Confetti,
};

/**
 * The extraction payload's costCents, when it is present and sane. The
 * payload is opaque JSON — a shape this cannot read simply shows no cost.
 */
function draftCostCents(draft: DraftBooking): number | null {
  if (draft.extracted === null || typeof draft.extracted !== "object") return null;
  const value = (draft.extracted as { costCents?: unknown }).costCents;
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

/**
 * The /import review queue (issue #7): every pending draft booking, grouped
 * by the email it was extracted from, newest email first. Each draft can be
 * corrected (extraction is a suggestion, not truth), accepted onto an
 * existing or new trip, or dismissed — all server-enforced writes, so every
 * affordance is useCanWrite()-gated and a viewer sees a read-only queue.
 *
 * After any action the local state is updated in place — the queue reflects
 * the change without a reload, and a rejected write leaves everything (and
 * every typed value, in the dialogs) exactly as it was.
 */
export function Import({
  api = defaultApi,
}: {
  api?: typeof defaultApi;
}) {
  const [groups, setGroups] = useState<ImportQueueGroup[] | null>(null);
  const [trips, setTrips] = useState<Trip[]>([]);
  const [people, setPeople] = useState<Person[]>([]);
  const [loadFailed, setLoadFailed] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [editing, setEditing] = useState<DraftBooking | null>(null);
  const [accepting, setAccepting] = useState<DraftBooking | null>(null);
  const [viewing, setViewing] = useState<ImportQueueEmail | null>(null);
  const canWrite = useCanWrite();

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [queue, tripList, peopleList] = await Promise.all([
          api.import.queue(),
          api.trips.list(),
          api.people.list(),
        ]);
        if (cancelled) return;
        setGroups(queue);
        setTrips(tripList);
        setPeople(peopleList);
      } catch (err) {
        // Same rule as every fetching page: no silent "Loading…" forever. A
        // failed load replaces the view; it must never look like inbox zero.
        if (!cancelled) setLoadFailed(errorMessage(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api]);

  /** Drop a resolved draft; a group with nothing left to review disappears. */
  function removeDraft(draftId: string) {
    setGroups((prev) =>
      (prev ?? [])
        .map((group) => ({ ...group, drafts: group.drafts.filter((d) => d.id !== draftId) }))
        .filter((group) => group.drafts.length > 0),
    );
  }

  function replaceDraft(updated: DraftBooking) {
    setGroups((prev) =>
      (prev ?? []).map((group) => ({
        ...group,
        drafts: group.drafts.map((d) => (d.id === updated.id ? updated : d)),
      })),
    );
  }

  async function dismiss(draft: DraftBooking) {
    setBusyId(draft.id);
    setActionError(null);
    try {
      await api.import.dismissDraft(draft.id);
      removeDraft(draft.id);
    } catch (err) {
      // Leave the queue exactly as it was — a rejected write must not
      // unmount the page or drop the draft. Same rule as Checklist.
      setActionError(errorMessage(err));
    } finally {
      setBusyId(null);
    }
  }

  function onAccepted(result: AcceptDraftResult) {
    removeDraft(result.draft.id);
    // A trip created by accept-as-new-trip joins the picker immediately, so
    // the NEXT draft from the same email can be accepted onto it — that is
    // the several-emails-one-trip flow.
    setTrips((prev) => (prev.some((t) => t.id === result.trip.id) ? prev : [...prev, result.trip]));
    setAccepting(null);
  }

  if (loadFailed) {
    return (
      <p className="warning" role="alert">
        {loadFailed}
      </p>
    );
  }

  return (
    <>
      <header style={{ marginBottom: 20 }}>
        <h3 style={{ marginBottom: 4 }}>Import review</h3>
        <p className="text-muted" style={{ margin: 0 }}>
          Draft bookings extracted from forwarded emails. Nothing lands on a trip until you accept
          it.
        </p>
      </header>

      {actionError && (
        <div className="card-meta warning" role="alert" style={{ marginBottom: 12 }}>
          <span>{actionError}</span>
          <button
            type="button"
            className="btn btn-secondary btn-icon"
            aria-label="dismiss error"
            onClick={() => setActionError(null)}
          >
            ×
          </button>
        </div>
      )}

      {groups === null && <p className="text-muted">Loading…</p>}

      {groups !== null && groups.length === 0 && (
        <div className="card" style={{ maxWidth: 560, alignItems: "flex-start", gap: 10 }}>
          <span className="card-title">
            <EnvelopeSimple size={16} style={{ marginRight: 6, verticalAlign: "-2px" }} />
            Nothing waiting for review
          </span>
          <p className="card-body" style={{ margin: 0 }}>
            Forward a confirmation email to your household's forward address (set in Settings) and
            the extracted draft bookings will appear here for review.
          </p>
        </div>
      )}

      {groups !== null && groups.length > 0 && (
        <div style={{ display: "grid", gap: 24, maxWidth: 760 }}>
          {groups.map((group) => (
            <EmailGroup
              key={group.email.id}
              group={group}
              canWrite={canWrite}
              busyId={busyId}
              onViewOriginal={() => setViewing(group.email)}
              onEdit={setEditing}
              onAccept={setAccepting}
              onDismiss={(draft) => void dismiss(draft)}
            />
          ))}
        </div>
      )}

      {viewing && (
        <OriginalEmailDialog email={viewing} api={api} onClose={() => setViewing(null)} />
      )}

      {editing && (
        <EditDraftDialog
          draft={editing}
          api={api}
          onSaved={(updated) => {
            replaceDraft(updated);
            setEditing(null);
          }}
          onClose={() => setEditing(null)}
        />
      )}

      {accepting && (
        <AcceptDraftDialog
          draft={accepting}
          trips={trips}
          people={people}
          api={api}
          onAccepted={onAccepted}
          onClose={() => setAccepting(null)}
        />
      )}
    </>
  );
}

function EmailGroup({
  group,
  canWrite,
  busyId,
  onViewOriginal,
  onEdit,
  onAccept,
  onDismiss,
}: {
  group: ImportQueueGroup;
  canWrite: boolean;
  busyId: string | null;
  onViewOriginal: () => void;
  onEdit: (draft: DraftBooking) => void;
  onAccept: (draft: DraftBooking) => void;
  onDismiss: (draft: DraftBooking) => void;
}) {
  const { email, drafts } = group;
  const subject = email.subject ?? "(no subject)";

  return (
    <section aria-label={subject}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
        <h5 className="card-title" style={{ margin: 0 }}>
          {subject}
        </h5>
        <button
          type="button"
          className="btn btn-ghost"
          style={{ marginLeft: "auto", fontSize: 11 }}
          onClick={onViewOriginal}
        >
          View original
        </button>
      </div>
      <h6 className="card-kicker" style={{ margin: "2px 0 10px" }}>
        from {email.from} · {email.receivedAt.slice(0, 10)}
      </h6>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {drafts.map((draft) => (
          <DraftCard
            key={draft.id}
            draft={draft}
            canWrite={canWrite}
            busy={busyId === draft.id}
            onEdit={() => onEdit(draft)}
            onAccept={() => onAccept(draft)}
            onDismiss={() => onDismiss(draft)}
          />
        ))}
      </div>
    </section>
  );
}

function DraftCard({
  draft,
  canWrite,
  busy,
  onEdit,
  onAccept,
  onDismiss,
}: {
  draft: DraftBooking;
  canWrite: boolean;
  busy: boolean;
  onEdit: () => void;
  onAccept: () => void;
  onDismiss: () => void;
}) {
  const Icon = ICONS[draft.kind] ?? ForkKnife;
  const cost = draftCostCents(draft);

  return (
    <div
      className="card"
      // Dashed like OverviewTab's provisional bookings: a draft is not part
      // of any trip yet, and it should look that way.
      style={{ border: "1px dashed var(--color-divider)", background: "none" }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <Icon size={18} />
        <span style={{ fontSize: 15, fontWeight: 500 }}>{draft.title}</span>
        <span className="tag">{draft.source === "ics" ? "Calendar" : "AI"}</span>
        {canWrite && (
          <span style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
            <button
              type="button"
              className="btn btn-secondary"
              style={{ fontSize: 11 }}
              aria-label={`Edit ${draft.title}`}
              disabled={busy}
              onClick={onEdit}
            >
              Edit
            </button>
            <button
              type="button"
              className="btn btn-primary"
              style={{ fontSize: 11 }}
              aria-label={`Accept ${draft.title}`}
              disabled={busy}
              onClick={onAccept}
            >
              Accept…
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              style={{ fontSize: 11 }}
              aria-label={`Dismiss ${draft.title}`}
              disabled={busy}
              onClick={onDismiss}
            >
              Dismiss
            </button>
          </span>
        )}
      </div>
      <div className="card-meta">
        <span>{formatBookingWhen(draft, "No date yet")}</span>
        {draft.location && <span>{draft.location}</span>}
        {/* Plaintext by design pre-accept: the same value sits in the raw
            email one click away; it is encrypted the moment it becomes a
            booking. Showing it is the point — reviewing it IS the job. */}
        {draft.confirmationNumber && <span># {draft.confirmationNumber}</span>}
        {cost !== null && <span style={{ marginLeft: "auto" }}>{formatMoney(cost)}</span>}
      </div>
    </div>
  );
}
