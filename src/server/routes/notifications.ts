import { Hono } from "hono";
import { z } from "zod";
import {
  MAX_REMINDER_LEAD_MINUTES,
  NotificationRepo,
  TIMEZONE_SOURCES,
} from "../repos/notification.js";
import type {
  NotificationPreferences,
  PushSubscriptionRecord,
  UpdateNotificationPreferencesInput,
  UserTimezone,
} from "../repos/notification.js";
import { sendPush } from "../push/index.js";
import type { AppEnv } from "../index.js";
import type { AppBindings } from "../index.js";

/**
 * Per-user notification settings over HTTP (issue #61).
 *
 * NOT household settings, and deliberately not registered behind
 * `requireHouseholdWriter` in index.ts. Everything here is keyed by the
 * authenticated user: their phone, their digest time, the events they
 * personally want to hear about. A household `viewer` — which is what every
 * shared-trip account is — must be able to write all of it, or the parent
 * following a kid's connection cannot use the feature at all. See the note at
 * the top of repos/notification.ts for the full argument.
 *
 * The per-subject routes (`/api/bookings/:id/notification`,
 * `/api/trips/:id/notification`) live in a SECOND router, `notificationSubjects`,
 * mounted at `/api` next to routes/itinerary.ts. That is not a stylistic
 * choice: `authorizeBooking`/`authorizeTrip` are registered in index.ts against
 * `/api/bookings/:bookingId/*` and `/api/trips/:tripId/*`, so a route can only
 * inherit the parent check by living at that URL. A `/api/notifications/booking/:id`
 * spelling would skip it, which is exactly the bug two nested trip routes
 * shipped with once already.
 */

/**
 * Tri-state, as updateSettingsSchema established: an absent key leaves the
 * stored value alone. Only `digestSendTime` is nullable — "no digest time" is a
 * real state, whereas "no reminder" is spelled `off` on the booking.
 * `.strict()` so a client that PUTs back the whole object it was shown gets a
 * 400 naming the stray key rather than silently having it dropped.
 */
const updatePreferencesSchema = z
  .object({
    digestEnabled: z.boolean().optional(),
    digestSendTime: z
      .string()
      .regex(/^([01]\d|2[0-3]):([0-5]\d)$/, "digestSendTime must be a wall clock as HH:MM")
      .nullable()
      .optional(),
    remindersEnabled: z.boolean().optional(),
    // `0` is a legitimate lead meaning "at the moment it starts". The floor is
    // therefore 0, not 1, and `off` is a per-booking mode rather than a number.
    reminderLeadMinutes: z.number().int().min(0).max(MAX_REMINDER_LEAD_MINUTES).optional(),
  })
  .strict();

/**
 * `timezone: null` clears the stored zone AND its provenance, which is how the
 * UI's "use my device's timezone" reset works: clear the pin, then let the next
 * automatic report land. The repo — not this schema — enforces that a `device`
 * report never displaces a `manual` pin; validating the IANA name is also the
 * repo's job, so a bad zone is one 400 from one place.
 */
const setTimezoneSchema = z
  .object({
    timezone: z.string().min(1).nullable(),
    source: z.enum(TIMEZONE_SOURCES),
  })
  .strict();

/**
 * Exactly the shape `PushSubscription.toJSON()` produces in the browser, so
 * the client posts what the platform handed it without reshaping. `.strict()`
 * would reject the `expirationTime` key that shape also carries, so the two
 * keys the browser adds are accepted and ignored by name rather than by a
 * permissive schema.
 */
const registerSubscriptionSchema = z
  .object({
    endpoint: z.string().min(1),
    expirationTime: z.unknown().optional(),
    keys: z
      .object({ p256dh: z.string().min(1), auth: z.string().min(1) })
      .strict(),
  })
  .strict();

/**
 * `null` clears the explicit decision and falls back to the implicit default
 * (travelling on it / the trip-wide choice). That is a third state, not an
 * absent field: "I have no opinion" is a thing a user can go back to, and
 * spelling it as an absent key would make it unsendable.
 */
const setSubscribedSchema = z.object({ subscribed: z.boolean().nullable() }).strict();

/**
 * What the client is shown about one registered device.
 *
 * `p256dh` and `auth` are NOT here: they are the content-encryption secrets,
 * the server is the only thing that needs them, and a response that carried
 * them would put them in every browser cache and devtools log of every session.
 *
 * `endpoint` IS here, and only because the client cannot otherwise answer "is
 * push already on for THIS device" — it compares against what its own
 * `pushManager.getSubscription()` returns. It goes back only to the account
 * that registered it, over an authenticated, `Cache-Control: no-store`
 * response. `host` is the part safe to display and log.
 */
export type PushDeviceView = {
  id: string;
  endpoint: string;
  host: string;
  createdAt: string;
  lastSuccessAt: string | null;
  failureCount: number;
};

