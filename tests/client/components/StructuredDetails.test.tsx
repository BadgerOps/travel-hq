import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { StructuredDetails } from "../../../src/client/components/StructuredDetails.js";

describe("StructuredDetails", () => {
  it("renders humanized labels with friendly values instead of JSON", () => {
    render(
      <StructuredDetails
        value={{
          site: "1",
          waterParkOpen: true,
          silverwoodOpen: false,
          nights: 3,
          totalCents: 16_416,
          originIata: "boi",
          guests: ["Sol", "Badger"],
        }}
      />,
    );
    expect(screen.getByText("Site")).toBeInTheDocument();
    expect(screen.getByText("Water park open")).toBeInTheDocument();
    expect(screen.getByText("Yes")).toBeInTheDocument();
    expect(screen.getByText("Silverwood open")).toBeInTheDocument();
    expect(screen.getByText("No")).toBeInTheDocument();
    expect(screen.getByText("Nights")).toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument();
    expect(screen.getByText("Total cents")).toBeInTheDocument();
    expect(screen.getByText("$164.16")).toBeInTheDocument();
    expect(screen.getByText("Origin IATA")).toBeInTheDocument();
    expect(screen.getByText("Sol, Badger")).toBeInTheDocument();
    expect(screen.queryByText(/[{}"]/)).not.toBeInTheDocument();
  });

  it("indents nested records and skips omitted or empty fields", () => {
    render(
      <StructuredDetails
        value={{
          kind: "lodging",
          address: "",
          notes: null,
          roomInfo: { roomType: "RV site", hookups: true },
        }}
        omit={["kind"]}
      />,
    );
    expect(screen.queryByText("Kind")).not.toBeInTheDocument();
    expect(screen.queryByText("Address")).not.toBeInTheDocument();
    expect(screen.queryByText("Notes")).not.toBeInTheDocument();
    expect(screen.getByText("Room info")).toBeInTheDocument();
    expect(screen.getByText("Room type")).toBeInTheDocument();
    expect(screen.getByText("RV site")).toBeInTheDocument();
    expect(screen.getByText("Hookups")).toBeInTheDocument();
  });

  it("renders nothing at all for a record with no presentable fields", () => {
    const { container } = render(<StructuredDetails value={{ empty: null }} />);
    expect(container).toBeEmptyDOMElement();
  });
});
