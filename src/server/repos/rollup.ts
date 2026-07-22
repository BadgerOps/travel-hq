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
  points: { program: string; used: number }[];
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

    const points = await this.all<{ program: string; used: number }>(
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

    return {
      bookedCents,
      plannedCents,
      totalCents: bookedCents + plannedCents,
      draftCount: draft?.count ?? 0,
      points,
    };
  }
}
