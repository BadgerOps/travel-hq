import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { env } from "cloudflare:test";
import { Keyring } from "../../../src/server/crypto/envelope.js";
import { createApp } from "../../../src/server/index.js";
import type { AppBindings } from "../../../src/server/index.js";
import type { Identity } from "../../../src/server/auth.js";
import { generateVapidKeys } from "../../../src/server/push/index.js";

/**
 * The HTTP face of #61.
 *
 * Two households and three roles throughout, because the two properties that
 * matter most here are ones the tables cannot express structurally: the
 * notification tables carry no household_id, and the account this feature was
 * built for — a shared-trip parent following a kid's connection — is a
 * household VIEWER. So "a viewer may manage their own phone" and "a viewer
 * still cannot reach a booking in someone else's household" are the two
 * assertions this file exists for.
 */

const ring = new Keyring("server-v1", { "server-v1": crypto.getRandomValues(new Uint8Array(32)) });

const ava: Identity = { userId: "u-ava", email: "ava@example.com", householdId: "hh-a", role: "owner" };
const viewer: Identity = { userId: "u-vi", email: "vi@example.com", householdId: "hh-a", role: "viewer" };
const outsider: Identity = { userId: "u-zed", email: "zed@example.com", householdId: "hh-b", role: "owner" };

/** Generated once: a real P-256 pair, so sendPush's VAPID signing is exercised. */
const vapid = await generateVapidKeys();

const testEnv = {
  DB: env.DB,
  VAPID_PUBLIC_KEY: vapid.publicKey,
  VAPID_PRIVATE_KEY: vapid.privateKey,
  VAPID_SUBJECT: "mailto:ops@example.com",
} as unknown as AppBindings;

/** The same app with push deliberately unconfigured, for the degradation tests. */
const unconfiguredEnv = { DB: env.DB } as unknown as AppBindings;

function appAs(who: Identity) {
  return createApp({ verify: async () => who, ring });
}

function request(
  a: ReturnType<typeof createApp>,
  path: string,
  init?: RequestInit,
  bindings: AppBindings = testEnv,
) {
  return a.request(path, init, bindings);
}

function json(method: "POST" | "PUT", body: unknown): RequestInit {
  return { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/**
 * A REAL subscription: an actual P-256 point and 16 auth bytes, because
 * encryptPushPayload rejects anything else and the test-notification endpoint
 * would then never reach the fetch it is trying to exercise.
 */
async function realSubscription(endpoint: string) {
  const pair = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
    "deriveBits",
  ])) as CryptoKeyPair;
  const raw = new Uint8Array(
    (await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer,
  );
  return {
    endpoint,
    keys: { p256dh: b64url(raw), auth: b64url(crypto.getRandomValues(new Uint8Array(16))) },
  };
}

let app: ReturnType<typeof createApp>;

