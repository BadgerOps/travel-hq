import { Check } from "@phosphor-icons/react";
import type { Person } from "../api/types.js";
import { PersonChip } from "./PersonChip.js";

/**
 * The "who's on it" control from design 1g and the Import prototype. A real
 * <button> with `aria-pressed`, not a styled <span>: the design draws
 * selection as an accent outline plus a check, and colour alone is not a
 * state a screen reader or a colour-blind user can read.
 */
export function TravelerToggles({
  people,
  selected,
  onToggle,
}: {
  people: Pick<Person, "id" | "displayName">[];
  selected: string[];
  onToggle: (personId: string) => void;
}) {
  if (people.length === 0) {
    return <p className="text-muted" style={{ margin: 0 }}>No people yet — add the family first.</p>;
  }

  return (
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
      {people.map((p) => {
        const on = selected.includes(p.id);
        return (
          <button
            key={p.id}
            type="button"
            className={on ? "tag tag-outline" : "tag"}
            aria-pressed={on}
            onClick={() => onToggle(p.id)}
            style={{
              gap: 6,
              padding: "5px 11px",
              cursor: "pointer",
              border: on ? undefined : "1px solid var(--color-divider)",
              color: on ? undefined : "var(--color-neutral-400)",
              background: "none",
            }}
          >
            <PersonChip person={p} />
            {p.displayName}
            {on && <Check size={11} />}
          </button>
        );
      })}
    </div>
  );
}
