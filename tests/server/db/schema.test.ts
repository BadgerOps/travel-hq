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

  it("creates every core table, including extraction drafts", async () => {
    expect(await tableNames()).toEqual([
      "audit_log",
      "booking",
      "booking_duplicate_dismissal",
      "booking_person",
      "card",
      "card_perk",
      "checklist_item",
      "draft_booking",
      "household",
      "household_member",
      "household_settings",
      "inbound_email",
      "loyalty_account",
      "person",
      "trip",
      "trip_member",
      "trip_person",
      "user",
    ]);
  });

  /**
   * The audit trail's whole safety argument is structural: there is nowhere in
   * `audit_log` to PUT a revealed passport or confirmation number, so no future
   * edit to a route can accidentally persist one. Asserting the column list
   * exactly is what keeps that true -- adding a `value`/`plaintext` column
   * would have to break this test first.
   */
  it("records reveals as identifiers only, with no column that could hold a revealed value", async () => {
    const columns = await env.DB.prepare("PRAGMA table_info(audit_log)").all<{ name: string }>();
    expect(columns.results.map((column) => column.name)).toEqual([
      "id",
      "household_id",
      "event",
      "actor_user_id",
      "actor_email",
      "subject_type",
      "subject_id",
      "field",
      "trip_id",
      "at",
    ]);
  });

  /**
   * An audit record has to outlive what it describes: deleting the booking (or
   * the trip, or the account) whose secret was revealed must not erase the
   * record of the reveal. Only the household cascade applies.
   */
  it("keeps audit rows when the revealed record is deleted, and drops them with the household", async () => {
    const now = new Date().toISOString();
    await env.DB.prepare("INSERT INTO household (id, name, created_at) VALUES (?, ?, ?)")
      .bind("hh-a", "A", now)
      .run();
    await env.DB.prepare("INSERT INTO trip (id, household_id, title, created_at) VALUES (?, ?, ?, ?)")
      .bind("t1", "hh-a", "Guerneville", now)
      .run();
    await env.DB.prepare(
      `INSERT INTO audit_log (id, household_id, event, actor_user_id, actor_email,
                              subject_type, subject_id, field, trip_id, at)
       VALUES (?, ?, 'confirmation_reveal', ?, ?, 'booking', ?, 'confirmation_number', ?, ?)`,
    )
      .bind("a1", "hh-a", "u1", "badger@example.com", "b1", "t1", now)
      .run();

    await env.DB.prepare("DELETE FROM trip WHERE id = ?").bind("t1").run();
    expect(await env.DB.prepare("SELECT id FROM audit_log WHERE id = ?").bind("a1").first())
      .toMatchObject({ id: "a1" });

    await env.DB.prepare("DELETE FROM household WHERE id = ?").bind("hh-a").run();
    expect(await env.DB.prepare("SELECT id FROM audit_log WHERE id = ?").bind("a1").first()).toBeNull();
  });

  it("adds booking provenance and stable draft ordinals", async () => {
    const booking = await env.DB.prepare("PRAGMA table_info(booking)").all<{ name: string }>();
    expect(booking.results.map((column) => column.name)).toContain("source_inbound_email_id");

    const draft = await env.DB.prepare("PRAGMA table_info(draft_booking)").all<{ name: string }>();
    expect(draft.results.map((column) => column.name)).toEqual(
      expect.arrayContaining(["inbound_email_id", "ordinal", "source", "status"]),
    );
  });

  it("gives stored raw email an encryption label and a purge stamp", async () => {
    const columns = await env.DB.prepare("PRAGMA table_info(inbound_email)")
      .all<{ name: string; dflt_value: string | null; notnull: number }>();
    const byName = new Map(columns.results.map((column) => [column.name, column]));

    // 'plaintext' is the default because every row that predates migration
    // 0015 holds a readable message; anything else would mislabel history and
    // make legacy mail unreadable.
    expect(byName.get("raw_encryption")?.dflt_value).toContain("plaintext");
    expect(byName.get("raw_encryption")?.notnull).toBe(1);
    // Nullable on purpose: NULL means "never purged", which is distinct from
    // a rejected row that was born with raw = ''.
    expect(byName.get("raw_purged_at")?.notnull).toBe(0);

    const now = new Date().toISOString();
    await env.DB.prepare("INSERT INTO household (id,name,created_at) VALUES (?,?,?)")
      .bind("hh-raw", "Raw", now).run();
    await expect(env.DB.prepare(
      `INSERT INTO inbound_email
       (id, household_id, from_address, to_address, raw, raw_encryption, status, received_at)
       VALUES (?,?,?,?,?,?,?,?)`,
    ).bind("ie-bad", "hh-raw", "a@b.com", "t@b.foo", "raw", "rot13", "received", now).run())
      .rejects.toThrow(/CHECK/i);
  });

  it("adds constrained extraction-agent settings with safe defaults", async () => {
    const columns = await env.DB.prepare("PRAGMA table_info(household_settings)")
      .all<{ name: string; dflt_value: string | null }>();
    expect(columns.results.map((column) => column.name)).toEqual(expect.arrayContaining([
      "ai_provider",
      "ai_max_tokens",
      "anthropic_model",
      "anthropic_api_key",
      "extraction_instructions",
    ]));
    expect(columns.results.find((column) => column.name === "ai_provider")?.dflt_value)
      .toContain("workers-ai");
    expect(columns.results.find((column) => column.name === "ai_max_tokens")?.dflt_value)
      .toBe("4096");

    const now = new Date().toISOString();
    await env.DB.prepare("INSERT INTO household (id,name,created_at) VALUES (?,?,?)")
      .bind("hh-provider", "Provider", now).run();
    await expect(env.DB.prepare(
      `INSERT INTO household_settings
       (household_id, ai_provider, created_at, updated_at) VALUES (?,?,?,?)`,
    ).bind("hh-provider", "bogus", now, now).run()).rejects.toThrow(/CHECK/i);
  });

  it("cascades a household delete down to its trips, bookings, and inbound email", async () => {
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

    await env.DB.prepare("DELETE FROM household WHERE id = ?").bind("hh-a").run();

    const trip = await env.DB.prepare("SELECT id FROM trip WHERE id = ?").bind("t1").first();
    const booking = await env.DB.prepare("SELECT id FROM booking WHERE id = ?").bind("b1").first();
    const email = await env.DB.prepare("SELECT id FROM inbound_email WHERE id = ?").bind("ie1").first();
    expect(trip).toBeNull();
    expect(booking).toBeNull();
    expect(email).toBeNull();
  });

  it("stores a duplicate dismissal as one sorted pair that dies with its bookings", async () => {
    const now = new Date().toISOString();
    await env.DB.prepare("INSERT INTO household (id, name, created_at) VALUES (?, ?, ?)")
      .bind("hh-a", "A", now).run();
    await env.DB.prepare("INSERT INTO trip (id, household_id, title, created_at) VALUES (?, ?, ?, ?)")
      .bind("t1", "hh-a", "Mine", now).run();
    for (const id of ["b1", "b2"]) {
      await env.DB.prepare(
        "INSERT INTO booking (id, household_id, trip_id, kind, title, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      ).bind(id, "hh-a", "t1", "other", "Hotel", now).run();
    }

    // The sorted-pair invariant is the schema's job: an unsorted insert would
    // be a second row for a pair that already has one.
    await expect(env.DB.prepare(
      "INSERT INTO booking_duplicate_dismissal (household_id, booking_id_lo, booking_id_hi, dismissed_at) VALUES (?,?,?,?)",
    ).bind("hh-a", "b2", "b1", now).run()).rejects.toThrow(/CHECK/i);

    await env.DB.prepare(
      "INSERT INTO booking_duplicate_dismissal (household_id, booking_id_lo, booking_id_hi, dismissed_at) VALUES (?,?,?,?)",
    ).bind("hh-a", "b1", "b2", now).run();

    // Deleting (or merging away) either booking retires the decision with it,
    // so a later booking cannot inherit a judgement made about something else.
    await env.DB.prepare("DELETE FROM booking WHERE id = ?").bind("b2").run();
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM booking_duplicate_dismissal").first<{ n: number }>())
      .toMatchObject({ n: 0 });
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
