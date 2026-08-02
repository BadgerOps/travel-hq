import { describe, it, expect } from "vitest";
import {
  encryptPushPayload,
  MAX_PUSH_BODY_BYTES,
  MAX_PUSH_PLAINTEXT_BYTES,
} from "../../../src/server/push/encrypt.js";
import { PushError } from "../../../src/server/push/bytes.js";

/**
 * These tests are the only thing standing between a wrong byte and a
 * production outage nobody can see: a mis-encrypted push is accepted by the
 * push service (201) and silently discarded by the browser.
 *
 * Two independent checks are run:
 *
 * 1. A KNOWN-ANSWER TEST against RFC 8291 Appendix A. Every value below is
 *    copied from the RFC, including its published intermediate values, and
 *    the expected ciphertext is the RFC's. Injecting the appendix's salt and
 *    sender keypair makes our output fully deterministic, so this compares
 *    real bytes against the standard rather than against ourselves.
 *
 * 2. A RECEIVER-SIDE ROUND TRIP written from the RFC text directly (see
 *    `decryptAes128Gcm` below) rather than by calling any helper from
 *    src/server/push/. If the encryptor and the decryptor shared code, a
 *    consistent misreading of the spec would pass both.
 */

const b64url = (s: string): Uint8Array<ArrayBuffer> => {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

const toB64url = (bytes: Uint8Array): string => {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

/**
 * @cloudflare/workers-types spells the ECDH peer key `$public`; the runtime
 * property is `public`. A types wart, not a spec question — see the same note
 * in src/server/push/bytes.ts. Declared locally so this receiver stays
 * independent of the module under test.
 */
type DeriveBitsAlgorithm = Parameters<typeof crypto.subtle.deriveBits>[0];
const ecdhWith = (publicKey: CryptoKey): DeriveBitsAlgorithm =>
  ({ name: "ECDH", public: publicKey }) as unknown as DeriveBitsAlgorithm;

function cat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

/** RFC 8291 Appendix A. */
const RFC = {
  plaintext: "When I grow up, I want to be a watermelon",
  uaPublic: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  uaPrivate: "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94",
  asPublic: "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
  asPrivate: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
  salt: "DGv6ra1nlYgDCS1FRnbzlw",
  authSecret: "BTBZMqHH6r4Tts7J_aSIgg",
  // Appendix A's derived values, reproduced here so a failure points at the
  // exact step that broke rather than at "the ciphertext differs".
  ecdhSecret: "kyrL1jIIOHEzg3sM2ZWRHDRB62YACZhhSlknJ672kSs",
  ikm: "S4lYMb_L0FxCeq0WhDx813KgSYqU26kOyzWUdsXYyrg",
  cek: "oIhVW04MRdy2XN9CiKLxTg",
  nonce: "4h_95klXJ5E_qnoN",
  ciphertext: "8pfeW0KbunFT06SuDKoJH9Ql87S1QUrdirN6GcG7sFz1y1sqLgVi1VhjVkHsUoEsbI_0LpXMuGvnzQ",
} as const;

/** Build an EC CryptoKey from the raw point/scalar encodings the RFC uses. */
async function importEcKeyPair(
  publicPoint: Uint8Array<ArrayBuffer>,
  privateScalar: Uint8Array<ArrayBuffer>,
): Promise<CryptoKeyPair> {
  const jwk: JsonWebKey = {
    kty: "EC",
    crv: "P-256",
    x: toB64url(publicPoint.subarray(1, 33)),
    y: toB64url(publicPoint.subarray(33, 65)),
    d: toB64url(privateScalar),
    ext: true,
  };
  const privateKey = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    ["deriveBits"],
  );
  const publicKey = await crypto.subtle.importKey(
    "raw",
    publicPoint,
    { name: "ECDH", namedCurve: "P-256" },
    true,
    [],
  );
  return { privateKey, publicKey };
}

/**
 * An independent RFC 8188/8291 receiver, written from the specification text:
 *
 *   header    = salt(16) | rs(4, big-endian) | idlen(1) | keyid(idlen)
 *   key_info  = "WebPush: info" || 0x00 || ua_public || as_public
 *   IKM       = HKDF(salt=auth_secret, ikm=ecdh_secret, info=key_info, L=32)
 *   CEK       = HKDF(salt, IKM, "Content-Encoding: aes128gcm" || 0x00, L=16)
 *   NONCE     = HKDF(salt, IKM, "Content-Encoding: nonce"     || 0x00, L=12)
 *   record    = AES-128-GCM(CEK, NONCE, plaintext || 0x02)
 *
 * This is what a browser does. It deliberately does not import anything from
 * the module under test.
 */
async function decryptAes128Gcm(
  body: Uint8Array<ArrayBuffer>,
  receiverPrivate: CryptoKey,
  receiverPublicPoint: Uint8Array<ArrayBuffer>,
  authSecret: Uint8Array<ArrayBuffer>,
): Promise<{ plaintext: string; salt: Uint8Array; recordSize: number; senderPublic: Uint8Array }> {
  const salt = body.slice(0, 16);
  const recordSize = new DataView(body.buffer, body.byteOffset + 16, 4).getUint32(0, false);
  const idlen = body[20]!;
  const senderPublic = body.slice(21, 21 + idlen);
  const ciphertext = body.slice(21 + idlen);

  const senderKey = await crypto.subtle.importKey(
    "raw",
    senderPublic,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const ecdhSecret = new Uint8Array(
    await crypto.subtle.deriveBits(ecdhWith(senderKey), receiverPrivate, 256),
  );

  const te = new TextEncoder();
  const hkdf = async (
    hkdfSalt: Uint8Array<ArrayBuffer>,
    ikm: Uint8Array<ArrayBuffer>,
    info: Uint8Array<ArrayBuffer>,
    bytes: number,
  ): Promise<Uint8Array<ArrayBuffer>> => {
    const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
    return new Uint8Array(
      await crypto.subtle.deriveBits(
        { name: "HKDF", hash: "SHA-256", salt: hkdfSalt, info },
        key,
        bytes * 8,
      ),
    );
  };

  const keyInfo = cat(
    te.encode("WebPush: info"),
    new Uint8Array([0]),
    receiverPublicPoint,
    senderPublic,
  );
  const ikm = await hkdf(authSecret, ecdhSecret, keyInfo, 32);
  const cek = await hkdf(salt, ikm, cat(te.encode("Content-Encoding: aes128gcm"), new Uint8Array([0])), 16);
  const nonce = await hkdf(salt, ikm, cat(te.encode("Content-Encoding: nonce"), new Uint8Array([0])), 12);

  const aesKey = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]);
  const padded = new Uint8Array(
    await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, aesKey, ciphertext),
  );

  // RFC 8188 §2: the final record ends in the delimiter 0x02 (0x01 would mean
  // "more records follow", which a single-record body must not claim).
  expect(padded[padded.length - 1]).toBe(0x02);
  return {
    plaintext: new TextDecoder().decode(padded.subarray(0, padded.length - 1)),
    salt,
    recordSize,
    senderPublic,
  };
}

