import { describe, it, expect, vi } from "vitest";
import { env } from "cloudflare:test";
import worker from "../../src/server/worker.js";

// A minimal but fully-typed fake ForwardableEmailMessage -- there is no real
// mail transport in the workers-pool test harness, so the stub's contract
// (does it call forward()? does it touch D1?) is exercised directly.
function fakeMessage(forward: (rcptTo: string) => Promise<void>): ForwardableEmailMessage {
  return {
    from: "someone@example.com",
    to: "trips@badgerops.foo",
    raw: new ReadableStream(),
    headers: new Headers(),
    rawSize: 0,
    setReject: () => {},
    async forward(rcptTo: string) {
      await forward(rcptTo);
      return { messageId: "test-message-id" };
    },
    async reply() {
      return { messageId: "test-reply-id" };
    },
  };
}

async function householdCount(): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM household").first<{ n: number }>();
  return row?.n ?? -1;
}

describe("email() stub", () => {
  it("no-ops without throwing when FALLBACK_FORWARD_TO is unset, and writes nothing to D1", async () => {
    const before = await householdCount();
    const forward = vi.fn(async () => {});

    await expect(
      worker.email(fakeMessage(forward), {}, {} as ExecutionContext),
    ).resolves.toBeUndefined();

    expect(forward).not.toHaveBeenCalled();
    expect(await householdCount()).toBe(before);
  });

  it("forwards to FALLBACK_FORWARD_TO when configured, and still writes nothing to D1", async () => {
    const before = await householdCount();
    const forward = vi.fn(async () => {});

    await worker.email(
      fakeMessage(forward),
      { FALLBACK_FORWARD_TO: "owner@example.com" },
      {} as ExecutionContext,
    );

    expect(forward).toHaveBeenCalledTimes(1);
    expect(forward).toHaveBeenCalledWith("owner@example.com");
    expect(await householdCount()).toBe(before);
  });
});
