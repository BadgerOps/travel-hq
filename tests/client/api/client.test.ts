import { describe, it, expect, vi, afterEach } from "vitest";
import { createApi, ApiError } from "../../../src/client/api/client.js";

function mockFetch(status: number, body: unknown) {
  return vi.fn(async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  );
}

afterEach(() => vi.restoreAllMocks());

describe("api client", () => {
  it("lists trips", async () => {
    const fetchMock = mockFetch(200, [{ id: "t1", title: "Guerneville" }]);
    const api = createApi({ fetch: fetchMock, baseUrl: "" });
    expect(await api.trips.list()).toEqual([{ id: "t1", title: "Guerneville" }]);
    expect(fetchMock).toHaveBeenCalledWith("/api/trips", expect.anything());
  });

  it("passes personId through to the itinerary endpoint", async () => {
    const fetchMock = mockFetch(200, []);
    const api = createApi({ fetch: fetchMock, baseUrl: "" });
    await api.trips.itinerary("t1", "p-ava");
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/trips/t1/itinerary?personId=p-ava",
      expect.anything(),
    );
  });

  it("omits the query string when no person is given", async () => {
    const fetchMock = mockFetch(200, []);
    const api = createApi({ fetch: fetchMock, baseUrl: "" });
    await api.trips.itinerary("t1");
    expect(fetchMock).toHaveBeenCalledWith("/api/trips/t1/itinerary", expect.anything());
  });

  it("throws ApiError carrying the status on a failure", async () => {
    const api = createApi({ fetch: mockFetch(401, { error: "Unauthorized" }), baseUrl: "" });
    await expect(api.trips.list()).rejects.toThrow(ApiError);
    await expect(api.trips.list()).rejects.toMatchObject({ status: 401 });
  });

  it("reveals a booking confirmation", async () => {
    const fetchMock = mockFetch(200, { value: "ABCDX4T2" });
    const api = createApi({ fetch: fetchMock, baseUrl: "" });
    expect(await api.trips.revealConfirmation("t1", "b1")).toEqual({ value: "ABCDX4T2" });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/trips/t1/bookings/b1/reveal",
      expect.anything(),
    );
  });

  it("fetches the caller's identity", async () => {
    const fetchMock = mockFetch(200, {
      userId: "u1",
      email: "badger@example.com",
      householdId: "hh-a",
      role: "owner",
    });
    const api = createApi({ fetch: fetchMock, baseUrl: "" });
    expect((await api.me()).role).toBe("owner");
    expect(fetchMock).toHaveBeenCalledWith("/api/me", expect.anything());
  });

  it("url-encodes path parameters", async () => {
    const fetchMock = mockFetch(200, []);
    const api = createApi({ fetch: fetchMock, baseUrl: "" });
    await api.trips.bookings("a/../b");
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/trips/a%2F..%2Fb/bookings",
      expect.anything(),
    );
  });
});
