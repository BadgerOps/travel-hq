import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

// tests/server/architecture.test.ts -> src/server
const SERVER_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "server");
const REPO_ROOT = join(SERVER_ROOT, "..", "..");

/**
 * An allowlist, not a denylist: a newly added directory under src/server/ is
 * banned from raw db.prepare(...) by default, not silently permitted.
 *
 * - repos/**: repositories ARE the tenancy layer. TenantRepo prepares scoped
 *   statements itself, and repo methods for join tables (e.g.
 *   TripRepo.addTraveler preparing a direct `INSERT OR IGNORE INTO
 *   trip_person`) legitimately do too, as will later repos for other join
 *   tables.
 * - auth.ts: the documented bootstrap exception. You cannot scope a query by
 *   household before you've resolved which household the request belongs to.
 * - db/**: reserved for a future migration/connection helper below the
 *   tenancy layer. Empty after the Cloudflare port (D1 migrations are
 *   wrangler-managed), which is fine — the allowlist prefix simply matches
 *   nothing.
 *
 * Everything else under src/server/ — routes above all — must go through a
 * repository.
 */
const ALLOWED_DIR_PREFIXES = [`repos${sep}`, `db${sep}`];
const ALLOWED_FILES = ["auth.ts"];

function isAllowed(relPath: string): boolean {
  if (ALLOWED_FILES.includes(relPath)) return true;
  return ALLOWED_DIR_PREFIXES.some((prefix) => relPath.startsWith(prefix));
}

/**
 * M11: a minimal, conservative TS/JS comment stripper so this test matches
 * against code, not prose. Without it, a raw-SQL call mentioned only in a
 * comment (e.g. this very file's own doc comments) would count as a
 * violation, and -- the actual bug -- a real direct-execution call was
 * never banned at all, only the `.prepare(` spelling.
 *
 * Deliberately narrow: handles `//` and block comments, and skips over
 * `'`, `"`, and backtick string/template literal contents (so a comment
 * delimiter embedded in a string, e.g. a URL containing `//`, isn't
 * mistaken for the start of a real comment). Not a full JS/TS tokenizer --
 * doesn't need to be, since it only has to keep this allowlist check honest
 * over this repository's own source.
 */
function stripComments(src: string): string {
  let out = "";
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === "/" && src[i + 1] === "/") {
      const end = src.indexOf("\n", i);
      i = end === -1 ? n : end;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*" + "/", i + 2);
      i = end === -1 ? n : end + 2;
      continue;
    }
    if (c === "'" || c === '"' || c === "`") {
      const quote = c;
      out += c;
      i++;
      while (i < n) {
        if (src[i] === "\\") {
          out += src[i] + (src[i + 1] ?? "");
          i += 2;
          continue;
        }
        out += src[i];
        if (src[i] === quote) {
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** The two raw-SQL entry points a route must never call directly. */
const BANNED_CALLS = [".prepare(", ".ex" + "ec("];

function collectTsFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...collectTsFiles(full));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      found.push(full);
    }
  }
  return found;
}

describe("architecture", () => {
  it("bans raw db.prepare(...)/db.exec(...) outside repos/, auth.ts, and db/", () => {
    const offenders = collectTsFiles(SERVER_ROOT)
      .filter((file) => !isAllowed(relative(SERVER_ROOT, file)))
      .filter((file) => {
        const stripped = stripComments(readFileSync(file, "utf8"));
        return BANNED_CALLS.some((needle) => stripped.includes(needle));
      });

    if (offenders.length > 0) {
      const names = offenders.map((file) => relative(SERVER_ROOT, file)).join(", ");
      throw new Error(
        `Raw db.prepare(...)/db.exec(...) found outside the repository layer in: ${names}. ` +
          `Domain access against a domain table must go through a repository ` +
          `bound to a household (see src/server/repos/base.ts) — it must not be ` +
          `prepared or executed directly in a route or any other module.`,
      );
    }

    expect(offenders).toEqual([]);
  });

  it("never caches authenticated API responses in the service worker", () => {
    const source = readFileSync(join(REPO_ROOT, "public", "sw.js"), "utf8");
    expect(source).toContain('url.pathname.startsWith("/api/")');
    expect(source).toContain('url.pathname.startsWith("/assets/")');
    expect(source).toContain("caches.delete");
  });
});
