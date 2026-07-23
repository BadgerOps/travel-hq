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

  it("creates every core table (0001) plus the card tables (0002), and no inbound_email", async () => {
    expect(await tableNames()).toEqual([
      "booking",
      "booking_person",
      "card",
      "card_perk",
      "checklist_item",
      "household",
      "household_member",
      "loyalty_account",
      "person",
      "trip",
      "trip_person",
      "user",
    ]);
  });

  it("cascades a household delete down to its trips and bookings", async () => {
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

    await env.DB.prepare("DELETE FROM household WHERE id = ?").bind("hh-a").run();

    const trip = await env.DB.prepare("SELECT id FROM trip WHERE id = ?").bind("t1").first();
    const booking = await env.DB.prepare("SELECT id FROM booking WHERE id = ?").bind("b1").first();
    expect(trip).toBeNull();
    expect(booking).toBeNull();
  });

  it("cascades a household delete down to cards, and a card delete down to its perks", async () => {
    const now = new Date().toISOString();
    await env.DB.prepare("INSERT INTO household (id, name, created_at) VALUES (?, ?, ?)")
      .bind("hh-a", "A", now)
      .run();
    await env.DB.prepare("INSERT INTO card (id, household_id, name, created_at) VALUES (?, ?, ?, ?)")
      .bind("c1", "hh-a", "Sapphire Reserve", now)
      .run();
    await env.DB.prepare(
      "INSERT INTO card_perk (id, household_id, card_id, name, kind, value_cents, cadence, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
      .bind("k1", "hh-a", "c1", "Travel credit", "statement_credit", 30000, "annual", now)
      .run();

    await env.DB.prepare("DELETE FROM card WHERE id = ?").bind("c1").run();
    expect(await env.DB.prepare("SELECT id FROM card_perk WHERE id = ?").bind("k1").first()).toBeNull();

    await env.DB.prepare("INSERT INTO card (id, household_id, name, created_at) VALUES (?, ?, ?, ?)")
      .bind("c2", "hh-a", "Amex Platinum", now)
      .run();
    await env.DB.prepare("DELETE FROM household WHERE id = ?").bind("hh-a").run();
    expect(await env.DB.prepare("SELECT id FROM card WHERE id = ?").bind("c2").first()).toBeNull();
  });
});
