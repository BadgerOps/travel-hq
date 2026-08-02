import { describe, it, expect, vi, afterEach } from "vitest";
import {
  createTimezoneReporter,
  isIos,
  isStandalone,
  pushAvailability,
  urlBase64ToUint8Array,
} from "../../../src/client/lib/push.js";

/**
 * The browser-side rules of #61 that must hold before any pixel is drawn:
 * which devices can be offered a button at all, and the one rule that decides
 * whether a person's deliberately pinned timezone survives a trip.
 */

function setUserAgent(value: string) {
  Object.defineProperty(navigator, "userAgent", { value, configurable: true });
}

function setStandalone(standalone: boolean) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({ matches: standalone && query.includes("standalone") })),
  );
  Object.defineProperty(navigator, "standalone", { value: standalone, configurable: true });
}

/** Everything a browser that CAN do web push has. */
function supportPush() {
  Object.defineProperty(navigator, "serviceWorker", { value: {}, configurable: true });
  vi.stubGlobal("PushManager", class {});
  vi.stubGlobal("Notification", { permission: "default" });
}

afterEach(() => {
  vi.unstubAllGlobals();
  Object.defineProperty(navigator, "userAgent", { value: "vitest", configurable: true });
  Object.defineProperty(navigator, "standalone", { value: undefined, configurable: true });
  Object.defineProperty(navigator, "maxTouchPoints", { value: 0, configurable: true });
});

describe("isStandalone / isIos", () => {
  it("trusts navigator.standalone, which is the only reliable signal on iOS Safari", () => {
    setStandalone(true);
    expect(isStandalone()).toBe(true);
  });

  it("is false in a plain tab", () => {
    setStandalone(false);
    expect(isStandalone()).toBe(false);
  });

  it("recognises an iPad that reports itself as a Mac, which every iPad does by default", () => {
    setUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605");
    Object.defineProperty(navigator, "maxTouchPoints", { value: 5, configurable: true });
    expect(isIos()).toBe(true);
  });

  it("does not mistake a real Mac for an iPad", () => {
    setUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605");
    Object.defineProperty(navigator, "maxTouchPoints", { value: 0, configurable: true });
    expect(isIos()).toBe(false);
  });
});

describe("pushAvailability", () => {
  /**
   * The acceptance criterion this exists for: an iPhone in a Safari tab must
   * NOT be offered an enable button, because there is no API behind one. The
   * distinction between this and "unsupported" is the whole point — one of
   * them has a fix the reader can carry out.
   */
  it("asks an iPhone in a Safari tab to install first, rather than calling it unsupported", () => {
    setUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Safari/604");
    setStandalone(false);
    expect(pushAvailability("key")).toBe("needs-install");
  });

  it("is ready on an installed iOS PWA", () => {
    setUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Safari/604");
    setStandalone(true);
    supportPush();
    expect(pushAvailability("key")).toBe("ready");
  });

  it("reports a denied permission as its own state — a button there could only fail silently", () => {
    setUserAgent("Mozilla/5.0 (Macintosh) Chrome/120");
    setStandalone(false);
    supportPush();
    vi.stubGlobal("Notification", { permission: "denied" });
    expect(pushAvailability("key")).toBe("denied");
  });

  it("blames the SERVER, not the device, when there is no VAPID key", () => {
    setUserAgent("Mozilla/5.0 (Macintosh) Chrome/120");
    setStandalone(false);
    supportPush();
    expect(pushAvailability(null)).toBe("not-configured");
  });

  it("reports a browser with no PushManager as unsupported", () => {
    setUserAgent("Mozilla/5.0 (Macintosh) Firefox/1");
    setStandalone(false);
    expect(pushAvailability("key")).toBe("unsupported");
  });
});

describe("urlBase64ToUint8Array", () => {
  it("decodes an unpadded base64url key to its bytes", () => {
    // "hello" as base64url, unpadded, with a - and _ in a longer sample.
    expect(Array.from(urlBase64ToUint8Array("aGVsbG8"))).toEqual([104, 101, 108, 108, 111]);
    expect(Array.from(urlBase64ToUint8Array("-_8"))).toEqual([251, 255]);
  });
});

describe("createTimezoneReporter", () => {
  function makeApi(stored: string | null, source: "device" | "manual" | null = null) {
    let current = { timezone: stored, source, updatedAt: null as string | null };
    const preferences = vi.fn(async () => ({
      preferences: { digestEnabled: false, digestSendTime: null, remindersEnabled: true, reminderLeadMinutes: 60 },
      timezone: current,
      vapidPublicKey: "key",
    }));
    const setTimezone = vi.fn(async (timezone: string | null, src: "device" | "manual") => {
      // The server's rule, mirrored: a device report never displaces a pin.
      if (!(src === "device" && current.source === "manual" && timezone !== null)) {
        current = { timezone, source: timezone === null ? null : src, updatedAt: "now" };
      }
      return {
        preferences: { digestEnabled: false, digestSendTime: null, remindersEnabled: true, reminderLeadMinutes: 60 },
        timezone: current,
        vapidPublicKey: "key",
      };
    });
    return { notifications: { preferences, setTimezone } } as never as Parameters<typeof createTimezoneReporter>[0];
  }

  it("posts the device zone when the server has none", async () => {
    const api = makeApi(null);
    await createTimezoneReporter(api, () => "America/Boise")();
    expect(api.notifications.setTimezone).toHaveBeenCalledWith("America/Boise", "device");
  });

  it("writes NOTHING when the server already has this zone", async () => {
    const api = makeApi("America/Boise", "device");
    await createTimezoneReporter(api, () => "America/Boise")();
    expect(api.notifications.setTimezone).not.toHaveBeenCalled();
  });

  /**
   * The rule that protects a deliberate choice. The report is sent (the server
   * is the authority and simply ignores it), but it is sent ONCE — without the
   * memo, the stored pin would differ from the device zone forever and this
   * would re-post on every single return to the foreground.
   */
  it("does not clobber a manual pin, and stops re-posting against it", async () => {
    const api = makeApi("America/Boise", "manual");
    const report = createTimezoneReporter(api, () => "Europe/Amsterdam");
    await report();
    await report();
    await report();
    expect(api.notifications.setTimezone).toHaveBeenCalledTimes(1);
    const last = await api.notifications.preferences();
    expect(last.timezone).toMatchObject({ timezone: "America/Boise", source: "manual" });
  });

  it("posts again once the device actually moves", async () => {
    const api = makeApi(null);
    let zone = "America/Boise";
    const report = createTimezoneReporter(api, () => zone);
    await report();
    await report();
    zone = "Asia/Tokyo";
    await report();
    expect(api.notifications.setTimezone).toHaveBeenCalledTimes(2);
    expect(api.notifications.setTimezone).toHaveBeenLastCalledWith("Asia/Tokyo", "device");
  });

  it("swallows a failure: the next foreground retries and nothing on screen depends on it", async () => {
    const api = {
      notifications: {
        preferences: vi.fn(async () => {
          throw new Error("offline");
        }),
        setTimezone: vi.fn(),
      },
    } as never as Parameters<typeof createTimezoneReporter>[0];
    await expect(createTimezoneReporter(api, () => "America/Boise")()).resolves.toBeUndefined();
  });
});
