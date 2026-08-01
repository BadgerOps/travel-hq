import { log } from "../logging.js";

export type Role = "owner" | "adult" | "viewer";

export type HouseholdContext = {
  householdId: string;
  userId: string;
  role: Role;
  /**
   * Set only after a trip-scoped request has passed TripAccessRepo. It lets
   * an invited editor use ordinary repositories without turning that account
   * into a household-wide adult.
   */
  tripRole?: "viewer" | "editor";
};

const ROLES: readonly Role[] = ["owner", "adult", "viewer"];

/** Shared base for every error the repository layer throws. */
export abstract class RepoError extends Error {}

/**
 * A bug in how a repository (not a caller/request) was written: a query
 * missing its {scope} token, a token hidden in a comment/string, a query
 * shaped so the tenancy predicate can be neutralized, a caller writing the
 * reserved ?1, or an invalid identifier passed to insert(). Map to 500. The
 * .message never contains SQL or column/table names.
 */
export class TenantScopeError extends RepoError {}

/** The caller's role does not permit the attempted operation. Map to 403. */
export class ForbiddenError extends RepoError {}

/** The requested row does not exist in this household (or anywhere). Map to 404. */
export class NotFoundError extends RepoError {}

/** The request itself is malformed in a way only the repo layer can catch. Map to 400. */
export class ValidationError extends RepoError {}

/**
 * The request is well-formed but collides with state the caller may not have
 * known about, and the right answer is for a human to decide rather than for
 * the server to pick one. Map to 409 — distinct from ValidationError's 400
 * precisely because the client is expected to offer an override rather than
 * treat it as a bug in what it sent. The .message is written for that human.
 */
export class ConflictError extends RepoError {}

function logScopeBug(reason: string, detail: string): void {
  // ALWAYS logged, production included (issue #8). This used to be silenced
  // when NODE_ENV === "production", which had it exactly backwards: a tenancy
  // scope bug is the single failure this codebase most needs a trace of in
  // production, and the client only ever sees a generic 500 (mapError's
  // TenantScopeError branch), so the log line is the ONLY evidence it happened.
  //
  // The process-wide logger rather than a request-scoped child: scopeBug() is
  // called from deep inside statement preparation, which has no Hono context
  // to reach. The line is still correlatable -- the `request` line for the
  // same invocation carries the same timestamp window and the resulting 500.
  //
  // `reason` and `sql` are safe to log by construction: both are written from
  // the query TEXT and identifier names, never from bound parameter VALUES.
  // The .message on the thrown TenantScopeError stays generic; see mapError.
  log.error("tenant_scope_bug", { reason, sql: detail });
}

function scopeBug(reason: string, detail: string): never {
  logScopeBug(reason, detail);
  throw new TenantScopeError(reason);
}

const SCOPE_TOKEN = "{scope}";
// {scope} expands to household_id = ?1. ?1 is RESERVED for the household id,
// bound first by every all()/get()/run() below. Callers write ?2, ?3, ...
const SCOPE_SQL = "household_id = ?1";

const IDENTIFIER_RE = /^[a-z_][a-z0-9_]*$/;
const WRITE_KEYWORD_RE = /^\s*(INSERT|UPDATE|DELETE|REPLACE)\b/i;

type Hit = { index: number; depth: number };
type ParamHit = { index: number; number: number };

/**
 * Single left-to-right scan of the raw SQL that skips comments and string
 * literals, tracks paren depth, and records:
 *  - every literal {scope} token (with depth),
 *  - every bare OR / UNION / EXCEPT / INTERSECT keyword (with depth),
 *  - every positional placeholder (?, ?NNN) OUTSIDE comments/strings, with its
 *    numeric index (0 for an anonymous ?), and
 *  - `stripped`: the SQL with comments removed (string literals kept), for the
 *    write-keyword check.
 */
