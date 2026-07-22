import { Check } from "@phosphor-icons/react";
import type { Person } from "../api/types.js";
import { PersonChip } from "../components/PersonChip.js";

export function PersonFilter({
  people,
  selected,
  onSelect,
}: {
  people: Pick<Person, "id" | "displayName">[];
  selected: string | null;
  onSelect: (personId: string | null) => void;
}) {
  return (
    <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
      {people.map((p) => {
        const on = selected === p.id;
        return (
          <button
            key={p.id}
            type="button"
            className={on ? "btn btn-primary" : "btn btn-secondary"}
            aria-pressed={on}
            onClick={() => onSelect(on ? null : p.id)}
          >
            <PersonChip person={p} />
            {p.displayName}
            {on && <Check size={12} />}
          </button>
        );
      })}
    </div>
  );
}
