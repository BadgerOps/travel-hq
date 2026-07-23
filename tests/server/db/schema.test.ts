import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";

// Each test starts from the migrated-but-empty database (isolated storage).
async function tableNames(): Promise<string[]> {
  const { results } = await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT IN ('d1_migrations', '_cf_METADATA') ORDER BY name",
  ).all<{ name: string }>();
  return results.map((r) => r.name);
}

describe("migrated schema", () => {
  beforeEach(async () => {
    // Clean the rows a prior test may have left; the schema itself persists.
    await env.DB.exec("DELETE FROM household");
  });

  it("creates every core table, including inbound_email and draft_booking", async () => {
    expect(await tableNames()).toEqual([
      "booking",
      "booking_person",
      "checklist_item",
      "draft_booking",
      "household",
      "household_member",
      "household_settings",
      "inbound_email",
      "loyalty_account",
      "person",
      "reveal_audit",
      "trip",
      "trip_person",
      "user",
    ]);
  });

  it("cascades a household delete down to its trips, bookings, inbound email, drafts, and reveal audit", async () => {
    const now = new Date().toISOString();
    await env.DB.prepare("INSERT INTO household (id, name, created_at) VALUES (?, ?, ?)")
      .bind("hh-a", "A", now)
      .run();
    await env.DB.prepare("INSERT INTO trip (id, household_id, title, created_at) VALUES (?, ?, ?, ?)")
      .bind("t1", "hh-a", "Mine", now)
      .run();
    await env.DB.prepare(
      "INSERT INTO booking (id, household_id, trip_id, kind, title, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
      .bind("b1", "hh-a", "t1", "other", "Hotel", now)
      .run();
    await env.DB.prepare(
      "INSERT INTO inbound_email (id, household_id, from_address, to_address, raw, status, received_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
      .bind("ie1", "hh-a", "a@example.com", "trips@badgerops.foo", "raw", "received", now)
      .run();
    await env.DB.prepare(
      "INSERT INTO draft_booking (id, household_id, inbound_email_id, kind, title, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
      .bind("db1", "hh-a", "ie1", "other", "Hotel stay", "ai", now)
      .run();
    await env.DB.prepare(
      "INSERT INTO reveal_audit (id, household_id, user_id, user_email, person_id, field, revealed_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
      .bind("ra1", "hh-a", "u1", "owner@example.com", "p1", "passport_number", now)
      .run();

    await env.DB.prepare("DELETE FROM household WHERE id = ?").bind("hh-a").run();

    const trip = await env.DB.prepare("SELECT id FROM trip WHERE id = ?").bind("t1").first();
    const booking = await env.DB.prepare("SELECT id FROM booking WHERE id = ?").bind("b1").first();
    const email = await env.DB.prepare("SELECT id FROM inbound_email WHERE id = ?").bind("ie1").first();
    const draft = await env.DB.prepare("SELECT id FROM draft_booking WHERE id = ?").bind("db1").first();
    const audit = await env.DB.prepare("SELECT id FROM reveal_audit WHERE id = ?").bind("ra1").first();
    expect(trip).toBeNull();
    expect(booking).toBeNull();
    expect(email).toBeNull();
    expect(draft).toBeNull();
    expect(audit).toBeNull();
  });
});
