import type { Keyring } from "../crypto/envelope.js";
import { log } from "../logging.js";

/**
 * Unseal a stored confirmation number.
 *
 * Both BookingRepo and ItineraryRepo construct Booking objects, so this lives in
 * one place — duplicating an unmasking path is how a plaintext leak gets
 * introduced later.
 */
export async function openConfirmation(ring: Keyring, stored: string | null): Promise<string | null> {
  // `return await`, not a bare `return` of ring.decrypt(...): returning the
  // promise defers its adoption to a later microtask, and workerd's rejection
  // tracker reports that window as an unhandled rejection even when the caller
  // wraps this call in try/catch — which matchableConfirmation below does. See
  // the same note on InboundEmailRepo.markExtracted.
  return stored === null ? null : await ring.decrypt(stored);
}

/**
 * Unseal a confirmation number for *matching* rather than for display.
 *
 * Duplicate detection reads every booking on a trip at once, which makes it
 * the one caller where a single unreadable row is fatal to everything else:
 * an envelope sealed under a key that has since left the keyring (the ordinary
 * end of a key rotation), or a legacy plaintext value, would otherwise reject
 * here and turn the trip's duplicates card — and the entire import review
 * queue, which runs the same comparison against existing bookings — into a
 * 500. Every other read of that same booking already degrades instead: see
 * `BookingRepo.listByTrip` and `ItineraryRepo.group()`.
 *
 * Degrading to `null` rather than dropping the row is deliberate. `null` means
 * "this row offers no confirmation signal", so the title/time/location rules
 * in ../dedupe.ts still get to see it; removing it from the candidate list
 * would silently hide a real duplicate, which is the failure this feature
 * exists to prevent.
 *
 * The booking id is logged, never the stored value or the error's own message
 * — a decrypt failure's detail can echo ciphertext.
 */
export async function matchableConfirmation(
  ring: Keyring,
  stored: string | null,
  bookingId: string,
): Promise<string | null> {
  try {
    return await openConfirmation(ring, stored);
  } catch (err) {
    log.warn("unreadable_confirmation", {
      bookingId,
      reason: (err as Error)?.constructor?.name ?? "unknown",
      usage: "duplicate_matching",
    });
    return null;
  }
}
