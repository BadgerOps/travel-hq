import { describe, it, expect } from "vitest";
import { decodeJwt, decodeProtectedHeader, jwtVerify } from "jose";
import {
  createVapidAuthorization,
  generateVapidKeys,
  importVapidPrivateKey,
  vapidAudience,
  verifyVapidKeys,
  MAX_VAPID_EXPIRY_SECONDS,
} from "../../../src/server/push/vapid.js";
import type { VapidConfig, VapidKeys } from "../../../src/server/push/vapid.js";

const SUBJECT = "mailto:ops@example.com";

async function config(): Promise<VapidConfig> {
  return { ...(await generateVapidKeys()), subject: SUBJECT };
}

function splitHeader(header: string): { t: string; k: string } {
  const match = /^vapid t=([^,]+), k=(.+)$/.exec(header);
  if (!match) throw new Error(`Authorization header is not RFC 8292 shaped: ${header}`);
  return { t: match[1]!, k: match[2]! };
}

/** Import the `k=` value as an ECDSA verification key, the way a push service would. */
async function verificationKey(publicKeyB64: string): Promise<CryptoKey> {
  const b64 = publicKeyB64.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64);
  const raw = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) raw[i] = bin.charCodeAt(i);
  return crypto.subtle.importKey("raw", raw, { name: "ECDSA", namedCurve: "P-256" }, false, [
    "verify",
  ]);
}

describe("vapidAudience", () => {
  it("uses the endpoint origin and drops the path", () => {
    expect(vapidAudience("https://fcm.googleapis.com/fcm/send/dK9xY-abc123")).toBe(
      "https://fcm.googleapis.com",
    );
    expect(vapidAudience("https://updates.push.services.mozilla.com/wpush/v2/gAAAA")).toBe(
      "https://updates.push.services.mozilla.com",
    );
    expect(vapidAudience("https://web.push.apple.com/QF12345/very/long/path?x=1#y")).toBe(
      "https://web.push.apple.com",
    );
  });

  it("has no trailing slash", () => {
    expect(vapidAudience("https://example.com/")).toBe("https://example.com");
    expect(vapidAudience("https://example.com/").endsWith("/")).toBe(false);
  });

  it("keeps a non-default port", () => {
    expect(vapidAudience("https://localhost:8788/push/abc")).toBe("https://localhost:8788");
  });

  it("rejects a non-URL and a non-http scheme", () => {
    expect(() => vapidAudience("not-a-url")).toThrow(/not a valid URL/);
    expect(() => vapidAudience("ftp://example.com/x")).toThrow(/http\(s\)/);
  });
});

describe("generateVapidKeys / verifyVapidKeys", () => {
  it("generates a 65-byte uncompressed public point and a 32-byte private scalar", async () => {
    const keys = await generateVapidKeys();
    const decode = (v: string): Uint8Array => {
      const bin = atob(v.replace(/-/g, "+").replace(/_/g, "/"));
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    };
    expect(decode(keys.publicKey)).toHaveLength(65);
    expect(decode(keys.publicKey)[0]).toBe(0x04);
    expect(decode(keys.privateKey)).toHaveLength(32);
    // Unpadded base64url: what RFC 8292's `k=` and applicationServerKey want.
    expect(keys.publicKey).not.toContain("=");
    expect(keys.publicKey).not.toContain("+");
    expect(keys.publicKey).not.toContain("/");
  });

  it("confirms a matching pair", async () => {
    await expect(verifyVapidKeys(await generateVapidKeys())).resolves.toBe(true);
  });

  it("reports a mismatched pair as false rather than as a config error", async () => {
    const a = await generateVapidKeys();
    const b = await generateVapidKeys();
    const frankenpair: VapidKeys = { publicKey: a.publicKey, privateKey: b.privateKey };
    await expect(verifyVapidKeys(frankenpair)).resolves.toBe(false);
  });

  it("documents that workerd itself rejects a mismatched d/x/y at import", async () => {
    // Recorded as a test because it is a runtime behaviour we rely on but do
    // not control: other WebCrypto implementations import this happily and
    // fail only when a push service refuses every request.
    const a = await generateVapidKeys();
    const b = await generateVapidKeys();
    await expect(
      importVapidPrivateKey({ publicKey: a.publicKey, privateKey: b.privateKey }),
    ).rejects.toMatchObject({ code: "invalid_vapid_key" });
  });
});

describe("importVapidPrivateKey", () => {
  it("rejects a public key of the wrong length", async () => {
    const keys = await generateVapidKeys();
    await expect(
      importVapidPrivateKey({ ...keys, publicKey: keys.publicKey.slice(0, 40) }),
    ).rejects.toMatchObject({ code: "invalid_vapid_key" });
  });

  it("rejects a private key of the wrong length", async () => {
    const keys = await generateVapidKeys();
    await expect(
      importVapidPrivateKey({ ...keys, privateKey: keys.privateKey.slice(0, 10) }),
    ).rejects.toThrow(/32 bytes/);
  });

  it("rejects a 65-byte public key that is not an uncompressed point", async () => {
    const keys = await generateVapidKeys();
    const bogus = new Uint8Array(65).fill(0x07);
    let s = "";
    for (const b of bogus) s += String.fromCharCode(b);
    const encoded = btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    await expect(importVapidPrivateKey({ ...keys, publicKey: encoded })).rejects.toThrow(
      /uncompressed P-256 point/,
    );
  });

  it("rejects garbage that is not base64url", async () => {
    const keys = await generateVapidKeys();
    await expect(importVapidPrivateKey({ ...keys, privateKey: "%%%%" })).rejects.toThrow(
      /not valid base64url/,
    );
  });
});

