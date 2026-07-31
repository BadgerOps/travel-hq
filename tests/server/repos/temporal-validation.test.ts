import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { TripRepo } from "../../../src/server/repos/trip.js";
import { ChecklistRepo } from "../../../src/server/repos/checklist.js";
import { PersonRepo } from "../../../src/server/repos/person.js";
import { BookingRepo } from "../../../src/server/repos/booking.js";
import { Keyring } from "../../../src/server/crypto/envelope.js";
import { ValidationError } from "../../../src/server/repos/base.js";
import type { HouseholdContext } from "../../../src/server/repos/base.js";

/**
 * Issue #23. The bug was not that any one check was missing -- it was that
 * create and update disagreed about which checks existed, so which values the
 * API accepted depended on which verb you reached for. Every case below is
 * therefore asserted on BOTH write paths where both exist, and at the
 * REPOSITORY rather than through HTTP, because the email-import path writes
 * trips and bookings without passing a route at all. The matching route-level
 * assertions live in tests/server/routes/temporal-validation.test.ts.
 */

const ring = new Keyring("server-v1", { "server-v1": crypto.getRandomValues(new Uint8Array(32)) });
const owner: HouseholdContext = { householdId: "hh-a", userId: "u1", role: "owner" };

beforeEach(async () => {
  for (const table of [
    "booking_person",
    "checklist_item",
    "booking",
    "trip_person",
    "person",
    "trip",
    "household",
  ]) {
    await env.DB.exec(`DELETE FROM ${table}`);
  }
  const now = new Date().toISOString();
  await env.DB.prepare("INSERT INTO household (id,name,created_at) VALUES (?,?,?)")
    .bind("hh-a", "A", now)
    .run();
  await env.DB.prepare("INSERT INTO trip (id,household_id,title,created_at) VALUES (?,?,?,?)")
    .bind("t1", "hh-a", "Glacier", now)
    .run();
  await env.DB.prepare("INSERT INTO person (id,household_id,display_name,created_at) VALUES (?,?,?,?)")
    .bind("p-ava", "hh-a", "Ava", now)
    .run();
});

const trips = () => new TripRepo(env.DB, owner);
const checklist = () => new ChecklistRepo(env.DB, owner);
const people = () => new PersonRepo(env.DB, owner, ring);
const bookings = () => new BookingRepo(env.DB, owner, ring);

/** The minimum a booking needs, so each test states only what it is about. */
function bookingInput(over: Record<string, unknown> = {}) {
  return {
    tripId: "t1",
    kind: "activity",
    title: "Red Bus tour",
    details: {},
    ...over,
  } as Parameters<BookingRepo["create"]>[0];
}

