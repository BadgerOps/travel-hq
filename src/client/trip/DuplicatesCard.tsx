import { useCallback, useEffect, useState } from "react";
import { CopySimple } from "@phosphor-icons/react";
import type { api as defaultApi } from "../api/client.js";
import type { DuplicateReason, Person, TripDuplicateGroup } from "../api/types.js";
import { useCanWrite } from "../api/identity.js";
import { Dialog } from "../components/Dialog.js";
import { PersonChips } from "../components/PersonChip.js";
import { formatBookingWhen } from "../lib/dates.js";
import { formatMoney } from "../lib/money.js";
import { errorMessage } from "../lib/errors.js";

/**
 * The sentence each rule gets to say for itself. The matcher's reason is
 * carried all the way to the UI rather than collapsed into a score, because
 * the only question this card asks a human is "is this really one booking?" —
 * and that is far easier to answer knowing *why* it was asked.
 */
const REASON_TEXT: Record<DuplicateReason, string> = {
  confirmation: "Same confirmation number",
  identical: "Same name, same time",
  "same-slot": "Same place and time, different names",
};

/**
 * Surfaces bookings on this trip that look like the same real event imported
 * twice, and offers the two honest resolutions: merge them into one, or record
 * that they are genuinely different so the card stops asking.
 *
 * Sits above the tabs with TripWarnings rather than inside Overview: a
 * doubled flight is wrong everywhere the trip is shown — the day view, the
 * cost rollup, the checklist counts — so it is trip-level news, not an
 * Overview detail.
 */
