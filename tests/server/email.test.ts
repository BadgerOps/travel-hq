import { describe, it, expect, vi, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { createHash, createSign, generateKeyPairSync } from "node:crypto";
import worker from "../../src/server/worker.js";
import {
  cloudflareAuthentication,
  cloudflareAuthenticationDiagnostic,
  senderAuthenticated,
  MAX_RAW_BYTES,
} from "../../src/server/ingest.js";
import { verifyAlignedDkim } from "../../src/server/ingest/dkim.js";
import type { DnsTxtResolver } from "../../src/server/ingest/dkim.js";
import { HouseholdSettingsRepo } from "../../src/server/repos/household-settings.js";
import type { HouseholdContext } from "../../src/server/repos/base.js";
import {
  DELTA_BOOKINGS_90_DAYS,
  DELTA_ITINERARY_90_DAYS,
} from "../fixtures/delta-itinerary.js";

const ctxA: HouseholdContext = { householdId: "hh-a", userId: "u1", role: "owner" };
const ctxB: HouseholdContext = { householdId: "hh-b", userId: "u2", role: "owner" };

/** A trusted result record authored by Cloudflare's MX. */
const AUTH_PASS = "mx.cloudflare.net; dkim=pass; spf=pass smtp.mailfrom=example.com; dmarc=pass";
const AUTH_FAIL = "mx.cloudflare.net; spf=fail smtp.mailfrom=example.com; dmarc=fail";

const TEST_SELECTOR = "travel-hq-test";
const TEST_KEYS = generateKeyPairSync("rsa", { modulusLength: 1024 });
const TEST_PRIVATE_KEY = TEST_KEYS.privateKey.export({
  type: "pkcs8",
  format: "pem",
}).toString();
const TEST_PUBLIC_KEY = TEST_KEYS.publicKey.export({
  type: "spki",
  format: "der",
}).toString("base64");

const testDkimResolver: DnsTxtResolver = async (name) => {
  if (name !== `${TEST_SELECTOR}._domainkey.example.com`) {
    throw Object.assign(new Error("no test key"), { code: "ENOTFOUND" });
  }
  return [[`v=DKIM1; k=rsa; p=${TEST_PUBLIC_KEY}`]];
};

async function signedMessage(
  {
    from = "Badger <badger@example.com>",
    signingDomain = "example.com",
    body = "Confirmation body",
    maxBodyLength,
    extraHeaders = "",
  }: {
    from?: string;
    signingDomain?: string;
    body?: string;
    maxBodyLength?: number;
    extraHeaders?: string;
  } = {},
): Promise<string> {
  const lines = [
    `From: ${from}`,
    "To: trips@badgerops.foo",
    "Subject: Trip",
    extraHeaders,
    "",
    body,
  ].filter((line, index) => line !== "" || index >= 4);
  const unsigned = lines.join("\r\n");
  const canonicalBody = body
    .replace(/[ \t]+/g, " ")
    .replace(/[ \t]+$/gm, "")
    .replace(/(?:\r\n)*$/, "\r\n");
  const bodyHash = createHash("sha256").update(canonicalBody).digest("base64");
  const lengthTag = maxBodyLength === undefined ? "" : `l=${maxBodyLength}; `;
  const tags =
    `v=1; a=rsa-sha256; c=relaxed/relaxed; d=${signingDomain}; ` +
    `s=${TEST_SELECTOR}; h=from:to:subject; ${lengthTag}bh=${bodyHash}; b=`;
  const relaxed = (value: string) => value.replace(/[ \t]+/g, " ").trim();
  const signingInput =
    `from:${relaxed(from)}\r\n` +
    "to:trips@badgerops.foo\r\n" +
    "subject:Trip\r\n" +
    `dkim-signature:${tags}`;
  const signature = createSign("RSA-SHA256")
    .update(signingInput)
    .sign(TEST_PRIVATE_KEY, "base64");
  return `DKIM-Signature: ${tags}${signature}\r\n${unsigned}`;
}

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

  it("extracts all three shifted Delta flights from a mocked authenticated email", async () => {
    const ai = {
      run: vi.fn(async (_model: string, input: {
        messages: Array<{ role: string; content: string }>;
      }) => {
        const prompt = input.messages.at(-1)?.content ?? "";
        expect(prompt).toContain("TRIP90");
        expect(prompt).toContain("10/21/2026");
        expect(prompt).toContain("DL 9674");
        return {
          choices: [{
            message: {
              content: `Extraction result:\n${JSON.stringify({ bookings: DELTA_BOOKINGS_90_DAYS })}`,
            },
          }],
        };
      }),
    };
    const rawText = [
      "From: Delta Air Lines <receipts@delta.example>",
      "To: badger@example.com",
      "Subject: Fwd: Delta.com Trip Information",
      "Content-Type: text/plain; charset=utf-8",
      "",
      DELTA_ITINERARY_90_DAYS,
    ].join("\r\n");

    await worker.email(
      fakeMessage({
        headers: {
          "Authentication-Results": AUTH_PASS,
          Subject: "Fwd: Delta.com Trip Information",
        },
        rawText,
      }),
      { DB: env.DB, AI: ai },
      {} as ExecutionContext,
    );

    expect(ai.run).toHaveBeenCalledTimes(1);
    expect((await storedRows()).map((row) => row.status)).toEqual(["extracted"]);
    const { results } = await env.DB.prepare(
      `SELECT ordinal, title, starts_at, starts_at_tz, ends_at, ends_at_tz,
              confirmation_number, source
         FROM draft_booking ORDER BY ordinal`,
    ).all();
    expect(results).toMatchObject(DELTA_BOOKINGS_90_DAYS.map((booking, ordinal) => ({
      ordinal,
      title: booking.title,
      starts_at: booking.startsAt,
      starts_at_tz: booking.startsAtTz,
      ends_at: booking.endsAt,
      ends_at_tz: booking.endsAtTz,
      confirmation_number: "TRIP90",
      source: "ai",
    })));
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
      [
        "rejected",
        "Cloudflare authentication verdict unavailable; outer From must be one address matching the envelope sender",
      ],
    ]);
  });

  it("accepts independently verified aligned DKIM when Cloudflare omits its verdict", async () => {
    const rawText = await signedMessage();
    await worker.email(
      fakeMessage({ rawText }),
      { DB: env.DB, dkimResolver: testDkimResolver },
      {} as ExecutionContext,
    );
    const rows = await storedRows();
    expect(rows.map((row) => [row.status, row.error])).toEqual([["received", null]]);
    expect(rows[0]!.raw).toBe(rawText);
  });

  it("accepts a valid aligned signature after an earlier malformed signature", async () => {
    const valid = await signedMessage();
    const rawText =
      "DKIM-Signature: v=1; v=1; a=rsa-sha256; d=broken.example; s=bad\r\n" +
      valid;
    await worker.email(
      fakeMessage({ rawText }),
      { DB: env.DB, dkimResolver: testDkimResolver },
      {} as ExecutionContext,
    );
    expect((await storedRows()).map((row) => row.status)).toEqual(["received"]);
  });

  it("rejects a spoof whose outer From does not match the exact allowlisted envelope sender", async () => {
    const rawText = await signedMessage({ from: "Mallory <mallory@example.com>" });
    await worker.email(
      fakeMessage({ rawText }),
      { DB: env.DB, dkimResolver: testDkimResolver },
      {} as ExecutionContext,
    );
    expect((await storedRows()).map((row) => [row.status, row.raw, row.error])).toEqual([
      [
        "rejected",
        "",
        "Cloudflare authentication verdict unavailable; outer From must be one address matching the envelope sender",
      ],
    ]);
  });

  it("rejects a tampered body even when the sender claims match", async () => {
    const rawText = (await signedMessage()).replace("Confirmation body", "Forged booking");
    await worker.email(
      fakeMessage({ rawText }),
      { DB: env.DB, dkimResolver: testDkimResolver },
      {} as ExecutionContext,
    );
    expect((await storedRows()).map((row) => [row.status, row.raw])).toEqual([
      ["rejected", ""],
    ]);
  });

  it("rejects an unaligned DKIM signer", async () => {
    const rawText = await signedMessage({ signingDomain: "evil.example" });
    const resolver: DnsTxtResolver = async () => [
      [`v=DKIM1; k=rsa; p=${TEST_PUBLIC_KEY}`],
    ];
    await worker.email(
      fakeMessage({ rawText }),
      { DB: env.DB, dkimResolver: resolver },
      {} as ExecutionContext,
    );
    expect((await storedRows()).map((row) => row.status)).toEqual(["rejected"]);
  });

  it("rejects multiple outer From mailboxes", async () => {
    const rawText = await signedMessage({
      extraHeaders: "From: Other <other@example.com>",
    });
    await worker.email(
      fakeMessage({ rawText }),
      { DB: env.DB, dkimResolver: testDkimResolver },
      {} as ExecutionContext,
    );
    expect((await storedRows()).map((row) => row.status)).toEqual(["rejected"]);
  });

  it("rejects body-length-limited DKIM signatures", async () => {
    const rawText = await signedMessage({ maxBodyLength: 5 });
    await worker.email(
      fakeMessage({ rawText }),
      { DB: env.DB, dkimResolver: testDkimResolver },
      {} as ExecutionContext,
    );
    expect((await storedRows()).map((row) => row.status)).toEqual(["rejected"]);
  });

  it("does not use DKIM fallback after an explicit trusted Cloudflare failure", async () => {
    const resolver = vi.fn(testDkimResolver);
    await worker.email(
      fakeMessage({
        headers: { "Authentication-Results": AUTH_FAIL },
        brokenRaw: true,
      }),
      { DB: env.DB, dkimResolver: resolver },
      {} as ExecutionContext,
    );
    expect((await storedRows()).map((row) => row.status)).toEqual(["rejected"]);
    expect(resolver).not.toHaveBeenCalled();
  });

  it("rejects missing verdicts for domain-only allowlist entries without reading raw", async () => {
    await worker.email(
      fakeMessage({
        from: "noreply@bounce.airline.com",
        brokenRaw: true,
      }),
      { DB: env.DB, dkimResolver: testDkimResolver },
      {} as ExecutionContext,
    );
    expect((await storedRows()).map((row) => [row.status, row.error])).toEqual([
      [
        "rejected",
        "Cloudflare authentication verdict unavailable; aligned DKIM fallback requires an exact-address allowlist entry",
      ],
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
      "sender is not on the household allowlist; Cloudflare authentication verdict unavailable",
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
    expect(cloudflareAuthentication(h())).toBe("unavailable");
  });

  it("requires every DMARC verdict to pass", () => {
    expect(senderAuthenticated(h("mx.cloudflare.net; dmarc=pass"))).toBe(true);
    expect(senderAuthenticated(h("mx.cloudflare.net; dmarc=fail"))).toBe(false);
    expect(cloudflareAuthentication(h("mx.cloudflare.net; dmarc=fail"))).toBe("fail");
    expect(
      senderAuthenticated(
        h("mx.cloudflare.net; dmarc=pass, mx.cloudflare.net; dmarc=fail"),
      ),
    ).toBe(false);
    expect(senderAuthenticated(h("mx.cloudflare.net; DMARC=PASS"))).toBe(true);
  });

  it("reports bounded, content-free authentication evidence for observability", () => {
    expect(
      cloudflareAuthenticationDiagnostic(
        h("mx.cloudflare.net; dmarc=pass; spf=pass, mx.cloudflare.net; dmarc=fail"),
      ),
    ).toEqual({
      verdict: "fail",
      trustedRecords: 2,
      dmarc: ["pass", "fail"],
      spf: ["pass"],
    });
  });

  it("falls back to SPF only when no DMARC verdict is present", () => {
    expect(senderAuthenticated(h("mx.cloudflare.net; spf=pass"))).toBe(true);
    expect(senderAuthenticated(h("mx.cloudflare.net; spf=softfail"))).toBe(false);
    // An explicit DMARC fail is not rescued by a passing SPF.
    expect(senderAuthenticated(h("mx.cloudflare.net; spf=pass; dmarc=fail"))).toBe(false);
  });

  it("does not mistake a DMARC policy property for an authentication verdict", () => {
    const headers = h(
      "mx.cloudflare.net; dmarc=pass header.from=badgerops.net policy.dmarc=quarantine; spf=pass smtp.mailfrom=badgerops.net",
    );
    expect(senderAuthenticated(headers)).toBe(true);
    expect(cloudflareAuthenticationDiagnostic(headers)).toEqual({
      verdict: "pass",
      trustedRecords: 1,
      dmarc: ["pass"],
      spf: ["pass"],
    });
  });

  it("treats a header with neither mechanism as unauthenticated", () => {
    expect(senderAuthenticated(h("mx.cloudflare.net; dkim=pass"))).toBe(false);
    expect(cloudflareAuthentication(h("mx.cloudflare.net; dkim=pass"))).toBe(
      "unavailable",
    );
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

describe("verifyAlignedDkim resource limits", () => {
  it("rejects excessive DKIM signatures before DNS resolution", async () => {
    const resolver = vi.fn(testDkimResolver);
    const headers = Array.from(
      { length: 11 },
      () => "DKIM-Signature: v=1; a=rsa-sha256; d=example.com; s=test; b=x; bh=x",
    ).join("\r\n");
    const verdict = await verifyAlignedDkim(
      `${headers}\r\nFrom: badger@example.com\r\n\r\nbody`,
      "badger@example.com",
      resolver,
    );
    expect(verdict).toEqual({
      ok: false,
      reason:
        "Cloudflare authentication verdict unavailable; message has more than 10 DKIM signatures",
    });
    expect(resolver).not.toHaveBeenCalled();
  });
});
