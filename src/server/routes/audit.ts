import { Hono } from "hono";
import { RevealAuditRepo } from "../repos/reveal-audit.js";
import type { AppEnv } from "../index.js";

export const audit = new Hono<AppEnv>();

/**
 * The household's sensitive-reveal audit trail (issue #8): who revealed
 * which person's document field, when. OWNER-only — the repo throws
 * ForbiddenError for adult and viewer alike (see RevealAuditRepo.list for
 * why an adult is deliberately excluded), mapped to 403 by app.onError.
 * The revealed values themselves are never stored, so they cannot appear
 * here no matter who asks.
 */
audit.get("/reveals", async (c) =>
  c.json(await new RevealAuditRepo(c.get("db"), c.get("identity")).list()),
);
