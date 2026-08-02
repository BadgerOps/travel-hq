import type { api as defaultApi } from "../api/client.js";

/**
 * The browser half of Web Push (issue #61): what this device can actually do,
 * how to subscribe it, and how to keep the server's idea of "where this person
 * is" honest.
 *
 * Split out of Settings.tsx and main.tsx because both need it and because
 * every rule here is testable in isolation — particularly the timezone
 * reporter, whose whole job is to NOT overwrite something.
 */

type Api = typeof defaultApi;

/**
 * Why the enable button is, or is not, offered on this device.
 *
 * The states are separate rather than one boolean because the ADVICE differs
 * completely, and a UI that collapses them tells someone to "allow
 * notifications" when the real problem is that they are reading this in a
 * Safari tab, where the button they are being pointed at does not exist.
 *
 *   ready               — subscribe away.
 *   needs-install       — iOS/iPadOS, not launched from the home screen. Web
 *                         push requires an installed PWA there (16.4+); the
 *                         API is not merely restricted in a tab, it is absent,
 *                         so there is no button that could work.
 *   denied              — permission was refused. Nothing the page does can
 *                         re-prompt; only the OS/browser settings can undo it.
 *   unsupported         — no service worker or no PushManager at all.
 *   not-configured      — the SERVER has no VAPID key. Not the device's fault.
 */
export type PushAvailability = "ready" | "needs-install" | "denied" | "unsupported" | "not-configured";

/**
 * True when the page is running as an installed app rather than in a browser
 * tab. Both spellings are checked: `display-mode: standalone` is the standard
 * and what Chrome/Android answers, `navigator.standalone` is the non-standard
 * one iOS Safari has always used and still the reliable signal there.
 */
export function isStandalone(): boolean {
  const iosStandalone = (navigator as { standalone?: boolean }).standalone;
  if (iosStandalone === true) return true;
  return typeof matchMedia === "function" && matchMedia("(display-mode: standalone)").matches;
}

/**
 * iOS/iPadOS, including an iPad reporting itself as a Mac — which every iPad
 * since iPadOS 13 does by default, and which matters because the install
 * requirement applies to it just the same.
 */
export function isIos(): boolean {
  const ua = navigator.userAgent;
  if (/iPad|iPhone|iPod/.test(ua)) return true;
  return /Macintosh/.test(ua) && typeof navigator.maxTouchPoints === "number" && navigator.maxTouchPoints > 1;
}

export function pushSupported(): boolean {
  return "serviceWorker" in navigator && "PushManager" in globalThis && "Notification" in globalThis;
}

/**
 * The single answer the settings page renders from. Order matters: an iPhone
 * in a Safari tab is reported as `needs-install` rather than `unsupported`,
 * because the two look identical from feature detection and only one of them
 * has a fix the person can carry out.
 */
export function pushAvailability(vapidPublicKey: string | null): PushAvailability {
  if (!pushSupported()) return isIos() && !isStandalone() ? "needs-install" : "unsupported";
  if (isIos() && !isStandalone()) return "needs-install";
  if (!vapidPublicKey) return "not-configured";
  if (Notification.permission === "denied") return "denied";
  return "ready";
}

/**
 * The base64url VAPID public key as the bytes `pushManager.subscribe()` wants.
 * `applicationServerKey` accepts a string in some browsers and not in Safari,
 * so it is always converted here.
 */
export function urlBase64ToUint8Array(base64UrlKey: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64UrlKey.length % 4)) % 4);
  const base64 = (base64UrlKey + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

let registration: Promise<ServiceWorkerRegistration> | null = null;

/**
 * The one registration this app makes, memoized so the boot-time call and a
 * later "Enable notifications" click share it rather than racing two
 * registrations of the same script.
 */
export function ensureServiceWorker(): Promise<ServiceWorkerRegistration> {
  if (!("serviceWorker" in navigator)) {
    return Promise.reject(new Error("This browser has no service worker support."));
  }
  registration ??= navigator.serviceWorker.register("/sw.js");
  return registration;
}

/** Test seam: drops the memoized registration. */
export function resetServiceWorkerRegistration(): void {
  registration = null;
}

/**
 * Ask for permission and register this device, returning the stored device.
 *
 * MUST be called from a user gesture — iOS requires it and silently refuses
 * otherwise, which is the difference between a button that works and one that
 * appears to do nothing.
 */
export async function enablePush(
  api: Api,
  vapidPublicKey: string,
): Promise<{ endpoint: string }> {
  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    throw new Error(
      permission === "denied"
        ? "Notifications are blocked for this site. Allow them in your browser or system settings, then try again."
        : "Notification permission was dismissed.",
    );
  }
  const reg = await ensureServiceWorker();
  // Reuse whatever this device already has: re-subscribing with a different
  // key would leave the old endpoint live and every notification doubled.
  const existing = await reg.pushManager.getSubscription();
  const subscription =
    existing ??
    (await reg.pushManager.subscribe({
      // Non-negotiable on iOS and Chrome alike: a silent push is not allowed,
      // and asking for one is rejected outright.
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(vapidPublicKey),
    }));
  await api.notifications.registerDevice(subscription.toJSON());
  return { endpoint: subscription.endpoint };
}

/**
 * Stop this device receiving push: drop the browser subscription AND the
 * stored row. Dropping only one of the two is how a "disabled" device keeps
 * buzzing, or a live subscription becomes unreachable garbage.
 */
export async function disablePush(api: Api, deviceId: string | null): Promise<void> {
  if ("serviceWorker" in navigator) {
    const reg = await navigator.serviceWorker.getRegistration();
    const subscription = await reg?.pushManager.getSubscription();
    await subscription?.unsubscribe();
  }
  if (deviceId) await api.notifications.removeDevice(deviceId);
}

/** The endpoint this browser currently holds, or null. */
export async function currentEndpoint(): Promise<string | null> {
  if (!("serviceWorker" in navigator)) return null;
  const reg = await navigator.serviceWorker.getRegistration();
  const subscription = await reg?.pushManager.getSubscription();
  return subscription?.endpoint ?? null;
}

/**
 * Keeps the server's idea of this account's timezone current, without ever
 * stepping on a deliberate one.
 *
 * WHY IT EXISTS: the digest fires at a local wall clock, so a zone that is a
 * week stale sends someone's morning summary in the middle of their night.
 * The app is opened on both ends of a flight, so `visibilitychange` is exactly
 * where the change becomes visible.
 *
 * WHY IT READS BEFORE IT WRITES: it posts only when the device zone differs
 * from what the server already stores, so an app that is foregrounded forty
 * times a day writes nothing.
 *
 * WHY IT REMEMBERS WHAT IT SENT: a `manual` pin BEATS a `device` report — the
 * server keeps the pin and answers with it. Without `lastReported`, the
 * comparison above would differ forever and this would re-post on every single
 * foreground for someone who had pinned a zone they were not standing in.
 * Which is most of the people who bother to pin one.
 */
export function createTimezoneReporter(api: Api, deviceZone?: () => string | undefined) {
  const readZone = deviceZone ?? (() => Intl.DateTimeFormat().resolvedOptions().timeZone);
  let lastReported: string | null = null;
  return async function report(): Promise<void> {
    const zone = readZone();
    if (!zone || zone === lastReported) return;
    try {
      const state = await api.notifications.preferences();
      if (state.timezone.timezone === zone) {
        lastReported = zone;
        return;
      }
      await api.notifications.setTimezone(zone, "device");
      lastReported = zone;
    } catch {
      // A failed zone report is not worth a visible error: the next foreground
      // retries, and nothing the person is doing depends on it.
    }
  };
}
