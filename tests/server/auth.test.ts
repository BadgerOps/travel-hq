import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import type { JSONWebKeySet } from "jose";
import {
  createAccessVerifier,
  resolveDevIdentity,
  resolveVerifier,
  AuthError,
  HouseholdAccessError,
} from "../../src/server/auth.js";

const TEAM = "https://badgerops.cloudflareaccess.com";
const AUD = "test-aud";
const HEADER = "Cf-Access-Jwt-Assertion";
const HOUSEHOLD_HEADER = "X-Travel-HQ-Household";

let privateKey: CryptoKey;
let jwks: JSONWebKeySet;

async function token(
  claims: Record<string, unknown>,
  opts: { key?: CryptoKey; audience?: string; expSeconds?: number } = {},
): Promise<string> {
  const builder = new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setIssuer(TEAM)
    .setAudience(opts.audience ?? AUD)
    .setExpirationTime(opts.expSeconds ?? "5m");
  return builder.sign(opts.key ?? privateKey);
}

function req(headers: Record<string, string>): Request {
  return new Request("http://x/api/me", { headers });
}

function verifier() {
  return createAccessVerifier({ teamDomain: TEAM, audience: AUD, db: env.DB, fetchJwks: async () => jwks });
}

beforeEach(async () => {
  const pair = await generateKeyPair("RS256", { extractable: true });
  privateKey = pair.privateKey;
  const pub = await exportJWK(pair.publicKey);
  pub.kid = "k1";
  pub.alg = "RS256";
  jwks = { keys: [pub] };

  await env.DB.exec("DELETE FROM household_member");
  await env.DB.exec("DELETE FROM user");
  await env.DB.exec("DELETE FROM household");
  const now = new Date().toISOString();
  for (const id of ["hh-a", "hh-b"]) {
    await env.DB.prepare("INSERT INTO household (id,name,created_at) VALUES (?,?,?)").bind(id, id, now).run();
  }
  await env.DB.prepare("INSERT INTO user (id,email,created_at) VALUES (?,?,?)")
    .bind("u1", "ava@example.com", now)
    .run();
});

async function member(householdId: string, role: string) {
  await env.DB.prepare("INSERT INTO household_member (household_id,user_id,role) VALUES (?,?,?)")
    .bind(householdId, "u1", role)
    .run();
}

describe("createAccessVerifier", () => {
  it("rejects a missing Access header", async () => {
    await expect(verifier()(req({}))).rejects.toThrow(AuthError);
  });

  it("refuses a service-token JWT (common_name, no email) before the email check", async () => {
    await member("hh-a", "owner");
    const t = await token({ common_name: "svc" });
    await expect(verifier()(req({ [HEADER]: t }))).rejects.toThrow(/Service tokens may not use the human API/);
  });

  it("rejects a token with no email claim", async () => {
    const t = await token({ sub: "x" });
    await expect(verifier()(req({ [HEADER]: t }))).rejects.toThrow(/no email claim/);
  });

  it("rejects a token signed by the wrong key", async () => {
    await member("hh-a", "owner");
    const attacker = await generateKeyPair("RS256", { extractable: true });
    const t = await token({ email: "ava@example.com" }, { key: attacker.privateKey });
    await expect(verifier()(req({ [HEADER]: t }))).rejects.toThrow(AuthError);
  });

  it("rejects a token for the wrong audience", async () => {
    await member("hh-a", "owner");
    const t = await token({ email: "ava@example.com" }, { audience: "some-other-app" });
    await expect(verifier()(req({ [HEADER]: t }))).rejects.toThrow(AuthError);
  });

  it("rejects an expired token", async () => {
    await member("hh-a", "owner");
    const t = await token({ email: "ava@example.com" }, { expSeconds: Math.floor(Date.now() / 1000) - 60 });
    await expect(verifier()(req({ [HEADER]: t }))).rejects.toThrow(AuthError);
  });

  it("rejects a valid token for an unknown user", async () => {
    await member("hh-a", "owner");
    const t = await token({ email: "stranger@example.com" });
    await expect(verifier()(req({ [HEADER]: t }))).rejects.toThrow(/No household membership/);
  });

  it("rejects an email with no household membership", async () => {
    const t = await token({ email: "ava@example.com" });
    await expect(verifier()(req({ [HEADER]: t }))).rejects.toThrow(/No household membership/);
  });

  it("resolves the sole membership when no header is given", async () => {
    await member("hh-a", "owner");
    const id = await verifier()(req({ [HEADER]: await token({ email: "ava@example.com" }) }));
    expect(id).toMatchObject({ userId: "u1", householdId: "hh-a", role: "owner" });
  });

  it("matches the Access email case-insensitively", async () => {
    await member("hh-a", "owner");
    const id = await verifier()(req({
      [HEADER]: await token({ email: "AVA@EXAMPLE.COM" }),
    }));
    expect(id).toMatchObject({ userId: "u1", householdId: "hh-a" });
  });

  it("selects the requested household via the header", async () => {
    await member("hh-a", "owner");
    await member("hh-b", "viewer");
    const id = await verifier()(
      req({ [HEADER]: await token({ email: "ava@example.com" }), [HOUSEHOLD_HEADER]: "hh-b" }),
    );
    expect(id).toMatchObject({ householdId: "hh-b", role: "viewer" });
  });

  it("throws HouseholdAccessError for a header naming a non-member household", async () => {
    await member("hh-a", "owner");
    await expect(
      verifier()(req({ [HEADER]: await token({ email: "ava@example.com" }), [HOUSEHOLD_HEADER]: "hh-b" })),
    ).rejects.toThrow(HouseholdAccessError);
  });

  it("throws AuthError for ambiguous membership with no header", async () => {
    await member("hh-a", "owner");
    await member("hh-b", "viewer");
    await expect(
      verifier()(req({ [HEADER]: await token({ email: "ava@example.com" }) })),
    ).rejects.toThrow(/Ambiguous household membership/);
  });

  // The membership oracle test: whether the header names a household the
  // caller genuinely isn't a member of, or one that does not exist at all,
  // the thrown error must be byte-identical. Otherwise a client could probe
  // household ids by diffing error messages.
  it("does not disclose whether a non-member household exists (byte-equal message)", async () => {
    await member("hh-a", "owner");
    const t = await token({ email: "ava@example.com" });

    const notMember = await verifier()(req({ [HEADER]: t, [HOUSEHOLD_HEADER]: "hh-b" })).catch(
      (err) => err as AuthError,
    );
    const doesNotExist = await verifier()(
      req({ [HEADER]: t, [HOUSEHOLD_HEADER]: "hh-does-not-exist" }),
    ).catch((err) => err as AuthError);

    expect(notMember).toBeInstanceOf(HouseholdAccessError);
    expect(doesNotExist).toBeInstanceOf(HouseholdAccessError);
    expect((doesNotExist as AuthError).message).toBe((notMember as AuthError).message);
  });
});

