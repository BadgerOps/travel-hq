/**
 * Web Push payload encryption: RFC 8291 (Message Encryption for Web Push)
 * layered on RFC 8188 (`aes128gcm` HTTP content coding). Issue #61.
 *
 * WHY THIS IS WRITTEN BY HAND
 * The obvious dependency for this is the `web-push` npm package. It is
 * Node-only — it reaches for `crypto.createECDH`, `crypto.createHmac` and
 * Buffer semantics that workerd does not provide — so it cannot run on a
 * Cloudflare Worker at all. Everything below is therefore built on WebCrypto
 * (`crypto.subtle`), which workerd implements natively. No Node `crypto`
 * import appears anywhere in src/server/push/.
 *
 * WHY IT IS COMMENTED LIKE THIS
 * A push that is encrypted wrongly is not an error. The push service accepts
 * the POST and returns 201; the browser's service worker fails to decrypt and
 * drops the message without surfacing anything. There is no log, no bounce,
 * no callback. The only defenses are (a) getting each byte right the first
 * time and (b) a known-answer test — tests/server/push/encrypt.test.ts
 * reproduces RFC 8291 Appendix A exactly, including its published
 * intermediate values (ecdh_secret, IKM, CEK, NONCE).
 *
 * ── THE WIRE FORMAT (RFC 8188 §2.1) ───────────────────────────────────────
 * The request body is a single `aes128gcm` "record" preceded by a header:
 *
 *   +-----------+--------+-------+--------------+------------------+
 *   | salt (16) | rs (4) | idlen | keyid (idlen)| ciphertext (...) |
 *   +-----------+--------+-------+--------------+------------------+
 *
 *   salt   16 random octets, fresh per message; also the HKDF salt below.
 *   rs     record size, unsigned 32-bit BIG-ENDIAN. Not the length of this
 *          message — the maximum record size the decoder should expect.
 *   idlen  length of keyid, one octet. For Web Push this is always 65.
 *   keyid  RFC 8291 §4 redefines this field: it carries the application
 *          server's ephemeral ECDH PUBLIC KEY (uncompressed P-256, 65 bytes).
 *          That is how the receiver knows which point to run ECDH against.
 *   ciphertext AES-128-GCM over (plaintext || 0x02), tag appended.
 *
 * The 0x02 trailer is RFC 8188 §2's padding delimiter, and 0x02 specifically
 * means "this is the LAST record". A 0x01 there would tell the receiver more
 * records follow and decryption would fail. We only ever emit one record.
 *
 * ── THE KEY SCHEDULE (RFC 8291 §3.3-§3.4, RFC 8188 §2.2-§2.3) ─────────────
 *   ecdh_secret = ECDH(as_private, ua_public)                       32 bytes
 *   key_info    = "WebPush: info" || 0x00 || ua_public || as_public
 *   IKM         = HKDF(salt = auth_secret, ikm = ecdh_secret,
 *                      info = key_info, L = 32)
 *   CEK         = HKDF(salt = message salt, ikm = IKM,
 *                      info = "Content-Encoding: aes128gcm" || 0x00, L = 16)
 *   NONCE       = HKDF(salt = message salt, ikm = IKM,
 *                      info = "Content-Encoding: nonce" || 0x00,    L = 12)
 *
 * Note the ORDER inside key_info: user agent public key first, application
 * server public key second. Swapping them yields a perfectly valid-looking
 * 32-byte IKM and an undeliverable message. Note also the 0x00 separators —
 * they are part of the info strings, not decoration.
 *
 * With a single record the nonce is used as-is; RFC 8188 §2.3's XOR with the
 * record sequence number is a no-op for sequence 0.
 */

import {
  AUTH_SECRET_LENGTH,
  P256_UNCOMPRESSED_LENGTH,
  PushError,
  concatBytes,
  decodeFixed,
  ecdhAlgorithm,
  hkdfSha256,
  utf8,
} from "./bytes.js";
import type { Bytes } from "./bytes.js";

/** RFC 8188 §2.1 header: salt(16) + rs(4) + idlen(1) + keyid(65). */
const HEADER_LENGTH = 16 + 4 + 1 + P256_UNCOMPRESSED_LENGTH;

/** One padding-delimiter octet plus the 16-octet AES-GCM authentication tag. */
const RECORD_OVERHEAD = 1 + 16;

/**
 * RFC 8291 §4: "push services are REQUIRED to support 4096 octet message
 * bodies" — and in practice several (notably Apple's) accept nothing larger.
 * 4096 is therefore the ceiling for the whole encoded body, header included,
 * not for the plaintext.
 */
export const MAX_PUSH_BODY_BYTES = 4096;

/**
 * The largest plaintext that still fits: 4096 − 86 header − 17 overhead.
 * Exported so a payload builder can budget against it rather than discovering
 * the limit at send time.
 */
export const MAX_PUSH_PLAINTEXT_BYTES = MAX_PUSH_BODY_BYTES - HEADER_LENGTH - RECORD_OVERHEAD;

/**
 * Advertised record size. 4096 is what every mainstream sender uses and what
 * receivers are built around; it must be at least the real record length
 * (RFC 8188 rejects rs < 18, and a decoder rejects a record longer than rs).
 */
const RECORD_SIZE = 4096;

/** The literal info strings. One wrong byte here is an undebuggable outage. */
const WEBPUSH_INFO = utf8("WebPush: info");
const CEK_INFO = concatBytes(utf8("Content-Encoding: aes128gcm"), new Uint8Array([0x00]));
const NONCE_INFO = concatBytes(utf8("Content-Encoding: nonce"), new Uint8Array([0x00]));

