import { describe, it, expect, vi } from "vitest";
import { createApi } from "../../../src/client/api/client.js";

/** Typed parameters so `.mock.calls[n]` is indexable — the URLs are the assertion. */
function mockFetch(body: unknown, status = 200) {
  return vi.fn(
    async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(status === 204 ? null : JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
  );
}

/**
 * The notifications group (#61). What is being pinned here is the URLs, since
 * two of them are load-bearing: the per-subject routes MUST be spelled
 * /api/bookings/:id/notification and /api/trips/:id/notification, because that
 * is the only spelling the authorizeBooking/authorizeTrip middleware matches.
 * A tidier-looking /api/notifications/booking/:id would skip the parent check.
 */
describe("api client notifications", () => {
  it("reads preferences from the per-user endpoint", async () => {
    const fetchMock = mockFetch({ preferences: {}, timezone: {}, vapidPublicKey: "k" });
    const api = createApi({ fetch: fetchMock, baseUrl: "" });
    await api.notifications.preferences();
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/notifications/preferences");
  });

  it("sends only the keys it was given, so an absent one keeps its stored value", async () => {
    const fetchMock = mockFetch({ preferences: {}, timezone: {}, vapidPublicKey: "k" });
    const api = createApi({ fetch: fetchMock, baseUrl: "" });
    await api.notifications.update({ reminderLeadMinutes: 0 });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/notifications/preferences",
      expect.objectContaining({ method: "PUT", body: JSON.stringify({ reminderLeadMinutes: 0 }) }),
    );
  });

  it("sends a timezone clear as an explicit null, which is what resets the pin", async () => {
    const fetchMock = mockFetch({ preferences: {}, timezone: {}, vapidPublicKey: "k" });
    const api = createApi({ fetch: fetchMock, baseUrl: "" });
    await api.notifications.setTimezone(null, "device");
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/notifications/timezone",
      expect.objectContaining({ body: JSON.stringify({ timezone: null, source: "device" }) }),
    );
  });

  it("posts a browser subscription verbatim", async () => {
    const fetchMock = mockFetch({ device: { id: "d1" } }, 201);
    const api = createApi({ fetch: fetchMock, baseUrl: "" });
    const subscription = { endpoint: "https://push.example.com/x", keys: { p256dh: "p", auth: "a" } };
    await api.notifications.registerDevice(subscription);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/notifications/subscriptions",
      expect.objectContaining({ method: "POST", body: JSON.stringify(subscription) }),
    );
  });

  it("deletes a device with no body and no content-type", async () => {
    const fetchMock = mockFetch(null, 204);
    const api = createApi({ fetch: fetchMock, baseUrl: "" });
    await api.notifications.removeDevice("d 1");
    // The id is encoded: it is interpolated into the path.
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/notifications/subscriptions/d%201",
      expect.objectContaining({ method: "DELETE" }),
    );
    expect(fetchMock.mock.calls[0]?.[1]).not.toHaveProperty("headers");
  });

  it("addresses the per-booking and per-trip routes at the URLs the parent check guards", async () => {
    const fetchMock = mockFetch({ subscribed: true });
    const api = createApi({ fetch: fetchMock, baseUrl: "" });
    await api.notifications.forBooking("b1");
    await api.notifications.setBooking("b1", null);
    await api.notifications.setTrip("t1", false);
    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      "/api/bookings/b1/notification",
      "/api/bookings/b1/notification",
      "/api/trips/t1/notification",
    ]);
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({
      method: "PUT",
      body: JSON.stringify({ subscribed: null }),
    });
  });
});
