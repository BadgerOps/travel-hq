import type { Context, MiddlewareHandler } from "hono";
import type { AppEnv } from "./index.js";
import type { Identity } from "./auth.js";
import { mapError } from "./routes/errors.js";

/**
 * Structured logging for the Worker (issue #8). Every structured log line —
 * the per-request line below, the ingest outcome lines in ingest.ts and
 * ingest/extract.ts, the reveal lines in routes/people.ts and
 * routes/trips.ts — funnels through logEvent(), so the no-PII rule has one
 * place to live:
 *
 *   LOG IDS AND OUTCOMES, NEVER SECRETS. Banned from every log line:
 *   document numbers (or any decrypted value), raw email message text, and
 *   full email addresses — an address identifies a person out in the world,
 *   while a household id or row id identifies nothing outside our own
 *   database. "Who did what" in human-readable form belongs in the durable
 *   reveal_audit table, not in stdout.
 *
 * tests/server/routes/logging.test.ts and tests/server/email.test.ts hold
 * this to account by scanning captured log output for the known-sensitive
 * fixture strings (a passport number, sender addresses, a raw body marker).
 */

/**
 * One JSON line to stdout — the shape `wrangler tail` and the Workers logs
 * UI index. `event` and `at` first, then the caller's fields.
 */
export function logEvent(event: string, fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ event, at: new Date().toISOString(), ...fields }));
}

/** The error's message with no prefix; the counterpart of its class name. */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * The class name is the outcome vocabulary of the request line: mapError()
 * keys on classes, so the class name (NotFoundError, ForbiddenError,
 * ZodError, ...) is exactly the granularity the status code came from.
 */
function errorName(err: unknown): string {
  if (err instanceof Error && err.constructor.name !== "") return err.constructor.name;
  return typeof err;
}

/**
 * Emits exactly ONE structured JSON line per request: request id, method,
 * PARAMETERIZED route, status, duration, household id (when an identity was
 * resolved), and outcome. Registered on "*" ahead of the auth middleware in
 * createApp(), so even a 401 gets its line.
 *
 * The request id is set on the context (c.get("requestId")) so downstream
 * logs — the document/confirmation reveal lines — can join against the
 * request line in `wrangler tail`.
 *
 * Error handling: Hono resolves a thrown Error into a response via
 * app.onError at the level that threw, so after `await next()` the mapped
 * response is on c.res and the underlying error on c.error — that is the
 * normal error path here. For a 500, the line carries the REAL error
 * (name/message/stack): mapError() deliberately answers the client with a
 * generic body so schema internals never leak over HTTP, and this is the
 * counterpart that keeps the detail server-side. Non-500 outcomes log only
 * the error's class name — messages at that level are client-facing anyway,
 * and some (AuthError's) name the caller's email address, which must not
 * land in a log line.
 */
export function requestLogger(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const requestId = crypto.randomUUID();
    c.set("requestId", requestId);
    const startedAt = Date.now();
    try {
      await next();
    } catch (err) {
      // Reached only when the error was NOT already resolved into a response
      // downstream (a non-Error throwable, which Hono's onError never
      // handles — or a future Hono moving where errors are caught). Log with
      // the same status mapError() would assign, then rethrow: this
      // middleware never swallows an error.
      emitRequestLine(c, requestId, startedAt, mapError(err).status, err);
      throw err;
    }
    emitRequestLine(c, requestId, startedAt, c.res.status, c.error);
  };
}

function emitRequestLine(
  c: Context<AppEnv>,
  requestId: string,
  startedAt: number,
  status: number,
  err: unknown,
): void {
  // May genuinely be unset: the identity middleware runs after this one, and
  // never completed at all for an unauthenticated request.
  const identity = c.get("identity") as Identity | undefined;
  const line: Record<string, unknown> = {
    requestId,
    method: c.req.method,
    // The parameterized route ("/api/people/:id/reveal/:field"), never the
    // raw URL — path ids stay out of the request line by construction.
    route: c.req.routePath,
    status,
    durationMs: Date.now() - startedAt,
    outcome: err === undefined || err === null ? (status >= 400 ? "error" : "ok") : errorName(err),
  };
  if (identity !== undefined) {
    line.householdId = identity.householdId;
  }
  if (status >= 500 && err !== undefined && err !== null) {
    line.error = {
      name: errorName(err),
      message: errorMessage(err),
      ...(err instanceof Error && err.stack !== undefined ? { stack: err.stack } : {}),
    };
  }
  logEvent("request", line);
}
