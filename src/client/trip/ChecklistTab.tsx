import { useEffect, useState } from "react";
import type { api as defaultApi } from "../api/client.js";
import type { ChecklistItem, Person } from "../api/types.js";
import { PersonChip } from "../components/PersonChip.js";
import { formatDateRange } from "../lib/dates.js";
import { useCanWrite } from "../api/identity.js";

export function ChecklistTab({
  tripId,
  people,
  api,
}: {
  tripId: string;
  people: Person[];
  api: typeof defaultApi;
}) {
  const [items, setItems] = useState<ChecklistItem[]>([]);
  // Distinct from writeError below: a failed *load* means we never have a
  // list to show at all, so the whole tab is replaced. A failed *write*
  // means we already have a list — losing it because one toggle bounced
  // would be strictly worse than leaving the stale-but-correct state on
  // screen.
  const [loadFailed, setLoadFailed] = useState(false);
  const [writeError, setWriteError] = useState(false);
  const canWrite = useCanWrite();

  useEffect(() => {
    let cancelled = false;
    api.checklist
      .list(tripId)
      .then((all) => {
        if (!cancelled) setItems(all.filter((i) => i.tripId === tripId));
      })
      // Same rule as TripDetail: an unhandled rejection here would leave the
      // tab looking like an empty checklist, which is a lie — "nothing to do"
      // and "we could not find out" must not render identically.
      .catch(() => {
        if (!cancelled) setLoadFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [api, tripId]);

  async function toggle(item: ChecklistItem) {
    const done = item.doneAt === null;
    setWriteError(false);
    try {
      await api.checklist.setDone(item.id, done);
    } catch {
      // The write failed (403 for a viewer whose only path here is a stale
      // client-side check racing a role change, 404 for an item deleted in
      // another tab). Leave the item as it was rather than optimistically
      // showing a state the server rejected — and leave the rest of the list
      // exactly as it was too: a transient write failure must not unmount
      // the tab.
      setWriteError(true);
      return;
    }
    setItems((prev) =>
      prev.map((i) =>
        i.id === item.id ? { ...i, doneAt: done ? new Date().toISOString() : null } : i,
      ),
    );
  }

  const doneCount = items.filter((i) => i.doneAt !== null).length;
  // Only feeds formatDateRange's "append the year?" decision, so computing it
  // per render (rather than plumbing a prop like pages/Checklist.tsx does) is
  // fine here.
  const today = new Intl.DateTimeFormat("en-CA").format(new Date());

  if (loadFailed) {
    return (
      <p className="text-muted" role="alert">
        Couldn't load this trip's checklist.
      </p>
    );
  }

  if (items.length === 0) {
    return <p className="text-muted">No checklist items for this trip yet.</p>;
  }

  return (
    <section>
      <h6 className="card-kicker">
        {doneCount} of {items.length} done
      </h6>
      {writeError && (
        <div className="card-meta warning" role="alert" style={{ marginBottom: 8 }}>
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
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {items.map((item) => {
          const assignee = people.find((p) => p.id === item.personId);
          const done = item.doneAt !== null;
          const content = (
            <>
              <span style={{ fontSize: 13 }}>{item.label}</span>
              {item.dueOn && (
                <span className="card-meta">due {formatDateRange(item.dueOn, null, today)}</span>
              )}
              <span style={{ marginLeft: "auto" }}>
                {assignee && <PersonChip person={assignee} />}
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

          // A viewer's write is a guaranteed 403 (ChecklistRepo.setDone goes
          // through requireWrite()), so offering a clickable affordance would
          // be a control that can only fail — same rule MaskedValue applies
          // to reveal buttons. Static text, no cursor, nothing to click.
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
              onClick={() => toggle(item)}
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
