import { beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { createApp } from "../../../src/server/index.js";
import type { AppBindings } from "../../../src/server/index.js";
import type { Identity } from "../../../src/server/auth.js";
import { Keyring } from "../../../src/server/crypto/envelope.js";
import { BookingRepo } from "../../../src/server/repos/booking.js";
import { InboundEmailRepo } from "../../../src/server/repos/inbound-email.js";
import { TripRepo } from "../../../src/server/repos/trip.js";

const owner: Identity = {
  userId: "owner-a",
  email: "owner@example.com",
  householdId: "hh-a",
  role: "owner",
};
const ring = new Keyring("test", {
  test: crypto.getRandomValues(new Uint8Array(32)),
});

beforeEach(async () => {
  await env.DB.exec("DELETE FROM household");
  const now = new Date().toISOString();
  await env.DB.prepare("INSERT INTO household (id,name,created_at) VALUES (?,?,?)")
    .bind("hh-a", "A", now).run();
  await env.DB.prepare("INSERT INTO household (id,name,created_at) VALUES (?,?,?)")
    .bind("hh-b", "B", now).run();
});

function appAs(identity: Identity = owner) {
  return createApp({ verify: async () => identity, ring });
}

function request(identity: Identity, path: string) {
  return appAs(identity).request(
    path,
    undefined,
    { DB: env.DB } as unknown as AppBindings,
  );
}

async function seedBooking(householdId: string, withSource = true) {
  const identity: Identity = {
    userId: `owner-${householdId}`,
    email: `${householdId}@example.com`,
    householdId,
    role: "owner",
  };
  const trip = await new TripRepo(env.DB, identity).create({ title: "Silverwood" });
  const email = withSource
    ? await InboundEmailRepo.forIngest(env.DB, householdId).create({
        from: "reservations@silverwood.example",
        to: "trips@example.com",
        subject: "Stored envelope subject",
        raw: [
          "From: Silverwood <reservations@silverwood.example>",
          "To: trips@example.com",
          "Subject: Your Silverwood RV Park Reservation",
          'Content-Type: multipart/mixed; boundary="artifact-boundary"',
          "",
          "--artifact-boundary",
          "Content-Type: text/plain; charset=utf-8",
          "",
          "Your site A12 is confirmed.",
          "--artifact-boundary",
          "Content-Type: text/calendar; charset=utf-8",
          "",
          "BEGIN:VCALENDAR",
          "SUMMARY:Silverwood RV Park",
          "END:VCALENDAR",
          "--artifact-boundary--",
        ].join("\r\n"),
      })
    : null;
  return new BookingRepo(env.DB, identity, ring).create({
    tripId: trip.id,
    sourceInboundEmailId: email?.id,
    kind: "lodging",
    title: "Silverwood RV Park",
    details: { propertyName: "Silverwood RV Park", roomType: "Site A12" },
  });
}

describe("booking source artifact route", () => {
  it("returns parsed email body and calendar data for a source-linked booking", async () => {
    const booking = await seedBooking("hh-a");
    const res = await request(owner, `/api/bookings/${booking.id}/artifact`);

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      artifact: {
        from: "reservations@silverwood.example",
        to: "trips@example.com",
        subject: "Your Silverwood RV Park Reservation",
        textBody: "Your site A12 is confirmed.",
        calendars: [
          "BEGIN:VCALENDAR\r\nSUMMARY:Silverwood RV Park\r\nEND:VCALENDAR",
        ],
      },
    });
  });

  it("returns no artifact for a booking entered manually", async () => {
    const booking = await seedBooking("hh-a", false);
    const res = await request(owner, `/api/bookings/${booking.id}/artifact`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ artifact: null });
  });

  it("blocks viewers and does not expose another household's artifact", async () => {
    const ownBooking = await seedBooking("hh-a");
    const foreignBooking = await seedBooking("hh-b");
    const viewer: Identity = { ...owner, role: "viewer" };

    expect((await request(
      viewer,
      `/api/bookings/${ownBooking.id}/artifact`,
    )).status).toBe(403);
    expect((await request(
      owner,
      `/api/bookings/${foreignBooking.id}/artifact`,
    )).status).toBe(404);
  });
});
