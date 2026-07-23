import { describe, it, expect, vi, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import worker from "../../src/server/worker.js";
import { senderAuthenticated, MAX_RAW_BYTES } from "../../src/server/ingest.js";
import { HouseholdSettingsRepo } from "../../src/server/repos/household-settings.js";
import type { HouseholdContext } from "../../src/server/repos/base.js";

const ctxA: HouseholdContext = { householdId: "hh-a", userId: "u1", role: "owner" };
const ctxB: HouseholdContext = { householdId: "hh-b", userId: "u2", role: "owner" };

/** A trusted result record authored by Cloudflare's MX. */
const AUTH_PASS = "mx.cloudflare.net; dkim=pass; spf=pass smtp.mailfrom=example.com; dmarc=pass";
const AUTH_FAIL = "mx.cloudflare.net; spf=fail smtp.mailfrom=example.com; dmarc=fail";

type FakeMessageInit = {
  from?: string;
  to?: string;
  headers?: Record<string, string>;
  rawText?: string;
  /** Overrides rawText with a stream that errors mid-read. */
  brokenRaw?: boolean;
  forward?: (rcptTo: string) => Promise<void>;
  setReject?: (reason: string) => void;
};

// There is no real mail transport in the workers-pool test harness, so the
// handler's contract (what it stores, forwards, and never does — throw or
// setReject) is exercised directly with a fully-typed fake message.
function fakeMessage(init: FakeMessageInit = {}): ForwardableEmailMessage {
  const rawText = init.rawText ?? "Subject: Trip\r\n\r\nConfirmation body";
  const raw = init.brokenRaw
    ? new ReadableStream({
        start(controller) {
          controller.error(new Error("stream burped"));
        },
      })
    : (new Response(rawText).body ?? new ReadableStream());
  return {
    from: init.from ?? "badger@example.com",
    to: init.to ?? "trips@badgerops.foo",
    raw,
    headers: new Headers(init.headers ?? {}),
    rawSize: rawText.length,
    setReject: init.setReject ?? (() => {}),
    async forward(rcptTo: string) {
      await (init.forward ?? (async () => {}))(rcptTo);
      return { messageId: "test-message-id" };
    },
    async reply() {
      return { messageId: "test-reply-id" };
    },
  };
}

type StoredRow = {
  household_id: string;
  from_address: string;
  to_address: string;
  subject: string | null;
  message_id: string | null;
  raw: string;
  status: string;
  error: string | null;
};

async function storedRows(): Promise<StoredRow[]> {
  const { results } = await env.DB.prepare(
    "SELECT household_id, from_address, to_address, subject, message_id, raw, status, error FROM inbound_email ORDER BY received_at, id",
  ).all<StoredRow>();
  return results;
}

beforeEach(async () => {
  await env.DB.exec("DELETE FROM inbound_email");
  await env.DB.exec("DELETE FROM household_settings");
  await env.DB.exec("DELETE FROM household");
  const now = new Date().toISOString();
  await env.DB.prepare("INSERT INTO household (id,name,created_at) VALUES (?,?,?)").bind("hh-a", "A", now).run();
  await env.DB.prepare("INSERT INTO household (id,name,created_at) VALUES (?,?,?)").bind("hh-b", "B", now).run();
  await new HouseholdSettingsRepo(env.DB, ctxA).updateSettings({
    forwardAddress: "trips@badgerops.foo",
    senderAllowlist: ["badger@example.com", "airline.com"],
  });
  await new HouseholdSettingsRepo(env.DB, ctxB).updateSettings({
    forwardAddress: "trips-b@badgerops.foo",
    senderAllowlist: ["badger@example.com"],
  });
});

describe("email() ingest", () => {
  it("runs AI extraction inline after storing a verified plain message", async () => {
    const ai = {
      run: vi.fn(async () => ({
        response: {
          bookings: [{
            kind: "lodging",
            title: "Dawn Ranch",
            location: null,
            startsAt: null,
            startsAtTz: null,
            endsAt: null,
            endsAtTz: null,
            confirmationNumber: "ABC123",
            costCents: null,
            details: { propertyName: "Dawn Ranch" },
          }],
        },
      })),
    };

    await worker.email(
      fakeMessage({ headers: { "Authentication-Results": AUTH_PASS } }),
      { DB: env.DB, AI: ai },
      {} as ExecutionContext,
    );

    expect(ai.run).toHaveBeenCalledTimes(1);
    expect((await storedRows()).map((row) => row.status)).toEqual(["extracted"]);
    const draft = await env.DB.prepare(
      "SELECT source, title, confirmation_number FROM draft_booking",
    ).first<{ source: string; title: string; confirmation_number: string }>();
    expect(draft).toEqual({ source: "ai", title: "Dawn Ranch", confirmation_number: "ABC123" });
  });

  it("stores a verified message as a received row scoped to the right household", async () => {
    const forward = vi.fn(async () => {});
    const setReject = vi.fn();
    const rawText = "Subject: Flight ABC123\r\n\r\nYour flight is booked.";

    await expect(
      worker.email(
        fakeMessage({
          headers: {
            "Authentication-Results": AUTH_PASS,
            Subject: "Flight ABC123",
            "Message-ID": "<abc@airline.com>",
          },
          rawText,
          forward,
          setReject,
        }),
        { DB: env.DB, FALLBACK_FORWARD_TO: "owner@example.com" },
        {} as ExecutionContext,
      ),
    ).resolves.toBeUndefined();

    const rows = await storedRows();
    expect(rows).toEqual([
      {
        household_id: "hh-a",
        from_address: "badger@example.com",
        to_address: "trips@badgerops.foo",
        subject: "Flight ABC123",
        message_id: "<abc@airline.com>",
        raw: rawText,
        status: "received",
        error: null,
      },
    ]);
    // A stored message is not also forwarded, and the sender is never bounced.
    expect(forward).not.toHaveBeenCalled();
    expect(setReject).not.toHaveBeenCalled();
  });

  it("resolves the household from the recipient case-insensitively", async () => {
    await worker.email(
      fakeMessage({ to: "Trips@BadgerOps.FOO", headers: { "Authentication-Results": AUTH_PASS } }),
      { DB: env.DB },
      {} as ExecutionContext,
    );
    const rows = await storedRows();
    expect(rows.map((r) => [r.household_id, r.status])).toEqual([["hh-a", "received"]]);
  });

  it("accepts a subdomain sender via a bare-domain allowlist entry", async () => {
    await worker.email(
      fakeMessage({ from: "noreply@bounce.airline.com", headers: { "Authentication-Results": AUTH_PASS } }),
      { DB: env.DB },
      {} as ExecutionContext,
    );
    const rows = await storedRows();
    expect(rows.map((r) => r.status)).toEqual(["received"]);
  });

  it("drops an unknown recipient without writing, forwarding to the fallback when set", async () => {
    const forward = vi.fn(async () => {});
    await worker.email(
      fakeMessage({
        to: "stranger@badgerops.foo",
        headers: { "Authentication-Results": AUTH_PASS },
        forward,
      }),
      { DB: env.DB, FALLBACK_FORWARD_TO: "owner@example.com" },
      {} as ExecutionContext,
    );
    expect(await storedRows()).toEqual([]);
    expect(forward).toHaveBeenCalledTimes(1);
    expect(forward).toHaveBeenCalledWith("owner@example.com");
  });

  it("drops an unknown recipient silently when no fallback is configured", async () => {
    const forward = vi.fn(async () => {});
    await expect(
      worker.email(
        fakeMessage({ to: "stranger@badgerops.foo", forward }),
        { DB: env.DB },
        {} as ExecutionContext,
      ),
    ).resolves.toBeUndefined();
    expect(await storedRows()).toEqual([]);
    expect(forward).not.toHaveBeenCalled();
  });

  it("rejects an allowlisted sender whose DMARC/SPF failed (forged sender)", async () => {
    const forward = vi.fn(async () => {});
    await worker.email(
      fakeMessage({ headers: { "Authentication-Results": AUTH_FAIL }, forward }),
      { DB: env.DB, FALLBACK_FORWARD_TO: "owner@example.com" },
      {} as ExecutionContext,
    );
    const rows = await storedRows();
    expect(rows.map((r) => [r.household_id, r.status])).toEqual([["hh-a", "rejected"]]);
    expect(rows[0]!.error).toBe("sender did not pass DMARC/SPF authentication");
    // Metadata is enough for the audit trail. Persisting an attacker's body
    // makes a public forward address an unbounded D1 storage-amplification
    // endpoint.
    expect(rows[0]!.raw).toBe("");
    expect(forward).toHaveBeenCalledWith("owner@example.com");
  });

  it("rejects before touching an untrusted raw stream", async () => {
    await worker.email(
      fakeMessage({
        headers: { "Authentication-Results": AUTH_FAIL },
        brokenRaw: true,
      }),
      { DB: env.DB },
      {} as ExecutionContext,
    );
    const rows = await storedRows();
    expect(rows.map((r) => [r.status, r.raw])).toEqual([["rejected", ""]]);
  });

  it("rejects a message with no Authentication-Results header at all (fail-safe)", async () => {
    await worker.email(fakeMessage(), { DB: env.DB }, {} as ExecutionContext);
    const rows = await storedRows();
    expect(rows.map((r) => [r.status, r.error])).toEqual([
      ["rejected", "sender did not pass DMARC/SPF authentication"],
    ]);
  });

  it("ignores a planted pass from an untrusted authentication authority", async () => {
    await worker.email(
      fakeMessage({
        headers: {
          "Authentication-Results": "forger.example; dmarc=pass",
        },
      }),
      { DB: env.DB },
      {} as ExecutionContext,
    );
    expect((await storedRows()).map((r) => r.status)).toEqual(["rejected"]);
  });

  it("is not fooled by a planted pass alongside a genuine Cloudflare failure", async () => {
    await worker.email(
      fakeMessage({
        headers: {
          "Authentication-Results": "forger.example; dmarc=pass, mx.cloudflare.net; dmarc=fail",
        },
      }),
      { DB: env.DB },
      {} as ExecutionContext,
    );
    expect((await storedRows()).map((r) => r.status)).toEqual(["rejected"]);
  });

  it("accepts Cloudflare's documented ARC-Authentication-Results record", async () => {
    await worker.email(
      fakeMessage({
        headers: {
          "ARC-Authentication-Results": `i=1; ${AUTH_PASS}`,
        },
      }),
      { DB: env.DB },
      {} as ExecutionContext,
    );
    expect((await storedRows()).map((r) => r.status)).toEqual(["received"]);
  });

  it("rejects an authenticated sender that is not on the allowlist", async () => {
    await worker.email(
      fakeMessage({ from: "mallory@evil.com", headers: { "Authentication-Results": AUTH_PASS } }),
      { DB: env.DB },
      {} as ExecutionContext,
    );
    const rows = await storedRows();
    expect(rows.map((r) => [r.household_id, r.status])).toEqual([["hh-a", "rejected"]]);
    expect(rows[0]!.error).toBe("sender is not on the household allowlist");
  });

  it("names both failed legs when neither allowlist nor authentication passes", async () => {
    await worker.email(
      fakeMessage({ from: "mallory@evil.com" }),
      { DB: env.DB },
      {} as ExecutionContext,
    );
    expect((await storedRows())[0]!.error).toBe(
      "sender is not on the household allowlist; sender did not pass DMARC/SPF authentication",
    );
  });

  it("does not match a bare-domain entry against a lookalike suffix domain", async () => {
    await worker.email(
      fakeMessage({ from: "x@evilairline.com", headers: { "Authentication-Results": AUTH_PASS } }),
      { DB: env.DB },
      {} as ExecutionContext,
    );
    expect((await storedRows()).map((r) => r.status)).toEqual(["rejected"]);
  });

  it("scopes the row to the household whose forward address matched, not any other", async () => {
    await worker.email(
      fakeMessage({ to: "trips-b@badgerops.foo", headers: { "Authentication-Results": AUTH_PASS } }),
      { DB: env.DB },
      {} as ExecutionContext,
    );
    expect((await storedRows()).map((r) => [r.household_id, r.status])).toEqual([
      ["hh-b", "received"],
    ]);
  });

  it("stores a failed row and forwards to the fallback when the raw stream cannot be read", async () => {
    const forward = vi.fn(async () => {});
    const setReject = vi.fn();
    await expect(
      worker.email(
        fakeMessage({
          headers: { "Authentication-Results": AUTH_PASS, Subject: "Broken" },
          brokenRaw: true,
          forward,
          setReject,
        }),
        { DB: env.DB, FALLBACK_FORWARD_TO: "owner@example.com" },
        {} as ExecutionContext,
      ),
    ).resolves.toBeUndefined();

    const rows = await storedRows();
    expect(rows.map((r) => [r.household_id, r.status, r.subject, r.raw])).toEqual([
      ["hh-a", "failed", "Broken", ""],
    ]);
    expect(rows[0]!.error).toBe("Ingest failed: stream burped");
    expect(forward).toHaveBeenCalledWith("owner@example.com");
    expect(setReject).not.toHaveBeenCalled();
  });

  it("never throws and never bounces, even when D1 itself is down", async () => {
    const setReject = vi.fn();
    const forward = vi.fn(async () => {});
    const brokenDb = new Proxy(env.DB, {
      get() {
        throw new Error("D1 is down");
      },
    });
    await expect(
      worker.email(
        fakeMessage({ forward, setReject }),
        { DB: brokenDb, FALLBACK_FORWARD_TO: "owner@example.com" },
        {} as ExecutionContext,
      ),
    ).resolves.toBeUndefined();
    expect(setReject).not.toHaveBeenCalled();
    expect(forward).toHaveBeenCalledWith("owner@example.com");
  });

  it("survives a failing fallback forward without throwing", async () => {
    const forward = vi.fn(async () => {
      throw new Error("destination not verified");
    });
    await expect(
      worker.email(
        fakeMessage({ to: "stranger@badgerops.foo", forward }),
        { DB: env.DB, FALLBACK_FORWARD_TO: "owner@example.com" },
        {} as ExecutionContext,
      ),
    ).resolves.toBeUndefined();
    expect(await storedRows()).toEqual([]);
  });

  it("truncates an oversized raw message before storing it", async () => {
    const rawText = "x".repeat(MAX_RAW_BYTES + 100);
    await worker.email(
      fakeMessage({ headers: { "Authentication-Results": AUTH_PASS }, rawText }),
      { DB: env.DB },
      {} as ExecutionContext,
    );
    const rows = await storedRows();
    expect(rows.map((r) => r.status)).toEqual(["received"]);
    expect(rows[0]!.raw.length).toBeLessThan(rawText.length);
    expect(rows[0]!.raw).toContain("[truncated by travel-hq ingest]");
  });
});

describe("senderAuthenticated (trusted authentication-result parsing)", () => {
  const h = (value?: string, name = "Authentication-Results") =>
    new Headers(value === undefined ? {} : { [name]: value });

  it("treats a missing header as unauthenticated", () => {
    expect(senderAuthenticated(h())).toBe(false);
  });

  it("requires every DMARC verdict to pass", () => {
    expect(senderAuthenticated(h("mx.cloudflare.net; dmarc=pass"))).toBe(true);
    expect(senderAuthenticated(h("mx.cloudflare.net; dmarc=fail"))).toBe(false);
    expect(
      senderAuthenticated(
        h("mx.cloudflare.net; dmarc=pass, mx.cloudflare.net; dmarc=fail"),
      ),
    ).toBe(false);
    expect(senderAuthenticated(h("mx.cloudflare.net; DMARC=PASS"))).toBe(true);
  });

  it("falls back to SPF only when no DMARC verdict is present", () => {
    expect(senderAuthenticated(h("mx.cloudflare.net; spf=pass"))).toBe(true);
    expect(senderAuthenticated(h("mx.cloudflare.net; spf=softfail"))).toBe(false);
    // An explicit DMARC fail is not rescued by a passing SPF.
    expect(senderAuthenticated(h("mx.cloudflare.net; spf=pass; dmarc=fail"))).toBe(false);
  });

  it("treats a header with neither mechanism as unauthenticated", () => {
    expect(senderAuthenticated(h("mx.cloudflare.net; dkim=pass"))).toBe(false);
  });

  it("accepts Cloudflare's ARC form and rejects another ARC authority", () => {
    expect(
      senderAuthenticated(
        h("i=1; mx.cloudflare.net; dmarc=pass", "ARC-Authentication-Results"),
      ),
    ).toBe(true);
    expect(
      senderAuthenticated(
        h("i=1; mx.google.com; dmarc=pass", "ARC-Authentication-Results"),
      ),
    ).toBe(false);
  });

  it("does not let a forged DMARC pass hide a trusted SPF failure", () => {
    expect(
      senderAuthenticated(
        h("forger.example; dmarc=pass, mx.cloudflare.net; spf=fail"),
      ),
    ).toBe(false);
  });
});
