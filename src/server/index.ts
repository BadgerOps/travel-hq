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
import { cards } from "./routes/cards.js";
import { settings } from "./routes/settings.js";
import { inboundEmails } from "./routes/inbound-emails.js";
import { mapError } from "./routes/errors.js";
import { createAnthropicClient } from "./ingest/providers.js";
import type { AnthropicClientFactory } from "./ingest/providers.js";
import { WorkersAiModelCatalog } from "./ingest/model-catalog.js";

export type AppBindings = {
  DB: D1Database;
  AI: Ai;
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
    anthropicClientFactory: AnthropicClientFactory;
    modelCatalog: WorkersAiModelCatalog;
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

export function createApp(overrides: AppOverrides = {}) {
  const app = new Hono<AppEnv>();

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
  // there is exactly one status-mapping decision (routes/errors.ts).
  app.onError((err, c) => {
    const mapped = mapError(err);
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

  app.route("/api/people", people);
  app.route("/api/trips", trips);
  app.route("/api", itinerary);
  app.route("/api/bookings", bookings);
  app.route("/api/checklist", checklist);
  app.route("/api/cards", cards);
  app.route("/api/settings", settings);
  app.route("/api/inbound-emails", inboundEmails);

  app.get("/healthz", (c) => c.text("ok"));

  return app;
}
