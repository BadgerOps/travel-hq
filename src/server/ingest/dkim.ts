/**
 * Narrow RFC 6376 verifier for the Email Routing missing-verdict fallback.
 *
 * The fallback accepts RSA/SHA-256 only, requires strict signing-domain
 * alignment, rejects partial-body signatures, and resolves keys through an
 * injected TXT resolver. Web Crypto performs all hashing and verification.
 */

export type DnsTxtResolver = (name: string) => Promise<string[][]>;
export type DkimVerdict = { ok: true } | { ok: false; reason: string };

const MAX_DKIM_SIGNATURES = 10;
const MAX_CLOCK_SKEW_SECONDS = 300;
const MIN_RSA_BITS = 1024;
const textEncoder = new TextEncoder();

type HeaderField = {
  name: string;
  raw: string;
  value: string;
};

type ParsedMessage = {
  headers: HeaderField[];
  body: string;
};

export async function verifyAlignedDkim(
  raw: string,
  envelopeFrom: string,
  resolver: DnsTxtResolver = resolveDnsTxt,
): Promise<DkimVerdict> {
  try {
    const message = parseMessage(raw);
    const signatures = message.headers.filter(
      (header) => header.name.toLowerCase() === "dkim-signature",
    );
    if (signatures.length > MAX_DKIM_SIGNATURES) {
      return {
        ok: false,
        reason: `Cloudflare authentication verdict unavailable; message has more than ${MAX_DKIM_SIGNATURES} DKIM signatures`,
      };
    }

    const outerFrom = parseSingleFrom(message.headers);
    const normalizedEnvelope = normalizeMailbox(envelopeFrom);
    if (outerFrom === null || normalizedEnvelope === null || outerFrom !== normalizedEnvelope) {
      return {
        ok: false,
        reason:
          "Cloudflare authentication verdict unavailable; outer From must be one address matching the envelope sender",
      };
    }

    for (const signature of signatures) {
      try {
        if (await verifySignature(message, signature, outerFrom, resolver)) {
          return { ok: true };
        }
      } catch (err) {
        // A message can carry signatures from several transit systems. One
        // malformed, stale, or unresolvable signature must not suppress a
        // later independently valid aligned signature.
        console.warn("[email-ingest] ignored invalid DKIM signature", err);
      }
    }
    return {
      ok: false,
      reason:
        "Cloudflare authentication verdict unavailable; sender did not pass independent aligned DKIM authentication",
    };
  } catch (err) {
    console.warn("[email-ingest] independent DKIM verifier failed", err);
    return {
      ok: false,
      reason:
        "Cloudflare authentication verdict unavailable; independent DKIM verification could not be completed",
    };
  }
}

