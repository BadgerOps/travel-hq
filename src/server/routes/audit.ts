import { Hono } from "hono";
import type { AppEnv } from "../index.js";
import { AuditRepo } from "../repos/audit.js";

/**
 * The owner-facing read side of the reveal audit trail (issue #8).
 *
 * There is no write endpoint, on purpose: audit rows are written by the reveal
 * routes themselves, from the authenticated context, as part of the action
 * being audited. An HTTP surface that could append to this table would let a
 * caller manufacture history.
 */
export const audit = new Hono<AppEnv>();

/**
 * Newest reveals first. A non-owner gets 403 from AuditRepo.requireOwner via
 * app.onError -- the same shape as every other role denial in the API, and the
 * client (Settings) treats it as "this panel isn't for you" rather than an
 * error, exactly as it already does for the ingest activity feed.
 */
audit.get("/reveals", async (c) =>
  c.json(await new AuditRepo(c.get("db"), c.get("identity")).listReveals()),
);
