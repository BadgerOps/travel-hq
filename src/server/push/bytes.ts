/**
 * Byte plumbing for Web Push (issue #61).
 *
 * Web Push is a wire format, not an API: every value that crosses a boundary
 * here — subscription keys, VAPID keys, the encrypted body — is a specific
 * number of specific octets in a specific order. Getting one of them wrong
 * produces no error anywhere. The push service accepts the POST, returns 201,
 * and the browser silently discards the message because AES-GCM failed to
 * authenticate. There is no feedback channel. So the helpers in this file are
 * deliberately strict and length-checking: the only place a mistake can be
 * caught is *before* it goes out.
 *
 * All base64 in Web Push is base64url WITHOUT padding (RFC 4648 §5), which is
 * what the browser's `PushSubscription.getKey()` values are serialized as by
 * every client that stores them, and what RFC 8292 requires for the `k=`
 * parameter of the Authorization header. `decodeBase64Url` nonetheless accepts
 * padded input, because a subscription that arrived through some other client
 * with `=` on the end is a real thing and rejecting it would be pointless
 * pedantry — but we never *emit* padding.
 */

/**
 * Everything in this module throws this and only this, with a machine-readable
 * `code`. `sendPush` turns it into a typed result rather than letting it
 * escape: a caller sweeping hundreds of subscriptions must never have one bad
 * row abort the sweep (see send.ts).
 *
 * The `.message` is written to be safe to log. It never contains key material,
 * payload plaintext, or a full endpoint URL.
 */
export type PushErrorCode =
  /** A subscription's p256dh/auth is not decodable or not the right length. */
  | "invalid_subscription"
  /** The configured VAPID keypair is malformed or internally inconsistent. */
  | "invalid_vapid_key"
  /** The encrypted body would exceed what push services are required to accept. */
  | "payload_too_large"
  /** The notification payload violates the no-secrets-on-a-lock-screen rule. */
  | "invalid_payload";

export class PushError extends Error {
  constructor(
    readonly code: PushErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "PushError";
  }
}

/**
 * Explicit `<ArrayBuffer>` generics throughout this module: a bare
 * `Uint8Array` annotation resolves to `Uint8Array<ArrayBufferLike>` (which
 * includes SharedArrayBuffer), and workerd's `BufferSource` (from
 * @cloudflare/workers-types) only accepts views backed by a concrete
 * `ArrayBuffer`. Pinning the type keeps these values assignable straight into
 * `crypto.subtle.*` without casts. Same convention as crypto/envelope.ts.
 */
export type Bytes = Uint8Array<ArrayBuffer>;

export function encodeBase64Url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Decode base64url, failing loudly on anything that is not base64url.
 *
 * `atob` is famously lax — it will happily ignore some junk — and a
 * silently-truncated key produces the "delivered but undecryptable" failure
 * this whole file exists to prevent. So the character set is checked up front
 * against the base64url alphabet, and `label` names the offending field so the
 * error tells an operator which column of which row is broken.
 */
export function decodeBase64Url(value: string, label: string, code: PushErrorCode): Bytes {
  if (typeof value !== "string" || value.length === 0) {
    throw new PushError(code, `${label} is empty`);
  }
  // Accept both alphabets on input (some clients hand back standard base64)
  // and accept trailing padding, but nothing else.
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(normalized)) {
    throw new PushError(code, `${label} is not valid base64url`);
  }
  let binary: string;
  try {
    binary = atob(normalized);
  } catch {
    throw new PushError(code, `${label} is not valid base64url`);
  }
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** Decode and assert an exact octet length. See the note above on why exact. */
export function decodeFixed(
  value: string,
  label: string,
  expectedLength: number,
  code: PushErrorCode,
): Bytes {
  const bytes = decodeBase64Url(value, label, code);
  if (bytes.length !== expectedLength) {
    throw new PushError(
      code,
      `${label} must be ${expectedLength} bytes, got ${bytes.length}`,
    );
  }
  return bytes;
}

export function concatBytes(...parts: readonly Uint8Array[]): Bytes {
  let total = 0;
  for (const part of parts) total += part.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

const encoder = new TextEncoder();

/**
 * UTF-8 bytes. Also used for the literal RFC info strings ("WebPush: info",
 * "Content-Encoding: aes128gcm", ...) — those are pure ASCII, for which UTF-8
 * is byte-identical, so one helper serves both without the risk of two
 * near-identical encoders drifting apart.
 */
export function utf8(value: string): Bytes {
  return encoder.encode(value) as Bytes;
}

/**
 * HKDF-SHA-256 (RFC 5869) via WebCrypto.
 *
 * `crypto.subtle.deriveBits` with `HKDF` performs extract-then-expand in one
 * call: it computes `PRK = HMAC(salt, ikm)` and then
 * `T(1) = HMAC(PRK, info || 0x01)`, truncated to `lengthBytes`. Every HKDF use
 * in RFC 8291/8188 asks for at most 32 octets, i.e. exactly one expand block,
 * so this single call is the whole derivation — the `|| 0x01` counter octet
 * the RFCs spell out is supplied by WebCrypto, NOT by us. Appending it to
 * `info` ourselves would be a classic and undetectable off-by-one-byte bug.
 */
export async function hkdfSha256(
  salt: Uint8Array,
  ikm: Uint8Array,
  info: Uint8Array,
  lengthBytes: number,
): Promise<Bytes> {
  const key = await crypto.subtle.importKey("raw", ikm as Bytes, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: salt as Bytes, info: info as Bytes },
    key,
    lengthBytes * 8,
  );
  return new Uint8Array(bits);
}

/**
 * ECDH derivation parameters, with a cast that is a types bug, not a code bug.
 *
 * @cloudflare/workers-types declares the field as `$public` — its generator
 * escapes `public` because the name is a reserved word in the C++ side of
 * workerd — while the property the runtime actually reads is `public`.
 * Writing `$public` would typecheck and then derive nothing. The cast is
 * routed through `Parameters<...>` rather than the interface name so it does
 * not depend on which tsconfig's globals are in scope.
 */
type DeriveBitsAlgorithm = Parameters<typeof crypto.subtle.deriveBits>[0];

export function ecdhAlgorithm(publicKey: CryptoKey): DeriveBitsAlgorithm {
  return { name: "ECDH", public: publicKey } as unknown as DeriveBitsAlgorithm;
}

/**
 * The length of an uncompressed P-256 point: 0x04 || X(32) || Y(32).
 * Both a subscription's `p256dh` and a VAPID public key are exactly this.
 */
export const P256_UNCOMPRESSED_LENGTH = 65;

/** The raw scalar length of a P-256 private key (the JWK `d` value). */
export const P256_PRIVATE_LENGTH = 32;

/** RFC 8291 §3.2: the client's `auth` secret is 16 octets. */
export const AUTH_SECRET_LENGTH = 16;

/**
 * Split an uncompressed P-256 point into its JWK `x`/`y` halves, rejecting a
 * point that does not start with the 0x04 uncompressed marker. A compressed
 * (0x02/0x03) point is 33 bytes and would already have failed the length
 * check; this catches a 65-byte blob that is simply not a point at all.
 */
export function pointToXY(point: Bytes, label: string, code: PushErrorCode): { x: string; y: string } {
  if (point[0] !== 0x04) {
    throw new PushError(
      code,
      `${label} is not an uncompressed P-256 point (expected a leading 0x04)`,
    );
  }
  return {
    x: encodeBase64Url(point.subarray(1, 33)),
    y: encodeBase64Url(point.subarray(33, 65)),
  };
}
