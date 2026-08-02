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

  /**
   * package.json's version is not decoration: vite.config.ts substitutes it
   * into the bundle as __APP_VERSION__, and Settings shows it so a bug report
   * can name the build it came from. That number is only useful if it agrees
   * with the release CHANGELOG.md describes — a build calling itself 0.9.0
   * while the changelog's newest release is 0.8.0 sends the reader to the
   * wrong list of changes.
   *
   * Cutting a release is therefore two edits, and this test fails until both
   * are made: bump `version`, and add the matching `## <version> — <date>`
   * heading above the previous one.
   */
  it("ships the version CHANGELOG.md says is newest", () => {
    const { version } = JSON.parse(
      readFileSync(join(REPO_ROOT, "package.json"), "utf8"),
    ) as { version: string };
    const changelog = readFileSync(join(REPO_ROOT, "CHANGELOG.md"), "utf8");

    expect(version).toMatch(/^\d+\.\d+\.\d+/);
    expect(newestReleaseInChangelog(changelog)).toBe(version);
  });
});

/**
 * The first `##` heading that names a version, reading top-down. Deliberately
 * tolerant, because the alternative — a regex tuned to today's exact heading —
 * would break on the next release for reasons that have nothing to do with
 * what this test is checking:
 *
 * - `## Unreleased` (and any other prose heading) is skipped rather than
 *   treated as a version, so entries can sit there between releases.
 * - A leading `v` is accepted, as is any suffix after the numbers: the date is
 *   separated by an em dash today and was a hyphen in older headings, and a
 *   prerelease tag (`0.2.0-rc.1`) would read as part of the version.
 * - Order in the file wins over numeric comparison, because "newest" is a
 *   question about release order and the file is already kept in it. Sorting
 *   the numbers instead would answer a subtly different question, and would
 *   have to be taught how prerelease tags rank to answer even that one.
 */
function newestReleaseInChangelog(markdown: string): string | null {
  for (const line of markdown.split("\n")) {
    const heading = /^##\s+v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\b/.exec(line.trim());
    if (heading) return heading[1] ?? null;
  }
  return null;
}
