export type ParsedEmail = {
  from: string | null;
  subject: string | null;
  textBody: string | null;
  calendars: string[];
};

type Collector = {
  plain: string[];
  html: string[];
  calendars: string[];
};

export class MimeParseError extends Error {}
const MAX_MIME_DEPTH = 20;

/**
 * A deliberately narrow MIME reader for stored confirmation mail. It extracts
 * readable text and calendar parts from nested multiparts and attached
 * forwarded messages. HTML is normalized as text; it is never rendered.
 */
export function parseMime(raw: string): ParsedEmail {
  const root = splitPart(raw);
  const fromRaw = headerValue(root.headers, "from");
  const collected: Collector = { plain: [], html: [], calendars: [] };
  walk(root.headers, root.body, collected);
  return {
    from: fromRaw === null ? null : (fromRaw.match(/<([^>]+)>/)?.[1] ?? fromRaw),
    subject: headerValue(root.headers, "subject"),
    textBody: joinText([...collected.plain, ...collected.html]),
    calendars: collected.calendars,
  };
}

function walk(headers: string, body: string, out: Collector, depth = 0): void {
  if (depth > MAX_MIME_DEPTH) {
    throw new MimeParseError(`MIME nesting exceeds ${MAX_MIME_DEPTH} levels`);
  }
  const contentTypeRaw = headerValue(headers, "content-type") ?? "text/plain";
  const contentType = contentTypeRaw.toLowerCase();
  const encoding = headerValue(headers, "content-transfer-encoding");

  if (contentType.startsWith("multipart/")) {
    // Boundaries are case-sensitive, so extract from the original value.
    const boundary = contentTypeRaw.match(/boundary\s*=\s*(?:"([^"]+)"|([^;\s]+))/i);
    const token = boundary?.[1] ?? boundary?.[2];
    if (!token) return;
    for (const part of splitMultipart(body, token)) {
      const inner = splitPart(part);
      walk(inner.headers, inner.body, out, depth + 1);
    }
    return;
  }

  if (contentType.startsWith("message/rfc822")) {
    const nestedRaw = decode(body, encoding);
    const nested = splitPart(nestedRaw);
    const subject = headerValue(nested.headers, "subject");
    const fromRaw = headerValue(nested.headers, "from");
    const from = fromRaw?.match(/<([^>]+)>/)?.[1] ?? fromRaw;
    const metadata = [
      subject ? `Forwarded subject: ${subject}` : "",
      from ? `Forwarded from: ${from}` : "",
    ].filter(Boolean).join("\n");
    if (metadata) out.plain.push(metadata);
    walk(nested.headers, nested.body, out, depth + 1);
    return;
  }

  if (contentType.startsWith("text/calendar")) {
    const calendar = decode(body, encoding).trim();
    if (calendar !== "") out.calendars.push(calendar);
    return;
  }

  if (contentType.startsWith("text/plain")) {
    const text = decode(body, encoding).trim();
    if (text !== "") out.plain.push(text);
    return;
  }

  if (contentType.startsWith("text/html")) {
    const text = htmlToText(decode(body, encoding));
    if (text !== "") out.html.push(text);
  }
}

function joinText(parts: string[]): string | null {
  const unique = [...new Set(parts.map((part) => part.trim()).filter(Boolean))];
  return unique.length > 0 ? unique.join("\n\n") : null;
}

/** Converts confirmation HTML into prompt text without a DOM or execution. */
function htmlToText(html: string): string {
  const withoutActiveContent = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|head)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ");
  const structured = withoutActiveContent
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(?:p|div|section|article|header|footer|h[1-6]|tr|li)\s*>/gi, "\n")
    .replace(/<\/(?:td|th)\s*>/gi, "\t")
    .replace(/<li\b[^>]*>/gi, "• ")
    .replace(/<[^>]+>/g, " ");
  return decodeHtmlEntities(structured)
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.replace(/[ \t\f\v]+/g, " ").trim())
    .filter(Boolean)
    .join("\n")
    .trim();
}

function decodeHtmlEntities(text: string): string {
  const named: Record<string, string> = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    nbsp: " ",
    quot: '"',
    ndash: "–",
    mdash: "—",
  };
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, key: string) => {
    if (key[0] !== "#") return named[key.toLowerCase()] ?? entity;
    const hex = key[1]?.toLowerCase() === "x";
    const point = Number.parseInt(key.slice(hex ? 2 : 1), hex ? 16 : 10);
    if (!Number.isInteger(point) || point < 0 || point > 0x10ffff) return entity;
    try {
      return String.fromCodePoint(point);
    } catch {
      return entity;
    }
  });
}

function splitMultipart(body: string, boundary: string): string[] {
  const delimiter = `--${boundary}`;
  const lines = body.replace(/\r\n/g, "\n").split("\n");
  const parts: string[] = [];
  let current: string[] | null = null;
  for (const line of lines) {
    if (line === delimiter || line === `${delimiter}--`) {
      if (current) parts.push(current.join("\r\n"));
      current = line.endsWith("--") ? null : [];
      if (line.endsWith("--")) break;
    } else if (current) {
      current.push(line);
    }
  }
  if (current?.length) parts.push(current.join("\r\n"));
  return parts.filter((part) => part.trim() !== "");
}

function splitPart(raw: string): { headers: string; body: string } {
  const match = raw.match(/\r?\n\r?\n/);
  if (!match || match.index === undefined) return { headers: "", body: raw };
  return {
    headers: raw.slice(0, match.index),
    body: raw.slice(match.index + match[0].length),
  };
}

function headerValue(headers: string, name: string): string | null {
  const unfolded = headers.replace(/\r?\n[ \t]+/g, " ");
  const target = name.toLowerCase();
  for (const line of unfolded.split(/\r?\n/)) {
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    if (line.slice(0, colon).trim().toLowerCase() === target) {
      return line.slice(colon + 1).trim();
    }
  }
  return null;
}

function decode(body: string, encoding: string | null): string {
  const kind = encoding?.trim().toLowerCase();
  if (kind === "base64") {
    try {
      const compact = body.replace(/\s/g, "");
      const binary = atob(compact);
      return new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
    } catch {
      return "";
    }
  }
  if (kind === "quoted-printable") {
    const unfolded = body.replace(/=\r?\n/g, "");
    const bytes: number[] = [];
    for (let i = 0; i < unfolded.length; i++) {
      if (unfolded[i] === "=" && /^[0-9a-f]{2}$/i.test(unfolded.slice(i + 1, i + 3))) {
        bytes.push(Number.parseInt(unfolded.slice(i + 1, i + 3), 16));
        i += 2;
      } else {
        bytes.push(unfolded.charCodeAt(i));
      }
    }
    return new TextDecoder().decode(Uint8Array.from(bytes));
  }
  return body;
}
