import { describe, it, expect } from "vitest";
import { buildNotificationJson } from "../../../src/server/push/payload.js";
import type { NotificationPayload } from "../../../src/server/push/payload.js";
import { MAX_PUSH_PLAINTEXT_BYTES } from "../../../src/server/push/encrypt.js";

describe("buildNotificationJson", () => {
  it("renders the allowed fields", () => {
    const json = buildNotificationJson({
      title: "Check in for UA 231",
      body: "Tomorrow, 6:40 AM from SEA",
      tag: "checkin-booking-42",
      path: "/trips/abc",
      timestamp: "2026-08-02T13:40:00Z",
    });
    expect(JSON.parse(json)).toEqual({
      title: "Check in for UA 231",
      body: "Tomorrow, 6:40 AM from SEA",
      tag: "checkin-booking-42",
      path: "/trips/abc",
      timestamp: "2026-08-02T13:40:00Z",
    });
  });

  it("omits absent optional fields rather than emitting nulls", () => {
    expect(buildNotificationJson({ title: "Only a title" })).toBe('{"title":"Only a title"}');
  });

  it("drops any field that is not part of the notification vocabulary", () => {
    // The whole point: a caller spreading a booking row in cannot leak its
    // confirmation number, because unknown keys are never read.
    const smuggled = {
      title: "Hotel tonight",
      confirmationNumber: "C03X72119",
      passportNumber: "X1234567",
      note: "seat 14C, paid with card ending 4242",
    } as unknown as NotificationPayload;
    const json = buildNotificationJson(smuggled);
    expect(json).toBe('{"title":"Hotel tonight"}');
    expect(json).not.toContain("C03X72119");
    expect(json).not.toContain("X1234567");
    expect(json).not.toContain("4242");
  });

  it("refuses a masked secret in any field", () => {
    expect(() => buildNotificationJson({ title: "Hotel ••••2119" })).toThrow(/masked secret/);
    expect(() => buildNotificationJson({ title: "ok", body: "Conf ••••2119" })).toThrow(
      /masked secret/,
    );
    expect(() => buildNotificationJson({ title: "ok", tag: "••••" })).toThrow(/masked secret/);
  });

  it("names the offending field without echoing its value", () => {
    try {
      buildNotificationJson({ title: "ok", body: "Conf ••••2119" });
      expect.unreachable("should have thrown");
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain("body");
      expect(message).not.toContain("2119");
    }
  });

  it("rejects an empty title", () => {
    expect(() => buildNotificationJson({ title: "" })).toThrow(/title is empty/);
  });

  it("caps field lengths", () => {
    expect(() => buildNotificationJson({ title: "x".repeat(101) })).toThrow(/limit is 100/);
    expect(() => buildNotificationJson({ title: "ok", body: "x".repeat(201) })).toThrow(
      /limit is 200/,
    );
    expect(() => buildNotificationJson({ title: "ok", tag: "x".repeat(65) })).toThrow(
      /limit is 64/,
    );
  });

  it("keeps a valid payload comfortably inside the encryption budget", () => {
    const json = buildNotificationJson({
      title: "x".repeat(100),
      body: "y".repeat(200),
      tag: "z".repeat(64),
      path: `/${"p".repeat(200)}`,
      timestamp: "2026-08-02T13:40:00Z",
    });
    expect(new TextEncoder().encode(json).length).toBeLessThan(MAX_PUSH_PLAINTEXT_BYTES);
  });

  it("rejects an off-origin tap target", () => {
    expect(() => buildNotificationJson({ title: "ok", path: "https://evil.example/x" })).toThrow(
      /app-relative path/,
    );
    // Protocol-relative: `//evil.example/x` resolves off-origin in a browser.
    expect(() => buildNotificationJson({ title: "ok", path: "//evil.example/x" })).toThrow(
      /app-relative path/,
    );
    expect(() => buildNotificationJson({ title: "ok", path: "trips/abc" })).toThrow(
      /app-relative path/,
    );
  });

  it("rejects a timestamp that is not a real instant", () => {
    expect(() => buildNotificationJson({ title: "ok", timestamp: "tomorrow-ish" })).toThrow(
      /ISO 8601/,
    );
  });
});
