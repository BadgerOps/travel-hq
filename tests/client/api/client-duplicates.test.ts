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

describe("duplicate api", () => {
  it("reads a trip's duplicate groups", async () => {
    const fetchMock = mockFetch({ groups: [] });
    const api = createApi({ fetch: fetchMock, baseUrl: "" });
    await expect(api.trips.duplicates("t/1")).resolves.toEqual({ groups: [] });
    expect(fetchMock).toHaveBeenCalledWith("/api/trips/t%2F1/duplicates", expect.anything());
  });

  it("POSTs a merge as keepId plus the ids being folded in", async () => {
    const fetchMock = mockFetch({ id: "b1" });
    const api = createApi({ fetch: fetchMock, baseUrl: "" });
    await api.trips.mergeDuplicates("t1", "b1", ["b2", "b3"]);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/trips/t1/duplicates/merge",
      expect.objectContaining({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ keepId: "b1", mergeIds: ["b2", "b3"] }),
      }),
    );
  });

  it("POSTs a dismissal as the whole set of ids", async () => {
    const fetchMock = mockFetch(null, 204);
    const api = createApi({ fetch: fetchMock, baseUrl: "" });
    await expect(api.trips.dismissDuplicates("t1", ["b1", "b2"])).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/trips/t1/duplicates/dismiss",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ bookingIds: ["b1", "b2"] }),
      }),
    );
  });

  it("DELETEs a booking with no body", async () => {
    const fetchMock = mockFetch(null, 204);
    const api = createApi({ fetch: fetchMock, baseUrl: "" });
    await api.bookings.remove("b/1");
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/bookings/b%2F1",
      expect.objectContaining({ method: "DELETE" }),
    );
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.body).toBeUndefined();
  });
});
