const FORMAT = "v1";
const IV_BYTES = 12;

function bytesToB64url(bytes: Uint8Array<ArrayBuffer>): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Explicit `<ArrayBuffer>` generics below: a bare `Uint8Array` type
// annotation resolves to `Uint8Array<ArrayBufferLike>` (which includes
// SharedArrayBuffer), and workerd's `BufferSource` (from
// @cloudflare/workers-types) only accepts views backed by a concrete
// `ArrayBuffer`. Pinning the parameter keeps these values assignable
// directly to `crypto.subtle.importKey`/`encrypt`/`decrypt` without casts.
function b64urlToBytes(b64url: string): Uint8Array<ArrayBuffer> {
  const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function b64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export class Keyring {
  constructor(
    private readonly activeKeyId: string,
    private readonly keys: Record<string, Uint8Array<ArrayBuffer>>,
  ) {
    if (!keys[activeKeyId]) {
      throw new Error(`Active key "${activeKeyId}" is not present in the keyring`);
    }
    for (const [id, key] of Object.entries(keys)) {
      if (key.length !== 32) {
        throw new Error(`Key "${id}" must be 32 bytes, got ${key.length}`);
      }
    }
  }

  private importKey(id: string): Promise<CryptoKey> {
    // Imported per operation. Workers have no node:crypto; a raw AES-GCM key is
    // non-extractable and used only for encrypt/decrypt.
    return crypto.subtle.importKey("raw", this.keys[id]!, "AES-GCM", false, [
      "encrypt",
      "decrypt",
    ]);
  }

  async encrypt(plaintext: string): Promise<string> {
    const key = await this.importKey(this.activeKeyId);
    const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
    // WebCrypto AES-GCM returns ciphertext WITH the auth tag appended.
    const ctAndTag = new Uint8Array(
      await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plaintext)),
    );
    return [FORMAT, this.activeKeyId, bytesToB64url(iv), bytesToB64url(ctAndTag)].join(".");
  }

  async decrypt(envelope: string): Promise<string> {
    const parts = envelope.split(".");
    if (parts.length !== 4 || parts[0] !== FORMAT) {
      throw new Error("Malformed encryption envelope");
    }
    const [, keyId, ivB64, ctB64] = parts as [string, string, string, string];
    if (!this.keys[keyId]) {
      throw new Error(`Cannot decrypt: unknown key id "${keyId}"`);
    }
    const key = await this.importKey(keyId);
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: b64urlToBytes(ivB64) },
      key,
      b64urlToBytes(ctB64),
    );
    return new TextDecoder().decode(plaintext);
  }
}

/**
 * A fixed-width stand-in for a value too short to safely mask by trailing
 * characters. Carries no plaintext at all — every character is the mask
 * glyph — so it can't be told apart from another short secret of a
 * different length or content.
 */
const FULLY_MASKED = "••••••••";

/**
 * Mask a plaintext value for display. Never pass an envelope to this.
 *
 * Values of 4 characters or fewer are masked in full: `plaintext.slice(-4)`
 * on a 4-character (or shorter) value would echo back the *entire* secret
 * with a decorative prefix, which is not masking at all. Hotel and
 * car-rental confirmation codes are frequently exactly this short.
 */
export function mask(plaintext: string | null): string | null {
  if (plaintext === null) return null;
  if (plaintext.length <= 4) return FULLY_MASKED;
  return `••••${plaintext.slice(-4)}`;
}

/**
 * The character `mask()` composes its output from: U+2022 BULLET. It appears
 * in no real passport, Known Traveler, redress, or confirmation number.
 */
export const MASK_GLYPH = "•";

/**
 * Refuses a value that is plainly a masked display string being handed back
 * as if it were plaintext. Encrypting `••••2119` over a real passport number
 * destroys it silently, with a 200 response and a UI that looks correct;
 * there is no undo and no plaintext copy anywhere.
 *
 * This lives beside `mask()` rather than in one repository because `person`
 * is not the only table at risk: `BookingRepo`'s `toBooking()` masks
 * `confirmationNumber` with the same helper, so the same round-trip bug is
 * available there the moment a component reconstructs a booking body from a
 * list response. One glyph, one guard, one file — they cannot drift apart.
 *
 * It throws a plain `Error`; the repository layer is what turns it into a
 * `ValidationError` (400), because `crypto/` sits below the repo layer and
 * must not import from it.
 */
export function assertNotMasked(field: string, value: string): void {
  if (value.includes(MASK_GLYPH)) {
    throw new Error(
      `${field} looks like a masked placeholder rather than a real value. ` +
        `Omit the field to leave it unchanged, or send null to clear it.`,
    );
  }
}

/**
 * Load the keyring from a secret string (a Workers secret value, not a file).
 * Contains base64 keys, one per line, as `<key_id> <base64-32-bytes>`. The
 * last non-comment line is the active key.
 */
export function loadKeyring(contents: string): Keyring {
  const lines = contents
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"));

  if (lines.length === 0) {
    throw new Error("Encryption key secret contains no keys");
  }

  const keys: Record<string, Uint8Array<ArrayBuffer>> = {};
  let activeKeyId = "";
  for (const line of lines) {
    const [id, b64] = line.split(/\s+/);
    if (!id || !b64) throw new Error("Malformed key line in encryption key secret");
    keys[id] = b64ToBytes(b64);
    activeKeyId = id;
  }
  return new Keyring(activeKeyId, keys);
}
