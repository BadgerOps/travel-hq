import { useCallback, useEffect, useState } from "react";
import { ClockCounterClockwise } from "@phosphor-icons/react";
import { api as defaultApi } from "../api/client.js";
import type { AuditEntry } from "../api/types.js";
import { errorMessage } from "../lib/errors.js";
import "./audit.css";

/** One page. Small enough that the first paint is quick, large enough that
    "Show older" is not the thing you spend the afternoon pressing. */
const PAGE_SIZE = 50;

/**
 * The household activity log.
 *
 * Deliberately NOT gated on `useCanWrite()`. `GET /api/audit/activity` is open
 * to every role, and it is the SERVER that decides what comes back: an owner
 * reads the whole household's history, anyone else reads only the entries they
 * are the actor or the subject of. That makes "who edited my passport number?"
 * answerable by the person it was done to, which is the entire reason a viewer
 * has a page here at all. Hiding the page from non-owners would have hidden
 * people's own records from them and gained nothing — the filtering already
 * happened before the bytes left the worker.
 *
 * Nothing here can render a revealed value, because none was ever stored:
 * `audit_log` names records and fields and has no column that could hold a
 * passport number (see repos/audit.ts). The footnote says so out loud, because
 * somebody reading an audit trail deserves to know what it does and does not
 * keep.
 */
export function Audit({ api = defaultApi }: { api?: typeof defaultApi }) {
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /**
   * Hides entries where somebody acted on their own record.
   *
   * This is the filter the log exists for. A family of five checking their own
   * passport numbers the night before a trip writes ten self-reveals, and the
   * one entry that matters — somebody unmasking a document that is not theirs
   * — sits underneath them. `self_service` was written at the time of the
   * action precisely so this question stays answerable.
   */
  const [othersOnly, setOthersOnly] = useState(false);

  const load = useCallback(
    async (before: string | null) => {
      setBusy(true);
      setError(null);
      try {
        const page = await api.audit.activity({
          limit: PAGE_SIZE,
          ...(before ? { cursor: before } : {}),
        });
        // Append rather than replace when paging: `before === null` is the
        // first page and starts the list over, which is also what a retry
        // after an error does.
        setEntries((current) => (before === null ? page.entries : [...(current ?? []), ...page.entries]));
        setCursor(page.nextCursor);
      } catch (err) {
        setError(errorMessage(err));
      } finally {
        setBusy(false);
      }
    },
    [api],
  );

  useEffect(() => {
    void load(null);
  }, [load]);

  // Filtering client-side, over the pages already fetched. The server has no
  // self_service query parameter, and adding one would mean a cursor whose
  // meaning changed with the filter. The cost is honest and worth naming: with
  // the filter on, a page of fifty can show far fewer than fifty rows, so the
  // count below reports what is being shown rather than what was loaded.
  const shown = (entries ?? []).filter((entry) => !othersOnly || !entry.selfService);

  return (
    <>
      <header className="page-header">
        <div className="page-title-group">
          <h3>Activity</h3>
          <p className="page-subline">
            What has happened to this household's records — who revealed a stored number, who
            changed whose details, and who was invited. Never the numbers themselves.
          </p>
        </div>
        <div className="page-actions">
          <button
            type="button"
            className="chip-toggle"
            aria-pressed={othersOnly}
            onClick={() => setOthersOnly((on) => !on)}
          >
            Only other people's records
          </button>
        </div>
      </header>

      {error && (
        <p className="warning" role="alert">
          {error}
        </p>
      )}

      {!error && entries === null && <p className="text-muted">Loading…</p>}

      {!error && entries !== null && shown.length === 0 && (
        <div className="card" style={{ alignItems: "flex-start", gap: 10 }}>
          <span className="card-title">
            <ClockCounterClockwise size={16} style={{ marginRight: 6 }} />
            {entries.length === 0 ? "Nothing has happened yet" : "Nothing but your own records"}
          </span>
          <p className="card-body" style={{ margin: 0 }}>
            {entries.length === 0
              ? "Unmasking a passport, Known Traveler, redress or confirmation number is recorded here, along with edits to people and changes to who is in the household."
              : "Every entry loaded so far is somebody acting on their own record. Turn the filter off to see them."}
          </p>
        </div>
      )}

      {!error && shown.length > 0 && (
        <ul className="activity-list" aria-label="Household activity">
          {shown.map((entry) => (
            <li
              key={entry.id}
              className={entry.selfService ? "activity-item activity-item--self" : "activity-item"}
              data-self={entry.selfService ? "true" : "false"}
            >
              <span className="activity-what">
                {sentence(entry)}
                {" "}
                <span className="activity-ref">{shortRef(entry.subjectId)}</span>
              </span>
              <span className="activity-meta">
                {entry.selfService ? (
                  <span className="tag tag-neutral">Own record</span>
                ) : (
                  isReveal(entry) && <span className="tag tag-accent">Someone else's</span>
                )}
                <time className="card-meta" dateTime={entry.at}>
                  {new Date(entry.at).toLocaleString()}
                </time>
              </span>
            </li>
          ))}
        </ul>
      )}

      {!error && entries !== null && (
        <div className="activity-foot">
          {cursor !== null ? (
            <button
              type="button"
              className="btn btn-secondary"
              disabled={busy}
              onClick={() => void load(cursor)}
            >
              {busy ? "Loading…" : "Show older"}
            </button>
          ) : (
            entries.length > 0 && <span className="text-muted">That is the whole log.</span>
          )}
          <p className="text-muted" style={{ margin: 0 }}>
            Revealed values are never stored in this log.
          </p>
        </div>
      )}
    </>
  );
}