function scanSql(sql: string): {
  scopeHits: Hit[];
  orHits: Hit[];
  setHits: Hit[];
  paramHits: ParamHit[];
  stripped: string;
} {
  const scopeHits: Hit[] = [];
  const orHits: Hit[] = [];
  const setHits: Hit[] = [];
  const paramHits: ParamHit[] = [];
  let stripped = "";
  let depth = 0;
  let i = 0;
  const n = sql.length;

  while (i < n) {
    const c = sql[i];

    if (c === "-" && sql[i + 1] === "-") {
      const end = sql.indexOf("\n", i);
      i = end === -1 ? n : end + 1;
      continue;
    }
    if (c === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2);
      i = end === -1 ? n : end + 2;
      continue;
    }
    if (c === "'" || c === '"') {
      const quote = c;
      const start = i;
      i++;
      while (i < n) {
        if (sql[i] === quote && sql[i + 1] === quote) {
          i += 2;
          continue;
        }
        if (sql[i] === quote) {
          i++;
          break;
        }
        i++;
      }
      stripped += sql.slice(start, i);
      continue;
    }
    if (c === "(") {
      depth++;
      stripped += c;
      i++;
      continue;
    }
    if (c === ")") {
      depth--;
      stripped += c;
      i++;
      continue;
    }
    if (c === "?") {
      // A positional placeholder. Read any following digits to get its index.
      let j = i + 1;
      while (j < n && sql[j]! >= "0" && sql[j]! <= "9") j++;
      const digits = sql.slice(i + 1, j);
      paramHits.push({ index: i, number: digits.length > 0 ? Number(digits) : 0 });
      stripped += sql.slice(i, j);
      i = j;
      continue;
    }
    if (sql.startsWith(SCOPE_TOKEN, i)) {
      scopeHits.push({ index: i, depth });
      stripped += SCOPE_TOKEN;
      i += SCOPE_TOKEN.length;
      continue;
    }
    if (/[A-Za-z_]/.test(c!)) {
      const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(sql.slice(i))!;
      const word = match[0].toUpperCase();
      if (word === "OR") orHits.push({ index: i, depth });
      else if (word === "UNION" || word === "EXCEPT" || word === "INTERSECT") {
        setHits.push({ index: i, depth });
      }
      stripped += match[0];
      i += match[0].length;
      continue;
    }
    stripped += c;
    i++;
  }

  return { scopeHits, orHits, setHits, paramHits, stripped };
}

/**
 * Base class for all domain repositories.
 *
 * Queries MUST contain the literal {scope} token exactly once, outside any
 * comment or string literal. It expands to `household_id = ?1`. The household
 * id is RESERVED at index ?1 and bound as the FIRST value by all()/get()/run();
 * caller params start at ?2. Nothing counts anonymous ? to find a splice
 * position, so a ? in a comment or string literal cannot shift the household
 * id: it owns a fixed explicit index the caller never writes.
 *
 * A query without the token throws rather than running. So does a query shaped
 * so the predicate can be neutralized (a bare OR, or a UNION/EXCEPT/INTERSECT,
 * at or above the token's nesting depth), one where the token is hidden in a
 * comment or string literal, and one where the caller writes ?1 anywhere
 * (reserved) or ?1 appears outside the {scope} expansion.
 *
 * Bypassing all of the above requires unscoped()/unscopedRun(), which take a
 * human-readable reason so every bypass is greppable.
 */
export abstract class TenantRepo {
  private readonly db: D1Database;
  protected readonly ctx: HouseholdContext;

  constructor(db: D1Database, ctx: HouseholdContext) {
    if (typeof ctx.householdId !== "string" || ctx.householdId.trim() === "") {
      throw new TenantScopeError("HouseholdContext.householdId must be a non-empty string");
    }
    if (typeof ctx.userId !== "string" || ctx.userId.trim() === "") {
      throw new TenantScopeError("HouseholdContext.userId must be a non-empty string");
    }
    if (!ROLES.includes(ctx.role)) {
      throw new TenantScopeError(`HouseholdContext.role must be one of ${ROLES.join(", ")}`);
    }
    this.db = db;
    this.ctx = ctx;
  }

