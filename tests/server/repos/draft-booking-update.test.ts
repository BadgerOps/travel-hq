import { beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { Keyring } from "../../../src/server/crypto/envelope.js";
import {
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from "../../../src/server/repos/base.js";
import type { HouseholdContext } from "../../../src/server/repos/base.js";
import { DraftBookingRepo } from "../../../src/server/repos/draft-booking.js";
import type { CreateDraftBookingInput } from "../../../src/server/repos/draft-booking.js";
import { ImportReviewRepo } from "../../../src/server/repos/import-review.js";
import { InboundEmailRepo } from "../../../src/server/repos/inbound-email.js";
import { TripRepo } from "../../../src/server/repos/trip.js";

const ctx: HouseholdContext = { householdId: "edit-a", userId: "u1", role: "owner" };
const ring = new Keyring("test", { test: crypto.getRandomValues(new Uint8Array(32)) });

beforeEach(async () => {
  await env.DB.exec("DELETE FROM household");
  const now = new Date().toISOString();
  for (const id of ["edit-a", "edit-b"]) {
    await env.DB.prepare("INSERT INTO household (id,name,created_at) VALUES (?,?,?)")
      .bind(id, id, now)
      .run();
  }
});

async function seedDraft(
  householdId = "edit-a",
  overrides: Partial<CreateDraftBookingInput> = {},
) {
  const source = await InboundEmailRepo.forIngest(env.DB, householdId).create({
    from: "receipts@delta.example",
    to: "trips@example.com",
    subject: "Delta.com Trip Information",
    raw: "raw message",
  });
  const [draft] = await DraftBookingRepo.forIngest(env.DB, householdId).createMany([{
    inboundEmailId: source.id,
    ordinal: 0,
    kind: "flight",
    title: "DL 2586",
    location: "DEN → AMS",
    startsAt: "2026-10-21T22:00:00.000Z",
    startsAtTz: "America/Denver",
    endsAt: "2026-10-22T08:00:00.000Z",
    endsAtTz: "Europe/Amsterdam",
    confirmationNumber: "TRIP90",
    source: "ai",
    extracted: {
      costCents: 42_500,
      travelerNames: ["David Apsley"],
      travelerEmails: ["dapsley1@gmail.com"],
      details: {
        carrier: "Delta",
        flightNumber: "2586",
        originIata: "DEN",
        destinationIata: "AMS",
      },
    },
    ...overrides,
  }]);
  return draft!;
}

function repo(householdId = "edit-a", role: HouseholdContext["role"] = "owner") {
  return new DraftBookingRepo(env.DB, { householdId, userId: "u1", role });
}

describe("DraftBookingRepo.update", () => {
  it("corrects the mapped columns and leaves the untouched ones alone", async () => {
    const draft = await seedDraft();
    const updated = await repo().update(draft.id, {
      title: "  Delta 2586  ",
      startsAt: "2026-10-21T23:15:00.000Z",
      confirmationNumber: "ABC123",
    });

    expect(updated).toMatchObject({
      title: "Delta 2586",
      startsAt: "2026-10-21T23:15:00.000Z",
      // Silent in the patch, so the stored zone stays paired with the new time.
      startsAtTz: "America/Denver",
      endsAt: "2026-10-22T08:00:00.000Z",
      location: "DEN → AMS",
      confirmationNumber: "ABC123",
      status: "pending",
    });
  });

  it("clears a value with null and keeps a draft's confirmation number in the clear", async () => {
    const draft = await seedDraft();
    const cleared = await repo().update(draft.id, {
      location: null,
      endsAt: null,
      endsAtTz: null,
      confirmationNumber: null,
    });
    expect(cleared).toMatchObject({
      location: null,
      endsAt: null,
      endsAtTz: null,
      confirmationNumber: null,
    });

    // draft_booking has no envelope column: the accept is what encrypts (see
    // commitDraftsToTrip). Storing ciphertext here would double-encrypt.
    await repo().update(draft.id, { confirmationNumber: "WN88ZZ" });
    expect(
      await env.DB.prepare("SELECT confirmation_number FROM draft_booking WHERE id = ?")
        .bind(draft.id)
        .first(),
    ).toEqual({ confirmation_number: "WN88ZZ" });
  });

  it("patches cost and details into extracted_json without disturbing the travellers beside them", async () => {
    const draft = await seedDraft();
    const updated = await repo().update(draft.id, {
      costCents: 51_000,
      details: { carrier: "Delta", flightNumber: "2586", originIata: "den", destinationIata: "ams", seat: "14C" },
    });

    expect(updated.extracted).toEqual({
      costCents: 51_000,
      // Untouched by the edit — the accept matches people against these.
      travelerNames: ["David Apsley"],
      travelerEmails: ["dapsley1@gmail.com"],
      details: {
        carrier: "Delta",
        flightNumber: "2586",
        // Stored as the schema normalises it, so re-review shows what the
        // booking will actually carry.
        originIata: "DEN",
        destinationIata: "AMS",
        seat: "14C",
      },
    });
  });

  it("commits the edited values, not the extracted ones, when the draft is accepted", async () => {
    const trip = await new TripRepo(env.DB, ctx).create({
      title: "Europe",
      startsOn: "2026-10-20",
      endsOn: "2026-10-30",
    });
    const draft = await seedDraft();
    await repo().update(draft.id, {
      title: "Delta 2586 (rebooked)",
      startsAt: "2026-10-21T23:15:00.000Z",
      confirmationNumber: "ABC123",
      costCents: 51_000,
      details: {
        carrier: "Delta",
        flightNumber: "2586",
        originIata: "DEN",
        destinationIata: "AMS",
        seat: "14C",
      },
    });

    await new ImportReviewRepo(env.DB, ctx, ring).acceptIntoTrip([draft.id], trip.id);

    const booking = await env.DB.prepare(
      "SELECT title, starts_at, cost_cents, details, confirmation_number FROM booking",
    ).first<{
      title: string;
      starts_at: string;
      cost_cents: number;
      details: string;
      confirmation_number: string;
    }>();
    expect(booking).toMatchObject({
      title: "Delta 2586 (rebooked)",
      starts_at: "2026-10-21T23:15:00.000Z",
      cost_cents: 51_000,
    });
    expect(JSON.parse(booking!.details)).toMatchObject({ seat: "14C" });
    // Encrypted by the accept, exactly as it was before edits existed.
    expect(booking!.confirmation_number).not.toBe("ABC123");
    expect(await ring.decrypt(booking!.confirmation_number)).toBe("ABC123");
  });

  it("edits a lodging without demanding a propertyName the accept would have supplied", async () => {
    const draft = await seedDraft("edit-a", {
      kind: "lodging",
      title: "St. Mary / East Glacier KOA",
      extracted: { details: { checkInDate: "2026-08-05", checkOutDate: "2026-08-09" } },
    });
    const updated = await repo().update(draft.id, {
      details: { checkInDate: "2026-08-06", checkOutDate: "2026-08-09", siteNumber: "1896" },
    });
    expect(updated.extracted).toMatchObject({
      details: {
        // Filled from the title by importedDetails(), the same repair the
        // accept makes, so the stored draft and the booking agree.
        propertyName: "St. Mary / East Glacier KOA",
        checkInDate: "2026-08-06",
        siteNumber: "1896",
      },
    });
  });

  it("refuses every value BookingRepo.create would refuse, with the same messages", async () => {
    const draft = await seedDraft();
    const edit = repo();

    await expect(edit.update(draft.id, { startsAtTz: null })).rejects.toThrow(
      "startsAt requires startsAtTz (an IANA timezone)",
    );
    await expect(edit.update(draft.id, { startsAt: "2026-10-21T22:00:00" })).rejects.toThrow(
      "startsAt must be an ISO-8601 instant with an explicit offset or Z",
    );
    await expect(edit.update(draft.id, { startsAtTz: "Mars/Olympus" })).rejects.toThrow(
      "startsAtTz must be a valid IANA timezone",
    );
    // Inverted against the STORED start, which the patch never mentions.
    await expect(edit.update(draft.id, { endsAt: "2026-10-20T08:00:00.000Z" })).rejects.toThrow(
      "startsAt must be at or before endsAt",
    );
    await expect(edit.update(draft.id, { costCents: -1 })).rejects.toThrow(
      "costCents must not be negative",
    );
    await expect(edit.update(draft.id, { title: "   " })).rejects.toThrow(ValidationError);
    await expect(
      edit.update(draft.id, { kind: "spaceship" as never }),
    ).rejects.toThrow(/kind must be one of/);
    // A flight's details are not a car rental's.
    await expect(edit.update(draft.id, { kind: "car" })).rejects.toThrow(
      "Changing this import to car needs details that match that kind",
    );

    // Not one of them landed.
    expect(await repo().findById(draft.id)).toMatchObject({
      title: "DL 2586",
      startsAt: "2026-10-21T22:00:00.000Z",
      startsAtTz: "America/Denver",
    });
  });

  it("edits only PENDING drafts", async () => {
    const dismissed = await seedDraft();
    await repo().markDismissed(dismissed.id);
    await expect(repo().update(dismissed.id, { title: "Too late" })).rejects.toThrow(
      ValidationError,
    );

    const trip = await new TripRepo(env.DB, ctx).create({ title: "Europe" });
    const accepted = await seedDraft();
    await new ImportReviewRepo(env.DB, ctx, ring).acceptIntoTrip([accepted.id], trip.id);
    await expect(repo().update(accepted.id, { title: "Too late" })).rejects.toThrow(
      ValidationError,
    );
  });

  it("cannot see, let alone edit, another household's draft", async () => {
    const foreign = await seedDraft("edit-b");
    await expect(repo().update(foreign.id, { title: "Theirs" })).rejects.toThrow(NotFoundError);
    await expect(repo().update("no-such-draft", { title: "Nobody's" })).rejects.toThrow(
      NotFoundError,
    );
    // Untouched in its own household.
    expect(await repo("edit-b").findById(foreign.id)).toMatchObject({ title: "DL 2586" });
  });

  it("refuses a viewer", async () => {
    const draft = await seedDraft();
    await expect(repo("edit-a", "viewer").update(draft.id, { title: "Nope" })).rejects.toThrow(
      ForbiddenError,
    );
  });
});
