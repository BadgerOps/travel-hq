import { describe, it, expect } from "vitest";
import { classifyStatus, parseRetryAfter, sendPush } from "../../../src/server/push/send.js";
import type { WebPushSubscription } from "../../../src/server/push/send.js";
import { generateVapidKeys } from "../../../src/server/push/vapid.js";
import type { VapidConfig } from "../../../src/server/push/vapid.js";
import { MAX_PUSH_PLAINTEXT_BYTES } from "../../../src/server/push/encrypt.js";
import { createLogger } from "../../../src/server/logging.js";
import type { LogLevel } from "../../../src/server/logging.js";

const ENDPOINT_PATH = "/wpush/v2/the-secret-capability-token";
const ENDPOINT = `https://updates.push.services.mozilla.com${ENDPOINT_PATH}`;

const toB64url = (bytes: Uint8Array): string => {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

async function makeSubscription(): Promise<WebPushSubscription> {
  const pair = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
    "deriveBits",
  ])) as CryptoKeyPair;
  const raw = new Uint8Array(
    (await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer,
  );
  return {
    endpoint: ENDPOINT,
    keys: {
      p256dh: toB64url(raw),
      auth: toB64url(crypto.getRandomValues(new Uint8Array(16))),
    },
  };
}

async function makeVapid(): Promise<VapidConfig> {
  return { ...(await generateVapidKeys()), subject: "mailto:ops@example.com" };
}

type Captured = { url: string; init: RequestInit };

/** A fetch stand-in that records the request and answers with a fixed response. */
function stubFetch(
  response: Response | (() => never),
  captured: Captured[] = [],
): { fetchImpl: typeof fetch; captured: Captured[] } {
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    captured.push({ url: String(input), init: init ?? {} });
    if (typeof response === "function") response();
    return response;
  }) as unknown as typeof fetch;
  return { fetchImpl, captured };
}

/** Captures every log line the module emits, so we can assert on what leaks. */
function capturingLogger() {
  const lines: { level: LogLevel; line: string }[] = [];
  return { lines, logger: createLogger({}, (level, line) => lines.push({ level, line })) };
}

describe("classifyStatus", () => {
  it("treats every 2xx as sent", () => {
    for (const status of [200, 201, 202, 204]) expect(classifyStatus(status)).toBe("sent");
  });

  it("treats 404 and 410 as gone", () => {
    expect(classifyStatus(404)).toBe("gone");
    expect(classifyStatus(410)).toBe("gone");
  });

  it("treats 429, 408 and every 5xx as retryable", () => {
    for (const status of [408, 429, 500, 502, 503, 504]) {
      expect(classifyStatus(status)).toBe("retryable");
    }
  });

  it("treats other 4xx as permanent failures", () => {
    for (const status of [400, 401, 403, 413]) expect(classifyStatus(status)).toBe("failed");
  });
});

describe("parseRetryAfter", () => {
  const now = Date.UTC(2026, 0, 2, 12, 0, 0);

  it("parses delta-seconds", () => {
    expect(parseRetryAfter("120", now)).toBe(120);
    expect(parseRetryAfter("  0  ", now)).toBe(0);
  });

  it("parses an HTTP-date into seconds from now", () => {
    expect(parseRetryAfter(new Date(now + 90_000).toUTCString(), now)).toBe(90);
  });

  it("never returns a negative wait for a date in the past", () => {
    expect(parseRetryAfter(new Date(now - 90_000).toUTCString(), now)).toBe(0);
  });

  it("returns null for a missing or unparseable header", () => {
    expect(parseRetryAfter(null, now)).toBe(null);
    expect(parseRetryAfter("soon-ish", now)).toBe(null);
  });
});