  /**
   * Validates the scope token's shape and rewrites {scope} to `household_id =
   * ?1`. Throws (never returns a partially-scoped string) if the token is
   * missing, duplicated, hidden in a comment/string, the query is shaped so the
   * predicate could be neutralized, or the caller writes the reserved ?1.
   */
  private scopeQuery(sql: string): string {
    const { scopeHits, orHits, setHits, paramHits } = scanSql(sql);

    if (scopeHits.length !== 1) {
      scopeBug(
        `Query must contain exactly one ${SCOPE_TOKEN} token outside comments and string literals`,
        `found ${scopeHits.length} valid occurrence(s):\n${sql}`,
      );
    }

    const { depth: scopeDepth } = scopeHits[0]!;

    if (orHits.some((h) => h.depth <= scopeDepth)) {
      scopeBug(
        "Query has an OR at or above the scope token's nesting level; it can neutralize the tenancy predicate",
        sql,
      );
    }
    if (setHits.some((h) => h.depth <= scopeDepth)) {
      scopeBug(
        "Query has a UNION/EXCEPT/INTERSECT at or above the scope token's nesting level; it can bypass the tenancy predicate",
        sql,
      );
    }
    // NEW GUARDS: ?1 is reserved for the household id, injected only by the
    // expansion below (after this scan). Any ?1 the scanner sees is the
    // caller's, and is illegal whether written as a value placeholder or in a
    // select position -- both cases are exactly "index === 1 in caller SQL".
    if (paramHits.some((p) => p.number === 1)) {
      scopeBug(
        "Query writes the reserved ?1 parameter; the household id owns ?1, caller params start at ?2",
        sql,
      );
    }

    const { index } = scopeHits[0]!;
    return sql.slice(0, index) + SCOPE_SQL + sql.slice(index + SCOPE_TOKEN.length);
  }

  protected async all<T>(sql: string, ...params: unknown[]): Promise<T[]> {
    const scoped = this.scopeQuery(sql);
    const { results } = await this.db
      .prepare(scoped)
      .bind(this.ctx.householdId, ...params)
      .all<T>();
    return results;
  }

  protected async get<T>(sql: string, ...params: unknown[]): Promise<T | undefined> {
    const scoped = this.scopeQuery(sql);
    const row = await this.db
      .prepare(scoped)
      .bind(this.ctx.householdId, ...params)
      .first<T>();
    return row ?? undefined;
  }

  protected async run(sql: string, ...params: unknown[]): Promise<void> {
    if (isWriteQuery(sql)) this.requireWrite();
    const scoped = this.scopeQuery(sql);
    await this.db
      .prepare(scoped)
      .bind(this.ctx.householdId, ...params)
      .run();
  }

  /**
   * run() for a compare-and-set: identical scoping, but it returns how many
   * rows the statement actually changed instead of discarding that.
   *
   * A conditional write (`... AND status = 'received'`) carries its own
   * outcome in that number. Zero means the guard did not hold — another
   * worker moved the row between this caller's read and its write — and
   * throwing away the count is precisely what turns a lost race into a
   * reported success. A caller that asserts an exact count gets optimistic
   * concurrency with no lock and no second read to race against.
   */
  protected async runChanges(sql: string, ...params: unknown[]): Promise<number> {
    if (isWriteQuery(sql)) this.requireWrite();
    const scoped = this.scopeQuery(sql);
    const { meta } = await this.db
      .prepare(scoped)
      .bind(this.ctx.householdId, ...params)
      .run();
    return changedRows(meta);
  }

  /**
   * Inserts are the one case with no WHERE clause to scope. The household id is
   * supplied by the context, not the caller, so a caller cannot insert into
   * another tenant even if they try. Placeholders here are anonymous ? bound in
   * column order -- there is no {scope} expansion and no ?1 reservation.
   */
  protected async insert(table: string, values: Record<string, unknown>): Promise<void> {
    this.requireWrite();
    if (!IDENTIFIER_RE.test(table)) {
      scopeBug("insert(): invalid table identifier", `table=${table}`);
    }
    const withScope: Record<string, unknown> = { ...values, household_id: this.ctx.householdId };
    const cols = Object.keys(withScope);
    for (const col of cols) {
      if (!IDENTIFIER_RE.test(col)) {
        scopeBug("insert(): invalid column identifier", `table=${table} column=${col}`);
      }
    }
    const sql = `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols
      .map(() => "?")
      .join(", ")})`;
    await this.db
      .prepare(sql)
      .bind(...cols.map((c) => withScope[c] as never))
      .run();
  }

  /** Denies viewer (may read but not modify). */
  protected requireWrite(): void {
    if (this.ctx.role === "viewer") {
      throw new ForbiddenError("Viewers may not modify data");
    }
  }