beforeEach(async () => {
  for (const table of [
    "notification_log",
    "notification_subscription",
    "push_subscription",
    "notification_preference",
    "booking_person",
    "trip_person",
    "trip_member",
    "booking",
    "person",
    "trip",
    "household_member",
    "household",
    "user",
  ]) {
    await env.DB.exec(`DELETE FROM ${table}`);
  }

  const now = "2026-07-01T00:00:00.000Z";
  const household = env.DB.prepare("INSERT INTO household (id,name,created_at) VALUES (?,?,?)");
  await household.bind("hh-a", "A", now).run();
  await household.bind("hh-b", "B", now).run();

  const user = env.DB.prepare("INSERT INTO user (id,email,created_at) VALUES (?,?,?)");
  await user.bind("u-ava", "ava@example.com", now).run();
  await user.bind("u-vi", "vi@example.com", now).run();
  await user.bind("u-zed", "zed@example.com", now).run();

  const member = env.DB.prepare(
    "INSERT INTO household_member (household_id,user_id,role) VALUES (?,?,?)",
  );
  await member.bind("hh-a", "u-ava", "owner").run();
  await member.bind("hh-a", "u-vi", "viewer").run();
  await member.bind("hh-b", "u-zed", "owner").run();

  const trip = env.DB.prepare("INSERT INTO trip (id,household_id,title,created_at) VALUES (?,?,?,?)");
  await trip.bind("t1", "hh-a", "Tokyo", now).run();
  await trip.bind("t2", "hh-b", "Elsewhere", now).run();

  const person = env.DB.prepare(
    "INSERT INTO person (id,household_id,display_name,user_id,created_at) VALUES (?,?,?,?,?)",
  );
  await person.bind("p-ava", "hh-a", "Ava", "u-ava", now).run();

  const booking = env.DB.prepare(
    `INSERT INTO booking (id,household_id,trip_id,kind,title,starts_at,starts_at_tz,status,created_at)
     VALUES (?,?,?,'flight',?,?,?,'booked',?)`,
  );
  await booking.bind("b1", "hh-a", "t1", "NRT -> BOI", "2026-08-02T15:00:00Z", "Asia/Tokyo", now).run();
  await booking.bind("b-zed", "hh-b", "t2", "Not yours", "2026-08-02T15:00:00Z", "Asia/Tokyo", now).run();

  await env.DB.prepare("INSERT INTO booking_person (booking_id,person_id) VALUES (?,?)")
    .bind("b1", "p-ava")
    .run();

  // THE motivating account of #61: invited to one trip, a household viewer
  // everywhere (and still a `viewer` inside the shared trip — see
  // authorizeTrip), travelling on nothing. Every "a viewer may…" test below is
  // about this person.
  await env.DB.prepare(
    "INSERT INTO trip_member (trip_id, user_id, role, invited_by_user_id, created_at) VALUES (?,?,?,?,?)",
  )
    .bind("t1", "u-vi", "viewer", "u-ava", now)
    .run();

  app = appAs(ava);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("GET /api/notifications/preferences", () => {
  it("answers the documented defaults, the stored zone, and the VAPID key", async () => {
    const res = await request(app, "/api/notifications/preferences");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      preferences: {
        digestEnabled: false,
        digestSendTime: null,
        remindersEnabled: true,
        reminderLeadMinutes: 60,
      },
      timezone: { timezone: null, source: null, updatedAt: null },
      vapidPublicKey: vapid.publicKey,
    });
  });

  /**
   * The precedent is GET /api/settings/ai-models: a soft error in the body so
   * the settings page still renders and can explain why there is no enable
   * button, rather than a 5xx that reads as "the app is broken".
   */
  it("degrades to 200 with an error when the server has no VAPID key", async () => {
    const res = await request(app, "/api/notifications/preferences", undefined, unconfiguredEnv);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.vapidPublicKey).toBeNull();
    expect(body.error).toMatch(/not configured/i);
  });
});

