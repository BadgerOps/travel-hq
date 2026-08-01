/**
 * Structured logging for the Worker (issue #8).
 *
 * Cloudflare's Workers Logs / `wrangler tail` index whole JSON objects, so one
 * line per event -- not a formatted sentence -- is what makes a production
 * failure searchable after the fact. Everything here exists to make that line
 * (a) always present, (b) correlatable, and (c) safe to keep.
 *
 * The contract every emitted line satisfies:
 *   {"level","event","time", ...fields}
 * `event` is a stable snake_case name (`request`, `unhandled_error`,
 * `document_reveal`, ...) so a query can pin one kind of line without matching
 * prose that later gets reworded.
 *
 * Correlation is by `requestId`: the request middleware in index.ts mints one
 * per request, binds it into a child logger that every downstream log line
 * inherits, AND returns it on the response as `X-Request-Id`. A user reporting
 * "it failed at 14:02" can be answered from the header alone.
 *
 * SAFETY (issue #8, "no PII in logs"): fields are scrubbed on the way out --
 * see `scrub`. This is a real runtime guard, not a convention, because the
 * failure mode it prevents (someone adding `{ value }` to a reveal log line
 * while debugging) is a one-word edit that no review reliably catches. The
 * end-to-end assertion that secrets never reach a sink lives in
 * tests/server/logging-pii.test.ts.
 */

export type LogLevel = "info" | "warn" | "error";

/** A flat-ish bag of context. Scrubbed before it is serialized. */
export type LogFields = Record<string, unknown>;

/** Where a serialized line goes. Injectable so tests can capture without spying on console. */
export type LogSink = (level: LogLevel, line: string) => void;

export type Logger = {
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
  /** A logger that prepends `bound` to every line -- the per-request logger. */
  child(bound: LogFields): Logger;
};

/**
 * Name tokens that mean "this field's VALUE is a secret or a person's data".
 * Matched against the field name split into words, so `confirmationNumber`,
 * `confirmation_number` and `confirmation` are all caught by one entry.
 *
 * Deliberately broad on the side of over-redaction: a redacted field costs an
 * hour of debugging, a leaked passport number costs considerably more. The
 * escape hatch is the `*Id` rule below -- log the identifier of a thing, never
 * the thing.
 */
const SENSITIVE_TOKENS = new Set([
  "raw",
  "body",
  "value",
  "plaintext",
  "secret",
  "password",
  "passphrase",
  "token",
  "cookie",
  "authorization",
  "auth",
  "key",
  "apikey",
  "passport",
  "ktn",
  "redress",
  "confirmation",
  "dob",
  "email",
  "address",
  "phone",
  "name",
  "subject",
  "note",
  "notes",
  "title",
]);

/**
 * Longest string a single field may contribute. A raw RFC 5322 message or a
 * model prompt smuggled through an innocuous key (`{ detail: email.raw }`)
 * would otherwise dump an entire inbox into the log stream. Comfortably above
 * every legitimate value we log -- the longest is the offending SQL from a
 * tenancy-scope bug, which is a few hundred characters.
 */
const MAX_STRING = 1_000;

/** Depth past which a nested object is summarized rather than walked. */
const MAX_DEPTH = 4;

const REDACTED = "[redacted]";

/**
 * Splits a field name into lowercase words across camelCase, snake_case and
 * kebab-case, so one token list serves every spelling convention in the
 * codebase.
 */
function tokenize(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+|\s+/)
    .filter(Boolean)
    .map((word) => word.toLowerCase());
}

/**
 * True if the field name promises an OPAQUE IDENTIFIER rather than content.
 * `inboundEmailId` and `personId` are ids we very much want in the logs even
 * though "email" and "person" are sensitive words; `subject` and `raw` are
 * not. The rule is the whole point of the logging policy in one line: log ids
 * and outcomes, not secrets.
 */
function isIdentifierField(tokens: string[]): boolean {
  const last = tokens[tokens.length - 1];
  return last === "id" || last === "ids";
}

function isSensitiveField(key: string): boolean {
  const tokens = tokenize(key);
  if (isIdentifierField(tokens)) return false;
  return tokens.some((token) => SENSITIVE_TOKENS.has(token));
}

/**
 * Returns a structurally-cloned, log-safe copy of `fields`: sensitive keys
 * replaced by a marker, long strings truncated, non-JSON values coerced.
 * Never throws -- a logger that can fail is a logger that takes a request
 * down with it.
 */
export function scrub(fields: LogFields, depth = 0): LogFields {
  const out: LogFields = {};
  for (const [key, raw] of Object.entries(fields)) {
    if (isSensitiveField(key)) {
      out[key] = REDACTED;
      continue;
    }
    out[key] = scrubValue(raw, depth);
  }
  return out;
}

function scrubValue(value: unknown, depth: number): unknown {
  if (value === null || value === undefined) return value ?? null;
  if (typeof value === "string") {
    return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…[truncated]` : value;
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (depth >= MAX_DEPTH) return "[deep]";
  if (Array.isArray(value)) return value.map((entry) => scrubValue(entry, depth + 1));
  if (typeof value === "object") return scrub(value as LogFields, depth + 1);
  // Functions, symbols: never intentional in a log line.
  return String(value);
}

const consoleSink: LogSink = (level, line) => {
  // Distinct console methods so Cloudflare's log stream keeps its own level
  // filter working; the level is also inside the JSON for anything grepping.
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.info(line);
};

export function createLogger(bound: LogFields = {}, sink: LogSink = consoleSink): Logger {
  function emit(level: LogLevel, event: string, fields: LogFields = {}): void {
    const record = {
      level,
      event,
      time: new Date().toISOString(),
      ...scrub(bound),
      ...scrub(fields),
    };
    let line: string;
    try {
      line = JSON.stringify(record);
    } catch {
      // A circular reference or an un-serializable value snuck past scrub().
      // Losing the fields is acceptable; losing the event is not.
      line = JSON.stringify({ level, event, time: record.time, note: "fields not serializable" });
    }
    sink(level, line);
  }

  return {
    info: (event, fields) => emit("info", event, fields),
    warn: (event, fields) => emit("warn", event, fields),
    error: (event, fields) => emit("error", event, fields),
    child: (extra) => createLogger({ ...bound, ...extra }, sink),
  };
}

/**
 * The process-wide logger, for code that runs below (or outside) a request and
 * therefore has no request-scoped child to inherit: `logScopeBug` in
 * repos/base.ts is the motivating caller. Request-scoped code should use
 * `c.get("logger")` instead so its lines carry the request id.
 */
export const log: Logger = createLogger();
