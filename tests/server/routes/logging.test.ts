import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { MockInstance } from "vitest";
import { env } from "cloudflare:test";
import { Keyring } from "../../../src/server/crypto/envelope.js";
import { createApp } from "../../../src/server/index.js";
import type { AppBindings } from "../../../src/server/index.js";
import { AuthError } from "../../../src/server/auth.js";
import type { Identity } from "../../../src/server/auth.js";
import worker from "../../../src/server/worker.js";
import { HouseholdSettingsRepo } from "../../../src/server/repos/household-settings.js";
import type { HouseholdContext } from "../../../src/server/repos/base.js";

/**
 * Issue #8's observability contract, held to account:
 *
 * - every request emits exactly ONE structured JSON line (requestId, method,
 *   parameterized route, status, duration, householdId, outcome);
 * - a generic 500 to the client still logs the REAL error server-side;
 * - ingest emits one outcome line per inbound email;
 * - and the PII guard: NOTHING logged anywhere on these paths may contain a
 *   document number, a raw email body, or a full email address. Every
 *   console method is spied, so a stray console.error can't slip past.
 */

const ring = new Keyring("server-v1", { "server-v1": crypto.getRandomValues(new Uint8Array(32)) });
const identity: Identity = { userId: "u1", email: "badger@example.com", householdId: "hh-a", role: "owner" };
const testEnv = { DB: env.DB } as unknown as AppBindings;

// Known-sensitive fixture strings the log scan hunts for.
const PASSPORT = "C03X72119";
const OWNER_EMAIL = "badger@example.com";
const STRANGER_EMAIL = "mallory@evil.com";
const RAW_BODY_MARKER = "RAW-BODY-SECRET itinerary text";

function appAs(who: Identity | (() => Promise<never>)) {
  const verify = typeof who === "function" ? who : async () => who;
  return createApp({ verify: verify as (req: Request, e: AppBindings) => Promise<Identity>, ring });
}

let app: ReturnType<typeof createApp>;
let logs: string[];
let spies: MockInstance[];

