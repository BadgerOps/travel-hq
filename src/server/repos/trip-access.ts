import { newId } from "../ids.js";
import {
  ForbiddenError,
  NotFoundError,
  TenantRepo,
  ValidationError,
  type HouseholdContext,
} from "./base.js";

export const TRIP_MEMBER_ROLES = ["viewer", "editor"] as const;
export type TripMemberRole = (typeof TRIP_MEMBER_ROLES)[number];
export type TripAccessRole = "owner" | TripMemberRole;

export type TripMember = {
  userId: string;
  email: string;
  role: TripMemberRole;
  createdAt: string;
};

type MemberRow = {
  user_id: string;
  email: string;
  role: TripMemberRole;
  created_at: string;
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export class TripAccessRepo extends TenantRepo {
  constructor(
    db: D1Database,
    ctx: HouseholdContext,
  ) {
    super(db, ctx);
  }

  async roleForTrip(tripId: string): Promise<TripAccessRole | undefined> {
    const trip = await this.get<{ id: string }>(
      "SELECT id FROM trip WHERE {scope} AND id = ?2",
      tripId,
    );
    if (!trip) return undefined;
    if (this.ctx.role === "owner") return "owner";
    if (this.ctx.role === "admin") return "editor";

    const rows = await this.unscoped<{ role: TripMemberRole }>(
      "trip_member is a join table; trip ownership was confirmed by the scoped trip query above",
      "SELECT role FROM trip_member WHERE trip_id = ? AND user_id = ?",
      tripId,
      this.ctx.userId,
    );
    return rows[0]?.role;
  }

  async tripIdForBooking(bookingId: string): Promise<string | undefined> {
    return (
      await this.get<{ trip_id: string }>(
        "SELECT trip_id FROM booking WHERE {scope} AND id = ?2",
        bookingId,
      )
    )?.trip_id;
  }

  async tripIdForChecklistItem(itemId: string): Promise<string | undefined> {
    return (
      await this.get<{ trip_id: string }>(
        "SELECT trip_id FROM checklist_item WHERE {scope} AND id = ?2",
        itemId,
      )
    )?.trip_id;
  }

  async list(tripId: string): Promise<TripMember[]> {
    this.requireOwner();
    if (!(await this.roleForTrip(tripId))) {
      throw new NotFoundError("Trip not found in this household");
    }
    const rows = await this.unscoped<MemberRow>(
      "trip_member and user carry no household scope; the trip was confirmed in-household above",
      `SELECT tm.user_id, u.email, tm.role, tm.created_at
         FROM trip_member tm
         JOIN user u ON u.id = tm.user_id
        WHERE tm.trip_id = ?
        ORDER BY lower(u.email)`,
      tripId,
    );
    return rows.map((row) => ({
      userId: row.user_id,
      email: row.email,
      role: row.role,
      createdAt: row.created_at,
    }));
  }

  async invite(tripId: string, rawEmail: string, role: TripMemberRole): Promise<TripMember> {
    this.requireOwner();
    if (!TRIP_MEMBER_ROLES.includes(role)) {
      throw new ValidationError("Invalid trip member role");
    }
    if (!(await this.roleForTrip(tripId))) {
      throw new NotFoundError("Trip not found in this household");
    }

    const email = rawEmail.trim().toLowerCase();
    if (email.length > 320 || !EMAIL_RE.test(email)) {
      throw new ValidationError("Enter a valid email address");
    }

    const now = new Date().toISOString();
    let user = (
      await this.unscoped<{ id: string }>(
        "user accounts are globally keyed by case-insensitive email",
        "SELECT id FROM user WHERE lower(email) = ?",
        email,
      )
    )[0];
    if (!user) {
      await this.unscopedRun(
        "user accounts are globally keyed by normalized email; owner is provisioning an invited account",
        `INSERT INTO user (id, email, created_at)
         VALUES (?, ?, ?)
         ON CONFLICT DO NOTHING`,
        newId(),
        email,
        now,
      );
      user = (
        await this.unscoped<{ id: string }>(
          "user accounts are globally keyed by case-insensitive email",
          "SELECT id FROM user WHERE lower(email) = ?",
          email,
        )
      )[0];
    }
    if (!user) throw new Error("Invited user disappeared after provisioning");

    await this.unscopedBatchRun(
      "owner is provisioning household authentication and trip-specific authorization for one invited email",
      [
        {
          sql: `INSERT INTO household_member (household_id, user_id, role)
                VALUES (?, ?, 'viewer')
                ON CONFLICT(household_id, user_id) DO NOTHING`,
          params: [this.ctx.householdId, user.id],
        },
        {
          sql: `INSERT INTO trip_member
                  (trip_id, user_id, role, invited_by_user_id, created_at)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(trip_id, user_id) DO UPDATE SET role = excluded.role`,
          params: [tripId, user.id, role, this.ctx.userId, now],
        },
      ],
    );

    return { userId: user.id, email, role, createdAt: now };
  }

  async remove(tripId: string, userId: string): Promise<void> {
    this.requireOwner();
    if (!(await this.roleForTrip(tripId))) {
      throw new NotFoundError("Trip not found in this household");
    }
    await this.unscopedRun(
      "trip_member is a join table; the trip was confirmed in-household above",
      "DELETE FROM trip_member WHERE trip_id = ? AND user_id = ?",
      tripId,
      userId,
    );
  }

  private requireOwner(): void {
    if (this.ctx.role !== "owner") {
      throw new ForbiddenError("Only household owners may manage trip invitations");
    }
  }
}