/** One device's answer to "did the test notification reach you". */
export type TestNotificationResult = {
  id: string;
  host: string;
  /** sendPush's own outcome union, verbatim — no re-interpretation here. */
  outcome: "sent" | "gone" | "retryable" | "failed" | "invalid";
  status: number | null;
  reason: string | null;
  /** True when this endpoint was deleted because the push service said `gone`. */
  pruned: boolean;
};

/**
 * Everything the notifications screen needs in one response: the preferences,
 * the stored zone, and the VAPID application server key the browser must pass
 * to `pushManager.subscribe()`.
 *
 * `vapidPublicKey: null` with an `error` string rather than a 5xx follows the
 * precedent of GET /api/settings/ai-models: a server without push configured
 * is a server whose settings page must still render, explaining why the
 * enable button is not there.
 */
export type NotificationSettingsResponse = {
  preferences: NotificationPreferences;
  timezone: UserTimezone;
  vapidPublicKey: string | null;
  error?: string;
};

const NOT_CONFIGURED = "Push notifications are not configured on this server";

function hostOf(endpoint: string): string {
  try {
    return new URL(endpoint).host;
  } catch {
    // A stored endpoint that is not a URL cannot be pushed to either; showing
    // it as unknown beats throwing while rendering a settings page.
    return "unknown";
  }
}

function toDeviceView(record: PushSubscriptionRecord): PushDeviceView {
  return {
    id: record.id,
    endpoint: record.endpoint,
    host: hostOf(record.endpoint),
    createdAt: record.createdAt,
    lastSuccessAt: record.lastSuccessAt,
    failureCount: record.failureCount,
  };
}

/**
 * The VAPID triple, or null when any part of it is missing. All three are
 * required to send: the key pair identifies this server to the push service
 * and the subject is the contact address the RFC mandates.
 */
function vapidConfig(
  env: AppBindings,
): { publicKey: string; privateKey: string; subject: string } | null {
  const publicKey = env.VAPID_PUBLIC_KEY?.trim();
  const privateKey = env.VAPID_PRIVATE_KEY?.trim();
  const subject = env.VAPID_SUBJECT?.trim();
  if (!publicKey || !privateKey || !subject) return null;
  return { publicKey, privateKey, subject };
}

export const notifications = new Hono<AppEnv>();

async function settingsResponse(
  repo: NotificationRepo,
  env: AppBindings,
): Promise<NotificationSettingsResponse> {
  const [preferences, timezone] = await Promise.all([repo.getPreferences(), repo.getTimezone()]);
  const publicKey = env.VAPID_PUBLIC_KEY?.trim();
  return {
    preferences,
    timezone,
    vapidPublicKey: publicKey ? publicKey : null,
    ...(publicKey ? {} : { error: NOT_CONFIGURED }),
  };
}

notifications.get("/preferences", async (c) =>
  c.json(await settingsResponse(new NotificationRepo(c.get("db"), c.get("identity")), c.env)),
);

notifications.put("/preferences", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const parsed = updatePreferencesSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Invalid notification preferences", details: parsed.error.issues }, 400);
  }
  // No try/catch: the repo's ValidationErrors reach app.onError, the single
  // status-mapping decision in the codebase.
  const repo = new NotificationRepo(c.get("db"), c.get("identity"));
  await repo.updatePreferences(parsed.data satisfies UpdateNotificationPreferencesInput);
  return c.json(await settingsResponse(repo, c.env));
});

notifications.put("/timezone", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const parsed = setTimezoneSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Invalid timezone", details: parsed.error.issues }, 400);
  }
  const repo = new NotificationRepo(c.get("db"), c.get("identity"));
  // A `device` report against a `manual` pin is IGNORED by the repo, not
  // rejected — the client sends it unprompted on every visibilitychange, and
  // the 200 it gets back carries the pin that won, so the UI corrects itself.
  await repo.setTimezone(parsed.data);
  return c.json(await settingsResponse(repo, c.env));
});

notifications.get("/subscriptions", async (c) => {
  const repo = new NotificationRepo(c.get("db"), c.get("identity"));
  return c.json({ devices: (await repo.listPushSubscriptions()).map(toDeviceView) });
});

notifications.post("/subscriptions", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const parsed = registerSubscriptionSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Invalid push subscription", details: parsed.error.issues }, 400);
  }
  const repo = new NotificationRepo(c.get("db"), c.get("identity"));
  // Upserted on the endpoint by the repo, so re-registering the same device
  // after a service-worker update replaces its keys rather than doubling it.
  const record = await repo.registerPushSubscription({
    endpoint: parsed.data.endpoint,
    p256dh: parsed.data.keys.p256dh,
    auth: parsed.data.keys.auth,
  });
  return c.json({ device: toDeviceView(record) }, 201);
});

notifications.delete("/subscriptions/:id", async (c) => {
  // NotFoundError (404) for an id that is not one of this caller's own devices
  // — the repo's lookup is constrained to `user_id`, so another account's
  // endpoint is indistinguishable from a nonexistent one.
  await new NotificationRepo(c.get("db"), c.get("identity")).deletePushSubscription(
    c.req.param("id"),
  );
  return c.body(null, 204);
});

