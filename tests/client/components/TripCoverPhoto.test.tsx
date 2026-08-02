import { describe, it, expect } from "vitest";
import { fireEvent, render } from "@testing-library/react";
import { TripCoverPhoto } from "../../../src/client/components/TripCoverPhoto.js";

/**
 * The cover art is the trip page's largest element, so what it does when the
 * photo does not arrive is the difference between "this trip has no picture"
 * and "this page is broken".
 */
describe("TripCoverPhoto", () => {
  it("renders the photo when the trip has one", () => {
    const { container } = render(<TripCoverPhoto photoUrl="/api/trips/t1/photo?v=1" tripId="t1" />);
    expect(container.querySelector("img.cover-img")).toHaveAttribute(
      "src",
      "/api/trips/t1/photo?v=1",
    );
    expect(container.querySelector("svg.cover-fallback")).toBeNull();
  });

  it("falls back to the placeholder art when the trip has no photo", () => {
    const { container } = render(<TripCoverPhoto photoUrl={null} tripId="t1" />);
    expect(container.querySelector("svg.cover-fallback")).toBeInTheDocument();
  });

  it("swaps a photo that fails to load for the placeholder, not a broken image", () => {
    const { container } = render(<TripCoverPhoto photoUrl="/api/trips/t1/photo?v=1" tripId="t1" />);
    fireEvent.error(container.querySelector("img.cover-img")!);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("svg.cover-fallback")).toBeInTheDocument();
  });

  it("gives a re-uploaded photo a fresh attempt rather than inheriting the old failure", () => {
    const { container, rerender } = render(
      <TripCoverPhoto photoUrl="/api/trips/t1/photo?v=1" tripId="t1" />,
    );
    fireEvent.error(container.querySelector("img.cover-img")!);
    expect(container.querySelector("svg.cover-fallback")).toBeInTheDocument();

    // A re-upload changes the ?v= cache-buster; that is a different URL and
    // deserves its own attempt.
    rerender(<TripCoverPhoto photoUrl="/api/trips/t1/photo?v=2" tripId="t1" />);
    expect(container.querySelector("img.cover-img")).toHaveAttribute(
      "src",
      "/api/trips/t1/photo?v=2",
    );
  });

  it("keeps the placeholder deterministic per trip", () => {
    const a = render(<TripCoverPhoto photoUrl={null} tripId="trip-alpha" />);
    const b = render(<TripCoverPhoto photoUrl={null} tripId="trip-alpha" />);
    const c = render(<TripCoverPhoto photoUrl={null} tripId="trip-beta" />);
    const art = (r: ReturnType<typeof render>) =>
      r.container.querySelector("svg.cover-fallback")!.innerHTML;
    expect(art(a)).toBe(art(b));
    expect(art(a)).not.toBe(art(c));
  });
});