/** A fresh browser-side subscription: ECDH keypair + 16-byte auth secret. */
async function makeReceiver() {
  const pair = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
    "deriveBits",
  ])) as CryptoKeyPair;
  const publicPoint = new Uint8Array(
    (await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer,
  );
  const authSecret = crypto.getRandomValues(new Uint8Array(16));
  return {
    privateKey: pair.privateKey,
    publicPoint,
    authSecret,
    keys: { p256dh: toB64url(publicPoint), auth: toB64url(authSecret) },
  };
}

describe("encryptPushPayload — RFC 8291 Appendix A known-answer test", () => {
  it("reproduces the RFC's exact ciphertext byte for byte", async () => {
    const senderKeyPair = await importEcKeyPair(b64url(RFC.asPublic), b64url(RFC.asPrivate));

    const body = await encryptPushPayload(
      RFC.plaintext,
      { p256dh: RFC.uaPublic, auth: RFC.authSecret },
      { salt: b64url(RFC.salt), senderKeyPair },
    );

    // Header, field by field, against RFC 8188 §2.1's layout.
    expect(toB64url(body.subarray(0, 16))).toBe(RFC.salt);
    expect(new DataView(body.buffer, body.byteOffset + 16, 4).getUint32(0, false)).toBe(4096);
    expect(body[20]).toBe(65);
    expect(toB64url(body.subarray(21, 86))).toBe(RFC.asPublic);
    // The payload itself.
    expect(toB64url(body.subarray(86))).toBe(RFC.ciphertext);
  });

  it("derives the RFC's published intermediate values", async () => {
    // Recomputed here from the RFC inputs so a mismatch in the KAT above can
    // be localized to a specific derivation step.
    const senderKeyPair = await importEcKeyPair(b64url(RFC.asPublic), b64url(RFC.asPrivate));
    const uaKey = await crypto.subtle.importKey(
      "raw",
      b64url(RFC.uaPublic),
      { name: "ECDH", namedCurve: "P-256" },
      false,
      [],
    );
    const ecdh = new Uint8Array(
      await crypto.subtle.deriveBits(ecdhWith(uaKey), senderKeyPair.privateKey, 256),
    );
    expect(toB64url(ecdh)).toBe(RFC.ecdhSecret);
  });

  it("decrypts under the RFC's own user-agent private key", async () => {
    const senderKeyPair = await importEcKeyPair(b64url(RFC.asPublic), b64url(RFC.asPrivate));
    const uaPair = await importEcKeyPair(b64url(RFC.uaPublic), b64url(RFC.uaPrivate));
    const body = await encryptPushPayload(
      RFC.plaintext,
      { p256dh: RFC.uaPublic, auth: RFC.authSecret },
      { salt: b64url(RFC.salt), senderKeyPair },
    );
    const decrypted = await decryptAes128Gcm(
      body,
      uaPair.privateKey,
      b64url(RFC.uaPublic),
      b64url(RFC.authSecret),
    );
    expect(decrypted.plaintext).toBe(RFC.plaintext);
  });
});

