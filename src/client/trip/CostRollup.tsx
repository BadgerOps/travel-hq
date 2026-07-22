import type { TripRollup } from "../api/types.js";
import { formatMoney } from "../lib/money.js";

const number = new Intl.NumberFormat("en-US");

export function CostRollup({ rollup }: { rollup: TripRollup }) {
  if (rollup.totalCents === 0 && rollup.points.length === 0 && rollup.draftCount === 0) {
    return null;
  }

  return (
    <section className="card">
      <h6 className="card-kicker">Trip cost</h6>
      <div style={{ fontSize: 20, fontWeight: 500 }}>{formatMoney(rollup.totalCents)}</div>
      {rollup.plannedCents > 0 && (
        <div className="card-meta">
          {formatMoney(rollup.bookedCents)} booked · {formatMoney(rollup.plannedCents)} planned
        </div>
      )}
      {rollup.draftCount > 0 && (
        // The total above excludes draft bookings on purpose (an unreviewed
        // parsed email must not move the stated cost) — but Overview renders
        // every non-cancelled booking, drafts included, so without this line
        // the rows visibly sum to more than the total beside them with no
        // explanation. See RollupRepo.forTrip.
        <div className="card-meta">
          excludes {rollup.draftCount} draft{rollup.draftCount === 1 ? "" : "s"}
        </div>
      )}
      {rollup.points.map((p) => (
        <div key={p.program} className="card-meta">
          {number.format(p.used)} {p.program}
        </div>
      ))}
    </section>
  );
}