describe("sendPush — the request it makes", () => {
  it("POSTs the aes128gcm body with the RFC 8030/8291 headers", async () => {
    const subscription = await makeSubscription();
    const { fetchImpl, captured } = stubFetch(new Response(null, { status: 201 }));

    const result = await sendPush({
      subscription,
      payload: { title: "Check in for UA 231" },
      vapid: await makeVapid(),
      fetchImpl,
    });

    expect(result).toEqual({ outcome: "sent", status: 201 });
    expect(captured).toHaveLength(1);
    const request = captured[0]!;
    expect(request.url).toBe(ENDPOINT);
    expect(request.init.method).toBe("POST");

    const headers = request.init.headers as Record<string, string>;
    expect(headers["Content-Encoding"]).toBe("aes128gcm");
    expect(headers["Content-Type"]).toBe("application/octet-stream");
    expect(headers.TTL).toBe("3600");
    expect(headers.Authorization!.startsWith("vapid t=")).toBe(true);
    expect(headers.Urgency).toBeUndefined();

    const body = request.init.body as Uint8Array;
    // salt(16) + rs(4) + idlen(1) + keyid(65) + at least one GCM tag.
    expect(body.length).toBeGreaterThan(86 + 16);
    expect(body[20]).toBe(65);
  });

  it("passes through TTL, Urgency and Topic when asked", async () => {
    const subscription = await makeSubscription();
    const { fetchImpl, captured } = stubFetch(new Response(null, { status: 201 }));

    await sendPush({
      subscription,
      payload: { title: "Boarding soon" },
      vapid: await makeVapid(),
      ttlSeconds: 60,
      urgency: "high",
      topic: "trip-abc-checkin",
      fetchImpl,
    });

    const headers = captured[0]!.init.headers as Record<string, string>;
    expect(headers.TTL).toBe("60");
    expect(headers.Urgency).toBe("high");
    expect(headers.Topic).toBe("trip-abc-checkin");
  });

  it("refuses a topic that is not RFC 8030 shaped", async () => {
    const subscription = await makeSubscription();
    const { fetchImpl, captured } = stubFetch(new Response(null, { status: 201 }));
    const result = await sendPush({
      subscription,
      payload: { title: "x" },
      vapid: await makeVapid(),
      topic: "not a valid topic",
      fetchImpl,
    });
    expect(result).toMatchObject({ outcome: "invalid", code: "invalid_payload" });
    expect(captured).toHaveLength(0);
  });

  it("sends a pre-rendered string payload unchanged", async () => {
    const subscription = await makeSubscription();
    const { fetchImpl, captured } = stubFetch(new Response(null, { status: 201 }));
    const result = await sendPush({
      subscription,
      payload: '{"title":"raw"}',
      vapid: await makeVapid(),
      fetchImpl,
    });
    expect(result.outcome).toBe("sent");
    expect(captured).toHaveLength(1);
  });
});

describe("sendPush — outcome mapping", () => {
  const cases: { status: number; outcome: string }[] = [
    { status: 200, outcome: "sent" },
    { status: 201, outcome: "sent" },
    { status: 202, outcome: "sent" },
    { status: 404, outcome: "gone" },
    { status: 410, outcome: "gone" },
    { status: 429, outcome: "retryable" },
    { status: 500, outcome: "retryable" },
    { status: 502, outcome: "retryable" },
    { status: 503, outcome: "retryable" },
    { status: 400, outcome: "failed" },
    { status: 403, outcome: "failed" },
    { status: 413, outcome: "failed" },
  ];

  for (const { status, outcome } of cases) {
    it(`maps ${status} to "${outcome}"`, async () => {
      const subscription = await makeSubscription();
      const { fetchImpl } = stubFetch(new Response("detail", { status }));
      const result = await sendPush({
        subscription,
        payload: { title: "t" },
        vapid: await makeVapid(),
        fetchImpl,
      });
      expect(result.outcome).toBe(outcome);
      expect(result).toMatchObject({ status });
    });
  }

  it("surfaces Retry-After on a 429 so a sweep can back off correctly", async () => {
    const subscription = await makeSubscription();
    const { fetchImpl } = stubFetch(
      new Response("slow down", { status: 429, headers: { "Retry-After": "300" } }),
    );
    const result = await sendPush({
      subscription,
      payload: { title: "t" },
      vapid: await makeVapid(),
      fetchImpl,
    });
    expect(result).toMatchObject({ outcome: "retryable", status: 429, retryAfterSeconds: 300 });
  });

  it("treats a transport failure as retryable with no status", async () => {
    const subscription = await makeSubscription();
    const { fetchImpl } = stubFetch(() => {
      throw new TypeError("network connection lost");
    });
    const result = await sendPush({
      subscription,
      payload: { title: "t" },
      vapid: await makeVapid(),
      fetchImpl,
    });
    expect(result).toMatchObject({ outcome: "retryable", status: null, retryAfterSeconds: null });
  });

  it("never throws, whatever the push service does", async () => {
    const subscription = await makeSubscription();
    for (const behaviour of [
      new Response(null, { status: 201 }),
      new Response("gone", { status: 410 }),
      new Response("boom", { status: 500 }),
    ]) {
      const { fetchImpl } = stubFetch(behaviour);
      await expect(
        sendPush({
          subscription,
          payload: { title: "t" },
          vapid: await makeVapid(),
          fetchImpl,
        }),
      ).resolves.toBeDefined();
    }
  });
});