/** The two public halves of a browser `PushSubscription`, as base64url. */
export type SubscriptionKeys = {
  /** The client's ECDH public key: uncompressed P-256 point, 65 bytes. */
  p256dh: string;
  /** The client's auth secret: 16 bytes. */
  auth: string;
};

export type EncryptPushPayloadOptions = {
  /**
   * Test-only injection points. Production callers pass neither: the salt must
   * be fresh random per message (RFC 8188 §2.1 forbids reuse under the same
   * keying material) and the sender keypair must be ephemeral per message
   * (RFC 8291 §3.1). They exist so the known-answer test can reproduce
   * RFC 8291 Appendix A byte for byte.
   */
  salt?: Bytes;
  senderKeyPair?: CryptoKeyPair;
};

/**
 * Encrypt `plaintext` for one subscription and return the complete
 * `aes128gcm` request body.
 *
 * Throws {@link PushError} with code `invalid_subscription` for unusable keys
 * and `payload_too_large` for an over-budget plaintext. It never throws
 * anything else for input it can characterize — `sendPush` relies on that to
 * turn bad rows into typed results instead of exceptions.
 */
export async function encryptPushPayload(
  plaintext: string | Uint8Array,
  keys: SubscriptionKeys,
  options: EncryptPushPayloadOptions = {},
): Promise<Bytes> {
  const message = typeof plaintext === "string" ? utf8(plaintext) : (plaintext as Bytes);

  if (message.length > MAX_PUSH_PLAINTEXT_BYTES) {
    // Caught here rather than at the push service, which would answer with an
    // opaque 413 long after the fact.
    throw new PushError(
      "payload_too_large",
      `Push payload is ${message.length} bytes; the aes128gcm limit is ${MAX_PUSH_PLAINTEXT_BYTES}`,
    );
  }

  const uaPublic = decodeFixed(
    keys.p256dh,
    "subscription p256dh",
    P256_UNCOMPRESSED_LENGTH,
    "invalid_subscription",
  );
  const authSecret = decodeFixed(
    keys.auth,
    "subscription auth secret",
    AUTH_SECRET_LENGTH,
    "invalid_subscription",
  );

  // importKey is where a 65-byte blob that isn't actually a point on the curve
  // is rejected. WebCrypto validates the point; we translate the DOMException
  // into our own typed error so the caller sees "prune/repair this row"
  // instead of an unrecognizable crypto failure.
  let uaPublicKey: CryptoKey;
  try {
    uaPublicKey = await crypto.subtle.importKey(
      "raw",
      uaPublic,
      { name: "ECDH", namedCurve: "P-256" },
      false,
      [],
    );
  } catch {
    throw new PushError(
      "invalid_subscription",
      "subscription p256dh is not a valid P-256 public key",
    );
  }

  // A fresh keypair per message: RFC 8291 §3.1 requires it, and it is what
  // makes the salt/nonce reuse question moot even if a salt ever repeated.
  const senderKeyPair =
    options.senderKeyPair ??
    ((await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
      "deriveBits",
    ])) as CryptoKeyPair);

  const asPublic = new Uint8Array(
    (await crypto.subtle.exportKey("raw", senderKeyPair.publicKey)) as ArrayBuffer,
  );

  const ecdhSecret = new Uint8Array(
    await crypto.subtle.deriveBits(ecdhAlgorithm(uaPublicKey), senderKeyPair.privateKey, 256),
  );

  // RFC 8291 §3.3/§3.4. Order matters: ua_public then as_public.
  const keyInfo = concatBytes(WEBPUSH_INFO, new Uint8Array([0x00]), uaPublic, asPublic);
  const ikm = await hkdfSha256(authSecret, ecdhSecret, keyInfo, 32);

  const salt = options.salt ?? (crypto.getRandomValues(new Uint8Array(16)) as Bytes);
  if (salt.length !== 16) {
    throw new PushError("invalid_subscription", `aes128gcm salt must be 16 bytes, got ${salt.length}`);
  }

  const cek = await hkdfSha256(salt, ikm, CEK_INFO, 16);
  const nonce = await hkdfSha256(salt, ikm, NONCE_INFO, 12);

  const contentKey = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  // 0x02 = "last record" delimiter (RFC 8188 §2). No zero padding follows: we
  // do not pad to a fixed length, so payload length is observable to the push
  // service. That is an accepted trade — the payloads are titles and times by
  // policy (see payload.ts), and padding every message to 4KB would multiply
  // our bandwidth for no secret worth hiding.
  const record = concatBytes(message, new Uint8Array([0x02]));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, contentKey, record),
  );

  const rs = new Uint8Array(4);
  new DataView(rs.buffer).setUint32(0, RECORD_SIZE, /* littleEndian */ false);

  const body = concatBytes(
    salt,
    rs,
    new Uint8Array([P256_UNCOMPRESSED_LENGTH]),
    asPublic,
    ciphertext,
  );

  /* c8 ignore start -- belt-and-braces: MAX_PUSH_PLAINTEXT_BYTES above makes
     this unreachable, but it is the invariant that actually matters and it is
     cheap to assert rather than to trust arithmetic done once in a header. */
  if (body.length > MAX_PUSH_BODY_BYTES) {
    throw new PushError(
      "payload_too_large",
      `Encrypted push body is ${body.length} bytes; the limit is ${MAX_PUSH_BODY_BYTES}`,
    );
  }
  /* c8 ignore stop */

  return body;
}
