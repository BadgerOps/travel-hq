import { describe, it, expect } from "vitest";
import { Keyring, loadKeyring, mask } from "../../../src/server/crypto/envelope.js";

function randomKey(): Uint8Array<ArrayBuffer> {
  return crypto.getRandomValues(new Uint8Array(32));
}

function keyToB64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

const key = randomKey();
const ring = new Keyring("server-v1", { "server-v1": key });

describe("envelope", () => {
  it("round-trips a value", async () => {
    const env = await ring.encrypt("C03X72119");
    expect(await ring.decrypt(env)).toBe("C03X72119");
  });

  it("produces different ciphertext for the same plaintext", async () => {
    expect(await ring.encrypt("same")).not.toBe(await ring.encrypt("same"));
  });

  it("tags the envelope with the key id and format", async () => {
    const env = await ring.encrypt("x");
    expect(env.startsWith("v1.server-v1.")).toBe(true);
    // Four dot-separated parts: format, keyId, iv, ct+tag.
    expect(env.split(".")).toHaveLength(4);
  });

  it("can decrypt under an older key after rotation", async () => {
    const oldEnv = await ring.encrypt("legacy");
    const rotated = new Keyring("server-v2", {
      "server-v1": key,
      "server-v2": randomKey(),
    });
    expect(await rotated.decrypt(oldEnv)).toBe("legacy");
    expect((await rotated.encrypt("new")).startsWith("v1.server-v2.")).toBe(true);
  });

  it("rejects a tampered envelope", async () => {
    const env = await ring.encrypt("secret");
    const parts = env.split(".");
    // The ciphertext+tag is the 4th part now; corrupt it.
    parts[3] = "AAAAAAAAAAAAAAAAAAAAAA";
    await expect(ring.decrypt(parts.join("."))).rejects.toThrow();
  });

  it("throws on a malformed envelope", async () => {
    await expect(ring.decrypt("not-an-envelope")).rejects.toThrow(/malformed/i);
  });

  it("throws on an unknown key id", async () => {
    await expect(ring.decrypt("v1.nope.AAAA.BBBB")).rejects.toThrow(/unknown key/i);
  });

  it("masks to the last four characters for values longer than four characters", () => {
    expect(mask("C03X72119")).toBe("••••2119");
    expect(mask(null)).toBe(null);
  });

  describe("mask() on short values", () => {
    it("fully masks a value shorter than four characters", () => {
      expect(mask("ab")).toBe("••••••••");
    });
    it("fully masks a value of exactly four characters", () => {
      expect(mask("ABCD")).toBe("••••••••");
    });
    it("fully masks an empty string", () => {
      expect(mask("")).toBe("••••••••");
    });
    it("still reveals the trailing four characters of a longer value", () => {
      expect(mask("ABCDE")).toBe("••••BCDE");
    });
    it("never lets a short mask leak the plaintext it stands in for", () => {
      expect(mask("ab")).not.toContain("ab");
      expect(mask("ABCD")).not.toContain("ABCD");
    });
  });
});

describe("loadKeyring", () => {
  const k1 = keyToB64(randomKey());
  const k2 = keyToB64(randomKey());

  it("parses a single-key secret and uses it as the active key", async () => {
    const ring2 = loadKeyring(`server-v1 ${k1}\n`);
    const env = await ring2.encrypt("hello");
    expect(env.startsWith("v1.server-v1.")).toBe(true);
    expect(await ring2.decrypt(env)).toBe("hello");
  });

  it("treats the last listed line as the active key", async () => {
    const ring2 = loadKeyring(`server-v1 ${k1}\nserver-v2 ${k2}\n`);
    expect((await ring2.encrypt("x")).startsWith("v1.server-v2.")).toBe(true);
  });

  it("ignores blank lines and comments", async () => {
    const ring2 = loadKeyring(`# comment\n\n  \nserver-v1 ${k1}\n`);
    expect((await ring2.encrypt("x")).startsWith("v1.server-v1.")).toBe(true);
  });

  it("rejects a malformed key line", () => {
    expect(() => loadKeyring(`server-v1-with-no-key-value\n`)).toThrow(/malformed/i);
  });

  it("rejects a secret with no keys", () => {
    expect(() => loadKeyring(`\n  \n`)).toThrow(/no keys/i);
  });
});