/**
 * Send a test notification to every device this account has registered.
 *
 * The FIRST deliverable of #61 and a permanent diagnostic, not scaffolding.
 * Web push on iOS fails in several ways that look identical from the outside —
 * VAPID misconfigured, the PWA never installed to the home screen, permission
 * granted and later revoked, a subscription silently dropped by the OS — and
 * without a button that sends one push right now, the first evidence any of
 * those happened is a reminder that never arrived for a flight already boarded.
 *
 * It answers PER DEVICE rather than with one boolean, because "it worked on
 * the iPad and not the phone" is the actual shape of the problem, and it
 * prunes any endpoint the push service reports as `gone` — iOS drops
 * subscriptions when a PWA is removed from the home screen, and a dead row
 * that is never cleaned up earns rate limits that hurt the live ones.
 *
 * A 200 with an `error` field rather than a 5xx when push is unconfigured or
 * no device is registered: neither is a server fault, and both are things the
 * settings page must be able to explain.
 */
notifications.post("/test", async (c) => {
  const repo = new NotificationRepo(c.get("db"), c.get("identity"));
  const devices = await repo.listPushSubscriptions();
  if (devices.length === 0) {
    return c.json({ results: [] as TestNotificationResult[], error: "No devices are registered for this account" });
  }
  const vapid = vapidConfig(c.env);
  if (!vapid) {
    return c.json({ results: [] as TestNotificationResult[], error: NOT_CONFIGURED });
  }

  const logger = c.get("logger");
  const results: TestNotificationResult[] = [];
  for (const device of devices) {
    const result = await sendPush({
      subscription: {
        endpoint: device.endpoint,
        keys: { p256dh: device.p256dh, auth: device.auth },
      },
      // No trip, no booking, no confirmation number — a test proves the
      // transport, and the payload policy in push/payload.ts is not relaxed
      // for it.
      payload: {
        title: "Travel HQ",
        body: "Push notifications are working on this device.",
        // A tag, so pressing the button twice replaces the first notification
        // rather than stacking two identical ones on the lock screen.
        tag: "travelhq-test",
        path: "/settings",
        timestamp: new Date().toISOString(),
      },
      vapid,
      logger,
      logFields: { subscriptionId: device.id },
    });

    let pruned = false;
    if (result.outcome === "gone") {
      pruned = await NotificationRepo.pruneEndpoint(c.get("db"), device.endpoint);
    } else if (result.outcome === "sent") {
      await NotificationRepo.recordPushSuccess(c.get("db"), device.endpoint);
    }
    results.push({
      id: device.id,
      host: hostOf(device.endpoint),
      outcome: result.outcome,
      status: "status" in result ? result.status : null,
      reason:
        result.outcome === "retryable" || result.outcome === "failed" || result.outcome === "invalid"
          ? result.reason
          : null,
      pruned,
    });
  }
  return c.json({ results });
});

/**
 * The per-subject router, mounted at `/api` so `authorizeBooking` and
 * `authorizeTrip` have already run by the time a handler here executes. Read
 * the note at the top of this file before moving either of these paths.
 */
export const notificationSubjects = new Hono<AppEnv>();

notificationSubjects.get("/bookings/:bookingId/notification", async (c) =>
  c.json(
    await new NotificationRepo(c.get("db"), c.get("identity")).getBookingSubscriptionState(
      c.req.param("bookingId"),
    ),
  ),
);

notificationSubjects.put("/bookings/:bookingId/notification", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const parsed = setSubscribedSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Invalid subscription", details: parsed.error.issues }, 400);
  }
  const repo = new NotificationRepo(c.get("db"), c.get("identity"));
  const bookingId = c.req.param("bookingId");
  // Each of the three branches ends with the reachability-checked state, so
  // the caller sees WHY they are subscribed (on it / trip-wide / explicit) and
  // not merely that they are.
  if (parsed.data.subscribed === null) return c.json(await repo.clearBookingSubscription(bookingId));
  return c.json(
    parsed.data.subscribed
      ? await repo.subscribeToBooking(bookingId)
      : await repo.unsubscribeFromBooking(bookingId),
  );
});

notificationSubjects.put("/trips/:tripId/notification", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const parsed = setSubscribedSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Invalid subscription", details: parsed.error.issues }, 400);
  }
  const repo = new NotificationRepo(c.get("db"), c.get("identity"));
  const tripId = c.req.param("tripId");
  // 204 rather than a state object: a trip-wide choice has no implicit half to
  // report (nobody "travels on" a trip the way they are on a booking), so the
  // only honest answer is the one the caller just sent.
  if (parsed.data.subscribed === null) await repo.clearTripSubscription(tripId);
  else if (parsed.data.subscribed) await repo.subscribeToTrip(tripId);
  else await repo.unsubscribeFromTrip(tripId);
  return c.body(null, 204);
});
