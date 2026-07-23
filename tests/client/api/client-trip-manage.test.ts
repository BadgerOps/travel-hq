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

describe("trip management api", () => {
  it("PUTs a partial trip update as JSON", async () => {
    const fetchMock = mockFetch({ id: "t1", title: "Wedding weekend" });
    const api = createApi({ fetch: fetchMock, baseUrl: "" });
    await api.trips.update("t1", { title: "Wedding weekend", destination: null });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/trips/t1",
      expect.objectContaining({
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "Wedding weekend", destination: null }),
      }),
    );
  });

  it("DELETEs a trip with no body", async () => {
    const fetchMock = mockFetch(null, 204);
    const api = createApi({ fetch: fetchMock, baseUrl: "" });
    await api.trips.delete("t1");
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/trips/t1",
      expect.objectContaining({ method: "DELETE" }),
    );
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.body).toBeUndefined();
  });

  it("DELETEs a traveller from a trip", async () => {
    const fetchMock = mockFetch(null, 204);
    const api = createApi({ fetch: fetchMock, baseUrl: "" });
    await api.trips.removeTraveler("t1", "p-ava");
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/trips/t1/people/p-ava",
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("encodes both path segments", async () => {
    const fetchMock = mockFetch(null, 204);
    const api = createApi({ fetch: fetchMock, baseUrl: "" });
    await api.trips.removeTraveler("t/1", "p ava");
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/trips/t%2F1/people/p%20ava",
      expect.anything(),
    );
  });
});
