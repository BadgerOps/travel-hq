import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { BookingDetailDialog } from "../../../src/client/components/BookingDetailDialog.js";

const booking = {
  id: "booking-1",
  tripId: "trip-1",
  sourceInboundEmailId: "mail-1",
  kind: "lodging",
  title: "Silverwood RV Park",
  location: "Athol, ID",
  startsAt: "2026-07-29T21:00:00.000Z",
  startsAtTz: "America/Boise",
  endsAt: null,
  endsAtTz: null,
  confirmationNumberMasked: "••••1234",
  costCents: 19_900,
  pointsUsed: null,
  pointsProgram: null,
  status: "planned" as const,
  details: { site: "A12" },
  personIds: [],
};

describe("BookingDetailDialog", () => {
  it("shows the parsed originating email and retained calendar artifact", async () => {
    const artifact = vi.fn(async () => ({
      artifact: {
        inboundEmailId: "mail-1",
        from: "reservations@silverwood.example",
        to: "trips@example.com",
        subject: "Your Silverwood RV Park Reservation",
        receivedAt: "2026-07-27T19:28:40.411Z",
        textBody: "Your site A12 is confirmed.",
        calendars: ["BEGIN:VCALENDAR\nSUMMARY:Silverwood RV Park\nEND:VCALENDAR"],
      },
    }));
    render(
      <BookingDetailDialog
        booking={booking}
        api={{ bookings: { artifact } } as never}
        onClose={vi.fn()}
      />,
    );

    expect(await screen.findByText("Your Silverwood RV Park Reservation"))
      .toBeInTheDocument();
    expect(screen.getByText("Your site A12 is confirmed.")).toBeInTheDocument();
    expect(screen.getByText(/Calendar artifact/)).toBeInTheDocument();
    expect(artifact).toHaveBeenCalledWith(booking.id);
  });

  it("explains when a manual booking has no email source", async () => {
    render(
      <BookingDetailDialog
        booking={{ ...booking, sourceInboundEmailId: null }}
        api={{ bookings: { artifact: vi.fn(async () => ({ artifact: null })) } } as never}
        onClose={vi.fn()}
      />,
    );
    expect(await screen.findByText(/entered manually/i)).toBeInTheDocument();
  });
});
