import { Hono } from "hono";
import type { Context } from "hono";
import { loadKeyring } from "./crypto/envelope.js";
import type { Keyring } from "./crypto/envelope.js";
import { resolveVerifier } from "./auth.js";
import type { Identity, WorkerAuthEnv } from "./auth.js";
import { people } from "./routes/people.js";
import { trips } from "./routes/trips.js";
import { itinerary } from "./routes/itinerary.js";
import { bookings } from "./routes/bookings.js";
import { checklist } from "./routes/checklist.js";
import { cards } from "./routes/cards.js";
import { settings } from "./routes/settings.js";
import { notifications, notificationSubjects } from "./routes/notifications.js";
import { inboundEmails } from "./routes/inbound-emails.js";
import { imports } from "./routes/imports.js";
import { audit } from "./routes/audit.js";
import { mapError } from "./routes/errors.js";
import { createLogger, log } from "./logging.js";
import type { Logger } from "./logging.js";
import { createAnthropicClient } from "./ingest/providers.js";
import type { AnthropicClientFactory } from "./ingest/providers.js";
import { WorkersAiModelCatalog } from "./ingest/model-catalog.js";
import {
  authorizeBooking,
  authorizeChecklistItem,
  authorizeTrip,
  requireHouseholdWriter,
} from "./trip-authorization.js";

export type AppBindings = {
  DB: D1Database;
  AI: Ai;
  TRIP_PHOTOS: R2Bucket;
  ENCRYPTION_KEY: string;
  TRAVEL_HQ_ENV?: string;
  TRAVEL_HQ_DEV_EMAIL?: string;
  CF_ACCESS_TEAM_DOMAIN?: string;
  CF_ACCESS_AUD?: string;
  // Where the email() ingest handler forwards anything it does not store as
  // `received` (see src/server/ingest.ts). Optional -- unset means such mail
  // is dropped after being recorded/logged.
  FALLBACK_FORWARD_TO?: string;
  // Web Push (issue #61). The public key is handed to the browser as
  // `applicationServerKey`; the private key is a secret and never leaves the
  // Worker; the subject is the `mailto:`/`https:` contact RFC 8292 requires.
  // ALL THREE OPTIONAL, on purpose: a deployment without push configured must
  // still serve every other route, and the notification endpoints degrade with
  // an explanation rather than a 5xx (see routes/notifications.ts).
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  VAPID_SUBJECT?: string;
};

export type AppEnv = {
  Bindings: AppBindings;
  Variables: {
    db: D1Database;
    ring: Keyring;
    identity: Identity;
    anthropicClientFactory: AnthropicClientFactory;
    modelCatalog: WorkersAiModelCatalog;
    /** Correlates every log line of one request with its X-Request-Id header. */
    requestId: string;
    /** Request-scoped child logger; already carries `requestId`. */
    logger: Logger;
  };
};

/**
 * Test seam. Production passes nothing: db/ring/verify are derived from the
 * per-request env. Tests inject `verify` (to supply an identity without a real
 * Access token) and `ring` (to control the encryption key).
 */
export type AppOverrides = {
  verify?: (req: Request, env: AppBindings) => Promise<Identity>;
  ring?: Keyring;
  anthropicClientFactory?: AnthropicClientFactory;
  modelCatalog?: WorkersAiModelCatalog;
};

// Isolate-lifetime cache of the Workers AI model catalog (see model-catalog.ts).
const defaultModelCatalog = new WorkersAiModelCatalog();

// The Access verifier caches JWKS; cache it per env object so that survives
// across requests within an isolate.
const verifierCache = new WeakMap<AppBindings, (req: Request) => Promise<Identity>>();

function verifierFor(env: AppBindings): (req: Request) => Promise<Identity> {
  let v = verifierCache.get(env);
  if (!v) {
    v = resolveVerifier(env as WorkerAuthEnv);
    verifierCache.set(env, v);
  }
  return v;
}

/**
 * The route PATTERN a request matched ("/api/trips/:tripId/bookings"), not the
 * concrete path. Patterns are what make a log query aggregate: "every 500 on
 * the reveal route" is answerable, "every 500 on /api/trips/<one uuid>/..." is
 * not.
 *
 * `c.req.routePath` is the path of the CURRENTLY EXECUTING handler, which
 * inside this middleware is always "*". `matchedRoutes` holds every entry the
 * router matched, middleware included; middleware is registered with `app.use`
 * and therefore carries method "ALL", so the last non-ALL entry is the actual
 * endpoint. Nothing matched (a 404) yields null rather than a fake route.
 */