describe("TripRepo date validation", () => {
  it("accepts a well-formed range on create, including a single-day trip", async () => {
    const trip = await trips().create({
      title: "Glacier",
      startsOn: "2026-10-09",
      endsOn: "2026-10-11",
    });
    expect(trip.startsOn).toBe("2026-10-09");

    const dayTrip = await trips().create({
      title: "Boise",
      startsOn: "2026-10-09",
      endsOn: "2026-10-09",
    });
    expect(dayTrip.endsOn).toBe("2026-10-09");
  });

  it("rejects a date the calendar does not contain, on create as well as update", async () => {
    await expect(
      trips().create({ title: "Glacier", startsOn: "2026-02-30" }),
    ).rejects.toThrow(ValidationError);
    await expect(
      trips().create({ title: "Glacier", endsOn: "2026-02-31" }),
    ).rejects.toThrow(ValidationError);

    const trip = await trips().create({ title: "Glacier" });
    await expect(trips().update(trip.id, { startsOn: "2026-02-30" })).rejects.toThrow(
      ValidationError,
    );
  });

  it("rejects a date that is not YYYY-MM-DD, on create as well as update", async () => {
    for (const startsOn of ["10/09/2026", "next tuesday", "2026-10-09T00:00:00Z", ""]) {
      await expect(trips().create({ title: "Glacier", startsOn })).rejects.toThrow(
        ValidationError,
      );
    }
    const trip = await trips().create({ title: "Glacier" });
    await expect(trips().update(trip.id, { endsOn: "10/09/2026" })).rejects.toThrow(
      ValidationError,
    );
  });

  it("rejects an inverted range on create, which used to be accepted", async () => {
    await expect(
      trips().create({ title: "Glacier", startsOn: "2026-10-11", endsOn: "2026-10-09" }),
    ).rejects.toThrow(ValidationError);
  });

  it("rejects a patch that inverts the range against the STORED half", async () => {
    const trip = await trips().create({
      title: "Glacier",
      startsOn: "2026-10-09",
      endsOn: "2026-10-11",
    });
    // Only endsOn is sent; startsOn comes from the row. A boundary check could
    // not catch this, which is why the repository is the enforcement point.
    await expect(trips().update(trip.id, { endsOn: "2026-10-08" })).rejects.toThrow(
      ValidationError,
    );
    await expect(trips().update(trip.id, { startsOn: "2026-10-12" })).rejects.toThrow(
      ValidationError,
    );
  });

  it("still lets a range be cleared, because null is not a broken date", async () => {
    const trip = await trips().create({
      title: "Glacier",
      startsOn: "2026-10-09",
      endsOn: "2026-10-11",
    });
    const cleared = await trips().update(trip.id, { startsOn: null, endsOn: null });
    expect(cleared.startsOn).toBeNull();
    expect(cleared.endsOn).toBeNull();
  });
});

describe("ChecklistRepo due-date validation", () => {
  it("accepts a well-formed due date", async () => {
    const item = await checklist().create({ tripId: "t1", label: "Pack", dueOn: "2026-10-01" });
    expect(item.dueOn).toBe("2026-10-01");
  });

  it("rejects an impossible or free-text due date", async () => {
    for (const dueOn of ["2026-02-30", "10/01/2026", "next tuesday", "2026-10-01T00:00:00Z"]) {
      await expect(
        checklist().create({ tripId: "t1", label: "Pack", dueOn }),
      ).rejects.toThrow(ValidationError);
    }
  });

  it("still accepts an item with no due date at all", async () => {
    const item = await checklist().create({ tripId: "t1", label: "Pack" });
    expect(item.dueOn).toBeNull();
  });
});

describe("PersonRepo date validation", () => {
  it("rejects an impossible DOB or passport expiry, on create as well as update", async () => {
    await expect(people().create({ displayName: "Ava", dob: "2018-02-30" })).rejects.toThrow(
      ValidationError,
    );
    await expect(
      people().create({ displayName: "Ava", passportExpiry: "2031-13-01" }),
    ).rejects.toThrow(ValidationError);

    const ava = await people().create({ displayName: "Ava", dob: "2018-04-02" });
    await expect(people().update(ava.id, { dob: "04/02/2018" })).rejects.toThrow(ValidationError);
    await expect(
      people().update(ava.id, { passportExpiry: "sometime in 2031" }),
    ).rejects.toThrow(ValidationError);
  });

  it("still lets a date be cleared or left absent", async () => {
    const ava = await people().create({
      displayName: "Ava",
      dob: "2018-04-02",
      passportExpiry: "2031-06-01",
    });
    const cleared = await people().update(ava.id, { dob: null, passportExpiry: null });
    expect(cleared.dob).toBeNull();
    expect(cleared.passportExpiry).toBeNull();

    const untouched = await people().update(ava.id, { displayName: "Ava R." });
    expect(untouched.displayName).toBe("Ava R.");
  });
});

