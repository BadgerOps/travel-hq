import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { env } from "cloudflare:test";
import { Keyring } from "../../src/server/crypto/envelope.js";
import { createApp } from "../../src/server/index.js";
import type { AppBindings } from "../../src/server/index.js";
import { AuthError } from "../../src/server/auth.js";
import type { Identity } from "../../src/server/auth.js";

/**
 * Issue #8, items 1-3: the Worker emits a structured, correlatable line for
 * every request; a 500 writes the real cause down server-side while the client
 * still gets nothing; and a tenancy-scope bug is logged in production too.
 *
 * These spy on the real `console` rather than injecting a sink, deliberately:
 * console IS the Cloudflare log stream, so asserting against it is what proves
 * the production path works, not just that the logger module can format JSON.
 */

const ring = new Keyring("server-v1", { "server-v1": crypto.getRandomValues(new Uint8Array(32)) });
const identity: Identity = {
  userId: "u1",
  email: "badger@example.com",
  householdId: "hh-a",
  role: "owner",
};
const testEnv = { DB: env.DB } as unknown as AppBindings;

type Line = Record<string, unknown>;

/** Every JSON line the app wrote at the given console level, parsed. */
function lines(spy: { mock: { calls: unknown[][] } }): Line[] {
  return spy.mock.calls
    .map((call) => call[0])
    .filter((arg): arg is string => typeof arg === "string")
    .flatMap((arg) => {
      try {
        return [JSON.parse(arg) as Line];
      } catch {
        // Not ours (workerd/miniflare chatter).
        return [];
      }
    });
}

function lineFor(spy: { mock: { calls: unknown[][] } }, event: string): Line | undefined {
  return lines(spy).find((line) => line.event === event);
}

let info: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;
let app: ReturnType<typeof createApp>;

function appAs(who: Identity | (() => Promise<never>)) {
  const verify = typeof who === "function" ? who : async () => who;
  return createApp({ verify: verify as (req: Request, e: AppBindings) => Promise<Identity>, ring });
}

function request(a: ReturnType<typeof createApp>, path: string, init?: RequestInit) {
  return a.request(path, init, testEnv);
}

beforeEach(async () => {
  await env.DB.exec("DELETE FROM household");
  await env.DB.prepare("INSERT INTO household (id, name, created_at) VALUES (?, ?, ?)")
    .bind("hh-a", "Badger", new Date().toISOString())
    .run();
  info = vi.spyOn(console, "info").mockImplementation(() => {});
  error = vi.spyOn(console, "error").mockImplementation(() => {});
  app = appAs(identity);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("structured request logging", () => {
  it("logs one JSON line per request carrying the request id, route, household and outcome", async () => {
    const res = await request(app, "/api/trips");
    expect(res.status).toBe(200);

    const line = lineFor(info, "request");
    expect(line).toBeDefined();
    expect(line).toMatchObject({
      level: "info",
      event: "request",
      method: "GET",
      route: "/api/trips",
      path: "/api/trips",
      status: 200,
      outcome: "ok",
      householdId: "hh-a",
      userId: "u1",
    });
    expect(typeof line!.requestId).toBe("string");
    expect(typeof line!.time).toBe("string");
    expect(typeof line!.durationMs).toBe("number");
  });

  it("returns the same request id on the response, so a reported failure is traceable", async () => {
    const res = await request(app, "/api/trips");
    const header = res.headers.get("X-Request-Id");
    expect(header).toBeTruthy();
    expect(lineFor(info, "request")?.requestId).toBe(header);
  });

  it("gives each request its own id and ignores a client-supplied one", async () => {
    const first = await request(app, "/api/trips");
    const second = await request(app, "/api/trips", {
      // A caller must not be able to choose, collide with, or forge the
      // correlation id of a request.
      headers: { "X-Request-Id": "forged-by-the-client" },
    });
    const a = first.headers.get("X-Request-Id");
    const b = second.headers.get("X-Request-Id");
    expect(a).not.toBe(b);
    expect(b).not.toBe("forged-by-the-client");
  });

  it("logs the route as its PATTERN, not the concrete ids, so lines aggregate", async () => {
    const trip = (await (
      await request(app, "/api/trips", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "Guerneville" }),
      })
    ).json()) as { id: string };
    info.mockClear();

    await request(app, `/api/trips/${trip.id}/bookings`);
    const line = lineFor(info, "request");
    expect(line?.route).toBe("/api/trips/:tripId/bookings");
    expect(line?.path).toBe(`/api/trips/${trip.id}/bookings`);
  });

  it("logs an unauthenticated request with no household, and records the 401", async () => {
    const unauthed = appAs(async () => {
      throw new AuthError("nope");
    });
    const res = await request(unauthed, "/api/trips");
    expect(res.status).toBe(401);
    expect(res.headers.get("X-Request-Id")).toBeTruthy();
    expect(lineFor(info, "request")).toMatchObject({
      status: 401,
      outcome: "rejected",
      householdId: null,
      userId: null,
    });
  });

  it("covers requests outside /api, including a path no route claims", async () => {
    const res = await request(app, "/healthz");
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Request-Id")).toBeTruthy();
    expect(lineFor(info, "request")).toMatchObject({ route: "/healthz", status: 200 });

    info.mockClear();
    await request(app, "/nothing-here");
    expect(lineFor(info, "request")).toMatchObject({ route: null, status: 404 });
  });
});

