import { daysUntil } from "./dates.js";

/**
 * Many countries require roughly six months' passport validity **beyond the
 * date of arrival** — not beyond today. Measuring from today warns about a
 * passport that is perfectly valid for a trip eight months out and, worse,
 * stays quiet about one that expires two weeks into a trip fourteen months
 * out.
 *
 * This constant and the branch below are the ONLY place in the client that
 * decides whether a passport is a problem. The People page, the Travelers
 * tab, and the trip warning banner all call through here, so they cannot
 * disagree about whether Finn's passport is fine.
 */
const REQUIRED_VALIDITY_DAYS = 183;

export type PassportHolder = {
  id: string;
  displayName: string;
  passportExpiry: string | null;
};

export type PassportStatus = {
  kind: "none" | "ok" | "short" | "expired";
  expiry: string | null;
};

export function passportStatus(
  person: PassportHolder,
  arrivalOn: string | null,
  today: string,
): PassportStatus {
  // `== null` on purpose: partially-shaped Person objects (test fixtures,
  // future optional fields) arrive with the key missing, and undefined must
  // mean "no passport", not a NaN date downstream.
  const expiry = person.passportExpiry;
  if (expiry == null) return { kind: "none", expiry: null };

  // Two different questions, two different reference dates: "is this
  // document already dead?" is measured from today; "will it still be
  // valid long enough when we land?" is measured from arrival.
  if (daysUntil(expiry, today) < 0) return { kind: "expired", expiry };

  const measureFrom = arrivalOn ?? today;
  if (daysUntil(expiry, measureFrom) < REQUIRED_VALIDITY_DAYS) {
    return { kind: "short", expiry };
  }
  return { kind: "ok", expiry };
}

/** The sentence a person can act on, or null when there is nothing to say. */
export function passportWarningText(
  person: PassportHolder,
  status: PassportStatus,
): string | null {
  switch (status.kind) {
    case "expired":
      return `${person.displayName}'s passport expired ${status.expiry}.`;
    case "short":
      return `${person.displayName}'s passport expires ${status.expiry} — under six months' validity at arrival.`;
    default:
      return null;
  }
}