async function verifySignature(
  message: ParsedMessage,
  signatureHeader: HeaderField,
  outerFrom: string,
  resolver: DnsTxtResolver,
): Promise<boolean> {
  const tags = parseTagList(signatureHeader.value);
  if (
    tags.get("v") !== "1" ||
    tags.get("a")?.toLowerCase() !== "rsa-sha256" ||
    tags.has("l")
  ) {
    return false;
  }

  const domain = normalizeDomain(tags.get("d"));
  const selector = tags.get("s")?.trim();
  const signature = decodeBase64(tags.get("b"));
  const expectedBodyHash = tags.get("bh")?.replace(/[ \t]/g, "");
  const signedHeaderNames = tags.get("h")
    ?.split(":")
    .map((name) => name.trim().toLowerCase())
    .filter(Boolean);
  if (
    domain === null ||
    selector === undefined ||
    !validDnsLabelSequence(selector) ||
    signature === null ||
    !expectedBodyHash ||
    !signedHeaderNames?.includes("from") ||
    signedHeaderNames.includes("dkim-signature")
  ) {
    return false;
  }

  const fromDomain = outerFrom.slice(outerFrom.lastIndexOf("@") + 1);
  if (domain !== fromDomain) return false;

  const queryMethods = tags.get("q");
  if (
    queryMethods !== undefined &&
    !queryMethods.split(":").some((method) => method.trim().toLowerCase() === "dns/txt")
  ) {
    return false;
  }

  const identity = tags.get("i");
  if (identity !== undefined) {
    const at = identity.lastIndexOf("@");
    const identityDomain = normalizeDomain(at === -1 ? undefined : identity.slice(at + 1));
    if (
      identityDomain === null ||
      (identityDomain !== domain && !identityDomain.endsWith(`.${domain}`))
    ) {
      return false;
    }
  }

  const now = Math.floor(Date.now() / 1000);
  const signedAt = parseTimestamp(tags.get("t"));
  const expiresAt = parseTimestamp(tags.get("x"));
  if (
    signedAt === null ||
    expiresAt === null ||
    (signedAt !== undefined && signedAt > now + MAX_CLOCK_SKEW_SECONDS) ||
    (expiresAt !== undefined && expiresAt <= now) ||
    (signedAt !== undefined && expiresAt !== undefined && expiresAt < signedAt)
  ) {
    return false;
  }

  const [headerMode, bodyMode] = parseCanonicalization(tags.get("c"));
  if (headerMode === null || bodyMode === null) return false;
  const canonicalBody = canonicalizeBody(message.body, bodyMode);
  const bodyHash = await crypto.subtle.digest("SHA-256", textEncoder.encode(canonicalBody));
  if (encodeBase64(new Uint8Array(bodyHash)) !== expectedBodyHash) return false;

  const signingInput = selectSignedHeaders(message.headers, signedHeaderNames)
    .map((header) => canonicalizeHeader(header.raw, headerMode, true))
    .join("");
  const withoutSignatureValue = removeSignatureValue(signatureHeader.raw);
  if (withoutSignatureValue === null) return false;
  const canonicalDkim = canonicalizeHeader(withoutSignatureValue, headerMode, false);

  const records = await resolver(`${selector}._domainkey.${domain}`);
  const keyRecord = singleKeyRecord(records);
  if (keyRecord === null) return false;
  const keyTags = parseTagList(keyRecord);
  if (
    (keyTags.get("v") !== undefined && keyTags.get("v") !== "DKIM1") ||
    (keyTags.get("k") ?? "rsa").toLowerCase() !== "rsa" ||
    keyTags.get("p") === undefined ||
    keyTags.get("p") === ""
  ) {
    return false;
  }
  const allowedHashes = keyTags.get("h");
  if (
    allowedHashes !== undefined &&
    !allowedHashes.split(":").some((hash) => hash.trim().toLowerCase() === "sha256")
  ) {
    return false;
  }
  const services = keyTags.get("s");
  if (
    services !== undefined &&
    !services.split(":").some((service) => ["*", "email"].includes(service.trim()))
  ) {
    return false;
  }

  const publicKeyBytes = decodeBase64(keyTags.get("p"));
  if (publicKeyBytes === null) return false;
  const publicKey = await crypto.subtle.importKey(
    "spki",
    asArrayBuffer(publicKeyBytes),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const algorithm = publicKey.algorithm as unknown as { modulusLength: number };
  if (algorithm.modulusLength < MIN_RSA_BITS) return false;

  return crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    publicKey,
    asArrayBuffer(signature),
    textEncoder.encode(signingInput + canonicalDkim),
  );
}

function parseMessage(raw: string): ParsedMessage {
  const normalized = raw.replace(/\r\n|\r|\n/g, "\r\n");
  const separator = normalized.indexOf("\r\n\r\n");
  if (separator === -1) throw new Error("message has no header/body separator");
  const headerBlock = normalized.slice(0, separator);
  const body = normalized.slice(separator + 4);
  const fields: HeaderField[] = [];

  for (const line of headerBlock.split("\r\n")) {
    if (/^[ \t]/.test(line)) {
      const current = fields.at(-1);
      if (!current) throw new Error("orphaned header continuation");
      current.raw += `\r\n${line}`;
      current.value += `\r\n${line}`;
      continue;
    }
    const colon = line.indexOf(":");
    if (colon <= 0) throw new Error("malformed message header");
    fields.push({
      name: line.slice(0, colon),
      raw: line,
      value: line.slice(colon + 1),
    });
  }
  return { headers: fields, body };
}

