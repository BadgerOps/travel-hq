import type { api as defaultApi } from "../api/client.js";
import type { Person } from "../api/types.js";
import { PersonCard } from "../components/PersonCard.js";

/**
 * A thin map over PersonCard. The expiry rule this used to own now lives in
 * `lib/passport.ts` and the markup in `components/PersonCard.tsx`, so this
 * tab and the People page cannot drift apart.
 *
 * No `onEdit`: editing a person from inside a trip is not a flow this app
 * builds, and design 1b does not show one.
 */
export function TravelersTab({
  people,
  arrivalOn,
  api,
  today = new Intl.DateTimeFormat("en-CA").format(new Date()),
}: {
  people: Person[];
  arrivalOn: string | null;
  api: typeof defaultApi;
  today?: string;
}) {
  if (people.length === 0) {
    return <p className="text-muted">No travellers on this trip yet.</p>;
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {people.map((p) => (
        <PersonCard key={p.id} person={p} arrivalOn={arrivalOn} today={today} api={api} />
      ))}
    </div>
  );
}