describe("encryptPushPayload — receiver round trip", () => {
  it("produces a body a browser-side decryptor can read", async () => {
    const receiver = await makeReceiver();
    const message = JSON.stringify({ title: "Check in for UA 231", body: "Tomorrow, 6:40 AM" });

    const body = await encryptPushPayload(message, receiver.keys);
    const result = await decryptAes128Gcm(
      body,
      receiver.privateKey,
      receiver.publicPoint,
      receiver.authSecret,
    );

    expect(result.plaintext).toBe(message);
    expect(result.recordSize).toBe(4096);
    expect(result.senderPublic).toHaveLength(65);
    expect(result.senderPublic[0]).toBe(0x04);
  });

  it("round-trips multi-byte UTF-8 intact", async () => {
    const receiver = await makeReceiver();
    const message = "Fahrt nach München — 6:40 ✈️";
    const body = await encryptPushPayload(message, receiver.keys);
    const result = await decryptAes128Gcm(
      body,
      receiver.privateKey,
      receiver.publicPoint,
      receiver.authSecret,
    );
    expect(result.plaintext).toBe(message);
  });

  it("uses a fresh salt and a fresh sender key for every message", async () => {
    const receiver = await makeReceiver();
    const a = await encryptPushPayload("same text", receiver.keys);
    const b = await encryptPushPayload("same text", receiver.keys);

    const first = await decryptAes128Gcm(a, receiver.privateKey, receiver.publicPoint, receiver.authSecret);
    const second = await decryptAes128Gcm(b, receiver.privateKey, receiver.publicPoint, receiver.authSecret);

    expect(toB64url(first.salt)).not.toBe(toB64url(second.salt));
    expect(toB64url(first.senderPublic)).not.toBe(toB64url(second.senderPublic));
    expect(first.plaintext).toBe(second.plaintext);
  });

  it("encrypts a payload of exactly the maximum size", async () => {
    const receiver = await makeReceiver();
    const message = "x".repeat(MAX_PUSH_PLAINTEXT_BYTES);
    const body = await encryptPushPayload(message, receiver.keys);
    expect(body.length).toBe(MAX_PUSH_BODY_BYTES);
    const result = await decryptAes128Gcm(
      body,
      receiver.privateKey,
      receiver.publicPoint,
      receiver.authSecret,
    );
    expect(result.plaintext).toBe(message);
  });
});

