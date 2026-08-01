import { beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { handleInboundEmail } from "../../src/server/ingest.js";
import { Keyring } from "../../src/server/crypto/envelope.js";
import { HouseholdSettingsRepo } from "../../src/server/repos/household-settings.js";
import { InboundEmailRepo } from "../../src/server/repos/inbound-email.js";
import type { HouseholdContext } from "../../src/server/repos/base.js";
import { RAW_RETENTION_UNRESOLVED_DAYS } from "../../src/shared/email-retention.js";

const ctxA: HouseholdContext = { householdId: "hh-a", userId: "u1", role: "owner" };

// The ENCRYPTION_KEY secret's on-the-wire shape: "<key id> <base64 32 bytes>".
const KEY_BYTES = crypto.getRandomValues(new Uint8Array(32));
const ENCRYPTION_KEY = `k1 ${btoa(String.fromCharCode(...KEY_BYTES))}`;
const ring = new Keyring("k1", { k1: KEY_BYTES });

const AUTH_PASS = "mx.cloudflare.net; dkim=pass; spf=pass smtp.mailfrom=example.com; dmarc=pass";
const BODY = "Subject: Trip\r\n\r\nConfirmation ABC123 at the Grand Hotel";

function fakeMessage(rawText = BODY): ForwardableEmailMessage {
  return {
    from: "badger@example.com",
    to: "trips@badgerops.foo",
    raw: new Response(rawText).body ?? new ReadableStream(),
    headers: new Headers({ "Authentication-Results": AUTH_PASS }),
    rawSize: rawText.length,
    setReject: () => {},
    async forward() {
      return { messageId: "test-message-id" };
    },
    async reply() {
      return { messageId: "test-reply-id" };
    },
  };
}

beforeEach(async () => {
  await env.DB.exec("DELETE FROM inbound_email");
  await env.DB.exec("DELETE FROM household_settings");
  await env.DB.exec("DELETE FROM household");
  await env.DB.prepare("INSERT INTO household (id,name,created_at) VALUES (?,?,?)")
    .bind("hh-a", "A", new Date().toISOString())
    .run();
  await new HouseholdSettingsRepo(env.DB, ctxA).updateSettings({
    forwardAddress: "trips@badgerops.foo",
    senderAllowlist: ["badger@example.com"],
  });
});

describe("email() ingest raw lifecycle", () => {
  it("seals the message before it reaches D1 when a keyring is configured", async () => {
    await handleInboundEmail(fakeMessage(), { DB: env.DB, ENCRYPTION_KEY });

    const row = await env.DB.prepare("SELECT raw, raw_encryption FROM inbound_email")
      .first<{ raw: string; raw_encryption: string }>();
    expect(row?.raw_encryption).toBe("envelope");
    expect(row?.raw).not.toContain("ABC123");
    expect(await ring.decrypt(row!.raw)).toBe(BODY);
  });

  it("still stores readable mail when no keyring is configured, rather than losing it", async () => {
    // A Worker deployed without the secret must not start dropping
    // confirmations; it falls back to the pre-0015 behaviour and says so in
    // the column, so a later read knows not to try decrypting it.
    await handleInboundEmail(fakeMessage(), { DB: env.DB });

    const row = await env.DB.prepare("SELECT raw, raw_encryption FROM inbound_email")
      .first<{ raw: string; raw_encryption: string }>();
    expect(row?.raw_encryption).toBe("plaintext");
    expect(row?.raw).toBe(BODY);
  });

  it("sweeps expired raw as a side effect of new mail arriving", async () => {
    // No cron trigger exists for this Worker, so ingest is one of the two
    // places the retention policy actually gets enforced.
    const stale = await InboundEmailRepo.forIngest(env.DB, "hh-a", ring).create({
      from: "old@example.com",
      to: "trips@badgerops.foo",
      raw: "Subject: Old\r\n\r\nAn expired confirmation",
    });
    await env.DB.prepare("UPDATE inbound_email SET received_at = ? WHERE id = ?")
      .bind(
        new Date(Date.now() - (RAW_RETENTION_UNRESOLVED_DAYS + 1) * 86_400_000).toISOString(),
        stale.id,
      )
      .run();

    await handleInboundEmail(fakeMessage(), { DB: env.DB, ENCRYPTION_KEY });

    const reader = InboundEmailRepo.forIngest(env.DB, "hh-a", ring);
    const swept = await reader.findById(stale.id);
    expect(swept?.rawState).toBe("purged");
    expect(swept?.raw).toBe("");
    // The mail that triggered the sweep is itself untouched.
    expect((await reader.list()).filter((e) => e.rawState === "retained")).toHaveLength(1);
  });
});
