import { Hono } from "hono";
import type { AppEnv } from "../index.js";
import { AuditRepo, clampActivityPage } from "../repos/audit.js";

/**
 * The read side of the household activity log (issue #8, widened by the /me
 * profile work).
 *
 * There is no write endpoint, on purpose: audit rows are written by the
 * repositories performing the actions they describe, from the authenticated
 * context, as part of the action. An HTTP surface that could append to this
 * table would let a caller manufacture history.
 */
export const audit = new Hono<AppEnv>();

/**
 * Newest reveals first. A non-owner gets 403 from AuditRepo.requireOwner via
 * app.onError -- the same shape as every other role denial in the API, and the
 * client (Settings) treats it as "this panel isn't for you" rather than an
 * error, exactly as it already does for the ingest activity feed.
 *
 * Kept as its own endpoint now that the table holds more than reveals: this is
 * the "who unmasked a stored secret" question, which is a sharper one than
 * "what happened lately", and the panel that asks it should not have to filter
 * a general feed to find its answer.
 */
audit.get("/reveals", async (c) =>
  c.json(await new AuditRepo(c.get("db"), c.get("identity")).listReveals()),
);

/**
 * The rolling activity log, newest first, one keyset page at a time.
 *
 *   GET /api/audit/activity?limit=50&cursor=<opaque>
 *   -> { entries: AuditEntry[], nextCursor: string | null }
 *
 * `nextCursor` is null when this page is the end of the log; otherwise it is
 * fed straight back as `?cursor=` for the next page. It is deliberately opaque
 * to the client -- it encodes the (at, id) pair the repository pages on, and a
 * client that parsed it would be depending on a sort key we should stay free
 * to change.
 *
 * Everyone may call this. WHAT they see is AuditRepo.listActivity's decision:
 * an owner sees the household, and everybody else sees the entries they are
 * the actor or the subject of. No 403, because "what happened to my own
 * record" is a question every role may ask -- an empty page is a real answer,
 * not a denial.
 */
audit.get("/activity", async (c) => {
  // Clamped here as well as in the repo, because the "is there another page?"
  // test below has to compare against the number of rows the repo will
  // ACTUALLY return, not the number the query string asked for.
  const limit = clampActivityPage(parseLimit(c.req.query("limit")));
  const before = parseCursor(c.req.query("cursor"));
  const entries = await new AuditRepo(c.get("db"), c.get("identity")).listActivity({
    limit,
    before,
  });
  // A full page means there may be more; a short one is the end. This can hand
  // back a cursor for an empty next page (when the log ends exactly on a page
  // boundary), which is a wasted request rather than a wrong answer -- the
  // alternative is reading limit+1 rows to peek, and paying for the peek on
  // every page to save one request at the end of the log.
  const last = entries.length < limit ? undefined : entries.at(-1);
  return c.json({
    entries,
    nextCursor: last ? encodeCursor(last.at, last.id) : null,
  });
});

/**
 * A garbage `?limit=` is ignored rather than rejected: this is a paging hint,
 * the repository clamps it to a sane window anyway, and 400-ing a feed because
 * a query string was mistyped answers a question nobody asked.
 */
function parseLimit(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

/**
 * `<at>|<id>`. The timestamp is ISO 8601 and the id is a UUID, so neither can
 * contain the separator; splitting on the FIRST one keeps that true even if a
 * future id spelling stops being one.
 *
 * An unparseable cursor reads as "no cursor" and returns the first page. A
 * cursor is not authorization -- listActivity() scopes and filters the query
 * regardless of what it points at -- so the worst a malformed one can do is
 * show the reader the top of their own log.
 */
function parseCursor(raw: string | undefined): { at: string; id: string } | undefined {
  if (!raw) return undefined;
  const separator = raw.indexOf("|");
  if (separator <= 0 || separator === raw.length - 1) return undefined;
  return { at: raw.slice(0, separator), id: raw.slice(separator + 1) };
}

function encodeCursor(at: string, id: string): string {
  return `${at}|${id}`;
}
