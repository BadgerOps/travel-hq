import { useEffect, useState } from "react";
import { Link } from "wouter";
import { Check } from "@phosphor-icons/react";
import { api as defaultApi } from "../api/client.js";
import { useCanWrite } from "../api/identity.js";
import type { ChecklistItem } from "../api/types.js";
import { daysUntil } from "../lib/dates.js";
import { errorMessage } from "../lib/errors.js";

/** Undone first, then soonest due, with undated items last. */
function rank(a: ChecklistItem, b: ChecklistItem): number {
  const aDone = a.doneAt !== null;
  const bDone = b.doneAt !== null;
  if (aDone !== bDone) return aDone ? 1 : -1;
  if (a.dueOn === null) return b.dueOn === null ? 0 : 1;
  if (b.dueOn === null) return -1;
  return a.dueOn.localeCompare(b.dueOn);
}

/**
 * Urgency from data this card actually has. The prototype paints "132 days"
 * amber because that row is a passport blocker, not because 132 days is a
 * threshold; a generic checklist item carries no such signal. Passport amber
 * lives in TripWarnings and PersonCard, where the expiry date is in hand.
 */
function urgency(dueOn: string | null, today: string): { text: string; tone: string } | null {
  if (dueOn === null) return null;
  const days = daysUntil(dueOn, today);
  if (days < 0) return { text: "overdue", tone: "#d9b98a" };
  if (days === 0) return { text: "today", tone: "var(--color-accent-300)" };
  return { text: `${days} day${days === 1 ? "" : "s"}`, tone: "var(--color-neutral-500)" };
}

export function NextBestActions({
  api = defaultApi,
  today = new Intl.DateTimeFormat("en-CA").format(new Date()),
  limit = 4,
}: {
  api?: typeof defaultApi;
  today?: string;
  limit?: number;
}) {
  const [items, setItems] = useState<ChecklistItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [writeError, setWriteError] = useState<string | null>(null);
  const canWrite = useCanWrite();

  useEffect(() => {
    let cancelled = false;
    api.checklist
      .list()
      .then((all) => {
        if (!cancelled) setItems(all);
      })
      // Without this the card renders as "no actions", which reads as "you
      // are all caught up" -- the most misleading thing it could say.
      .catch((err) => {
        if (!cancelled) setError(errorMessage(err));
      });
    return () => {
      cancelled = true;
    };
  }, [api]);

  async function toggle(item: ChecklistItem) {
    const done = item.doneAt === null;
    setWriteError(null);
    try {
      await api.checklist.setDone(item.id, done);
    } catch (err) {
      // Distinct from `error` above: a failed *load* means there is no list
      // to show at all and the card is replaced entirely. A failed *write*
      // means the list we already have is still correct -- losing it because
      // one toggle bounced would be strictly worse than leaving the
      // stale-but-accurate state on screen (see ChecklistTab).
      setWriteError(errorMessage(err));
      return;
    }
    setItems((prev) =>
      (prev ?? []).map((i) =>
        i.id === item.id ? { ...i, doneAt: done ? new Date().toISOString() : null } : i,
      ),
    );
  }

  if (error) {
    return (
      <section className="card" style={{ flex: "1 1 340px" }}>
        <h6 className="card-kicker">Next best actions</h6>
        <p className="warning" role="alert" style={{ margin: 0, fontSize: 12 }}>
          Couldn't load the checklist. {error}
        </p>
      </section>
    );
  }

  // Still loading, or genuinely nothing to do: render nothing rather than an
  // empty panel taking up a third of the hero row.
  if (items === null || items.length === 0) return null;

  const ranked = items.slice().sort(rank).slice(0, limit);

  return (
    <section className="card" style={{ flex: "1 1 340px" }}>
      <h6 className="card-kicker">Next best actions</h6>

      {writeError && (
        <p className="warning" role="alert" style={{ margin: "0 0 10px", fontSize: 12 }}>
          That change didn't save. {writeError}
        </p>
      )}

      {ranked.map((item, index) => {
        const done = item.doneAt !== null;
        const due = urgency(item.dueOn, today);
        const rowStyle = {
          display: "flex",
          alignItems: "center",
          gap: 10,
          width: "100%",
          padding: 0,
          background: "none",
          border: 0,
          color: "inherit",
          font: "inherit",
          textAlign: "left" as const,
          opacity: done ? 0.45 : 1,
        };
        const badge = (
          <span
            aria-hidden="true"
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              width: 22,
              height: 22,
              flex: "none",
              borderRadius: "var(--radius-sm)",
              fontSize: 11,
              background:
                done || index === 0 ? "var(--color-accent-800)" : "var(--color-neutral-800)",
              color: done || index === 0 ? "var(--color-accent-200)" : "var(--color-neutral-200)",
            }}
          >
            {done ? <Check size={12} /> : index + 1}
          </span>
        );
        const label = (
          <span
            data-testid="action-label"
            style={{
              fontSize: 13,
              fontWeight: 500,
              textDecoration: done ? "line-through" : "none",
            }}
          >
            {item.label}
          </span>
        );
        return (
          <div key={item.id}>
            {canWrite ? (
              <button
                type="button"
                data-testid={`action-row-${item.id}`}
                data-done={String(done)}
                onClick={() => void toggle(item)}
                style={{ ...rowStyle, cursor: "pointer" }}
              >
                {badge}
                {label}
                {due && (
                  <span style={{ marginLeft: "auto", fontSize: 11, color: due.tone }}>
                    {due.text}
                  </span>
                )}
              </button>
            ) : (
              // A viewer's write is a guaranteed 403 (ChecklistRepo.setDone
              // goes through requireWrite()), so offering a clickable
              // affordance here would be a control that can only fail -- same
              // rule ChecklistTab and MaskedValue apply to their own writes.
              <div data-testid={`action-row-${item.id}`} data-done={String(done)} style={rowStyle}>
                {badge}
                {label}
                {due && (
                  <span style={{ marginLeft: "auto", fontSize: 11, color: due.tone }}>
                    {due.text}
                  </span>
                )}
              </div>
            )}
            {index < ranked.length - 1 && <hr className="hr" style={{ margin: "10px 0" }} />}
          </div>
        );
      })}

      <Link href="/checklist" className="btn btn-ghost" style={{ alignSelf: "flex-start" }}>
        Full checklist →
      </Link>
    </section>
  );
}