describe("PUT /api/notifications/preferences", () => {
  it("round-trips a partial update and leaves absent keys alone", async () => {
    const first = await request(app, "/api/notifications/preferences", json("PUT", { digestEnabled: true, digestSendTime: "07:15" }));
    expect(first.status).toBe(200);
    await request(app, "/api/notifications/preferences", json("PUT", { reminderLeadMinutes: 15 }));
    const body = (await (await request(app, "/api/notifications/preferences")).json()) as {
      preferences: Record<string, unknown>;
    };
    expect(body.preferences).toEqual({
      digestEnabled: true,
      digestSendTime: "07:15",
      remindersEnabled: true,
      reminderLeadMinutes: 15,
    });
  });

  it("accepts 0 minutes: 'at the moment it starts' is a lead time, not 'off'", async () => {
    const res = await request(app, "/api/notifications/preferences", json("PUT", { reminderLeadMinutes: 0 }));
    expect(res.status).toBe(200);
    expect((await res.json() as { preferences: { reminderLeadMinutes: number } }).preferences.reminderLeadMinutes).toBe(0);
  });

  it("rejects a malformed JSON body with 400", async () => {
    const res = await request(app, "/api/notifications/preferences", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: "{ not json",
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Invalid JSON body" });
  });

  it("rejects an unknown key with 400 (strict schema)", async () => {
    const res = await request(app, "/api/notifications/preferences", json("PUT", { digestEnabled: true, extra: 1 }));
    expect(res.status).toBe(400);
  });

  it("rejects a send time that is not a wall clock with 400", async () => {
    const res = await request(app, "/api/notifications/preferences", json("PUT", { digestSendTime: "half past eight" }));
    expect(res.status).toBe(400);
  });

  it("rejects a negative lead time with 400", async () => {
    expect((await request(app, "/api/notifications/preferences", json("PUT", { reminderLeadMinutes: -1 }))).status).toBe(400);
  });
});

/**
 * THE FIX. Every one of these used to be a 403, because the repo routed each
 * write through requireWrite(). None of it is household data, and the account
 * that most needs it — a shared-trip parent — is a household viewer.
 */
describe("a household viewer and their OWN notification settings", () => {
  it("may set their own digest time", async () => {
    const res = await request(appAs(viewer), "/api/notifications/preferences", json("PUT", { digestEnabled: true, digestSendTime: "06:30" }));
    expect(res.status).toBe(200);
    expect((await res.json() as { preferences: { digestSendTime: string } }).preferences.digestSendTime).toBe("06:30");
  });

  it("may pin their own timezone", async () => {
    const res = await request(appAs(viewer), "/api/notifications/timezone", json("PUT", { timezone: "America/Boise", source: "manual" }));
    expect(res.status).toBe(200);
    expect((await res.json() as { timezone: { timezone: string } }).timezone.timezone).toBe("America/Boise");
  });

  it("may register and remove their own push device", async () => {
    const subscription = await realSubscription("https://push.example.com/viewer-1");
    const created = await request(appAs(viewer), "/api/notifications/subscriptions", json("POST", subscription));
    expect(created.status).toBe(201);
    const { device } = (await created.json()) as { device: { id: string; host: string } };
    expect(device.host).toBe("push.example.com");

    const removed = await request(appAs(viewer), `/api/notifications/subscriptions/${device.id}`, { method: "DELETE" });
    expect(removed.status).toBe(204);
    expect((await (await request(appAs(viewer), "/api/notifications/subscriptions")).json() as { devices: unknown[] }).devices).toEqual([]);
  });

  it("may follow a booking they CAN see", async () => {
    const res = await request(appAs(viewer), "/api/bookings/b1/notification", json("PUT", { subscribed: true }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ bookingId: "b1", subscribed: true, implicit: false });
  });

  /**
   * The half that must NOT relax. The reachability check is scoped to the
   * caller's household, and a booking outside it 404s exactly as it does for
   * an owner — an out-of-household id is indistinguishable from a nonexistent
   * one.
   */
  it("still cannot follow a booking they cannot see", async () => {
    const res = await request(appAs(viewer), "/api/bookings/b-zed/notification", json("PUT", { subscribed: true }));
    expect(res.status).toBe(404);
    const rows = await env.DB.prepare("SELECT COUNT(*) AS n FROM notification_subscription").first<{ n: number }>();
    expect(rows?.n).toBe(0);
  });
});

describe("cross-household reachability", () => {
  it("404s another household's booking for an OWNER too", async () => {
    expect((await request(appAs(outsider), "/api/bookings/b1/notification", json("PUT", { subscribed: true }))).status).toBe(404);
  });

  it("404s another household's trip", async () => {
    expect((await request(appAs(outsider), "/api/trips/t1/notification", json("PUT", { subscribed: true }))).status).toBe(404);
  });
});

describe("PUT /api/notifications/timezone", () => {
  it("stores a device report", async () => {
    const res = await request(app, "/api/notifications/timezone", json("PUT", { timezone: "America/Boise", source: "device" }));
    expect(await res.json()).toMatchObject({ timezone: { timezone: "America/Boise", source: "device" } });
  });

  /**
   * The rule the client cannot be trusted with. The browser posts its device
   * zone on every visibilitychange, so a pin that could be clobbered would
   * survive until the next time the app was backgrounded in another country.
   */
  it("does not let an automatic device report displace a manual pin", async () => {
    await request(app, "/api/notifications/timezone", json("PUT", { timezone: "America/Boise", source: "manual" }));
    const res = await request(app, "/api/notifications/timezone", json("PUT", { timezone: "Europe/Amsterdam", source: "device" }));
    expect(res.status).toBe(200);
    // 200, not 403: the client sends this unprompted, and the answer carries
    // the pin that won so the UI corrects itself.
    expect(await res.json()).toMatchObject({ timezone: { timezone: "America/Boise", source: "manual" } });
  });

  it("clearing the zone clears the pin, so the next device report lands", async () => {
    await request(app, "/api/notifications/timezone", json("PUT", { timezone: "America/Boise", source: "manual" }));
    await request(app, "/api/notifications/timezone", json("PUT", { timezone: null, source: "device" }));
    const res = await request(app, "/api/notifications/timezone", json("PUT", { timezone: "Europe/Amsterdam", source: "device" }));
    expect(await res.json()).toMatchObject({ timezone: { timezone: "Europe/Amsterdam", source: "device" } });
  });

  it("rejects a fixed offset with 400 — an offset is only true until the next DST change", async () => {
    expect((await request(app, "/api/notifications/timezone", json("PUT", { timezone: "-08:00", source: "manual" }))).status).toBe(400);
  });

  it("rejects an unknown source with 400", async () => {
    expect((await request(app, "/api/notifications/timezone", json("PUT", { timezone: "UTC", source: "guess" }))).status).toBe(400);
  });
});

describe("push subscriptions", () => {
  it("never returns the content-encryption secrets", async () => {
    const subscription = await realSubscription("https://push.example.com/ava-1");
    const created = await request(app, "/api/notifications/subscriptions", json("POST", subscription));
    const body = await created.text();
    // The endpoint IS returned (the client matches it against its own), but
    // p256dh and auth are the encryption secrets and must never leave.
    expect(body).toContain("push.example.com/ava-1");
    expect(body).not.toContain(subscription.keys.p256dh);
    expect(body).not.toContain(subscription.keys.auth);
  });

  it("upserts on the endpoint, so re-registering one device does not double it", async () => {
    const subscription = await realSubscription("https://push.example.com/ava-1");
    await request(app, "/api/notifications/subscriptions", json("POST", subscription));
    const again = await realSubscription("https://push.example.com/ava-1");
    await request(app, "/api/notifications/subscriptions", json("POST", again));
    const { devices } = (await (await request(app, "/api/notifications/subscriptions")).json()) as { devices: unknown[] };
    expect(devices).toHaveLength(1);
  });

  it("lists only the caller's own devices", async () => {
    await request(app, "/api/notifications/subscriptions", json("POST", await realSubscription("https://push.example.com/ava-1")));
    await request(appAs(viewer), "/api/notifications/subscriptions", json("POST", await realSubscription("https://push.example.com/vi-1")));
    const { devices } = (await (await request(app, "/api/notifications/subscriptions")).json()) as {
      devices: { endpoint: string }[];
    };
    expect(devices.map((d) => d.endpoint)).toEqual(["https://push.example.com/ava-1"]);
  });

  it("404s a delete of somebody else's device id", async () => {
    const created = await request(appAs(viewer), "/api/notifications/subscriptions", json("POST", await realSubscription("https://push.example.com/vi-1")));
    const { device } = (await created.json()) as { device: { id: string } };
    expect((await request(app, `/api/notifications/subscriptions/${device.id}`, { method: "DELETE" })).status).toBe(404);
  });

  it("rejects a body without the browser's keys with 400", async () => {
    expect((await request(app, "/api/notifications/subscriptions", json("POST", { endpoint: "https://push.example.com/x" }))).status).toBe(400);
  });
});

describe("POST /api/notifications/test", () => {
  it("reports success per device", async () => {
    await request(app, "/api/notifications/subscriptions", json("POST", await realSubscription("https://push.example.com/ava-1")));
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 201 })));

    const res = await request(app, "/api/notifications/test", json("POST", {}));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { results: { outcome: string; host: string; pruned: boolean }[] };
    expect(body.results).toEqual([
      { id: expect.any(String), host: "push.example.com", outcome: "sent", status: 201, reason: null, pruned: false },
    ]);
  });

  /**
   * The garbage-collection story. iOS silently drops a subscription when the
   * PWA leaves the home screen; a 404/410 is the push service saying so, and a
   * row that is never pruned earns rate limits that hurt the live ones.
   */
  it("prunes an endpoint the push service reports as gone", async () => {
    await request(app, "/api/notifications/subscriptions", json("POST", await realSubscription("https://push.example.com/dead")));
    vi.stubGlobal("fetch", vi.fn(async () => new Response("gone", { status: 410 })));

    const res = await request(app, "/api/notifications/test", json("POST", {}));
    const body = (await res.json()) as { results: { outcome: string; pruned: boolean }[] };
    expect(body.results[0]).toMatchObject({ outcome: "gone", pruned: true });
    const { devices } = (await (await request(app, "/api/notifications/subscriptions")).json()) as { devices: unknown[] };
    expect(devices).toEqual([]);
  });

  it("does NOT prune on a transient 503 — a bad afternoon is not a dead device", async () => {
    await request(app, "/api/notifications/subscriptions", json("POST", await realSubscription("https://push.example.com/flaky")));
    vi.stubGlobal("fetch", vi.fn(async () => new Response("later", { status: 503 })));

    const res = await request(app, "/api/notifications/test", json("POST", {}));
    const body = (await res.json()) as { results: { outcome: string; pruned: boolean }[] };
    expect(body.results[0]).toMatchObject({ outcome: "retryable", pruned: false });
    const { devices } = (await (await request(app, "/api/notifications/subscriptions")).json()) as { devices: unknown[] };
    expect(devices).toHaveLength(1);
  });

  it("answers 200 with an explanation when no device is registered", async () => {
    const res = await request(app, "/api/notifications/test", json("POST", {}));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ results: [], error: "No devices are registered for this account" });
  });

  it("answers 200 with an explanation when the server has no VAPID key", async () => {
    await request(app, "/api/notifications/subscriptions", json("POST", await realSubscription("https://push.example.com/ava-1")), unconfiguredEnv);
    const res = await request(app, "/api/notifications/test", json("POST", {}), unconfiguredEnv);
    expect(res.status).toBe(200);
    expect((await res.json() as { error: string }).error).toMatch(/not configured/i);
  });

  it("is available to a viewer, who has their own devices to prove out", async () => {
    await request(appAs(viewer), "/api/notifications/subscriptions", json("POST", await realSubscription("https://push.example.com/vi-1")));
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 201 })));
    const res = await request(appAs(viewer), "/api/notifications/test", json("POST", {}));
    expect(res.status).toBe(200);
    expect((await res.json() as { results: unknown[] }).results).toHaveLength(1);
  });
});

