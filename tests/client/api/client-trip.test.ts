import { describe, it, expect, vi } from "vitest";
import { createApi } from "../../../src/client/api/client.js";

function mockFetch(body: unknown, status = 200) {
  return vi.fn(async () =>
    new Response(status === 204 ? null : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  );
}

describe("trip and checklist api", () => {
  it("fetches a rollup", async () => {
    const fetchMock = mockFetch({ totalCents: 148_400, points: [] });
    const api = createApi({ fetch: fetchMock, baseUrl: "" });
    expect(await api.trips.rollup("t1")).toMatchObject({ totalCents: 148_400 });
    expect(fetchMock).toHaveBeenCalledWith("/api/trips/t1/rollup", expect.anything());
  });

  it("toggles a checklist item", async () => {
    const fetchMock = mockFetch(null, 204);
    const api = createApi({ fetch: fetchMock, baseUrl: "" });
    await api.checklist.setDone("c1", true);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/checklist/c1/done",
      expect.objectContaining({ method: "PUT", body: JSON.stringify({ done: true }) }),
    );
  });

  describe("api.trips.itinerary", () => {
    it("fetches the whole-trip itinerary with no query string when personId is omitted", async () => {
      const fetchMock = mockFetch([]);
      const api = createApi({ fetch: fetchMock, baseUrl: "" });
      await api.trips.itinerary("t1");
      expect(fetchMock).toHaveBeenCalledWith("/api/trips/t1/itinerary", expect.anything());
    });

    it("appends a personId query parameter when given", async () => {
      const fetchMock = mockFetch([]);
      const api = createApi({ fetch: fetchMock, baseUrl: "" });
      await api.trips.itinerary("t1", "p-ava");
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/trips/t1/itinerary?personId=p-ava",
        expect.anything(),
      );
    });

    // The tripId is a path segment (encodeURIComponent via `seg`); the
    // personId is a query value, encoded with the plain global function.
    // Both need their own escaping, and it's easy to encode one and forget
    // the other.
    it("encodes special characters in both the tripId segment and the personId query value", async () => {
      const fetchMock = mockFetch([]);
      const api = createApi({ fetch: fetchMock, baseUrl: "" });
      await api.trips.itinerary("t/1", "p ava&more");
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/trips/t%2F1/itinerary?personId=p%20ava%26more",
        expect.anything(),
      );
    });
  });

  it("fetches a trip's travelers", async () => {
    const fetchMock = mockFetch([{ id: "p1", displayName: "Ava" }]);
    const api = createApi({ fetch: fetchMock, baseUrl: "" });
    expect(await api.trips.travelers("t1")).toEqual([{ id: "p1", displayName: "Ava" }]);
    expect(fetchMock).toHaveBeenCalledWith("/api/trips/t1/travelers", expect.anything());
  });
});