function request(a: ReturnType<typeof createApp>, path: string, init?: RequestInit) {
  return a.request(path, init, testEnv);
}
function postJson(path: string, body: unknown) {
  return request(app, path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
function putJson(path: string, body: unknown) {
  return request(app, path, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function serialize(arg: unknown): string {
  if (typeof arg === "string") return arg;
  if (arg instanceof Error) return `${arg.name}: ${arg.message}\n${arg.stack ?? ""}`;
  try {
    return JSON.stringify(arg) ?? String(arg);
  } catch {
    return String(arg);
  }
}

type RequestLine = {
  event: string;
  requestId: string;
  method: string;
  route: string;
  status: number;
  durationMs: number;
  householdId?: string;
  outcome: string;
  error?: { name: string; message: string; stack?: string };
};

function linesFor(event: string): Record<string, unknown>[] {
  const parsed: Record<string, unknown>[] = [];
  for (const entry of logs) {
    try {
      const line = JSON.parse(entry) as Record<string, unknown>;
      if (line.event === event) parsed.push(line);
    } catch {
      // Not a JSON line (e.g. a legacy prefix log) — the PII sweep still
      // sees it via `logs`, it just isn't a structured line.
    }
  }
  return parsed;
}

const requestLines = () => linesFor("request") as unknown as RequestLine[];

/** Everything any console method received, one big haystack for the sweep. */
const allLogged = () => logs.join("\n");

beforeEach(async () => {
  await env.DB.exec("DELETE FROM reveal_audit");
  await env.DB.exec("DELETE FROM draft_booking");
  await env.DB.exec("DELETE FROM inbound_email");
  await env.DB.exec("DELETE FROM household_settings");
  await env.DB.exec("DELETE FROM person");
  await env.DB.exec("DELETE FROM household");
  const now = new Date().toISOString();
  await env.DB.prepare("INSERT INTO household (id,name,created_at) VALUES (?,?,?)").bind("hh-a", "A", now).run();
  app = appAs(identity);

  logs = [];
  const capture = (...args: unknown[]) => {
    logs.push(args.map(serialize).join(" "));
  };
  spies = (["log", "info", "warn", "error", "debug"] as const).map((method) =>
    vi.spyOn(console, method).mockImplementation(capture),
  );
});

afterEach(() => {
  for (const spy of spies) spy.mockRestore();
});

describe("structured request logging (issue #8)", () => {
  it("emits exactly one JSON line per request with id, route, status, duration, and household", async () => {
    const res = await request(app, "/api/people");
    expect(res.status).toBe(200);

    const lines = requestLines();
    expect(lines).toHaveLength(1);
    const line = lines[0]!;
    expect(line.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(line.method).toBe("GET");
    expect(line.route).toBe("/api/people");
    expect(line.status).toBe(200);
    expect(typeof line.durationMs).toBe("number");
    expect(line.householdId).toBe("hh-a");
    expect(line.outcome).toBe("ok");
    expect(line.error).toBeUndefined();
  });

  it("logs the parameterized route, never the raw path ids", async () => {
    const person = (await (
      await postJson("/api/people", { displayName: "Ava", passportNumber: PASSPORT })
    ).json()) as { id: string };
    logs = [];

    expect((await request(app, `/api/people/${person.id}/reveal/passport_number`)).status).toBe(200);

    const lines = requestLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]!.route).toBe("/api/people/:id/reveal/:field");
    expect(lines[0]!.route).not.toContain(person.id);
  });

  it("maps a thrown domain error to its class name without logging its message", async () => {
    const res = await request(app, "/api/people/does-not-exist/reveal/passport_number");
    expect(res.status).toBe(404);
    const lines = requestLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]!.status).toBe(404);
    expect(lines[0]!.outcome).toBe("NotFoundError");
    expect(lines[0]!.error).toBeUndefined();
  });

  it("logs an auth failure's class, not its message (which names the caller's email)", async () => {
    const unauthed = appAs(async () => {
      throw new AuthError(`No household membership for ${OWNER_EMAIL}`);
    });
    expect((await request(unauthed, "/api/people")).status).toBe(401);

    const lines = requestLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]!.status).toBe(401);
    expect(lines[0]!.outcome).toBe("AuthError");
    expect(lines[0]!.error).toBeUndefined();
    expect(lines[0]!.householdId).toBeUndefined();
    expect(allLogged()).not.toContain(OWNER_EMAIL);
  });

  it("keeps a 500 generic to the client while logging the real error and stack server-side", async () => {
    const rawError = new Error(
      "D1_ERROR: table trip_person has no column named household_id: SQLITE_ERROR",
    );
    const brokenStatement = {
      bind: () => brokenStatement,
      first: async () => {
        throw rawError;
      },
      all: async () => {
        throw rawError;
      },
      run: async () => {
        throw rawError;
      },
    };
    const brokenDb = { prepare: () => brokenStatement } as unknown as D1Database;
    const brokenEnv = { DB: brokenDb } as unknown as AppBindings;

    const res = await app.request("/api/people", undefined, brokenEnv);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Internal error" });

    const lines = requestLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]!.status).toBe(500);
    expect(lines[0]!.outcome).toBe("Error");
    expect(lines[0]!.error?.message).toContain("no column named household_id");
    expect(lines[0]!.error?.stack).toBeTruthy();
  });

  it("logs the document reveal with the user id, never the email", async () => {
    const person = (await (
      await postJson("/api/people", { displayName: "Ava", passportNumber: PASSPORT })
    ).json()) as { id: string };
    logs = [];

    expect((await request(app, `/api/people/${person.id}/reveal/passport_number`)).status).toBe(200);

    const reveals = linesFor("document_reveal");
    expect(reveals).toHaveLength(1);
    expect(reveals[0]).toMatchObject({
      userId: "u1",
      householdId: "hh-a",
      personId: person.id,
      field: "passport_number",
    });
    expect(typeof reveals[0]!.requestId).toBe("string");
    expect(allLogged()).not.toContain(OWNER_EMAIL);
    expect(allLogged()).not.toContain(PASSPORT);
  });
});

