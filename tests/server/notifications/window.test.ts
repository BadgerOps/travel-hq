import { describe, it, expect } from "vitest";
import {
  CATCH_UP_MINUTES,
  CRON_INTERVAL_MINUTES,
  STALE_LOOKBACK_MINUTES,
  isStale,
  sweepWindow,
} from "../../../src/server/notifications/window.js";

/**
 * No database and no clock: the window is pure arithmetic, and it is the
 * single most important correctness property in the whole feature. If it were
 * ever reduced to an equality, every notification this app sends would go
 * missing at once, silently, with nothing failing.
 */

const NOW = new Date("2026-08-02T14:07:33.000Z");
const minutesBefore = (n: number) => new Date(NOW.getTime() - n * 60_000).toISOString();

describe("sweepWindow", () => {
  it("is a range with a width, never the single instant the tick fired at", () => {
    const window = sweepWindow(NOW);
    expect(window.to.toISOString()).toBe(NOW.toISOString());
    expect(window.from.getTime()).toBeLessThan(window.to.getTime());
    expect(window.to.getTime() - window.from.getTime()).toBeGreaterThanOrEqual(
      CRON_INTERVAL_MINUTES * 60_000,
    );
  });

  it("reaches back the full stale lookback for the query and the catch-up bound for sending", () => {
    const window = sweepWindow(NOW);
    expect(window.from.toISOString()).toBe(minutesBefore(STALE_LOOKBACK_MINUTES));
    expect(window.sendFrom.toISOString()).toBe(minutesBefore(CATCH_UP_MINUTES));
  });

  it("overlaps the previous tick's window rather than abutting it", () => {
    // Overlap is the deliberate failure mode: a duplicate claim is a no-op,
    // whereas a gap is a notification nobody gets and nobody can see was
    // missed. Two consecutive ticks must share ground.
    const first = sweepWindow(NOW);
    const second = sweepWindow(new Date(NOW.getTime() + CRON_INTERVAL_MINUTES * 60_000));
    expect(second.from.getTime()).toBeLessThan(first.to.getTime());
    expect(second.sendFrom.getTime()).toBeLessThan(first.to.getTime());
  });

  it("keeps the query at least as wide as the catch-up bound plus one cron interval", () => {
    // Even if somebody sets the lookback to something absurd, a tick may never
    // be narrower than the ground the previous tick could have missed.
    const window = sweepWindow(NOW, { staleLookbackMinutes: 1 });
    expect(window.to.getTime() - window.from.getTime()).toBe(
      (CATCH_UP_MINUTES + CRON_INTERVAL_MINUTES) * 60_000,
    );
  });

  it("falls back to the defaults for a nonsensical option rather than turning the sweep off", () => {
    const window = sweepWindow(NOW, { catchUpMinutes: -5, intervalMinutes: Number.NaN });
    expect(window.sendFrom.toISOString()).toBe(minutesBefore(CATCH_UP_MINUTES));
  });
});

describe("isStale", () => {
  const window = sweepWindow(NOW);

  it("sends something a few minutes overdue after a missed run", () => {
    expect(isStale(minutesBefore(CATCH_UP_MINUTES - 1), window)).toBe(false);
    expect(isStale(minutesBefore(0), window)).toBe(false);
  });

  it("refuses anything past the catch-up bound, because late is worse than silent", () => {
    expect(isStale(minutesBefore(CATCH_UP_MINUTES + 1), window)).toBe(true);
    expect(isStale(minutesBefore(240), window)).toBe(true);
  });

  it("treats an unreadable instant as stale rather than sending at a guess", () => {
    expect(isStale("not a timestamp", window)).toBe(true);
  });
});
