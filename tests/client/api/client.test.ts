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
      expect.objectContaining({
        method: "POST",
        headers: { "content-type": "application/json" },
      }),
    );
  });

  it("reveals a person document with POST", async () => {
    const fetchMock = mockFetch(200, { value: "C03X72119" });
    const api = createApi({ fetch: fetchMock, baseUrl: "" });
    await api.people.reveal("p1", "passport_number");
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/people/p1/reveal/passport_number",
      expect.objectContaining({
        method: "POST",
        headers: { "content-type": "application/json" },
      }),
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

  it("posts extraction tests and lists safe inbound activity", async () => {
    const fetchMock = mockFetch(200, { bookings: [] });
    const api = createApi({ fetch: fetchMock, baseUrl: "" });
    await api.settings.testExtraction({ subject: "Flight", text: "Confirmation" });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/settings/extraction-test",
      expect.objectContaining({ method: "POST" }),
    );

    fetchMock.mockResolvedValueOnce(new Response("[]", {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    await api.inboundEmails.list();
    expect(fetchMock).toHaveBeenCalledWith("/api/inbound-emails", expect.anything());
  });

  it("lists and reviews pending imports", async () => {
    const fetchMock = mockFetch(200, []);
    const api = createApi({ fetch: fetchMock, baseUrl: "" });
    await api.imports.pending();
    expect(fetchMock).toHaveBeenLastCalledWith("/api/imports/pending", expect.anything());

    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      trip: { id: "trip-1" },
      acceptedDraftIds: ["draft-1"],
    }), { status: 200, headers: { "content-type": "application/json" } }));
    await api.imports.accept(["draft-1"], "trip-1");
    expect(fetchMock).toHaveBeenLastCalledWith(
      "/api/imports/accept",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ draftIds: ["draft-1"], tripId: "trip-1" }),
      }),
    );

    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      trip: { id: "trip-new" },
      acceptedDraftIds: ["draft-1", "draft-2"],
    }), { status: 201, headers: { "content-type": "application/json" } }));
    await api.imports.createTrip({
      draftIds: ["draft-1", "draft-2"],
      title: "Europe",
      startsOn: "2026-10-21",
      endsOn: "2026-10-24",
    });
    expect(fetchMock).toHaveBeenLastCalledWith(
      "/api/imports/create-trip",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          draftIds: ["draft-1", "draft-2"],
          title: "Europe",
          startsOn: "2026-10-21",
          endsOn: "2026-10-24",
        }),
      }),
    );

    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      dismissedDraftIds: ["draft-2"],
    }), { status: 200, headers: { "content-type": "application/json" } }));
    await api.imports.dismiss(["draft-2"]);
    expect(fetchMock).toHaveBeenLastCalledWith(
      "/api/imports/dismiss",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ draftIds: ["draft-2"] }),
      }),
    );
  });
});