describe("sendPush — refusals that never reach the network", () => {
  it("rejects an oversized payload cleanly", async () => {
    const subscription = await makeSubscription();
    const { fetchImpl, captured } = stubFetch(new Response(null, { status: 201 }));
    const result = await sendPush({
      subscription,
      payload: "x".repeat(MAX_PUSH_PLAINTEXT_BYTES + 1),
      vapid: await makeVapid(),
      fetchImpl,
    });
    expect(result).toMatchObject({ outcome: "invalid", code: "payload_too_large" });
    expect(captured).toHaveLength(0);
  });

  it("rejects a subscription with a wrong-length p256dh", async () => {
    const subscription = await makeSubscription();
    const { fetchImpl, captured } = stubFetch(new Response(null, { status: 201 }));
    const result = await sendPush({
      subscription: { ...subscription, keys: { ...subscription.keys, p256dh: "AAAA" } },
      payload: { title: "t" },
      vapid: await makeVapid(),
      fetchImpl,
    });
    expect(result).toMatchObject({ outcome: "invalid", code: "invalid_subscription" });
    expect(captured).toHaveLength(0);
  });

  it("rejects a subscription whose auth secret is not base64url", async () => {
    const subscription = await makeSubscription();
    const { fetchImpl } = stubFetch(new Response(null, { status: 201 }));
    const result = await sendPush({
      subscription: { ...subscription, keys: { ...subscription.keys, auth: "!!!!" } },
      payload: { title: "t" },
      vapid: await makeVapid(),
      fetchImpl,
    });
    expect(result).toMatchObject({ outcome: "invalid", code: "invalid_subscription" });
  });

  it("rejects an endpoint that is not a URL", async () => {
    const subscription = await makeSubscription();
    const { fetchImpl, captured } = stubFetch(new Response(null, { status: 201 }));
    const result = await sendPush({
      subscription: { ...subscription, endpoint: "not-a-url" },
      payload: { title: "t" },
      vapid: await makeVapid(),
      fetchImpl,
    });
    expect(result).toMatchObject({ outcome: "invalid", code: "invalid_subscription" });
    expect(captured).toHaveLength(0);
  });

  it("reports a broken VAPID config distinctly from a broken subscription", async () => {
    const subscription = await makeSubscription();
    const { fetchImpl } = stubFetch(new Response(null, { status: 201 }));
    const vapid = await makeVapid();
    const result = await sendPush({
      subscription,
      payload: { title: "t" },
      vapid: { ...vapid, subject: "ops@example.com" },
      fetchImpl,
    });
    // A sweep prunes on invalid_subscription but must alert on this one.
    expect(result).toMatchObject({ outcome: "invalid", code: "invalid_vapid_key" });
  });

  it("rejects a payload carrying a masked secret", async () => {
    const subscription = await makeSubscription();
    const { fetchImpl, captured } = stubFetch(new Response(null, { status: 201 }));
    const result = await sendPush({
      subscription,
      payload: { title: "Hotel ••••2119" },
      vapid: await makeVapid(),
      fetchImpl,
    });
    expect(result).toMatchObject({ outcome: "invalid", code: "invalid_payload" });
    expect(captured).toHaveLength(0);
  });
});

describe("sendPush — what it logs", () => {
  it("logs the host but never the endpoint path, payload or keys", async () => {
    const subscription = await makeSubscription();
    const { lines, logger } = capturingLogger();
    const { fetchImpl } = stubFetch(new Response(null, { status: 201 }));

    await sendPush({
      subscription,
      payload: { title: "Check in for UA 231", body: "Tomorrow, 6:40 AM from SEA" },
      vapid: await makeVapid(),
      fetchImpl,
      logger,
      logFields: { subscriptionId: "sub_123" },
    });

    expect(lines).toHaveLength(1);
    const line = lines[0]!.line;
    expect(line).toContain("push_sent");
    expect(line).toContain("updates.push.services.mozilla.com");
    expect(line).toContain("sub_123");
    // The load-bearing negatives.
    expect(line).not.toContain(ENDPOINT_PATH);
    expect(line).not.toContain("UA 231");
    expect(line).not.toContain(subscription.keys.auth);
    expect(line).not.toContain(subscription.keys.p256dh);
  });

  it("logs a gone subscription at info, with no endpoint path", async () => {
    const subscription = await makeSubscription();
    const { lines, logger } = capturingLogger();
    const { fetchImpl } = stubFetch(new Response(null, { status: 410 }));

    await sendPush({
      subscription,
      payload: { title: "t" },
      vapid: await makeVapid(),
      fetchImpl,
      logger,
    });

    expect(lines[0]!.line).toContain("push_subscription_gone");
    expect(lines[0]!.line).not.toContain(ENDPOINT_PATH);
  });

  it("does not echo a push service's error body into the log line", async () => {
    const subscription = await makeSubscription();
    const { lines, logger } = capturingLogger();
    const { fetchImpl } = stubFetch(
      new Response(`rejected for ${ENDPOINT}`, { status: 400 }),
    );

    const result = await sendPush({
      subscription,
      payload: { title: "t" },
      vapid: await makeVapid(),
      fetchImpl,
      logger,
    });

    expect(result).toMatchObject({ outcome: "failed", status: 400 });
    expect(lines[0]!.line).toContain("push_rejected");
    expect(lines[0]!.line).not.toContain(ENDPOINT_PATH);
  });
});
