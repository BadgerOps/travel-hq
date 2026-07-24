import { describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Import } from "../../../src/client/pages/Import.js";
import { IdentityProvider } from "../../../src/client/api/identity.js";
import type { Identity } from "../../../src/client/api/types.js";
import { DELTA_BOOKINGS_90_DAYS } from "../../fixtures/delta-itinerary.js";
import { ApiError } from "../../../src/client/api/client.js";

function asRole(role: Identity["role"], ui: ReactNode) {
  const me = async () => ({
    userId: "u1",
    email: "badger@example.com",
    householdId: "hh-a",
    role,
  });
  return render(<IdentityProvider api={{ me } as never}>{ui}</IdentityProvider>);
}

function setup(role: Identity["role"] = "owner") {
  const file = vi.fn(async () => ({
    inboundEmailId: "email-1",
    status: "extracted" as const,
    error: null,
    bookings: DELTA_BOOKINGS_90_DAYS,
  }));
  const api = { imports: { file } };
  asRole(role, <Import api={api as never} />);
  return { api, file };
}

describe("Import page", () => {
  it("uploads a PDF and previews every extracted draft", async () => {
    const { file } = setup();
    const pdf = new File(["%PDF-1.4"], "delta-trip.pdf", { type: "application/pdf" });
    await userEvent.upload(screen.getByLabelText("PDF file"), pdf);
    await userEvent.click(screen.getByRole("button", { name: "Import PDF" }));

    expect(file).toHaveBeenCalledWith(pdf);
    expect(await screen.findByText("3 drafts ready for review")).toBeInTheDocument();
    for (const booking of DELTA_BOOKINGS_90_DAYS) {
      expect(screen.getByText(booking.title)).toBeInTheDocument();
    }
  });

  it("requires a file and reports an upload failure", async () => {
    const { file } = setup();
    await userEvent.click(screen.getByRole("button", { name: "Import PDF" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/choose a PDF/i);
    expect(file).not.toHaveBeenCalled();

    file.mockRejectedValueOnce(new ApiError("/api/imports/file failed", 422));
    await userEvent.upload(
      screen.getByLabelText("PDF file"),
      new File(["%PDF"], "trip.pdf", { type: "application/pdf" }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Import PDF" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/could not read that PDF/i);
  });

  it("does not offer file import to a viewer", async () => {
    setup("viewer");
    expect(await screen.findByText("Owners and adults only")).toBeInTheDocument();
    expect(screen.queryByLabelText("PDF file")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Import PDF" })).not.toBeInTheDocument();
  });
});
