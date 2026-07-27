import { Fragment } from "react";
import type { ReactNode } from "react";
import { formatMoney } from "../lib/money.js";

/**
 * Renders a stored/extracted record as readable label–value rows instead of a
 * JSON dump. Keys are humanized ("waterParkOpen" → "Water park open"),
 * booleans become Yes/No, `…Cents` amounts format as money, and nested
 * records indent under their label. Deep or exotic leaves fall back to
 * compact JSON so nothing is silently dropped.
 */
export function StructuredDetails({
  value,
  omit = [],
}: {
  value: unknown;
  omit?: string[];
}) {
  const entries = presentEntries(value, omit);
  if (entries.length === 0) return null;
  return <EntryList entries={entries} depth={0} />;
}

const MAX_DEPTH = 3;

type Entry = [string, unknown];

function presentEntries(value: unknown, omit: string[]): Entry[] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.entries(value as Record<string, unknown>).filter(
    ([key, entryValue]) =>
      !omit.includes(key) &&
      entryValue !== null &&
      entryValue !== undefined &&
      entryValue !== "",
  );
}

function EntryList({ entries, depth }: { entries: Entry[]; depth: number }) {
  return (
    <dl
      style={{
        display: "grid",
        gridTemplateColumns: "minmax(90px, max-content) minmax(0, 1fr)",
        gap: "5px 14px",
        margin: 0,
        fontSize: 13,
      }}
    >
      {entries.map(([key, value]) => (
        <Fragment key={key}>
          <dt style={{ color: "color-mix(in srgb, var(--color-text) 55%, transparent)" }}>
            {humanizeKey(key)}
          </dt>
          <dd style={{ margin: 0, overflowWrap: "anywhere" }}>
            {renderValue(key, value, depth)}
          </dd>
        </Fragment>
      ))}
    </dl>
  );
}

function renderValue(key: string, value: unknown, depth: number): ReactNode {
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "number") {
    return /cents$/i.test(key) && Number.isInteger(value) ? formatMoney(value) : String(value);
  }
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    if (value.every((item) => item === null || typeof item !== "object")) {
      return value.map((item) => String(item ?? "—")).join(", ");
    }
    return <span style={{ fontFamily: "monospace", fontSize: 12 }}>{JSON.stringify(value)}</span>;
  }
  if (value !== null && typeof value === "object" && depth < MAX_DEPTH) {
    const nested = presentEntries(value, []);
    if (nested.length === 0) return "—";
    return <EntryList entries={nested} depth={depth + 1} />;
  }
  return <span style={{ fontFamily: "monospace", fontSize: 12 }}>{JSON.stringify(value)}</span>;
}

/** Initialisms that would read wrong in sentence case ("Origin iata"). */
const UPPER = new Set(["iata", "id", "url", "tz", "utc", "rv", "koa"]);

function humanizeKey(key: string): string {
  const words = key
    .replace(/[_-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .trim()
    .split(/\s+/)
    .map((word) => (UPPER.has(word.toLowerCase()) ? word.toUpperCase() : word.toLowerCase()));
  if (words.length === 0) return key;
  words[0] = words[0]!.charAt(0).toUpperCase() + words[0]!.slice(1);
  return words.join(" ");
}
