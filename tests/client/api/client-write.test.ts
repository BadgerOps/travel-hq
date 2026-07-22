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

describe("api client writes", () => {
  it("creates a person", async () => {
    const fetchMock = mockFetch({ id: "p1", displayName: "Ava" });
    const api = createApi({ fetch: fetchMock, baseUrl: "" });
    expect(await api.people.create({ displayName: "Ava" })).toMatchObject({ id: "p1" });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/people",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ displayName: "Ava" }),
      }),
    );
  });

  it("updates a person without inventing keys it was not given", async () => {
    // The masked-value trap in reverse: the client must send exactly the keys
    // the caller supplied. A body that filled in `passportNumber: undefined`
    // is fine (JSON.stringify drops it); a body that filled in the masked
    // string would destroy a passport number.
    const fetchMock = mockFetch({ id: "p1", displayName: "Ava Wright" });
    const api = createApi({ fetch: fetchMock, baseUrl: "" });
    await api.people.update("p1", { displayName: "Ava Wright" });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/people/p1",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({ displayName: "Ava Wright" }),
      }),
    );
  });

  it("sends an explicit null through as a clear instruction", async () => {
    const fetchMock = mockFetch({ id: "p1" });
    const api = createApi({ fetch: fetchMock, baseUrl: "" });
    await api.people.update("p1", { passportNumber: null });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/people/p1",
      expect.objectContaining({ body: JSON.stringify({ passportNumber: null }) }),
    );
  });

  it("creates a trip", async () => {
    const fetchMock = mockFetch({ id: "t1", title: "Guerneville" });
    const api = createApi({ fetch: fetchMock, baseUrl: "" });
    expect(await api.trips.create({ title: "Guerneville" })).toMatchObject({ id: "t1" });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/trips",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("attaches a traveller to a trip and tolerates the 204", async () => {
    const fetchMock = mockFetch(null, 204);
    const api = createApi({ fetch: fetchMock, baseUrl: "" });
    await expect(api.trips.addTraveler("t1", "p1")).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/trips/t1/people/p1",
      expect.objectContaining({ method: "PUT" }),
    );
  });

  it("creates a booking on a trip", async () => {
    const fetchMock = mockFetch({ id: "b1" });
    const api = createApi({ fetch: fetchMock, baseUrl: "" });
    await api.trips.createBooking("t1", {
      kind: "lodging",
      title: "Dawn Ranch Lodge",
      details: { propertyName: "Dawn Ranch Lodge" },
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/trips/t1/bookings",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("assigns a person to a booking", async () => {
    const fetchMock = mockFetch(null, 204);
    const api = createApi({ fetch: fetchMock, baseUrl: "" });
    await api.bookings.assignPerson("b1", "p1");
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/bookings/b1/people/p1",
      expect.objectContaining({ method: "PUT" }),
    );
  });

  it("sets a booking status", async () => {
    const fetchMock = mockFetch(null, 204);
    const api = createApi({ fetch: fetchMock, baseUrl: "" });
    await api.bookings.setStatus("b1", "booked");
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/bookings/b1/status",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({ status: "booked" }),
      }),
    );
  });

  it("url-encodes ids in write paths", async () => {
    // Ids reach these methods from server data and, in the import flow, from
    // a form. An unencoded slash would reshape the request path.
    const fetchMock = mockFetch(null, 204);
    const api = createApi({ fetch: fetchMock, baseUrl: "" });
    await api.trips.addTraveler("a/../b", "p1");
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/trips/a%2F..%2Fb/people/p1",
      expect.anything(),
    );
  });
});
