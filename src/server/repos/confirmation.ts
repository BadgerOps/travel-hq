import type { Keyring } from "../crypto/envelope.js";

/**
 * Unseal a stored confirmation number.
 *
 * Both BookingRepo and ItineraryRepo construct Booking objects, so this lives in
 * one place — duplicating an unmasking path is how a plaintext leak gets
 * introduced later.
 */
export async function openConfirmation(ring: Keyring, stored: string | null): Promise<string | null> {
  return stored === null ? null : ring.decrypt(stored);
}