describe("createVapidAuthorization", () => {
  it("emits the RFC 8292 single-header form with the public key as k=", async () => {
    const cfg = await config();
    const header = await createVapidAuthorization(
      "https://fcm.googleapis.com/fcm/send/abc",
      cfg,
    );
    expect(header.startsWith("vapid t=")).toBe(true);
    const { t, k } = splitHeader(header);
    expect(k).toBe(cfg.publicKey);
    expect(t.split(".")).toHaveLength(3);
  });

  it("signs with ES256 and typ JWT", async () => {
    const cfg = await config();
    const { t } = splitHeader(
      await createVapidAuthorization("https://fcm.googleapis.com/fcm/send/abc", cfg),
    );
    expect(decodeProtectedHeader(t)).toMatchObject({ alg: "ES256", typ: "JWT" });
  });

  it("produces a signature that verifies against the advertised public key", async () => {
    const cfg = await config();
    const header = await createVapidAuthorization("https://web.push.apple.com/QF1/abc", cfg);
    const { t, k } = splitHeader(header);
    const { payload } = await jwtVerify(t, await verificationKey(k), {
      audience: "https://web.push.apple.com",
    });
    expect(payload.sub).toBe(SUBJECT);
  });

  it("does not verify against a different application server's key", async () => {
    const cfg = await config();
    const other = await generateVapidKeys();
    const { t } = splitHeader(
      await createVapidAuthorization("https://web.push.apple.com/QF1/abc", cfg),
    );
    await expect(jwtVerify(t, await verificationKey(other.publicKey))).rejects.toThrow();
  });

  it("sets aud to the endpoint origin, never the full endpoint", async () => {
    const cfg = await config();
    const endpoint = "https://updates.push.services.mozilla.com/wpush/v2/secret-capability";
    const { t } = splitHeader(await createVapidAuthorization(endpoint, cfg));
    const claims = decodeJwt(t);
    expect(claims.aud).toBe("https://updates.push.services.mozilla.com");
    // The endpoint path is a bearer capability: it must not ride along in a
    // token that gets copied into logs and proxies.
    expect(t).not.toContain("secret-capability");
  });

  it("defaults to a 12-hour expiry and stays inside RFC 8292's 24-hour ceiling", async () => {
    const cfg = await config();
    const nowMs = Date.UTC(2026, 0, 2, 3, 4, 5);
    const { t } = splitHeader(
      await createVapidAuthorization("https://example.com/p/1", cfg, { nowMs }),
    );
    const claims = decodeJwt(t);
    const exp = claims.exp!;
    expect(exp).toBe(Math.floor(nowMs / 1000) + 12 * 60 * 60);
    expect(exp).toBeGreaterThan(Math.floor(nowMs / 1000));
    expect(exp - Math.floor(nowMs / 1000)).toBeLessThanOrEqual(MAX_VAPID_EXPIRY_SECONDS);
  });

  it("clamps an over-long requested lifetime to 24 hours", async () => {
    const cfg = await config();
    const nowMs = Date.UTC(2026, 0, 2);
    const { t } = splitHeader(
      await createVapidAuthorization("https://example.com/p/1", cfg, {
        nowMs,
        expiresInSeconds: 30 * 24 * 60 * 60,
      }),
    );
    expect(decodeJwt(t).exp).toBe(Math.floor(nowMs / 1000) + MAX_VAPID_EXPIRY_SECONDS);
  });

  it("honours a shorter requested lifetime", async () => {
    const cfg = await config();
    const nowMs = Date.UTC(2026, 0, 2);
    const { t } = splitHeader(
      await createVapidAuthorization("https://example.com/p/1", cfg, {
        nowMs,
        expiresInSeconds: 60,
      }),
    );
    expect(decodeJwt(t).exp).toBe(Math.floor(nowMs / 1000) + 60);
  });

  it("rejects a non-positive lifetime rather than minting an expired token", async () => {
    const cfg = await config();
    await expect(
      createVapidAuthorization("https://example.com/p/1", cfg, { expiresInSeconds: 0 }),
    ).rejects.toThrow(/lifetime must be positive/);
  });

  it("accepts an https: subject as well as mailto:", async () => {
    const keys = await generateVapidKeys();
    const header = await createVapidAuthorization("https://example.com/p/1", {
      ...keys,
      subject: "https://travel-hq.example/contact",
    });
    const { t } = splitHeader(header);
    expect(decodeJwt(t).sub).toBe("https://travel-hq.example/contact");
  });

  it("rejects a subject that is not a mailto: or https: URI", async () => {
    const keys = await generateVapidKeys();
    await expect(
      createVapidAuthorization("https://example.com/p/1", { ...keys, subject: "ops@example.com" }),
    ).rejects.toMatchObject({ code: "invalid_vapid_key" });
  });

  it("rejects a malformed endpoint before signing anything", async () => {
    const cfg = await config();
    await expect(createVapidAuthorization("nope", cfg)).rejects.toThrow(/not a valid URL/);
    await expect(createVapidAuthorization("ftp://push.example/x", cfg)).rejects.toThrow(
      /http\(s\)/,
    );
  });
});