  /**
   * Trip editors remain household viewers. A trip-scoped write may only use
   * a person already visible through one of that account's shared trips;
   * otherwise a guessed household person id could be pulled into the shared
   * trip and disclosed.
   */
  protected async requireVisiblePerson(personId: string): Promise<void> {
    if (!this.ctx.tripRole) return;
    const person = await this.get<{ id: string }>(
      `SELECT id FROM person
        WHERE {scope} AND id = ?2
          AND id IN (
            SELECT tp.person_id
              FROM trip_person tp
              JOIN trip_member tm ON tm.trip_id = tp.trip_id
             WHERE tm.user_id = ?3
            UNION
            SELECT bp.person_id
              FROM booking_person bp
              JOIN booking b ON b.id = bp.booking_id
              JOIN trip_member tm ON tm.trip_id = b.trip_id
             WHERE tm.user_id = ?3
          )`,
      personId,
      this.ctx.userId,
    );
    if (!person) throw new NotFoundError("Person not found in an accessible trip");
  }

  private requireReason(reason: string): void {
    if (typeof reason !== "string" || reason.trim() === "") {
      throw new TenantScopeError("unscoped access requires a non-empty, human-readable reason");
    }
  }

  /**
   * Escape hatch for SQL against tables that carry no household_id of their own
   * (pure join tables). Bypasses every guarantee above: no {scope}, no OR/UNION
   * guard, no identifier validation, no ?1 reservation. Every call site must
   * supply a reason so a bypass is greppable and self-documenting. Read-only.
   */
  protected async unscoped<T>(reason: string, sql: string, ...params: unknown[]): Promise<T[]> {
    this.requireReason(reason);
    const { results } = await this.db.prepare(sql).bind(...(params as never[])).all<T>();
    return results;
  }

  /** The mutation counterpart of unscoped(). Same rules apply. */
  protected async unscopedRun(reason: string, sql: string, ...params: unknown[]): Promise<void> {
    this.requireReason(reason);
    if (isWriteQuery(sql)) this.requireWrite();
    await this.db.prepare(sql).bind(...(params as never[])).run();
  }

  /**
   * unscopedRun() for several statements that must succeed or fail together.
   * D1 has no interactive transactions; `db.batch()` is its atomic unit —
   * the statements execute sequentially in one implicit transaction and a
   * failure rolls back the ones before it. Same rules as unscopedRun(): a
   * single human-readable reason covers the batch, and any write statement
   * in it requires a writing role.
   */
  protected async unscopedBatchRun(
    reason: string,
    statements: { sql: string; params: unknown[] }[],
  ): Promise<void> {
    this.requireReason(reason);
    if (statements.some((s) => isWriteQuery(s.sql))) this.requireWrite();
    if (statements.length === 0) return;
    await this.db.batch(statements.map((s) => this.db.prepare(s.sql).bind(...(s.params as never[]))));
  }

  /**
   * Guards reads of encrypted/sensitive fields the same way requireWrite()
   * guards mutations. A viewer may see masked output but must not unmask it.
   */
  protected requireReveal(): void {
    if (this.ctx.role === "viewer") {
      throw new ForbiddenError("Viewers may not reveal encrypted fields");
    }
  }
}

/**
 * True if sql, with comments stripped, begins (after whitespace) with a write
 * keyword. Stripping comments first closes the gap where a leading comment hid
 * the real keyword from a naive regex anchored at ^.
 */
function isWriteQuery(sql: string): boolean {
  return WRITE_KEYWORD_RE.test(scanSql(sql).stripped);
}

/**
 * How many rows a write actually touched, from D1's run metadata.
 *
 * `changes` is SQLite's own count of rows modified by the statement and is
 * what a compare-and-set needs. `rows_written` is D1's billing/accounting
 * figure — it counts index pages as well as rows, so it can exceed the row
 * count and must never stand in for an exact comparison. It is used only as
 * a coarse did-anything-happen fallback for a driver that omits `changes`,
 * which is strictly better than reading `undefined` as zero and declaring
 * every successful write a lost race.
 */
function changedRows(meta: D1Meta): number {
  const changes: unknown = meta.changes;
  if (typeof changes === "number") return changes;
  const rowsWritten: unknown = meta.rows_written;
  return typeof rowsWritten === "number" && rowsWritten > 0 ? 1 : 0;
}