/**
 * Explicit beats implicit in BOTH directions, and the nearer subject beats the
 * wider one. Exercised through HTTP rather than only through the repo, because
 * the precedence is what a user actually sees when they press the button.
 */
describe("per-booking and per-trip subscriptions", () => {
  it("reports the implicit answer for someone travelling on it", async () => {
    const res = await request(app, "/api/bookings/b1/notification");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ implicit: true, bookingChoice: null, tripChoice: null, subscribed: true });
  });

  it("lets someone travelling on it turn it OFF", async () => {
    const res = await request(app, "/api/bookings/b1/notification", json("PUT", { subscribed: false }));
    expect(await res.json()).toMatchObject({ implicit: true, bookingChoice: false, subscribed: false });
  });

  it("null clears the explicit choice and falls back to the implicit one", async () => {
    await request(app, "/api/bookings/b1/notification", json("PUT", { subscribed: false }));
    const res = await request(app, "/api/bookings/b1/notification", json("PUT", { subscribed: null }));
    expect(await res.json()).toMatchObject({ bookingChoice: null, implicit: true, subscribed: true });
  });

  it("a booking decision beats a trip decision", async () => {
    expect((await request(appAs(viewer), "/api/trips/t1/notification", json("PUT", { subscribed: true }))).status).toBe(204);
    const followsTrip = await request(appAs(viewer), "/api/bookings/b1/notification");
    expect(await followsTrip.json()).toMatchObject({ implicit: false, tripChoice: true, subscribed: true });

    await request(appAs(viewer), "/api/bookings/b1/notification", json("PUT", { subscribed: false }));
    const res = await request(appAs(viewer), "/api/bookings/b1/notification");
    expect(await res.json()).toMatchObject({ bookingChoice: false, tripChoice: true, subscribed: false });
  });

  it("clearing the trip choice returns the booking to its implicit answer", async () => {
    await request(appAs(viewer), "/api/trips/t1/notification", json("PUT", { subscribed: true }));
    expect((await request(appAs(viewer), "/api/trips/t1/notification", json("PUT", { subscribed: null }))).status).toBe(204);
    const res = await request(appAs(viewer), "/api/bookings/b1/notification");
    expect(await res.json()).toMatchObject({ tripChoice: null, implicit: false, subscribed: false });
  });

  it("rejects a body without `subscribed` with 400", async () => {
    expect((await request(app, "/api/bookings/b1/notification", json("PUT", {}))).status).toBe(400);
  });

  it("404s an unknown booking id", async () => {
    expect((await request(app, "/api/bookings/nope/notification")).status).toBe(404);
  });
});

/**
 * The per-booking reminder override arrives through the ordinary booking edit
 * form, so it has to get through the ordinary `.strict()` update schema.
 */
describe("PUT /api/bookings/:id — the reminder override", () => {
  it("accepts inherit / custom / off", async () => {
    for (const reminderMode of ["custom", "off", "inherit"] as const) {
      const res = await request(app, "/api/bookings/b1", json("PUT", { reminderMode, reminderLeadMinutes: reminderMode === "custom" ? 30 : null }));
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ reminderMode });
    }
  });

  it("accepts a lead of 0 — 'at the moment it starts' is not 'off'", async () => {
    const res = await request(app, "/api/bookings/b1", json("PUT", { reminderMode: "custom", reminderLeadMinutes: 0 }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ reminderMode: "custom", reminderLeadMinutes: 0 });
  });

  it("rejects an unknown mode and a negative lead with 400", async () => {
    expect((await request(app, "/api/bookings/b1", json("PUT", { reminderMode: "maybe" }))).status).toBe(400);
    expect((await request(app, "/api/bookings/b1", json("PUT", { reminderLeadMinutes: -5 }))).status).toBe(400);
  });
});
