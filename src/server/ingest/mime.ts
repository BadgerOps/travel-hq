/**
 * A deliberately narrow MIME reader for the ingest extractor (#6): the
 * text/plain body, any text/calendar part, and the couple of headers the
 * extraction prompt wants. No dependency — a general-purpose MIME library is
 * a large surface whose failure modes we would not understand, for a problem
 * that is bounded and directly testable here.
 *
 * Spelling note: every regex in this module is used through `str.match(re)` /
 * `re.test(str)`, never the RegExp-side method of the same job —
 * tests/server/architecture.test.ts bans two literal substrings (`.prepare(`
 * and the RegExp method name) everywhere under src/server/ outside repos/,
 * db/, and auth.ts, and it matches text, not types. A non-global `.match`
 * returns the identical RegExpMatchArray, `.index` included, so nothing is
 * lost. Do not "fix" the test to be receiver-qualified; its bluntness is the
 * point.
 */
export type ParsedEmail = {
  from: string | null;
  subject: string | null;
  /** The first text/plain body, or null when the message carried none. */
  textBody: string | null;
  /** Decoded text/calendar parts, in the order they appeared. */
  calendars: string[];
};

/** Splits a raw part into its header block and its body. */
function splitPart(raw: string): { headers: string; body: string } {
  const match = raw.match(/\r?\n\r?\n/);
  if (match?.index === undefined) return { headers: raw, body: "" };
  return {
    headers: raw.slice(0, match.index),
    body: raw.slice(match.index + match[0].length),
  };
}

/** Unfolds continuation lines (a leading space or tab) into their header. */
function unfold(headers: string): string[] {
  return headers.replace(/\r?\n[ \t]+/g, " ").split(/\r?\n/);
}

function headerValue(headers: string, name: string): string | null {
  const lower = name.toLowerCase();
  for (const line of unfold(headers)) {
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    if (line.slice(0, colon).trim().toLowerCase() === lower) {
      return line.slice(colon + 1).trim();
    }
  }
  return null;
}

/**
 * Base64 → UTF-8 without Buffer: src/server compiles against
 * @cloudflare/workers-types only (no node types), and atob + TextDecoder are
 * the Workers-native pair. Throws on garbage input; decode() below treats
 * that as "keep the raw text", which fail-soft ingest prefers to losing the
 * part.
 */
function decodeBase64(value: string): string {
  const binary = atob(value.replace(/\s+/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/** Quoted-printable → UTF-8, byte-accurate (=C3=A9 is one é, not two chars). */
function decodeQuotedPrintable(value: string): string {
  // A trailing `=` before a line break is a soft break, not data.
  const joined = value.replace(/=\r?\n/g, "");
  const bytes: number[] = [];
  let i = 0;
  while (i < joined.length) {
    const hex = joined.slice(i + 1, i + 3);
    if (joined[i] === "=" && /^[0-9A-Fa-f]{2}$/.test(hex)) {
      bytes.push(Number.parseInt(hex, 16));
      i += 3;
    } else {
      bytes.push(joined.charCodeAt(i) & 0xff);
      i += 1;
    }
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

function decode(body: string, encoding: string | null): string {
  const how = (encoding ?? "").trim().toLowerCase();
  try {
    if (how === "base64") return decodeBase64(body);
    if (how === "quoted-printable") return decodeQuotedPrintable(body);
  } catch {
    // Undecodable transfer encoding: fall through to the raw text rather
    // than dropping the part — a parser that throws loses the email.
  }
  return body;
}

/**
 * Parses whatever the ingest handler stored — headers plus body, possibly
 * truncated, possibly not MIME at all. Recurses into nested multiparts,
 * ignores every part it does not need, and never throws.
 */
export function parseMime(raw: string): ParsedEmail {
  const { headers, body } = splitPart(raw);
  const fromRaw = headerValue(headers, "from");
  const result: ParsedEmail = {
    // `"Dawn Ranch" <res@dawnranch.com>` -> `res@dawnranch.com`
    from: fromRaw === null ? null : (fromRaw.match(/<([^>]+)>/)?.[1] ?? fromRaw),
    subject: headerValue(headers, "subject"),
    textBody: null,
    calendars: [],
  };

  walk(headers, body, result);
  return result;
}

function walk(headers: string, body: string, out: ParsedEmail): void {
  // The lowercased value is for TYPE comparisons only. The boundary is
  // matched out of the ORIGINAL header value: boundaries are case-sensitive
  // tokens (`boundary="BOUND1"` delimits lines spelled `--BOUND1`), and
  // extracting it from a lowercased copy silently breaks every multipart
  // whose boundary contains an uppercase letter — the split finds nothing
  // and the whole message walks as one text part.
  const contentTypeRaw = headerValue(headers, "content-type") ?? "text/plain";
  const contentType = contentTypeRaw.toLowerCase();
  const encoding = headerValue(headers, "content-transfer-encoding");

  if (contentType.startsWith("multipart/")) {
    const boundary = contentTypeRaw.match(/boundary="?([^";]+)"?/i)?.[1];
    if (boundary === undefined) return;
    // Split on the delimiter lines rather than on the bare boundary string,
    // so a boundary value appearing inside a body cannot split the message.
    const parts = body.split(new RegExp(`\r?\n?--${escapeRe(boundary)}(?:--)?\r?\n?`));
    for (const part of parts) {
      if (part.trim() === "") continue;
      const inner = splitPart(part);
      walk(inner.headers, inner.body, out);
    }
    return;
  }

  if (contentType.startsWith("text/calendar")) {
    out.calendars.push(decode(body, encoding).trim());
    return;
  }

  // First text/plain wins; text/html is ignored entirely rather than
  // tag-stripped, because a stripped marketing template is worse input for
  // the model than no input at all.
  if (contentType.startsWith("text/plain") && out.textBody === null) {
    const text = decode(body, encoding).trim();
    out.textBody = text === "" ? null : text;
  }
}

function escapeRe(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
