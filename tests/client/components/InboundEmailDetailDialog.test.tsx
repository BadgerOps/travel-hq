import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { ApiError } from "../../../src/client/api/client.js";
import { InboundEmailDetailDialog } from "../../../src/client/components/InboundEmailDetailDialog.js";
import type {
  InboundEmailDetail,
  InboundEmailMetadata,
} from "../../../src/client/api/types.js";

const metadata: InboundEmailMetadata = {
  id: "ie-1",
  from: "sol@example.com",
  to: "trips@example.com",
  subject: "Fwd: Your Silverwood RV Park Reservation",
  status: "extracted",
  error: null,
  receivedAt: "2026-07-27T14:37:17.000Z",
};

function apiWith(detail: InboundEmailDetail) {
  return { inboundEmails: { get: vi.fn(async () => detail) } };
}

describe("InboundEmailDetailDialog", () => {
  it("shows the extracted drafts, their raw data, and the message text", async () => {
    const api = apiWith({
      ...metadata,
      textBody: "Site A12, arriving July 30.",
      calendars: ["BEGIN:VCALENDAR\nEND:VCALENDAR"],
      drafts: [{
        id: "draft-1",
        inboundEmailId: "ie-1",
        ordinal: 0,
        kind: "lodging",
        title: "Silverwood RV Park",
        location: "Athol, ID",
        startsAt: "2026-07-30T22:00:00.000Z",
        startsAtTz: "America/Boise",
        endsAt: null,
        endsAtTz: null,
        confirmationNumber: "RV-4001",
        source: "ai",
        extracted: {
          costCents: 12_500,
          extractionProvider: "workers-ai",
          details: { site: "1", type: "RV", waterParkOpen: true },
        },
        status: "pending",
        bookingId: null,
        createdAt: "2026-07-27T14:37:20.000Z",
        resolvedAt: null,
      }],
    });
    render(
      <InboundEmailDetailDialog email={metadata} api={api as never} onClose={vi.fn()} />,
    );

    expect(await screen.findByText("Silverwood RV Park")).toBeInTheDocument();
    expect(api.inboundEmails.get).toHaveBeenCalledWith("ie-1");
    expect(screen.getByText("Athol, ID")).toBeInTheDocument();
    expect(screen.getByText("Confirmation RV-4001")).toBeInTheDocument();
    // Extracted values render as readable rows, never as JSON.
    expect(screen.getByText("Cost $125.00")).toBeInTheDocument();
    expect(screen.getByText("Site")).toBeInTheDocument();
    expect(screen.getByText("Water park open")).toBeInTheDocument();
    expect(screen.getByText("Yes")).toBeInTheDocument();
    expect(screen.getByText("Extracted by workers-ai")).toBeInTheDocument();
    expect(screen.queryByText(/costCents/)).not.toBeInTheDocument();
    expect(screen.getByText("Site A12, arriving July 30.")).toBeInTheDocument();
    expect(screen.getByText(/Calendar attachment/)).toBeInTheDocument();
  });

  it("explains a rejected email instead of showing an empty draft list", async () => {
    const rejected: InboundEmailMetadata = {
      ...metadata,
      id: "ie-2",
      status: "rejected",
      error: "sender is not on the household allowlist",
    };
    const api = apiWith({ ...rejected, textBody: null, calendars: [], drafts: [] });
    render(
      <InboundEmailDetailDialog email={rejected} api={api as never} onClose={vi.fn()} />,
    );

    expect(
      await screen.findByText(/rejected before extraction/i),
    ).toBeInTheDocument();
    expect(screen.getByText("sender is not on the household allowlist")).toBeInTheDocument();
    expect(screen.getByText(/no readable message body was stored/i)).toBeInTheDocument();
  });

  it("reports a failed detail load", async () => {
    const api = {
      inboundEmails: {
        get: vi.fn(async () => {
          throw new ApiError("/api/inbound-emails/ie-1 failed: detail unavailable", 500);
        }),
      },
    };
    render(
      <InboundEmailDetailDialog email={metadata} api={api as never} onClose={vi.fn()} />,
    );
    // errorMessage() deliberately never interpolates server text.
    expect(await screen.findByRole("alert")).toHaveTextContent(/something went wrong/i);
  });
});
