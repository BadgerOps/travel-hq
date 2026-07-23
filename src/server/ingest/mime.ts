export type ParsedEmail = {
  from: string | null;
  subject: string | null;
  textBody: string | null;
  calendars: string[];
};

/**
 * A deliberately narrow MIME reader for stored confirmation mail. It extracts
 * only the first text/plain body and text/calendar parts, including nested
 * multiparts. Unknown parts are ignored.
 */
export function parseMime(raw: string): ParsedEmail {
  const root = splitPart(raw);
  const fromRaw = headerValue(root.headers, "from");
  const parsed: ParsedEmail = {
    from: fromRaw === null ? null : (fromRaw.match(/<([^>]+)>/)?.[1] ?? fromRaw),
    subject: headerValue(root.headers, "subject"),
    textBody: null,
    calendars: [],
  };
  walk(root.headers, root.body, parsed);
  return parsed;
}

function walk(headers: string, body: string, out: ParsedEmail): void {
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
      walk(inner.headers, inner.body, out);
    }
    return;
  }

  if (contentType.startsWith("text/calendar")) {
    const calendar = decode(body, encoding).trim();
    if (calendar !== "") out.calendars.push(calendar);
    return;
  }

  if (contentType.startsWith("text/plain") && out.textBody === null) {
    const text = decode(body, encoding).trim();
    out.textBody = text === "" ? null : text;
  }
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