describe("structured ingest logging (issue #8)", () => {
  const ctxA: HouseholdContext = { householdId: "hh-a", userId: "u1", role: "owner" };
  const AUTH_PASS = "mx.cloudflare.net; dkim=pass; spf=pass smtp.mailfrom=example.com; dmarc=pass";

  function fakeMessage(init: {
    from?: string;
    to?: string;
    headers?: Record<string, string>;
    rawText?: string;
  } = {}): ForwardableEmailMessage {
    const rawText = init.rawText ?? `Subject: Trip\r\n\r\n${RAW_BODY_MARKER}`;
    return {
      from: init.from ?? OWNER_EMAIL,
      to: init.to ?? "trips@badgerops.foo",
      raw: new Response(rawText).body ?? new ReadableStream(),
      headers: new Headers(init.headers ?? {}),
      rawSize: rawText.length,
      setReject: () => {},
      async forward() {
        return { messageId: "test-forward" };
      },
      async reply() {
        return { messageId: "test-reply" };
      },
    } as unknown as ForwardableEmailMessage;
  }

  beforeEach(async () => {
    await new HouseholdSettingsRepo(env.DB, ctxA).updateSettings({
      forwardAddress: "trips@badgerops.foo",
      senderAllowlist: [OWNER_EMAIL],
    });
    logs = [];
  });

  it("logs one 'rejected' outcome line with the reason but no addresses or body", async () => {
    await worker.email(
      fakeMessage({ from: STRANGER_EMAIL, headers: { "Authentication-Results": AUTH_PASS } }),
      { DB: env.DB },
      {} as ExecutionContext,
    );

    const lines = linesFor("email_ingest");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      outcome: "rejected",
      householdId: "hh-a",
      reason: "sender is not on the household allowlist",
    });
    expect(typeof lines[0]!.emailId).toBe("string");
    expect(allLogged()).not.toContain(STRANGER_EMAIL);
    expect(allLogged()).not.toContain(RAW_BODY_MARKER);
  });

  it("logs one 'extracted' outcome line with draft count and source, never the message text", async () => {
    const aiRun = vi.fn(async () => ({
      response: {
        bookings: [
          {
            kind: "lodging",
            title: "Dawn Ranch Lodge",
            location: null,
            startsAt: null,
            startsAtTz: null,
            endsAt: null,
            endsAtTz: null,
            confirmationNumber: "D7WN88",
            costCents: null,
            details: { propertyName: "Dawn Ranch Lodge" },
          },
        ],
      },
    }));
    await worker.email(
      fakeMessage({ headers: { "Authentication-Results": AUTH_PASS } }),
      { DB: env.DB, AI: { run: aiRun } },
      {} as ExecutionContext,
    );

    const lines = linesFor("email_ingest");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ outcome: "extracted", householdId: "hh-a", source: "ai", drafts: 1 });
    expect(allLogged()).not.toContain(RAW_BODY_MARKER);
    expect(allLogged()).not.toContain(OWNER_EMAIL);
    // The extracted values stay out of the logs too.
    expect(allLogged()).not.toContain("D7WN88");
  });

  it("logs 'extraction_failed' with the stored reason when the model answers garbage", async () => {
    await worker.email(
      fakeMessage({ headers: { "Authentication-Results": AUTH_PASS } }),
      { DB: env.DB, AI: { run: async () => ({ response: "not json at all" }) } },
      {} as ExecutionContext,
    );

    const lines = linesFor("email_ingest");
    expect(lines).toHaveLength(1);
    expect(lines[0]!.outcome).toBe("extraction_failed");
    expect(String(lines[0]!.reason)).toContain("Extraction failed:");
    expect(allLogged()).not.toContain(RAW_BODY_MARKER);
    expect(allLogged()).not.toContain(OWNER_EMAIL);
  });

  it("logs 'unmatched_recipient' with no identifying detail at all", async () => {
    await worker.email(
      fakeMessage({ to: "stranger@badgerops.foo", headers: { "Authentication-Results": AUTH_PASS } }),
      { DB: env.DB },
      {} as ExecutionContext,
    );

    const lines = linesFor("email_ingest");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toEqual({
      event: "email_ingest",
      at: expect.any(String),
      outcome: "unmatched_recipient",
    });
    expect(allLogged()).not.toContain("stranger@badgerops.foo");
    expect(allLogged()).not.toContain(OWNER_EMAIL);
  });

  it("logs 'left_queued' when there is no AI binding and no calendar part", async () => {
    await worker.email(
      fakeMessage({ headers: { "Authentication-Results": AUTH_PASS } }),
      { DB: env.DB },
      {} as ExecutionContext,
    );

    const lines = linesFor("email_ingest");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ outcome: "left_queued", householdId: "hh-a" });
  });
});