function parseSingleFrom(headers: HeaderField[]): string | null {
  const fromHeaders = headers.filter((header) => header.name.toLowerCase() === "from");
  if (fromHeaders.length !== 1) return null;
  const value = unfold(fromHeaders[0]!.value).trim();
  const angleMatches = [...value.matchAll(/<([^<>]+)>/g)];
  if (angleMatches.length === 1) {
    const outside = value.replace(angleMatches[0]![0], "").trim();
    if (/[<>:;]/.test(outside)) return null;
    return normalizeMailbox(angleMatches[0]![1]!);
  }
  if (angleMatches.length > 0 || /[<>,:;]/.test(value)) return null;
  return normalizeMailbox(value);
}

function normalizeMailbox(value: string): string | null {
  const address = value.trim().toLowerCase();
  const at = address.lastIndexOf("@");
  if (at <= 0 || address.indexOf("@") !== at) return null;
  const local = address.slice(0, at);
  const domain = normalizeDomain(address.slice(at + 1));
  if (
    domain === null ||
    !/^[a-z0-9!#$%&'*+/=?^_`{|}~.-]+$/i.test(local) ||
    local.startsWith(".") ||
    local.endsWith(".") ||
    local.includes("..")
  ) {
    return null;
  }
  return `${local}@${domain}`;
}

function normalizeDomain(value: string | undefined): string | null {
  if (value === undefined) return null;
  const domain = value.trim().toLowerCase().replace(/\.$/, "");
  return validDnsLabelSequence(domain) ? domain : null;
}

function validDnsLabelSequence(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 253 &&
    value.split(".").every(
      (label) =>
        label.length > 0 &&
        label.length <= 63 &&
        /^[a-z0-9_-]+$/i.test(label) &&
        !label.startsWith("-") &&
        !label.endsWith("-"),
    )
  );
}

function parseTagList(value: string): Map<string, string> {
  const tags = new Map<string, string>();
  for (const part of unfold(value).split(";")) {
    if (part.trim() === "") continue;
    const equals = part.indexOf("=");
    if (equals <= 0) throw new Error("malformed DKIM tag");
    const name = part.slice(0, equals).trim().toLowerCase();
    if (!/^[a-z][a-z0-9_]*$/.test(name) || tags.has(name)) {
      throw new Error("invalid or duplicate DKIM tag");
    }
    tags.set(name, part.slice(equals + 1).trim());
  }
  return tags;
}

function parseCanonicalization(
  value: string | undefined,
): ["simple" | "relaxed" | null, "simple" | "relaxed" | null] {
  const [header = "simple", body = "simple", extra] = (value ?? "simple/simple")
    .toLowerCase()
    .split("/");
  const valid = (mode: string): mode is "simple" | "relaxed" =>
    mode === "simple" || mode === "relaxed";
  return [
    extra === undefined && valid(header) ? header : null,
    extra === undefined && valid(body) ? body : null,
  ];
}

function canonicalizeBody(body: string, mode: "simple" | "relaxed"): string {
  const lines = body.split("\r\n");
  const canonical = mode === "relaxed"
    ? lines.map((line) => line.replace(/[ \t]+/g, " ").replace(/[ \t]+$/, ""))
    : lines;
  while (canonical.at(-1) === "") canonical.pop();
  if (canonical.length === 0) return mode === "relaxed" ? "" : "\r\n";
  return `${canonical.join("\r\n")}\r\n`;
}

function selectSignedHeaders(headers: HeaderField[], names: string[]): HeaderField[] {
  const used = new Map<string, number>();
  return names.flatMap((name) => {
    const matches = headers.filter((header) => header.name.toLowerCase() === name);
    const alreadyUsed = used.get(name) ?? 0;
    used.set(name, alreadyUsed + 1);
    const selected = matches[matches.length - 1 - alreadyUsed];
    return selected ? [selected] : [];
  });
}

