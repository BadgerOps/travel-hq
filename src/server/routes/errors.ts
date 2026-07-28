import { ZodError } from "zod";
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  TenantScopeError,
  ValidationError,
} from "../repos/base.js";
import { AuthError, HouseholdAccessError } from "../auth.js";

export type MappedError = {
  status: 400 | 401 | 403 | 404 | 409 | 500;
  body: { error: string; details?: unknown };
};

/**
 * The one place that decides which HTTP status a thrown error becomes.
 * `createApp`'s `app.onError` funnels every route's thrown/rejected error
 * through this, so there is exactly one status-mapping decision in the
 * codebase rather than one inline per route. (JSON-parse and Zod-schema
 * failures are handled as early returns in the routes themselves, before a
 * repo is ever called — see routes/*.ts — because a body-parse SyntaxError
 * is not a domain error mapError() can honestly classify.)
 *
 * TenantScopeError intentionally gets a generic body: its `.message` is
 * written for logs/grep (see base.ts's `logScopeBug`), not for a client, and
 * surfacing it would hand back exactly the kind of internal detail — which
 * table, which query shape — a scope bug must never disclose over HTTP.
 */
export function mapError(err: unknown): MappedError {
  // HouseholdAccessError before AuthError: it's a subclass, and the household
  // selection failure it represents is an authorization problem (403), not
  // an authentication one — every *other* AuthError (missing/invalid token,
  // no membership at all, ambiguous membership) still maps to 401.
  if (err instanceof HouseholdAccessError) {
    return { status: 403, body: { error: "Forbidden" } };
  }
  if (err instanceof AuthError) {
    return { status: 401, body: { error: "Unauthorized" } };
  }
  if (err instanceof ForbiddenError) {
    return { status: 403, body: { error: "Forbidden" } };
  }
  if (err instanceof NotFoundError) {
    return { status: 404, body: { error: "Not found" } };
  }
  if (err instanceof ValidationError) {
    return { status: 400, body: { error: err.message } };
  }
  // Like ValidationError, the message is surfaced verbatim — a conflict is the
  // one case where the server knows something the caller does not, and the
  // client is meant to show it and offer to proceed anyway.
  if (err instanceof ConflictError) {
    return { status: 409, body: { error: err.message } };
  }
  if (err instanceof TenantScopeError) {
    return { status: 500, body: { error: "Internal error" } };
  }
  if (err instanceof ZodError) {
    return { status: 400, body: { error: "Invalid request", details: err.issues } };
  }
  return { status: 500, body: { error: "Internal error" } };
}