function matchedRoutePattern(c: Context<AppEnv>): string | null {
  const routes = c.req.matchedRoutes.filter((route) => route.method !== "ALL");
  return routes[routes.length - 1]?.path ?? null;
}

/**
 * Which KIND of failure this was, as one greppable word.
 *
 * `err.name` is useless for our taxonomy: none of the RepoError subclasses in
 * repos/base.ts assign `this.name`, so every one of them reports "Error". The
 * constructor name is what actually distinguishes NotFoundError from
 * ConflictError from a raw D1 failure -- which is the whole reason to log a
 * class at all rather than a message we have decided not to log.
 */
function errorClassOf(err: unknown): string {
  if (!(err instanceof Error)) return typeof err;
  return err.constructor?.name || err.name || "Error";
}

export function createApp(overrides: AppOverrides = {}) {
  const app = new Hono<AppEnv>();

  /**
   * Request-scoped structured logging (issue #8). First in the chain, and on
   * "*" rather than "/api/*", so that the log line and the X-Request-Id header
   * cover EVERY response the Worker produces -- including the ones produced by
   * app.onError below, and including a 404 for a path no route claimed.
   *
   * What the line carries, and why each field earns its place:
   *   requestId  -- also returned as X-Request-Id, so a user-reported failure
   *                 ("it broke, here's the id") is directly greppable.
   *   method/route/path -- what was called. `route` is the pattern (aggregable),
   *                 `path` the concrete one (ids only -- no route in this app
   *                 puts a name, address or document in its path, and the query
   *                 string, which is caller-controlled, is dropped).
   *   householdId/userId -- WHICH TENANT, as opaque ids. Never the email: the
   *                 audit trail names people (it must), the log stream does not.
   *   status/outcome/durationMs -- the answer to "did it work, and how slowly".
   *
   * The id is minted here and never taken from an inbound header: a
   * client-supplied X-Request-Id would let a caller forge, collide with, or
   * flood other requests' correlation ids.
   */
  app.use("*", async (c, next) => {
    const requestId = crypto.randomUUID();
    const logger = createLogger({ requestId });
    c.set("requestId", requestId);
    c.set("logger", logger);
    // Set before next() so it is merged into whatever response the chain
    // produces -- the same mechanism the no-store header below relies on.
    c.header("X-Request-Id", requestId);

    // Date.now() is coarse in Workers (it only advances across I/O), so this
    // measures I/O-bound time -- D1 round trips, AI calls -- which is exactly
    // the part worth watching, and reads 0 for a pure-CPU handler.
    const startedAt = Date.now();
    let threw = false;
    try {
      await next();
    } catch (err) {
      // Reaching here means the error escaped app.onError (a non-Error
      // throwable). Log the fact, then rethrow: swallowing it would turn a
      // hard failure into a silent one.
      threw = true;
      logger.error("request_failed", { errorClass: errorClassOf(err) });
      throw err;
    } finally {
      // Only read c.res on the non-throwing path: its getter MATERIALIZES a
      // 404 response when nothing set one, which would mask the real failure.
      const identity = c.get("identity") as Identity | undefined;
      logger.info("request", {
        method: c.req.method,
        route: matchedRoutePattern(c),
        path: new URL(c.req.url).pathname,
        status: threw ? null : c.res.status,
        outcome: threw ? "error" : c.res.status < 400 ? "ok" : "rejected",
        householdId: identity?.householdId ?? null,
        userId: identity?.userId ?? null,
        durationMs: Date.now() - startedAt,
      });
    }
  });

  // API responses contain private household data, and the explicit reveal
  // endpoints can contain plaintext passport, KTN, redress, and confirmation
  // numbers. Do not leave caching behavior to browsers, intermediary proxies,
  // or future Cloudflare cache rules. Set this before auth/routing so error
  // responses are covered too.
  app.use("/api/*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    await next();
  });

  // The one place every thrown/rejected error in a route funnels through, so
  // there is exactly one status-mapping decision (routes/errors.ts) -- and,
  // since issue #8, exactly one place that WRITES THE CAUSE DOWN.
  app.onError((err, c) => {
    const mapped = mapError(err);
    // The logger is set by the outermost middleware, so it is present for any
    // error thrown after routing began. `log` covers the vanishingly rare case
    // of a failure before that (and keeps this branch total).
    const logger = (c.get("logger") as Logger | undefined) ?? log;
    if (mapped.status >= 500) {
      // A 500 answers the client `{"error":"Internal error"}` and nothing more
      // -- deliberately, see mapError. That makes this line the ONLY surviving
      // evidence of what actually broke, so it carries the full cause: name,
      // message, stack, and the `cause` chain a rethrow may have wrapped.
      // None of it reaches the response body.
      logger.error("unhandled_error", {
        status: mapped.status,
        route: matchedRoutePattern(c),
        method: c.req.method,
        errorClass: errorClassOf(err),
        errorMessage: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
        cause: err instanceof Error && err.cause ? String(err.cause) : undefined,
      });
    } else {
      // 4xx is the API working as designed (a viewer denied, an unknown id),
      // not an incident. Record that it happened and its class, but not the
      // message: ValidationError/ConflictError messages quote what the CALLER
      // sent, which is the one place caller data could leak into the stream.
      logger.info("request_rejected", {
        status: mapped.status,
        errorClass: errorClassOf(err),
      });
    }
    return c.json(mapped.body, mapped.status);
  });

  app.use("/api/*", async (c, next) => {
    const env = c.env;
    c.set("db", env.DB);
    c.set("ring", overrides.ring ?? loadKeyring(env.ENCRYPTION_KEY));
    c.set("anthropicClientFactory", overrides.anthropicClientFactory ?? createAnthropicClient);
    c.set("modelCatalog", overrides.modelCatalog ?? defaultModelCatalog);
    const verify = overrides.verify ? (req: Request) => overrides.verify!(req, env) : verifierFor(env);
    // A real verify() rejects only with AuthError; app.onError maps it to 401.
    c.set("identity", await verify(c.req.raw));
    await next();
  });

  // Resolved by the middleware from the Access token + confirmed membership;
  // this route invents nothing.
  app.get("/api/me", (c) => c.json(c.get("identity")));

  // Shared-trip accounts stay household viewers globally. These narrow
  // middlewares grant their per-trip role only after resolving and checking
  // the resource being addressed.
  app.use("/api/trips/:tripId", (c, next) =>
    authorizeTrip(c, next, c.req.param("tripId")),
  );
  app.use("/api/trips/:tripId/*", (c, next) =>
    authorizeTrip(c, next, c.req.param("tripId")),
  );
  app.use("/api/bookings/:bookingId", (c, next) =>
    authorizeBooking(c, next, c.req.param("bookingId")),
  );
  app.use("/api/bookings/:bookingId/*", (c, next) =>
    authorizeBooking(c, next, c.req.param("bookingId")),
  );
  app.use("/api/checklist/:itemId/*", (c, next) =>
    authorizeChecklistItem(c, next, c.req.param("itemId")),
  );

  // Household-wide operational data is not part of a trip invitation.
  app.use("/api/cards/*", requireHouseholdWriter);
  app.use("/api/cards", requireHouseholdWriter);
  app.use("/api/settings/*", requireHouseholdWriter);
  app.use("/api/settings", requireHouseholdWriter);
  app.use("/api/inbound-emails/*", requireHouseholdWriter);
  app.use("/api/inbound-emails", requireHouseholdWriter);
  app.use("/api/imports/*", requireHouseholdWriter);
  app.use("/api/imports", requireHouseholdWriter);

  // /api/notifications is DELIBERATELY ABSENT from the list above. Every row
  // behind it is keyed by the authenticated user — their phone, their digest
  // time, the events they personally follow — and none of it is household
  // data, so the household write role has no question to answer about it.
  // Gating it would lock out every shared-trip account, which is a household
  // `viewer` globally and is the exact person #61 exists to serve.

  app.route("/api/people", people);
  app.route("/api/trips", trips);
  app.route("/api", itinerary);
  app.route("/api/bookings", bookings);
  app.route("/api/checklist", checklist);
  app.route("/api/cards", cards);
  app.route("/api/settings", settings);
  app.route("/api/notifications", notifications);
  // At "/api", not under /api/notifications: these two live at
  // /api/bookings/:bookingId/notification and /api/trips/:tripId/notification
  // so the authorizeBooking/authorizeTrip middleware registered above matches
  // them and the parent check cannot be skipped. Same reason routes/itinerary.ts
  // is mounted here.
  app.route("/api", notificationSubjects);
  app.route("/api/inbound-emails", inboundEmails);
  app.route("/api/imports", imports);
  // Owner-only; the gate lives in AuditRepo (requireOwner), not in a
  // middleware, so a non-HTTP caller gets the same answer.
  app.route("/api/audit", audit);

  app.get("/healthz", (c) => c.text("ok"));

  return app;
}