describe("encryptPushPayload — rejected input", () => {
  it("rejects a payload one byte over the limit, before any network call", async () => {
    const receiver = await makeReceiver();
    const message = "x".repeat(MAX_PUSH_PLAINTEXT_BYTES + 1);
    await expect(encryptPushPayload(message, receiver.keys)).rejects.toThrow(PushError);
    await expect(encryptPushPayload(message, receiver.keys)).rejects.toMatchObject({
      code: "payload_too_large",
    });
  });

  it("counts UTF-8 bytes, not characters, against the limit", async () => {
    const receiver = await makeReceiver();
    // Each emoji is 4 UTF-8 bytes; well under the limit by character count.
    const message = "🍉".repeat(MAX_PUSH_PLAINTEXT_BYTES / 4 + 1);
    await expect(encryptPushPayload(message, receiver.keys)).rejects.toMatchObject({
      code: "payload_too_large",
    });
  });

  it("rejects a p256dh of the wrong length", async () => {
    const receiver = await makeReceiver();
    const short = toB64url(receiver.publicPoint.subarray(0, 64));
    await expect(
      encryptPushPayload("hi", { p256dh: short, auth: receiver.keys.auth }),
    ).rejects.toMatchObject({ code: "invalid_subscription" });
    await expect(
      encryptPushPayload("hi", { p256dh: short, auth: receiver.keys.auth }),
    ).rejects.toThrow(/65 bytes, got 64/);
  });

  it("rejects a p256dh that is 65 bytes but not a point on the curve", async () => {
    const receiver = await makeReceiver();
    const bogus = new Uint8Array(65);
    bogus[0] = 0x04;
    bogus.fill(0xab, 1);
    await expect(
      encryptPushPayload("hi", { p256dh: toB64url(bogus), auth: receiver.keys.auth }),
    ).rejects.toMatchObject({ code: "invalid_subscription" });
  });

  it("rejects a p256dh that is not base64url at all", async () => {
    const receiver = await makeReceiver();
    await expect(
      encryptPushPayload("hi", { p256dh: "not valid!!", auth: receiver.keys.auth }),
    ).rejects.toThrow(/not valid base64url/);
  });

  it("rejects an empty p256dh", async () => {
    const receiver = await makeReceiver();
    await expect(
      encryptPushPayload("hi", { p256dh: "", auth: receiver.keys.auth }),
    ).rejects.toThrow(/is empty/);
  });

  it("rejects an auth secret that is not 16 bytes", async () => {
    const receiver = await makeReceiver();
    const auth = toB64url(crypto.getRandomValues(new Uint8Array(12)));
    await expect(
      encryptPushPayload("hi", { p256dh: receiver.keys.p256dh, auth }),
    ).rejects.toMatchObject({ code: "invalid_subscription" });
    await expect(
      encryptPushPayload("hi", { p256dh: receiver.keys.p256dh, auth }),
    ).rejects.toThrow(/16 bytes, got 12/);
  });

  it("accepts a padded base64 subscription key, since some clients store one", async () => {
    const receiver = await makeReceiver();
    const padded = (value: string): string => {
      const remainder = value.length % 4;
      return remainder === 0 ? value : value + "=".repeat(4 - remainder);
    };
    const body = await encryptPushPayload("hi", {
      p256dh: padded(receiver.keys.p256dh),
      auth: padded(receiver.keys.auth),
    });
    const result = await decryptAes128Gcm(
      body,
      receiver.privateKey,
      receiver.publicPoint,
      receiver.authSecret,
    );
    expect(result.plaintext).toBe("hi");
  });
});
