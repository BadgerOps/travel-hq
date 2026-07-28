import { useEffect, useState } from "react";
import { Plus } from "@phosphor-icons/react";
import { api as defaultApi } from "../api/client.js";
import type { Person } from "../api/types.js";
import { errorMessage } from "../lib/errors.js";
import { PersonCard } from "../components/PersonCard.js";
import { PersonForm } from "../components/PersonForm.js";

/**
 * Decided in this plan: a card grid in the trip-card idiom, one card per
 * family member, masked document numbers, and a passport-expiry warning row.
 * The design bundle never covered this page.
 *
 * `arrivalOn={null}` on every card: there is no trip here, so passport
 * validity is measured from today. `PersonCard` handles that fallback.
 */
export function People({
  api = defaultApi,
  today = new Intl.DateTimeFormat("en-CA").format(new Date()),
}: {
  api?: typeof defaultApi;
  today?: string;
}) {
  const [people, setPeople] = useState<Person[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Person | null>(null);
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api.people
      .list()
      .then((rows) => {
        if (!cancelled) setPeople(rows);
      })
      // Without this the page sits on "Loading…" forever on any failure and
      // the rejection goes unhandled. An empty household and a failed fetch
      // must never look the same.
      .catch((err) => {
        if (!cancelled) setError(errorMessage(err));
      });
    return () => {
      cancelled = true;
    };
  }, [api]);

  function onSaved(saved: Person) {
    setPeople((prev) => {
      const rows = prev ?? [];
      const exists = rows.some((p) => p.id === saved.id);
      const next = exists ? rows.map((p) => (p.id === saved.id ? saved : p)) : [...rows, saved];
      return [...next].sort((a, b) => a.displayName.localeCompare(b.displayName));
    });
    setEditing(null);
    setAdding(false);
  }

  return (
    <>
      <header className="page-header">
        <div className="page-title-group">
          <h3>People</h3>
          <p className="page-subline">
            Travel documents for everyone in the household. Numbers are stored encrypted and
            shown masked; revealing one is logged.
          </p>
        </div>
        <div className="page-actions">
          <button type="button" className="btn btn-primary" onClick={() => setAdding(true)}>
            <Plus size={14} /> Add person
          </button>
        </div>
      </header>

      {error && (
        <p className="warning" role="alert">
          {error}
        </p>
      )}

      {!error && people === null && <p className="text-muted">Loading…</p>}

      {!error && people !== null && people.length === 0 && (
        <div className="card" style={{ alignItems: "flex-start", gap: 10 }}>
          <span className="card-title">No one here yet</span>
          <p className="card-body" style={{ margin: 0 }}>
            Nothing else in Travel HQ works until the family is entered — trips need travellers
            and bookings need people to be on them. Start with one person; passports and Known
            Traveler numbers can be filled in later.
          </p>
          <button type="button" className="btn btn-primary" onClick={() => setAdding(true)}>
            <Plus size={14} /> Add the first family member
          </button>
        </div>
      )}

      {!error && people !== null && people.length > 0 && (
        <div className="grid-cards">
          {people.map((p) => (
            <PersonCard
              key={p.id}
              person={p}
              arrivalOn={null}
              today={today}
              api={api}
              onEdit={setEditing}
            />
          ))}
        </div>
      )}

      {adding && (
        <PersonForm api={api} onSaved={onSaved} onClose={() => setAdding(false)} />
      )}
      {editing && (
        <PersonForm
          // Remount per person: PersonForm seeds its state from props once,
          // so reusing one instance across two different people would show
          // the first person's values in the second person's form.
          key={editing.id}
          person={editing}
          api={api}
          onSaved={onSaved}
          onClose={() => setEditing(null)}
        />
      )}
    </>
  );
}
