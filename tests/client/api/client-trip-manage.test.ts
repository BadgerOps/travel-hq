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
  it("fetches one trip without loading the full trip list", async () => {
    const fetchMock = mockFetch({ id: "t1", title: "Wedding weekend" });
    const api = createApi({ fetch: fetchMock, baseUrl: "" });
    await expect(api.trips.get("t/1")).resolves.toMatchObject({ id: "t1" });
    expect(fetchMock).toHaveBeenCalledWith("/api/trips/t%2F1", expect.anything());
  });

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

  it("creates and removes a trip invitation with encoded identifiers", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({
          userId: "u1",
          email: "guest@example.com",
          role: "viewer",
          createdAt: "2026-07-28T00:00:00Z",
        }), { status: 201, headers: { "content-type": "application/json" } }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const api = createApi({ fetch: fetchMock, baseUrl: "" });

    await api.trips.invite("t/1", "guest@example.com", "viewer");
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/trips/t%2F1/members",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ email: "guest@example.com", role: "viewer" }),
      }),
    );
    await api.trips.removeMember("t/1", "u 1");
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/trips/t%2F1/members/u%201",
      expect.objectContaining({ method: "DELETE" }),
    );
  });
});