function canonicalizeHeader(
  raw: string,
  mode: "simple" | "relaxed",
  trailingCrlf: boolean,
): string {
  if (mode === "simple") return raw + (trailingCrlf ? "\r\n" : "");
  const colon = raw.indexOf(":");
  if (colon <= 0) throw new Error("malformed signed header");
  const name = raw.slice(0, colon).trim().toLowerCase();
  const value = unfold(raw.slice(colon + 1))
    .replace(/[ \t]+/g, " ")
    .trim();
  return `${name}:${value}${trailingCrlf ? "\r\n" : ""}`;
}

function removeSignatureValue(raw: string): string | null {
  const colon = raw.indexOf(":");
  if (colon <= 0) return null;
  const value = raw.slice(colon + 1);
  let found = false;
  const stripped = value.replace(
    /(^|;)([ \t\r\n]*b[ \t\r\n]*=)[ \t\r\n]*[a-z0-9+/= \t\r\n]*(?=;|$)/i,
    (_match, separator: string, prefix: string) => {
      found = true;
      return separator + prefix;
    },
  );
  return found ? `${raw.slice(0, colon + 1)}${stripped}` : null;
}

function singleKeyRecord(records: string[][]): string | null {
  const joined = records.map((parts) => parts.join(""));
  return joined.length === 1 ? joined[0]! : null;
}

function unfold(value: string): string {
  return value.replace(/\r\n[ \t]+/g, " ");
}

function parseTimestamp(value: string | undefined): number | undefined | null {
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value.trim())) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function decodeBase64(value: string | undefined): Uint8Array | null {
  if (value === undefined) return null;
  const compact = value.replace(/[ \t\r\n]/g, "");
  if (
    compact === "" ||
    compact.length % 4 === 1 ||
    !/^[a-z0-9+/]*={0,2}$/i.test(compact)
  ) {
    return null;
  }
  try {
    const padded = compact.padEnd(Math.ceil(compact.length / 4) * 4, "=");
    const binary = atob(padded);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

function encodeBase64(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function asArrayBuffer(value: Uint8Array): ArrayBuffer {
  return value.buffer.slice(
    value.byteOffset,
    value.byteOffset + value.byteLength,
  ) as ArrayBuffer;
}

type DnsJsonResponse = {
  Status?: number;
  Answer?: Array<{ type?: number; data?: string }>;
};

/** Resolves DKIM TXT records without relying on unavailable Worker DNS APIs. */
export const resolveDnsTxt: DnsTxtResolver = async (name) => {
  if (!validDnsLabelSequence(name)) {
    throw dnsError("EINVAL", "invalid DKIM DNS query");
  }

  const url = new URL("https://cloudflare-dns.com/dns-query");
  url.searchParams.set("name", name);
  url.searchParams.set("type", "TXT");
  const response = await fetch(url, {
    headers: { Accept: "application/dns-json" },
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) {
    throw dnsError("ESERVFAIL", `DNS over HTTPS returned ${response.status}`);
  }

  const payload = (await response.json()) as DnsJsonResponse;
  if (payload.Status === 3) throw dnsError("ENOTFOUND", "DKIM key name does not exist");
  if (payload.Status !== 0) throw dnsError("ESERVFAIL", "DNS over HTTPS lookup failed");
  const answers = (payload.Answer ?? [])
    .filter((answer) => answer.type === 16 && typeof answer.data === "string")
    .map((answer) => parseDnsTxt(answer.data!));
  if (answers.length === 0) throw dnsError("ENODATA", "DKIM key TXT record does not exist");
  return answers;
};

function parseDnsTxt(data: string): string[] {
  const quoted = [...data.matchAll(/"((?:\\.|[^"\\])*)"/g)].map((match) =>
    match[1]!.replace(/\\(\d{3}|.)/g, (_whole, escaped: string) =>
      /^\d{3}$/.test(escaped)
        ? String.fromCharCode(Number.parseInt(escaped, 10))
        : escaped,
    ),
  );
  return quoted.length > 0 ? quoted : [data];
}

function dnsError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}
