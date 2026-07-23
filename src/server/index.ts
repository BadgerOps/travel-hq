import { Hono } from "hono";
import { loadKeyring } from "./crypto/envelope.js";
import type { Keyring } from "./crypto/envelope.js";
import { resolveVerifier } from "./auth.js";
import type { Identity, WorkerAuthEnv } from "./auth.js";
import { people } from "./routes/people.js";
import { trips } from "./routes/trips.js";
import { itinerary } from "./routes/itinerary.js";
import { bookings } from "./routes/bookings.js";
import { checklist } from "./routes/checklist.js";
import { settings } from "./routes/settings.js";
import { imports } from "./routes/import.js";
import { audit } from "./routes/audit.js";
import { mapError } from "./routes/errors.js";
import { requestLogger } from "./logging.js";

export type AppBindings = {
  DB: D1Database;
  AI: Ai; // declared for later plans; unused here
  ENCRYPTION_KEY: string;
  TRAVEL_HQ_ENV?: string;
  TRAVEL_HQ_DEV_EMAIL?: string;
  CF_ACCESS_TEAM_DOMAIN?: string;
  CF_ACCESS_AUD?: string;
  // Where the email() ingest handler forwards anything it does not store as
  // `received` (see src/server/ingest.ts). Optional -- unset means such mail
  // is dropped after being recorded/logged.
  FALLBACK_FORWARD_TO?: string;
};

export type AppEnv = {
  Bindings: AppBindings;
  Variables: {
    db: D1Database;
    ring: Keyring;
    identity: Identity;
    /** Set by requestLogger() for every request; joins log lines together. */
    requestId: string;
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
};

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

export function createApp(overrides: AppOverrides = {}) {
  const app = new Hono<AppEnv>();

  // The one place every thrown/rejected error in a route funnels through, so
  // there is exactly one status-mapping decision (routes/errors.ts).
  app.onError((err, c) => {
    const mapped = mapError(err);
    return c.json(mapped.body, mapped.status);
  });

  // Ahead of the auth middleware on purpose: a 401 (or any auth failure)
  // still gets its one structured request line, and the request id exists
  // before anything downstream could want to log. One JSON line per request
  // (issue #8); 500s carry the real error server-side while mapError keeps
  // the HTTP body generic.
  app.use("*", requestLogger());

  app.use("/api/*", async (c, next) => {
    const env = c.env;
    c.set("db", env.DB);
    c.set("ring", overrides.ring ?? loadKeyring(env.ENCRYPTION_KEY));
    const verify = overrides.verify ? (req: Request) => overrides.verify!(req, env) : verifierFor(env);
    // A real verify() rejects only with AuthError; app.onError maps it to 401.
    c.set("identity", await verify(c.req.raw));
    await next();
  });

  // Resolved by the middleware from the Access token + confirmed membership;
  // this route invents nothing.
  app.get("/api/me", (c) => c.json(c.get("identity")));

  app.route("/api/people", people);
  app.route("/api/trips", trips);
  app.route("/api", itinerary);
  app.route("/api/bookings", bookings);
  app.route("/api/checklist", checklist);
  app.route("/api/settings", settings);
  app.route("/api/import", imports);
  app.route("/api/audit", audit);

  app.get("/healthz", (c) => c.text("ok"));

  return app;
}