describe("500s are traceable server-side", () => {
  /**
   * The regression this guards: before issue #8 a production 500 answered
   * `{"error":"Internal error"}` and wrote NOTHING anywhere -- mapError drops
   * the cause and app.onError did not log it. The failure was, in the most
   * literal sense, untraceable.
   */
  it("logs the real cause of a 500 while the client still gets a generic body", async () => {
    const broken = new Error("D1_ERROR: no such column: booking.household_id");
    const failing = createApp({
      verify: async () => identity,
      ring,
    });
    // A raw failure from beneath the repo layer: not a RepoError, so it falls
    // through to mapError's generic 500 branch.
    const brokenEnv = {
      DB: {
        prepare() {
          throw broken;
        },
      },
    } as unknown as AppBindings;

    const res = await failing.request("/api/trips", undefined, brokenEnv);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Internal error" });

    const logged = lineFor(error, "unhandled_error");
    expect(logged).toMatchObject({
      level: "error",
      status: 500,
      route: "/api/trips",
      method: "GET",
      errorClass: "Error",
      errorMessage: broken.message,
    });
    expect(typeof logged!.stack).toBe("string");
    // ...and it is joined to the request line by the id the caller was given.
    expect(logged!.requestId).toBe(res.headers.get("X-Request-Id"));
  });

  it("records a 4xx as a rejection with its class, but not the message", async () => {
    const res = await request(app, "/api/trips/does-not-exist/bookings");
    expect(res.status).toBe(404);
    const logged = lineFor(info, "request_rejected");
    expect(logged).toMatchObject({ status: 404, errorClass: "NotFoundError" });
    expect(Object.keys(logged!)).not.toContain("errorMessage");
  });
});

describe("tenancy-scope bugs are logged unconditionally", () => {
  /**
   * Issue #8, item 3: logScopeBug used to be silent when NODE_ENV was
   * "production" -- silencing precisely the failure production most needs a
   * trace of, given the client only ever sees a generic 500.
   */
  it("logs the offending query even when NODE_ENV is production", async () => {
    const { TenantRepo } = await import("../../src/server/repos/base.js");
    class Unscoped extends TenantRepo {
      probe() {
        // No {scope} token: a repository-authoring bug, not a caller error.
        return this.all("SELECT id FROM trip WHERE title = ?2", "x");
      }
    }
    const before = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
      ?.env?.NODE_ENV;
    const processEnv = (globalThis as { process?: { env?: Record<string, string | undefined> } })
      .process?.env;
    if (processEnv) processEnv.NODE_ENV = "production";
    try {
      const repo = new Unscoped(env.DB, { householdId: "hh-a", userId: "u1", role: "owner" });
      await expect(repo.probe()).rejects.toThrow();
    } finally {
      if (processEnv) processEnv.NODE_ENV = before;
    }

    const logged = lineFor(error, "tenant_scope_bug");
    expect(logged).toBeDefined();
    expect(String(logged!.sql)).toContain("SELECT id FROM trip");
    expect(String(logged!.reason)).toContain("{scope}");
  });
});
