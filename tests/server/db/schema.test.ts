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
      "notification_log",
      "notification_preference",
      "notification_subscription",
      "person",
      "push_subscription",
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

  /**
   * The 60-minute default is the issue's (#61), and it lives in the schema so
   * a row written by anything other than NotificationRepo still gets it.
   * Reminders default ON and the digest defaults OFF: a reminder is only ever
   * about something the person already booked, a daily digest is not.
   */
  it("defaults a notification preference row to reminders on at 60 minutes and the digest off", async () => {
    const columns = await env.DB.prepare("PRAGMA table_info(notification_preference)")
      .all<{ name: string; dflt_value: string | null; notnull: number }>();
    const byName = new Map(columns.results.map((column) => [column.name, column]));
    expect(byName.get("reminder_lead_minutes")?.dflt_value).toBe("60");
    expect(byName.get("reminder_lead_minutes")?.notnull).toBe(1);
    expect(byName.get("reminders_enabled")?.dflt_value).toBe("1");
    expect(byName.get("digest_enabled")?.dflt_value).toBe("0");
    // NULL means "enabled the digest but has not picked a time yet", which is
    // a different state from "8am".
    expect(byName.get("digest_send_time")?.notnull).toBe(0);
  });

  /**
   * The tri-state is the point: 0 is a legitimate lead time meaning "at
   * start", so "off" has to be a separate word rather than a magic number.
   */
  it("gives every booking an inherited reminder mode and rejects a fourth state", async () => {
    const columns = await env.DB.prepare("PRAGMA table_info(booking)")
      .all<{ name: string; dflt_value: string | null; notnull: number }>();
    const byName = new Map(columns.results.map((column) => [column.name, column]));
    expect(byName.get("reminder_mode")?.dflt_value).toContain("inherit");
    expect(byName.get("reminder_mode")?.notnull).toBe(1);
    expect(byName.get("reminder_lead_minutes")?.notnull).toBe(0);

    const now = new Date().toISOString();
    await env.DB.prepare("INSERT INTO household (id,name,created_at) VALUES (?,?,?)")
      .bind("hh-rm", "Reminders", now).run();
    await env.DB.prepare("INSERT INTO trip (id,household_id,title,created_at) VALUES (?,?,?,?)")
      .bind("t-rm", "hh-rm", "Trip", now).run();
    await env.DB.prepare(
      "INSERT INTO booking (id,household_id,trip_id,kind,title,created_at) VALUES (?,?,?,?,?,?)",
    ).bind("b-rm", "hh-rm", "t-rm", "flight", "SFO->BOI", now).run();
    expect(
      await env.DB.prepare("SELECT reminder_mode FROM booking WHERE id = ?").bind("b-rm").first(),
    ).toMatchObject({ reminder_mode: "inherit" });

    await expect(env.DB.prepare(
      "UPDATE booking SET reminder_mode = ? WHERE id = ?",
    ).bind("sometimes", "b-rm").run()).rejects.toThrow(/CHECK/i);
  });

  /**
   * A subscription names a booking or a trip, never both and never neither --
   * "subscribed to nothing" would be a row the sweep can only ignore.
   */
  it("makes a notification subscription name exactly one subject, once per user", async () => {
    const now = new Date().toISOString();
    await env.DB.prepare("INSERT INTO household (id,name,created_at) VALUES (?,?,?)")
      .bind("hh-sub", "Subs", now).run();
    await env.DB.prepare("INSERT INTO trip (id,household_id,title,created_at) VALUES (?,?,?,?)")
      .bind("t-sub", "hh-sub", "Trip", now).run();
    await env.DB.prepare("INSERT INTO user (id,email,created_at) VALUES (?,?,?)")
      .bind("u-sub", "sub@example.com", now).run();

    const insert = env.DB.prepare(
      `INSERT INTO notification_subscription (id, user_id, booking_id, trip_id, subscribed, created_at)
       VALUES (?,?,?,?,?,?)`,
    );
    await expect(insert.bind("ns-0", "u-sub", null, null, 1, now).run()).rejects.toThrow(/CHECK/i);
    await insert.bind("ns-1", "u-sub", null, "t-sub", 1, now).run();
    // The partial index is what stops a second opinion about the same trip.
    await expect(insert.bind("ns-2", "u-sub", null, "t-sub", 0, now).run())
      .rejects.toThrow(/UNIQUE/i);
  });

  /**
   * The claim key includes the event instant on purpose: a rescheduled flight
   * has to be claimable again, or the reminder for the moved departure would
   * be suppressed as a duplicate of the one already sent for the old time.
   */
  it("claims one notification per user, kind, subject, and event instant", async () => {
    const now = new Date().toISOString();
    await env.DB.prepare("INSERT INTO user (id,email,created_at) VALUES (?,?,?)")
      .bind("u-log", "log@example.com", now).run();
    const insert = env.DB.prepare(
      `INSERT INTO notification_log (id, user_id, kind, subject_id, event_instant, claimed_at)
       VALUES (?,?,?,?,?,?)`,
    );
    await insert.bind("nl-1", "u-log", "reminder", "b-1", "2026-08-02T15:00:00Z", now).run();
    await expect(
      insert.bind("nl-2", "u-log", "reminder", "b-1", "2026-08-02T15:00:00Z", now).run(),
    ).rejects.toThrow(/UNIQUE/i);
    // The flight moved; the new instant is a new claim.
    await insert.bind("nl-3", "u-log", "reminder", "b-1", "2026-08-02T19:00:00Z", now).run();
    // A digest carries the empty string rather than NULL, so successive
    // digests for the same day collide instead of both inserting.
    await insert.bind("nl-4", "u-log", "digest", "", "2026-08-02", now).run();
    await expect(
      insert.bind("nl-5", "u-log", "digest", "", "2026-08-02", now).run(),
    ).rejects.toThrow(/UNIQUE/i);
    await expect(
      insert.bind("nl-6", "u-log", "telegram", "", "2026-08-02", now).run(),
    ).rejects.toThrow(/CHECK/i);
  });

  /**
   * Every per-user notification table dies with the account. A push endpoint
   * that outlived its user would be an unaddressable device still receiving
   * that household's flight times.
   */
  it("cascades a user delete down to their endpoints, preferences, subscriptions, and claims", async () => {
    const now = new Date().toISOString();
    await env.DB.prepare("INSERT INTO household (id,name,created_at) VALUES (?,?,?)")
      .bind("hh-push", "Push", now).run();
    await env.DB.prepare("INSERT INTO trip (id,household_id,title,created_at) VALUES (?,?,?,?)")
      .bind("t-push", "hh-push", "Trip", now).run();
    await env.DB.prepare("INSERT INTO user (id,email,created_at) VALUES (?,?,?)")
      .bind("u-push", "push@example.com", now).run();
    await env.DB.prepare(
      `INSERT INTO push_subscription (id, user_id, endpoint, p256dh, auth, created_at)
       VALUES (?,?,?,?,?,?)`,
    ).bind("ps-1", "u-push", "https://push.example/abc", "key", "auth", now).run();
    await env.DB.prepare(
      `INSERT INTO notification_preference
         (user_id, digest_enabled, digest_send_time, created_at, updated_at)
       VALUES (?,?,?,?,?)`,
    ).bind("u-push", 1, "08:00", now, now).run();
    await env.DB.prepare(
      `INSERT INTO notification_subscription (id, user_id, trip_id, subscribed, created_at)
       VALUES (?,?,?,?,?)`,
    ).bind("ns-push", "u-push", "t-push", 1, now).run();
    await env.DB.prepare(
      `INSERT INTO notification_log (id, user_id, kind, subject_id, event_instant, claimed_at)
       VALUES (?,?,?,?,?,?)`,
    ).bind("nl-push", "u-push", "digest", "", "2026-08-02", now).run();

    await env.DB.prepare("DELETE FROM user WHERE id = ?").bind("u-push").run();
    for (const [table, column, id] of [
      ["push_subscription", "id", "ps-1"],
      ["notification_preference", "user_id", "u-push"],
      ["notification_subscription", "id", "ns-push"],
      ["notification_log", "id", "nl-push"],
    ] as const) {
      expect(
        await env.DB.prepare(`SELECT ${column} FROM ${table} WHERE ${column} = ?`).bind(id).first(),
      ).toBeNull();
    }
  });

  /**
   * A zone is an IANA NAME, and how it was set decides who may overwrite it;
   * the repo's manual-pin rule is meaningless if the column cannot record
   * which kind of value it holds.
   */
  it("stores a user's timezone with its provenance and rejects an unknown source", async () => {
    const columns = await env.DB.prepare("PRAGMA table_info(user)").all<{ name: string }>();
    expect(columns.results.map((column) => column.name)).toEqual(
      expect.arrayContaining(["timezone", "timezone_source", "timezone_updated_at"]),
    );

    const now = new Date().toISOString();
    await env.DB.prepare("INSERT INTO user (id,email,created_at) VALUES (?,?,?)")
      .bind("u-tz", "tz@example.com", now).run();
    await env.DB.prepare(
      "UPDATE user SET timezone = ?, timezone_source = ?, timezone_updated_at = ? WHERE id = ?",
    ).bind("America/Los_Angeles", "manual", now, "u-tz").run();
    await expect(env.DB.prepare("UPDATE user SET timezone_source = ? WHERE id = ?")
      .bind("guessed", "u-tz").run()).rejects.toThrow(/CHECK/i);
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