describe("resolveDevIdentity", () => {
  it("resolves an identity for a member email", async () => {
    await member("hh-a", "owner");
    const id = await resolveDevIdentity(env.DB, "ava@example.com");
    expect(id).toMatchObject({ userId: "u1", householdId: "hh-a", role: "owner" });
  });

  it("returns undefined for an email with no membership", async () => {
    const id = await resolveDevIdentity(env.DB, "ava@example.com");
    expect(id).toBeUndefined();
  });
});

describe("resolveVerifier", () => {
  it("refuses to enable the dev bypass outside development", () => {
    expect(() => resolveVerifier({ DB: env.DB, TRAVEL_HQ_DEV_EMAIL: "ava@example.com" })).toThrow(
      /TRAVEL_HQ_DEV_EMAIL must never be set outside development/,
    );
  });

  it("refuses the dev bypass even when TRAVEL_HQ_ENV is set to something other than development", () => {
    expect(() =>
      resolveVerifier({ DB: env.DB, TRAVEL_HQ_ENV: "production", TRAVEL_HQ_DEV_EMAIL: "ava@example.com" }),
    ).toThrow(/TRAVEL_HQ_DEV_EMAIL must never be set outside development/);
  });

  it("in development with a dev email, resolves an identity via confirmed membership", async () => {
    await member("hh-a", "owner");
    const verify = resolveVerifier({
      DB: env.DB,
      TRAVEL_HQ_ENV: "development",
      TRAVEL_HQ_DEV_EMAIL: "ava@example.com",
    });
    const id = await verify(req({}));
    expect(id).toMatchObject({ userId: "u1", householdId: "hh-a", role: "owner" });
  });

  it("the dev bypass still enforces membership -- no membership row is still an AuthError", async () => {
    const verify = resolveVerifier({
      DB: env.DB,
      TRAVEL_HQ_ENV: "development",
      TRAVEL_HQ_DEV_EMAIL: "ava@example.com",
    });
    await expect(verify(req({}))).rejects.toThrow(AuthError);
  });

  it("without a dev email, requires CF_ACCESS_TEAM_DOMAIN and CF_ACCESS_AUD", () => {
    expect(() => resolveVerifier({ DB: env.DB })).toThrow(
      /CF_ACCESS_TEAM_DOMAIN and CF_ACCESS_AUD must be set/,
    );
  });

  it("without a dev email, builds a real Access verifier that rejects a missing token", async () => {
    const verify = resolveVerifier({
      DB: env.DB,
      CF_ACCESS_TEAM_DOMAIN: TEAM,
      CF_ACCESS_AUD: AUD,
    });
    await expect(verify(req({}))).rejects.toThrow(AuthError);
  });
});
