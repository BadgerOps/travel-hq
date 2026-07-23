/**
 * A short, curated zone list rather than `Intl.supportedValuesOf("timeZone")`
 * — that returns ~600 entries, which is an unusable <select>, and it is not
 * available on every runtime (the server code avoids it for the same reason).
 * Shared by the booking dialog and the import review's edit form so the two
 * timezone pickers cannot drift apart.
 */
export const COMMON_ZONES = [
  "America/Los_Angeles",
  "America/Denver",
  "America/Boise",
  "America/Chicago",
  "America/New_York",
  "Europe/London",
  "Europe/Paris",
  "Asia/Tokyo",
  "Australia/Sydney",
  "Pacific/Honolulu",
  "UTC",
];

/**
 * The options for a timezone <select>: the viewer's own zone first (so the
 * common case is one click), then any zones already stored on the record
 * being edited (an extracted draft can name a zone the curated list does not
 * — dropping it from the options would silently rewrite the draft), then the
 * curated list. De-duplicated, order-preserving.
 */
export function zoneOptions(...current: (string | null | undefined)[]): string[] {
  const local = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const zone of [local, ...current, ...COMMON_ZONES]) {
    if (typeof zone !== "string" || zone === "" || seen.has(zone)) continue;
    seen.add(zone);
    out.push(zone);
  }
  return out;
}
