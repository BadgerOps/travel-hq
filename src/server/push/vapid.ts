/**
 * VAPID — Voluntary Application Server Identification (RFC 8292). Issue #61.
 *
 * A push service will not accept an anonymous POST to a subscription
 * endpoint. VAPID is how we say "the same application server that the browser
 * subscribed to is the one sending this": a short-lived ES256 JWT signed with
 * a P-256 key whose public half the browser already pinned when it called
 * `pushManager.subscribe({ applicationServerKey })`. If the `k=` value in the
 * header does not match that pinned key, the push service rejects the request
 * (403) — so the keypair below and the key shipped to the client MUST be the
 * same pair, forever, for the life of every existing subscription. Rotating
 * it silently invalidates every subscription in the database.
 *
 * ── KEY ENCODING (pick one and never guess) ───────────────────────────────
 * This module expects, and only expects:
 *
 *   VAPID_PUBLIC_KEY   base64url, unpadded, of the 65-byte UNCOMPRESSED P-256
 *                      point: 0x04 || X(32) || Y(32). This is exactly the
 *                      value the browser wants for `applicationServerKey`.
 *   VAPID_PRIVATE_KEY  base64url, unpadded, of the RAW 32-byte private scalar
 *                      — the JWK `d` value. NOT PKCS#8, NOT a PEM, NOT DER.
 *
 * The raw-`d` choice matches what every existing tool prints (`web-push
 * generate-vapid-keys`, the `d` field of an exported JWK), so an operator can
 * paste a key generated anywhere. The cost is that `d` alone cannot be turned
 * into a CryptoKey — WebCrypto's JWK import needs `x` and `y` too — which is
 * why the public key is a *required* input here rather than a convenience:
 * the two values are reassembled into one JWK at import time.
 *
 * The consequence worth knowing: a JWK import can only be as strict as the
 * implementation running it. workerd (verified by
 * tests/server/push/vapid.test.ts) does check that `d` corresponds to `x`/`y`
 * and refuses a Frankenstein pair — but that is a runtime detail, not a
 * guarantee of the WebCrypto spec, and several implementations accept the
 * mismatch and go on to produce signatures no push service will ever accept.
 * `verifyVapidKeys()` closes that gap by signing and verifying a probe: call
 * it once at configuration time rather than discovering the problem at 3am.
 *
 * ── HOW AN OPERATOR GENERATES A PAIR ──────────────────────────────────────
 * Any machine with Node ≥ 18, no dependencies:
 *
 *   node -e 'const {webcrypto:w}=require("crypto");(async()=>{ \
 *     const kp=await w.subtle.generateKey({name:"ECDSA",namedCurve:"P-256"},true,["sign","verify"]); \
 *     const jwk=await w.subtle.exportKey("jwk",kp.privateKey); \
 *     const pub=Buffer.from(await w.subtle.exportKey("raw",kp.publicKey)); \
 *     console.log("VAPID_PUBLIC_KEY =",pub.toString("base64url")); \
 *     console.log("VAPID_PRIVATE_KEY=",jwk.d);})()'
 *
 * Then `npx wrangler secret put VAPID_PRIVATE_KEY` (the private half is a
 * secret; the public half is not — the browser receives it — but keeping both
 * as secrets/vars together is simplest).
 */

import { SignJWT } from "jose";
import {
  P256_PRIVATE_LENGTH,
  P256_UNCOMPRESSED_LENGTH,
  PushError,
  decodeFixed,
  encodeBase64Url,
  pointToXY,
  utf8,
} from "./bytes.js";

export type VapidKeys = {
  /** base64url, 65-byte uncompressed P-256 point. */
  publicKey: string;
  /** base64url, raw 32-byte private scalar (JWK `d`). A Worker secret. */
  privateKey: string;
};

export type VapidConfig = VapidKeys & {
  /**
   * RFC 8292 §2.1 `sub`: a contact the push service operator can reach if our
   * traffic causes them a problem. Must be a `mailto:` or `https:` URI —
   * push services reject anything else, sometimes only under load.
   */
  subject: string;
};

/**
 * Default JWT lifetime. RFC 8292 §2 caps `exp` at 24 hours from now; 12 gives
 * generous room for clock skew on the push service's side while keeping a
 * leaked header useless within a day. (The header is not a bearer token for
 * anything but "send to endpoints you already know", but short is free.)
 */
const DEFAULT_EXPIRY_SECONDS = 12 * 60 * 60;

/** RFC 8292 §2: `exp` MUST NOT be more than 24 hours in the future. */
export const MAX_VAPID_EXPIRY_SECONDS = 24 * 60 * 60;

/**
 * The `aud` claim: the ORIGIN of the endpoint — scheme + host (+ port) and
 * nothing else. Not the path.
 *
 * This is the single most commonly botched part of VAPID. The endpoint
 * `https://fcm.googleapis.com/fcm/send/dK9x...` has audience
 * `https://fcm.googleapis.com`; including the path, or the trailing slash
 * that `new URL(...).origin` thankfully omits, produces a 401 from some
 * services and — worse — silent acceptance-then-drop from others. Deriving it
 * from `URL.origin` rather than string surgery also means an endpoint on a
 * non-default port keeps its port, which is what a self-hosted push service
 * in a test harness needs.
 */
export function vapidAudience(endpoint: string): string {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new PushError("invalid_subscription", "subscription endpoint is not a valid URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new PushError("invalid_subscription", "subscription endpoint must be an http(s) URL");
  }
  return url.origin;
}

function assertSubject(subject: string): void {
  if (!subject.startsWith("mailto:") && !subject.startsWith("https://")) {
    throw new PushError(
      "invalid_vapid_key",
      "VAPID subject must be a mailto: or https: URI",
    );
  }
}

