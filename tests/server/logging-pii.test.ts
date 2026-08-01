import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { env } from "cloudflare:test";
import { Keyring } from "../../src/server/crypto/envelope.js";
import { createApp } from "../../src/server/index.js";
import type { AppBindings } from "../../src/server/index.js";
import type { Identity } from "../../src/server/auth.js";
import { createLogger, scrub, log } from "../../src/server/logging.js";

/**
 * Issue #8, item 5: "no PII in logs", as an automated guard rather than a
 * convention.
 *
 * The threat this exists for is mundane and extremely likely: someone
 * debugging a reveal adds `{ value }` to the log line, it works, it ships, and
 * every passport number the household ever unmasks is now sitting in a log
 * aggregator with a different (usually longer, usually broader) retention and
 * access policy than the encrypted column it came from.
 *
 * Two layers are tested here:
 *  1. `scrub` -- the runtime guard in the logger itself, which redacts by
 *     FIELD NAME so the mistake above cannot take effect.
 *  2. End to end -- the real app is driven through the paths that HANDLE
 *     secrets (both reveal endpoints, the inbound-email detail view, a 500)
 *     with distinctive plaintexts, and every byte the app wrote to console is
 *     searched for them.
 */

const ring = new Keyring("server-v1", { "server-v1": crypto.getRandomValues(new Uint8Array(32)) });
const identity: Identity = {
  userId: "u1",
  email: "badger@example.com",
  householdId: "hh-a",
  role: "owner",
};
const testEnv = { DB: env.DB } as unknown as AppBindings;

// Distinctive enough that a substring match cannot be a false positive.
const PASSPORT = "PASSPORT-ZZ9X7Q41";
const KTN = "KTN-77QX3390";
const CONFIRMATION = "CONF-8XQ4ZZ71";
const RAW_EMAIL_MARKER = "RAWBODYMARKER-Q7X3";

let captured: string[] = [];
let app: ReturnType<typeof createApp>;

function captureConsole() {
  captured = [];
  const record = (...args: unknown[]) => {
    captured.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
  };
  for (const method of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, method).mockImplementation(record);
  }
}

const revealInit: RequestInit = {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: "{}",
};

function request(path: string, init?: RequestInit) {
  return app.request(path, init, testEnv);
}
function postJson(path: string, body: unknown) {
  return request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(async () => {
  await env.DB.exec("DELETE FROM household");
  await env.DB.prepare("INSERT INTO household (id, name, created_at) VALUES (?, ?, ?)")
    .bind("hh-a", "Badger", new Date().toISOString())
    .run();
  app = createApp({ verify: async () => identity, ring });
  captureConsole();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the logger redacts secrets by field name", () => {
  it("redacts the field names a reveal would be tempted to log", () => {
    const scrubbed = scrub({
      value: PASSPORT,
      confirmationNumber: CONFIRMATION,
      passportNumber: PASSPORT,
      ktn: KTN,
      raw: RAW_EMAIL_MARKER,
      textBody: RAW_EMAIL_MARKER,
      anthropicApiKey: "sk-ant-secret",
      subject: "Your flight to Lisbon",
      displayName: "Ava Badger",
      email: "ava@example.com",
    });
    expect(Object.values(scrubbed).every((v) => v === "[redacted]")).toBe(true);
    expect(JSON.stringify(scrubbed)).not.toContain(PASSPORT);
  });

  it("keeps identifiers, outcomes and durations -- the things logs are FOR", () => {
    expect(
      scrub({
        requestId: "r1",
        householdId: "hh-a",
        userId: "u1",
        bookingId: "b1",
        tripId: "t1",
        personId: "p1",
        // "email" is a sensitive word, but an id of an email is still an id.
        inboundEmailId: "ie-1",
        field: "passport_number",
        status: 200,
        outcome: "ok",
        durationMs: 12,
      }),
    ).toEqual({
      requestId: "r1",
      householdId: "hh-a",
      userId: "u1",
      bookingId: "b1",
      tripId: "t1",
      personId: "p1",
      inboundEmailId: "ie-1",
      field: "passport_number",
      status: 200,
      outcome: "ok",
      durationMs: 12,
    });
  });

  it("redacts nested fields too, so wrapping a secret in an object does not smuggle it", () => {
    const scrubbed = scrub({ context: { detail: { confirmation: CONFIRMATION } } });
    expect(JSON.stringify(scrubbed)).not.toContain(CONFIRMATION);
  });

  it("truncates an oversized value, so a raw message body cannot flood the stream", () => {
    const sink = vi.fn();
    createLogger({}, sink).info("x", { detail: "A".repeat(50_000) });
    const line = String(sink.mock.calls[0]?.[1]);
    expect(line).toContain("[truncated]");
    expect(line.length).toBeLessThan(2_000);
  });

  it("never throws, whatever it is handed", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const sink = vi.fn();
    expect(() => createLogger({}, sink).error("x", { circular })).not.toThrow();
    expect(sink).toHaveBeenCalled();
  });
});

