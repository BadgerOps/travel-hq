import type { ExtractedBooking } from "../../src/server/ingest/extracted.js";

/**
 * Text equivalent of the supplied Delta PDF, shifted 90 days from the
 * 2026-07-23 request date. The personal PDF itself is never committed.
 */
export const DELTA_ITINERARY_90_DAYS = `
Delta.com Trip Information
Confirmation #: TRIP90

PASSENGERS
Example Traveler
Second Traveler
Third Traveler

FLIGHT 1 OF 3
DL 2586
Boise, ID (BOI) to Minneapolis/St Paul, MN (MSP)
Wednesday, 10/21/2026
DEPART 2:33 PM — Boise Airport
ARRIVE 6:21 PM — Minneapolis-St Paul International Airport

FLIGHT 2 OF 3
DL 162
Minneapolis/St Paul, MN (MSP) to Amsterdam, Netherlands (AMS)
Wednesday, 10/21/2026
DEPART 7:55 PM — Minneapolis-St Paul International Airport
Thursday, 10/22/2026
ARRIVE 11:15 AM — Amsterdam Airport Schiphol

FLIGHT 3 OF 3
DL 9674 operated by German Airways
Amsterdam, Netherlands (AMS) to Stuttgart, Germany (STR)
Thursday, 10/22/2026
DEPART 12:30 PM — Amsterdam Airport Schiphol
ARRIVE 1:45 PM — Stuttgart Airport
`.trim();

export const DELTA_EML_90_DAYS = [
  "From: Delta Air Lines <receipts@delta.example>",
  "To: traveler@example.com",
  "Subject: Delta.com Trip Information",
  "Message-ID: <delta-trip-90@example.test>",
  "MIME-Version: 1.0",
  "Content-Type: text/plain; charset=utf-8",
  "",
  DELTA_ITINERARY_90_DAYS,
].join("\r\n");

export const DELTA_BOOKINGS_90_DAYS = [
  {
    kind: "flight",
    title: "DL 2586: Boise to Minneapolis",
    location: "Boise Airport to Minneapolis-St Paul International Airport",
    startsAt: "2026-10-21T20:33:00.000Z",
    startsAtTz: "America/Boise",
    endsAt: "2026-10-21T23:21:00.000Z",
    endsAtTz: "America/Chicago",
    confirmationNumber: "TRIP90",
    costCents: null,
    details: {
      carrier: "Delta",
      flightNumber: "DL 2586",
      originIata: "BOI",
      destinationIata: "MSP",
    },
  },
  {
    kind: "flight",
    title: "DL 162: Minneapolis to Amsterdam",
    location: "Minneapolis-St Paul International Airport to Amsterdam Airport Schiphol",
    startsAt: "2026-10-22T00:55:00.000Z",
    startsAtTz: "America/Chicago",
    endsAt: "2026-10-22T09:15:00.000Z",
    endsAtTz: "Europe/Amsterdam",
    confirmationNumber: "TRIP90",
    costCents: null,
    details: {
      carrier: "Delta",
      flightNumber: "DL 162",
      originIata: "MSP",
      destinationIata: "AMS",
    },
  },
  {
    kind: "flight",
    title: "DL 9674: Amsterdam to Stuttgart",
    location: "Amsterdam Airport Schiphol to Stuttgart Airport",
    startsAt: "2026-10-22T10:30:00.000Z",
    startsAtTz: "Europe/Amsterdam",
    endsAt: "2026-10-22T11:45:00.000Z",
    endsAtTz: "Europe/Berlin",
    confirmationNumber: "TRIP90",
    costCents: null,
    details: {
      carrier: "German Airways",
      flightNumber: "DL 9674",
      originIata: "AMS",
      destinationIata: "STR",
    },
  },
] satisfies ExtractedBooking[];