/**
 * Reassemble the configured halves into an ECDSA P-256 signing key.
 *
 * `extractable: false` — nothing needs the private scalar back out, and a
 * non-extractable key cannot be exported into a log line by a later edit.
 */
export async function importVapidPrivateKey(keys: VapidKeys): Promise<CryptoKey> {
  const publicPoint = decodeFixed(
    keys.publicKey,
    "VAPID public key",
    P256_UNCOMPRESSED_LENGTH,
    "invalid_vapid_key",
  );
  const privateScalar = decodeFixed(
    keys.privateKey,
    "VAPID private key",
    P256_PRIVATE_LENGTH,
    "invalid_vapid_key",
  );
  const { x, y } = pointToXY(publicPoint, "VAPID public key", "invalid_vapid_key");

  try {
    return await crypto.subtle.importKey(
      "jwk",
      { kty: "EC", crv: "P-256", x, y, d: encodeBase64Url(privateScalar), ext: false },
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["sign"],
    );
  } catch {
    throw new PushError("invalid_vapid_key", "VAPID keypair could not be imported as ECDSA P-256");
  }
}

async function importVapidPublicKey(publicKey: string): Promise<CryptoKey> {
  const point = decodeFixed(
    publicKey,
    "VAPID public key",
    P256_UNCOMPRESSED_LENGTH,
    "invalid_vapid_key",
  );
  try {
    return await crypto.subtle.importKey(
      "raw",
      point,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
  } catch {
    throw new PushError("invalid_vapid_key", "VAPID public key is not a valid P-256 point");
  }
}

/**
 * True if the configured private key really is the private half of the
 * configured public key. Call once at configuration/startup, not per push.
 *
 * Returns false for a mismatched-but-well-formed pair (whether the runtime
 * catches it at import, as workerd does, or only at signature-verification
 * time, as a laxer WebCrypto would). Still THROWS for a config that is
 * structurally wrong — wrong length, not base64url, not an uncompressed point
 * — because that is an operator typo with a specific fix, not an ambiguous
 * "these two don't go together".
 */
export async function verifyVapidKeys(keys: VapidKeys): Promise<boolean> {
  let privateKey: CryptoKey;
  try {
    privateKey = await importVapidPrivateKey(keys);
  } catch (error) {
    if (error instanceof PushError && /could not be imported/.test(error.message)) return false;
    throw error;
  }
  const publicKey = await importVapidPublicKey(keys.publicKey);
  const probe = utf8("vapid-keypair-consistency-probe");
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    privateKey,
    probe,
  );
  return crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    publicKey,
    signature,
    probe,
  );
}

export type VapidHeaderOptions = {
  /** Overridable for tests; defaults to `Date.now()`. */
  nowMs?: number;
  /** JWT lifetime. Clamped to RFC 8292's 24-hour ceiling. */
  expiresInSeconds?: number;
};

/**
 * Build the `Authorization` header value for one push.
 *
 *   Authorization: vapid t=<jwt>, k=<base64url public key>
 *
 * This is the RFC 8292 §3.2 "vapid" HTTP authentication scheme, which
 * replaced the older split `Authorization: WebPush <jwt>` + `Crypto-Key: p256ecdsa=`
 * pair. Every current push service accepts the single-header form; the old
 * form is not emitted here.
 *
 * The JWT is signed with `jose` rather than by hand. ES256 signatures must be
 * the raw 64-byte r||s concatenation, and `crypto.subtle.sign` already
 * produces that (unlike OpenSSL, which produces DER) — but jose also gets the
 * base64url of every segment and the header/claims serialization right, and a
 * hand-rolled JWT is a large surface for a small saving.
 */
export async function createVapidAuthorization(
  endpoint: string,
  config: VapidConfig,
  options: VapidHeaderOptions = {},
): Promise<string> {
  assertSubject(config.subject);

  const nowMs = options.nowMs ?? Date.now();
  const requested = options.expiresInSeconds ?? DEFAULT_EXPIRY_SECONDS;
  if (requested <= 0) {
    throw new PushError("invalid_vapid_key", "VAPID token lifetime must be positive");
  }
  const lifetime = Math.min(requested, MAX_VAPID_EXPIRY_SECONDS);
  const exp = Math.floor(nowMs / 1000) + lifetime;

  const privateKey = await importVapidPrivateKey(config);
  const jwt = await new SignJWT({})
    .setProtectedHeader({ typ: "JWT", alg: "ES256" })
    .setAudience(vapidAudience(endpoint))
    .setExpirationTime(exp)
    .setSubject(config.subject)
    .sign(privateKey);

  // The `k` parameter is the public key as base64url of the uncompressed
  // point — the same string the client passed as applicationServerKey. Echoed
  // verbatim from config rather than re-encoded, so a padded or otherwise
  // odd-but-valid configured value cannot silently differ from what the
  // browser pinned... except that it is validated for length/shape by
  // importVapidPrivateKey above, which runs first.
  return `vapid t=${jwt}, k=${config.publicKey}`;
}

/**
 * Generate a fresh VAPID pair in the encodings this module expects. Handy for
 * tests and for a one-off `wrangler dev` console; an operator can equally use
 * the Node one-liner in the file header.
 */
export async function generateVapidKeys(): Promise<VapidKeys> {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const publicRaw = new Uint8Array(
    (await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer,
  );
  const jwk = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as JsonWebKey;
  /* c8 ignore next -- exportKey("jwk") on a P-256 private key always has `d`. */
  if (!jwk.d) throw new PushError("invalid_vapid_key", "generated key has no private scalar");
  return { publicKey: encodeBase64Url(publicRaw), privateKey: jwk.d };
}