describe("no secret reaches the log stream on the paths that handle them", () => {
  it("logs a document reveal by id and field name, never the document number", async () => {
    const person = (await (
      await postJson("/api/people", {
        displayName: "Ava",
        passportNumber: PASSPORT,
        knownTravelerNumber: KTN,
      })
    ).json()) as { id: string };

    const res = await request(`/api/people/${person.id}/reveal/passport_number`, revealInit);
    // The CALLER still gets the plaintext -- the guard is about the log stream,
    // not about breaking the feature.
    expect(await res.json()).toEqual({ value: PASSPORT });

    const stream = captured.join("\n");
    expect(stream).not.toContain(PASSPORT);
    expect(stream).not.toContain(KTN);
    // ...while the event itself IS logged, by identifier.
    expect(stream).toContain("document_reveal");
    expect(stream).toContain(person.id);
    expect(stream).toContain("passport_number");
  });

  it("logs a confirmation reveal by id, never the confirmation number", async () => {
    const trip = (await (await postJson("/api/trips", { title: "Guerneville" })).json()) as {
      id: string;
    };
    const booking = (await (
      await postJson(`/api/trips/${trip.id}/bookings`, {
        kind: "other",
        title: "Rehearsal dinner",
        confirmationNumber: CONFIRMATION,
        details: {},
      })
    ).json()) as { id: string };

    const res = await request(`/api/trips/${trip.id}/bookings/${booking.id}/reveal`, revealInit);
    expect(await res.json()).toEqual({ value: CONFIRMATION });

    const stream = captured.join("\n");
    expect(stream).not.toContain(CONFIRMATION);
    expect(stream).toContain("confirmation_reveal");
    expect(stream).toContain(booking.id);
    expect(stream).toContain(trip.id);
  });

  it("never logs a stored raw email body when its detail view is read", async () => {
    const now = new Date().toISOString();
    await env.DB.prepare(
      `INSERT INTO inbound_email (id, household_id, from_address, to_address, subject,
                                  message_id, raw, status, error, received_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'received', NULL, ?)`,
    )
      .bind(
        "ie-1",
        "hh-a",
        "airline@example.com",
        "trips@example.com",
        "Your itinerary",
        null,
        `Subject: Your itinerary\r\nContent-Type: text/plain\r\n\r\n${RAW_EMAIL_MARKER}\r\n`,
        now,
      )
      .run();

    const res = await request("/api/inbound-emails/ie-1");
    expect(res.status).toBe(200);
    // The body legitimately contains it; the log stream must not.
    expect(await res.text()).toContain(RAW_EMAIL_MARKER);
    expect(captured.join("\n")).not.toContain(RAW_EMAIL_MARKER);
  });

  it("does not leak a secret through the 500 path either", () => {
    // The one field a 500 logs verbatim is errorMessage. A repo would have to
    // put a secret into an error message for that to matter; assert the
    // scrubber still covers the shape a careless wrapper would produce.
    const sink = vi.fn();
    createLogger({}, sink).error("unhandled_error", {
      errorMessage: "insert failed",
      value: CONFIRMATION,
      raw: RAW_EMAIL_MARKER,
    });
    const line = String(sink.mock.calls[0]?.[1]);
    expect(line).toContain("insert failed");
    expect(line).not.toContain(CONFIRMATION);
    expect(line).not.toContain(RAW_EMAIL_MARKER);
  });

  it("guards the process-wide logger the same way, not just request-scoped ones", () => {
    log.error("tenant_scope_bug", { reason: "no scope token", value: PASSPORT });
    expect(captured.join("\n")).not.toContain(PASSPORT);
  });
});
