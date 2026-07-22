import type { Person } from "../api/types.js";

/**
 * Per-person colours come from a fixed palette indexed by a hash of the person
 * id, so a given person keeps the same colour across every screen without
 * storing a colour on the row.
 */
const PALETTE = [
  { bg: "var(--color-accent-700)", fg: "var(--color-accent-100)" },
  { bg: "var(--color-accent-2-800)", fg: "var(--color-accent-2-200)" },
  { bg: "var(--color-neutral-700)", fg: "var(--color-neutral-100)" },
  { bg: "#4c5397", fg: "var(--color-accent-200)" },
];

export function personColor(personId: string): { bg: string; fg: string } {
  let hash = 0;
  for (const ch of personId) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return PALETTE[hash % PALETTE.length]!;
}

export function PersonChip({ person }: { person: Pick<Person, "id" | "displayName"> }) {
  const { bg, fg } = personColor(person.id);
  return (
    <span
      className="person-chip"
      style={{ background: bg, color: fg }}
      title={person.displayName}
    >
      {person.displayName.slice(0, 1).toUpperCase()}
    </span>
  );
}

export function PersonChips({
  people,
}: {
  people: Pick<Person, "id" | "displayName">[];
}) {
  return (
    <span className="person-chips">
      {people.map((p) => (
        <PersonChip key={p.id} person={p} />
      ))}
    </span>
  );
}
