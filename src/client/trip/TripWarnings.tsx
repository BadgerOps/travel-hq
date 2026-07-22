import { WarningCircle } from "@phosphor-icons/react";
import type { Person } from "../api/types.js";
import { passportStatus, passportWarningText } from "../lib/passport.js";

/**
 * Plan 3's flagged promotion. Design 1b puts an expiring-passport row inside
 * the right rail's Travelers card; plan 3 shipped only CostRollup in the rail
 * and moved travellers into a tab, which left this warning visible only to
 * someone who happened to open that tab. A passport that will be too short at
 * arrival is trip-level news, so it renders above the tabs.
 *
 * `role="status"` rather than `role="alert"`: this is a standing condition
 * present on first render, not an event. `alert` would interrupt a screen
 * reader on every page load.
 */
export function TripWarnings({
  people,
  arrivalOn,
  today,
}: {
  people: Person[];
  arrivalOn: string | null;
  today: string;
}) {
  const warnings = people
    .map((p) => passportWarningText(p, passportStatus(p, arrivalOn, today)))
    .filter((text): text is string => text !== null);

  if (warnings.length === 0) return null;

  return (
    <div
      role="status"
      className="card"
      style={{ border: "1px solid #8a6d3b", marginBottom: 20 }}
    >
      {warnings.map((text) => (
        <div key={text} className="card-meta warning">
          <WarningCircle size={13} /> {text}
        </div>
      ))}
    </div>
  );
}