describe("PII guard: the full log output of a realistic session (issue #8)", () => {
  it("never contains document numbers, email addresses, or raw message text", async () => {
    // People: create with a passport, update it, list, reveal — the paths a
    // document number could plausibly leak through.
    const person = (await (
      await postJson("/api/people", { displayName: "Ava", passportNumber: PASSPORT })
    ).json()) as { id: string };
    await putJson(`/api/people/${person.id}`, { passportNumber: PASSPORT });
    await request(app, "/api/people");
    await request(app, `/api/people/${person.id}/reveal/passport_number`);
    await request(app, "/api/audit/reveals");

    // Failures: a 401 whose error message carries an email, a 400, a 404.
    const unauthed = appAs(async () => {
      throw new AuthError(`No household membership for ${OWNER_EMAIL}`);
    });
    await request(unauthed, "/api/people");
    await postJson("/api/people", { dob: "2018-04-02" });
    await request(app, "/api/people/nope/reveal/passport_number");

    // Ingest: a verified mail whose body carries the passport number, and a
    // rejected stranger.
    const ctxA: HouseholdContext = { householdId: "hh-a", userId: "u1", role: "owner" };
    await new HouseholdSettingsRepo(env.DB, ctxA).updateSettings({
      forwardAddress: "trips@badgerops.foo",
      senderAllowlist: [OWNER_EMAIL],
    });
    const AUTH_PASS = "mx.cloudflare.net; spf=pass; dmarc=pass";
    const mail = (from: string, rawText: string) =>
      ({
        from,
        to: "trips@badgerops.foo",
        raw: new Response(rawText).body ?? new ReadableStream(),
        headers: new Headers({ "Authentication-Results": AUTH_PASS, Subject: "Trip" }),
        rawSize: rawText.length,
        setReject: () => {},
        async forward() {
          return { messageId: "m" };
        },
        async reply() {
          return { messageId: "r" };
        },
      }) as unknown as ForwardableEmailMessage;
    await worker.email(
      mail(OWNER_EMAIL, `Subject: Trip\r\n\r\n${RAW_BODY_MARKER} passport ${PASSPORT}`),
      { DB: env.DB, AI: { run: async () => ({ response: "garbage" }) } },
      {} as ExecutionContext,
    );
    await worker.email(mail(STRANGER_EMAIL, `Subject: Spam\r\n\r\n${RAW_BODY_MARKER}`), { DB: env.DB }, {} as ExecutionContext);

    const haystack = allLogged();
    expect(haystack).not.toBe("");
    expect(haystack).not.toContain(PASSPORT);
    expect(haystack).not.toContain(OWNER_EMAIL);
    expect(haystack).not.toContain(STRANGER_EMAIL);
    expect(haystack).not.toContain(RAW_BODY_MARKER);
  });
});
