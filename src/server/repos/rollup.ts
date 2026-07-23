import { TenantRepo, NotFoundError } from "./base.js";

export type TripRollup = {
  bookedCents: number;
  plannedCents: number;
  totalCents: number;
  /**
   * Count of `draft` bookings excluded from `totalCents`. Draft/cancelled
   * exclusion from the total is the recorded decision (an unreviewed parsed
   * email must not move the stated cost) — this field exists so a client can
   * disclose the exclusion instead of silently showing a total that doesn't
   * sum to the visible rows. Cancelled bookings aren't counted here: they
   * don't render as a row on Overview at all (it filters them out before
   * OverviewTab ever sees them), so there is nothing for their exclusion to
   * look inconsistent with.
   */
  draftCount: number;
  /**
   * `balance` is the household's available points in that program, summed
   * over the card portfolio (card.points_balance) — null when no card carries
   * the program. Program-level on purpose: a booking records points_program,
   * not which card paid, so per-card attribution would be invented data (see
   * the card-perks design spec). Optional in the type so pre-cards client
   * fixtures remain valid; the server always includes it.
   */
  points: { program: string; used: number; balance?: number | null }[];
};

export class RollupRepo extends TenantRepo {
  /**
   * Cost and points totals for one trip. Draft and cancelled bookings are
   * excluded — an unreviewed parsed email must not move the stated cost.
   *
   * Existence-checks the trip first, the same way BookingRepo.listByTrip
   * does (I5). Without it "this trip does not exist" and "this trip has no
   * bookings" are both `200 {totalCents: 0}`, so a stale or mistyped trip id
   * renders as a real, empty trip — and the sibling /bookings call in
   * TripDetail's Promise.all 404s on the identical id, leaving the page in
   * two contradictory states at once.
   */
  async forTrip(tripId: string): Promise<TripRollup> {
    const trip = await this.get<{ id: string }>("SELECT id FROM trip WHERE {scope} AND id = ?2", tripId);
    if (!trip) throw new NotFoundError("Trip not found in this household");

    const costs = await this.all<{ status: string; total: number }>(
      `SELECT status, COALESCE(SUM(cost_cents), 0) AS total
         FROM booking
        WHERE {scope} AND trip_id = ?2
          AND status IN ('booked', 'planned')
        GROUP BY status`,
      tripId,
    );

    const bookedCents = costs.find((c) => c.status === "booked")?.total ?? 0;
    const plannedCents = costs.find((c) => c.status === "planned")?.total ?? 0;

    const draft = await this.get<{ count: number }>(
      `SELECT COUNT(*) AS count FROM booking WHERE {scope} AND trip_id = ?2 AND status = 'draft'`,
      tripId,
    );

    const used = await this.all<{ program: string; used: number }>(
      `SELECT points_program AS program, COALESCE(SUM(points_used), 0) AS used
         FROM booking
        WHERE {scope} AND trip_id = ?2
          AND status IN ('booked', 'planned')
          AND points_program IS NOT NULL
          AND points_used IS NOT NULL
        GROUP BY points_program
        ORDER BY points_program`,
      tripId,
    );

    // The card portfolio's balance per program (issue #2): lets the rollup
    // say "12,500 UR used · 85,000 available" instead of a bare usage count.
    // Queried only when the trip actually used points -- most trips don't,
    // and the join is in JS because bookings know a program, never a card.
    let balances = new Map<string, number>();
    if (used.length > 0) {
      const rows = await this.all<{ program: string; balance: number }>(
        `SELECT points_program AS program, COALESCE(SUM(points_balance), 0) AS balance
           FROM card
          WHERE {scope}
            AND points_program IS NOT NULL
            AND points_balance IS NOT NULL
          GROUP BY points_program`,
      );
      balances = new Map(rows.map((r) => [r.program, r.balance]));
    }

    return {
      bookedCents,
      plannedCents,
      totalCents: bookedCents + plannedCents,
      draftCount: draft?.count ?? 0,
      points: used.map((p) => ({ ...p, balance: balances.get(p.program) ?? null })),
    };
  }
}