/** The two events that unmask a stored secret. */
function isReveal(entry: AuditEntry): boolean {
  return entry.event === "document_reveal" || entry.event === "confirmation_reveal";
}

/**
 * One audit row as a sentence somebody's mother could read.
 *
 * A table of `event | subject_type | field` is a faithful rendering of the row
 * and tells a family member nothing. What they came to find out is "did
 * somebody look at MY passport number", so the actor, the verb, and whose
 * record it was are the three things the sentence leads with. The record's id
 * follows as a quiet handle rather than a column — it is there to match an
 * entry against a person you are looking at, not to be read aloud.
 */
export function sentence(entry: AuditEntry): string {
  const who = entry.actorEmail;
  switch (entry.event) {
    case "document_reveal":
    case "confirmation_reveal":
      return `${who} revealed the ${fieldLabel(entry.field)} on ${target(entry)}`;
    case "person_created":
      return `${who} added a person to the household`;
    case "person_updated": {
      const changed = fieldList(entry.fields);
      return changed
        ? `${who} changed the ${changed} on ${target(entry)}`
        : `${who} edited ${target(entry)}`;
    }
    case "member_invited":
      return `${who} invited someone to the household`;
    case "member_role_changed":
      return `${who} changed what someone in the household may do`;
    default:
      // The event list is a string-literal union and a CHECK constraint, so
      // this is unreachable today. It exists because a future event name
      // arriving from a newer server should degrade to a dull sentence rather
      // than a blank row that looks like the log lost something.
      return `${who} did something to ${target(entry)}`;
  }
}

/** Whose record this was, in words. The id is rendered separately. */
function target(entry: AuditEntry): string {
  if (entry.selfService) return "their own record";
  switch (entry.subjectType) {
    case "person":
      return "somebody else's record";
    case "booking":
      return "a booking";
    case "household_member":
      return "a household member";
    default:
      return "a record";
  }
}

/** "passport_number" → "passport number". Field NAMES only ever reach here. */
function fieldLabel(field: string | null): string {
  // Nullable because audit_log carries events that are not reveals; those name
  // their fields in `fields`. A reveal always has one, so the fallback is a
  // safety net rather than a case that renders.
  return field ? field.replace(/_/g, " ").trim() : "stored number";
}

/** ["phone","passport_number"] → "phone and passport number". */
function fieldList(fields: string[] | null): string | null {
  if (!fields || fields.length === 0) return null;
  const words = fields.map((f) => fieldLabel(f));
  if (words.length === 1) return words[0]!;
  // Hand-rolled rather than Intl.ListFormat: the field names themselves are
  // English column identifiers, so a locale-aware conjunction would be
  // decorating a string that was never localised in the first place.
  return `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

/**
 * A stable, quotable handle for the record. The full id is a UUID nobody can
 * read aloud; the tail is enough to match an entry against the person or
 * booking on screen. Same rule as the reveal panel in Settings.
 */
function shortRef(id: string): string {
  return id.length > 8 ? `…${id.slice(-8)}` : id;
}
