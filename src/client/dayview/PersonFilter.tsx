import type { Person } from "../api/types.js";
import { PersonChip } from "../components/PersonChip.js";

/**
 * 1c's filter pills: an "Everyone" chip plus one avatar chip per traveller.
 * Selection state is the accent outline via aria-pressed (see .chip-toggle);
 * clicking the selected person again returns to the whole-family view, so
 * "Everyone" is a convenience, not the only way back.
 */
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
    <div className="chip-row">
      <button
        type="button"
        className="chip-toggle"
        aria-pressed={selected === null}
        onClick={() => onSelect(null)}
      >
        Everyone
      </button>
      {people.map((p) => {
        const on = selected === p.id;
        return (
          <button
            key={p.id}
            type="button"
            className="chip-toggle"
            aria-pressed={on}
            onClick={() => onSelect(on ? null : p.id)}
          >
            <PersonChip person={p} />
            {p.displayName}
          </button>
        );
      })}
    </div>
  );
}