describe("BookingRepo instant validation", () => {
  it("rejects an ambiguous instant on create as well as update", async () => {
    for (const startsAt of [
      "2026-10-09T19:30:00", // a wall clock with no offset
      "2026-10-09Z", // a date pretending to be an instant
      "2026-02-30T19:30:00Z", // a day that does not exist
      "Oct 9 2026 19:30 GMT+00:00", // the legacy parser
    ]) {
      await expect(
        bookings().create(bookingInput({ startsAt, startsAtTz: "America/Denver" })),
      ).rejects.toThrow(ValidationError);
    }

    const booking = await bookings().create(
      bookingInput({ startsAt: "2026-10-09T19:30:00.000Z", startsAtTz: "America/Denver" }),
    );
    await expect(
      bookings().update(booking.id, { startsAt: "2026-02-30T19:30:00Z" }),
    ).rejects.toThrow(ValidationError);
  });

  it("rejects a booking that ends before it starts", async () => {
    await expect(
      bookings().create(
        bookingInput({
          startsAt: "2026-10-09T19:30:00.000Z",
          startsAtTz: "America/Denver",
          endsAt: "2026-10-09T18:30:00.000Z",
          endsAtTz: "America/Denver",
        }),
      ),
    ).rejects.toThrow(ValidationError);
  });

  it("rejects a patch that inverts the range against the STORED half", async () => {
    const booking = await bookings().create(
      bookingInput({
        startsAt: "2026-10-09T19:30:00.000Z",
        startsAtTz: "America/Denver",
        endsAt: "2026-10-09T23:30:00.000Z",
        endsAtTz: "America/Denver",
      }),
    );
    await expect(
      bookings().update(booking.id, { endsAt: "2026-10-09T18:00:00.000Z" }),
    ).rejects.toThrow(ValidationError);
    await expect(
      bookings().update(booking.id, { startsAt: "2026-10-10T08:00:00.000Z" }),
    ).rejects.toThrow(ValidationError);
  });

  it("accepts a cross-timezone leg whose offsets sort backwards as text", async () => {
    // 23:00-08:00 is 07:00Z; 06:00+09:00 the next day is 21:00Z the day before
    // -- ordered as instants, inverted as strings. Comparing the strings would
    // reject an ordinary transpacific red-eye.
    const booking = await bookings().create(
      bookingInput({
        startsAt: "2026-10-09T23:00:00-08:00",
        startsAtTz: "America/Anchorage",
        endsAt: "2026-10-11T06:00:00+09:00",
        endsAtTz: "Asia/Tokyo",
      }),
    );
    expect(booking.endsAt).toBe("2026-10-11T06:00:00+09:00");
  });

  it("accepts a zero-length booking, which is odd but not corrupt", async () => {
    const booking = await bookings().create(
      bookingInput({
        startsAt: "2026-10-09T19:30:00.000Z",
        startsAtTz: "America/Denver",
        endsAt: "2026-10-09T19:30:00.000Z",
        endsAtTz: "America/Denver",
      }),
    );
    expect(booking.endsAt).toBe("2026-10-09T19:30:00.000Z");
  });
});

describe("BookingRepo amount validation", () => {
  it("rejects a negative cost or points total on create as well as update", async () => {
    // The documented decision: these columns are spend and usage, not a signed
    // ledger -- see assertNonNegativeAmount in repos/validation.ts.
    await expect(bookings().create(bookingInput({ costCents: -1 }))).rejects.toThrow(
      ValidationError,
    );
    await expect(bookings().create(bookingInput({ pointsUsed: -25000 }))).rejects.toThrow(
      ValidationError,
    );

    const booking = await bookings().create(bookingInput({ costCents: 12000 }));
    await expect(bookings().update(booking.id, { costCents: -12000 })).rejects.toThrow(
      ValidationError,
    );
    await expect(bookings().update(booking.id, { pointsUsed: -1 })).rejects.toThrow(
      ValidationError,
    );
  });

  it("rejects a fractional amount on create, which only update used to catch", async () => {
    await expect(bookings().create(bookingInput({ costCents: 120.5 }))).rejects.toThrow(
      ValidationError,
    );
  });

  it("still accepts zero, and still lets an amount be cleared", async () => {
    const free = await bookings().create(bookingInput({ costCents: 0, pointsUsed: 0 }));
    expect(free.costCents).toBe(0);

    const cleared = await bookings().update(free.id, { costCents: null, pointsUsed: null });
    expect(cleared.costCents).toBeNull();
    expect(cleared.pointsUsed).toBeNull();
  });
});