export function DuplicatesCard({
  tripId,
  people,
  api,
  reloadKey = 0,
  checkRequest = 0,
  onResolved,
}: {
  tripId: string;
  people: Person[];
  api: typeof defaultApi;
  /** Bumped by the page after any write, so a new import re-runs detection. */
  reloadKey?: number;
  /** Incremented by the trip menu to run and open an on-demand check. */
  checkRequest?: number;
  onResolved: () => void;
}) {
  const [groups, setGroups] = useState<TripDuplicateGroup[]>([]);
  const [reviewing, setReviewing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const canWrite = useCanWrite();

  const load = useCallback(async (reportFailure = false): Promise<boolean> => {
    const fetchDuplicates = api.trips?.duplicates;
    // Progressive enhancement, the same guard OverviewTab applies to the
    // itinerary strip: a harness with a partial api stub renders no card
    // rather than throwing.
    if (typeof fetchDuplicates !== "function") return false;
    try {
      setGroups((await fetchDuplicates(tripId)).groups);
      if (reportFailure) setFailed(null);
      return true;
    } catch (err) {
      // Detection is an extra, not the trip. A failure here degrades to no
      // card — every booking is still listed by Overview and the day view.
      setGroups([]);
      if (reportFailure) setFailed(errorMessage(err));
      return false;
    }
  }, [api, tripId]);

  useEffect(() => {
    void load();
  }, [load, reloadKey]);

  useEffect(() => {
    if (checkRequest === 0) return;
    void load(true).then(() => setReviewing(true));
  }, [checkRequest, load]);

  async function resolve(action: () => Promise<unknown>): Promise<void> {
    setBusy(true);
    try {
      await action();
      setFailed(null);
      await load();
      // The trip's bookings, costs, and day view all just changed.
      onResolved();
    } catch (err) {
      // A 403 (role changed under us) or 404 (already resolved in another
      // tab) must say so — a silently re-enabled button is the failure mode
      // this card would be worst at.
      setFailed(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  if (groups.length === 0 && !reviewing) return null;

  const count = groups.length;

  return (
    <>
      {count > 0 && (
        <div
          role="status"
          className="card"
          style={{ border: "1px solid #8a6d3b", marginBottom: 20 }}
        >
          <div className="dup-card-row">
            <div className="card-meta warning">
              <CopySimple size={13} />{" "}
              {count === 1
                ? "1 booking on this trip looks like a duplicate import"
                : `${count} sets of bookings on this trip look like duplicate imports`}
            </div>
            {canWrite && (
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => setReviewing(true)}
              >
                Review duplicates
              </button>
            )}
          </div>
        </div>
      )}

      {reviewing && (
        <Dialog
          title={
            failed && count === 0
              ? "Could not check duplicates"
              : count === 0
                ? "No duplicates found"
                : count === 1
                  ? "Possible duplicate"
                  : "Possible duplicates"
          }
          subtitle="Merging keeps one booking and fills its blanks from the others"
          onClose={() => setReviewing(false)}
        >
          {failed && (
            <p className="warning" role="alert" style={{ marginTop: 0 }}>
              {failed}
            </p>
          )}
          {count === 0 && !failed ? (
            <p className="text-muted">No likely duplicate bookings were found on this trip.</p>
          ) : count > 0 ? (
            <div className="dup-groups">
              {groups.map((group) => (
                <DuplicateGroupReview
                  key={group.bookings.map((b) => b.id).join("-")}
                  group={group}
                  people={people}
                  busy={busy}
                  onMerge={(keepId, mergeIds) =>
                    void resolve(() => api.trips.mergeDuplicates(tripId, keepId, mergeIds))
                  }
                  onDismiss={(bookingIds) =>
                    void resolve(() => api.trips.dismissDuplicates(tripId, bookingIds))
                  }
                />
              ))}
            </div>
          ) : null}
          <div className="dialog-actions">
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => setReviewing(false)}
            >
              Done
            </button>
          </div>
        </Dialog>
      )}
    </>
  );
}

/**
 * One group: why it matched, which booking to keep, and the two resolutions.
 *
 * The keeper is a radio group rather than an automatic pick because the choice
 * is not reversible and only the household knows which title is the one they
 * will recognise later. It is pre-selected to the server's suggestion — the
 * most complete row — so the common case is one click.
 */
function DuplicateGroupReview({
  group,
  people,
  busy,
  onMerge,
  onDismiss,
}: {
  group: TripDuplicateGroup;
  people: Person[];
  busy: boolean;
  onMerge: (keepId: string, mergeIds: string[]) => void;
  onDismiss: (bookingIds: string[]) => void;
}) {
  const [keepId, setKeepId] = useState(group.suggestedKeepId);
  const ids = group.bookings.map((b) => b.id);
  // Radio names must be unique per group, or two groups in one dialog share a
  // selection and picking a keeper in the second clears the first.
  const radioName = `dup-keep-${ids.join("-")}`;

  return (
    <section className="dup-group" aria-label={REASON_TEXT[group.reason]}>
      <h6 className="section-kicker">
        {REASON_TEXT[group.reason]}
        {group.confidence === "medium" && (
          <span className="tag tag-neutral dup-tag">Might not be</span>
        )}
      </h6>

      <div className="dup-options">
        {group.bookings.map((booking) => (
          <label key={booking.id} className="dup-option">
            <input
              type="radio"
              name={radioName}
              value={booking.id}
              checked={keepId === booking.id}
              onChange={() => setKeepId(booking.id)}
            />
            <span className="dup-option-body">
              <span className="dup-option-title">{booking.title}</span>
              <span className="dup-option-sub">{describe(booking)}</span>
              <PersonChips people={people.filter((p) => booking.personIds.includes(p.id))} />
            </span>
          </label>
        ))}
      </div>

      <div className="dup-actions">
        <button
          type="button"
          className="btn btn-secondary"
          disabled={busy}
          onClick={() => onDismiss(ids)}
        >
          Not duplicates
        </button>
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy}
          onClick={() => onMerge(keepId, ids.filter((id) => id !== keepId))}
        >
          Keep selected, merge {ids.length - 1}{" "}
          {ids.length - 1 === 1 ? "other" : "others"}
        </button>
      </div>
    </section>
  );
}

/**
 * The one line that has to make two near-identical rows distinguishable: when,
 * then whatever else they might differ on. Cost and confirmation are included
 * precisely because that is often the only difference — one import caught the
 * price or the record locator and the other did not, which is also exactly
 * what makes the merge worth doing rather than deleting one at random.
 */
function describe(booking: TripDuplicateGroup["bookings"][number]): string {
  const parts: string[] = [];
  const when = booking.startsAt ? formatBookingWhen(booking, "") : "";
  parts.push(when || "No date yet");
  if (booking.location) parts.push(booking.location);
  if (booking.confirmationNumberMasked) parts.push(`conf ${booking.confirmationNumberMasked}`);
  if (booking.costCents !== null) parts.push(formatMoney(booking.costCents));
  parts.push(booking.status);
  return parts.join(" · ");
}
