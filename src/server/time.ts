/**
 * The single definition of "a valid timestamp" and "a valid IANA timezone"
 * for this codebase. Previously copy-pasted in three places --
 * `routes/trips.ts` (the HTTP boundary), `repos/booking.ts`
 * (`assertTimezonePaired`, the repo-level belt-and-braces check), and
 * `ingest/extracted.ts` (every extractor's shared funnel) -- which is exactly
 * the kind of duplication that lets three copies quietly drift apart.
 *
 * That would matter more than usual here: the day-view skip-asymmetry
 * documented on `BookingRepo.listByTrip` and `ItineraryRepo.group()` (see
 * also docs/BACKLOG.md) depends on all three call sites agreeing about what
 * counts as valid. If one copy started accepting a string the others reject,
 * a row could pass the write-time check under one definition and still brick
 * `ItineraryRepo.group()`'s `localDateOf()` under another.
 *
 * `Intl.supportedValuesOf("timeZone")` would be the more direct check for
 * `isValidTimezone` but isn't universally available across runtimes;
 * constructing an `Intl.DateTimeFormat` with the candidate zone and catching
 * the throw is the portable equivalent.
 */
export function isValidTimestamp(value: string): boolean {
  return !Number.isNaN(Date.parse(value));
}

export function isValidTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: value });
    return true;
  } catch {
    return false;
  }
}
