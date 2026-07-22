import { createLocalJWKSet, jwtVerify } from "jose";
import type { JSONWebKeySet } from "jose";
import type { Role } from "./repos/base.js";

export class AuthError extends Error {}

/**
 * The caller authenticated fine (a valid Access token, a known user) but the
 * household they asked to act as is not one they belong to. This is an
 * authorization failure, not an authentication one -- semantically a 403,
 * not the 401 every other AuthError maps to -- so it gets its own subclass
 * for mapError() to key on. The message text is unchanged from AuthError's:
 * it is deliberately identical whether the named household exists and the
 * caller isn't a member, or the household doesn't exist at all, so this
 * error can never be used as a membership oracle. Only change the class,
 * never the wording.
 */
export class HouseholdAccessError extends AuthError {}

export type Identity = {
  userId: string;
  email: string;
  householdId: string;
  role: Role;
};

export type AccessConfig = {
  /** e.g. https://badgerops.cloudflareaccess.com */
  teamDomain: string;
  /** The Access application's AUD tag. */
  audience: string;
  db: D1Database;
  /** Injectable for tests; defaults to fetching the team's certs endpoint. */
  fetchJwks?: () => Promise<JSONWebKeySet>;
};

const HEADER = "Cf-Access-Jwt-Assertion";

/**
 * Selects which of the caller's households a request acts on. This is a
 * SELECTOR, never a discovery mechanism: `verify()` only ever returns a
 * household the JWT-verified email is already a confirmed member of.
 */
const HOUSEHOLD_HEADER = "X-Travel-HQ-Household";

const JWKS_TTL_MS = 60 * 60 * 1000;

type Membership = {
  user_id: string;
  email: string;
  household_id: string;
  role: Role;
};

// No LIMIT: resolution must confirm membership in the requested household,
// never guess one. ORDER BY makes result order reproducible.
const MEMBERSHIP_SQL = `SELECT u.id AS user_id, u.email, hm.household_id, hm.role
     FROM user u
     JOIN household_member hm ON hm.user_id = u.id
    WHERE u.email = ?
    ORDER BY hm.household_id`;

/**
 * Resolves an identity from a bare email, with no JWT involved at all. Used
 * only by the development auth bypass (`resolveVerifier`'s dev-email path),
 * which skips the Cf-Access-Jwt-Assertion check entirely on a laptop with no
 * Cloudflare Access in front of it -- but never the membership check below.
 *
 * This lives in auth.ts, not worker.ts, for the same reason the rest of this
 * file is the documented bootstrap exception to "repositories are the only
 * raw-SQL callers": you cannot scope a query by household before you've
 * resolved which household the request belongs to. Returns `undefined` --
 * never invents a household -- for an email with no confirmed
 * household_member row; the caller is responsible for turning that into an
 * AuthError.
 */
export async function resolveDevIdentity(db: D1Database, email: string): Promise<Identity | undefined> {
  const row = await db.prepare(MEMBERSHIP_SQL).bind(email).first<Membership>();
  if (!row) return undefined;
  return {
    userId: row.user_id,
    email: row.email,
    householdId: row.household_id,
    role: row.role,
  };
}

export function createAccessVerifier(config: AccessConfig) {
  const fetchJwks =
    config.fetchJwks ??
    (async () => {
      const res = await fetch(`${config.teamDomain}/cdn-cgi/access/certs`);
      if (!res.ok) throw new AuthError(`Could not fetch Access certs: ${res.status}`);
      return (await res.json()) as JSONWebKeySet;
    });

  let cached: { jwks: ReturnType<typeof createLocalJWKSet>; at: number } | null = null;

  async function keys() {
    if (!cached || Date.now() - cached.at > JWKS_TTL_MS) {
      cached = { jwks: createLocalJWKSet(await fetchJwks()), at: Date.now() };
    }
    return cached.jwks;
  }

  return async function verify(req: Request): Promise<Identity> {
    const token = req.headers.get(HEADER);
    if (!token) {
      throw new AuthError(`Missing ${HEADER}. Requests must arrive through Cloudflare Access.`);
    }

    let email: string;
    try {
      const { payload } = await jwtVerify(token, await keys(), {
        issuer: config.teamDomain,
        audience: config.audience,
      });
      // ORDER IS LOAD-BEARING. A real Access service-token JWT carries
      // `common_name` and NO `email`, so if this sat after the email check
      // below it could never run: the email check would throw first and this
      // refusal would be dead code that looks like a control. A test
      // asserting only `.rejects.toThrow(AuthError)` would pass either way,
      // satisfied by the wrong branch. It goes first, and its test asserts
      // this exact message.
      if (typeof payload.common_name === "string") {
        throw new AuthError("Service tokens may not use the human API");
      }
      if (typeof payload.email !== "string") {
        throw new AuthError("Access token carries no email claim");
      }
      email = payload.email;
    } catch (err) {
      if (err instanceof AuthError) throw err;
      throw new AuthError(`Invalid Access token: ${String(err)}`);
    }

    const { results: memberships } = await config.db.prepare(MEMBERSHIP_SQL).bind(email).all<Membership>();

    if (memberships.length === 0) {
      throw new AuthError(`No household membership for ${email}`);
    }

    const requested = req.headers.get(HOUSEHOLD_HEADER);
    let membership: Membership;

    if (requested !== null) {
      // Header present: it must name a household the caller is a confirmed
      // member of, or this fails outright. It never falls back to picking a
      // different membership.
      const match = memberships.find((m) => m.household_id === requested);
      if (!match) {
        // Deliberately the same message whether `requested` names a
        // household the caller isn't in, or one that doesn't exist at all.
        // Distinguishing those would let a client use this error to probe
        // which household ids exist -- a membership oracle. (HouseholdAccessError
        // changes only the HTTP status this maps to -- the message itself
        // must stay byte-identical between both cases.)
        throw new HouseholdAccessError(
          `Not a member of the requested household. Provide a valid ${HOUSEHOLD_HEADER} header.`,
        );
      }
      membership = match;
    } else if (memberships.length === 1) {
      const only = memberships[0];
      // `memberships.length === 1` guarantees this is defined; under
      // noUncheckedIndexedAccess the type is still `Membership | undefined`,
      // so narrow explicitly rather than asserting with `!`.
      if (!only) {
        throw new AuthError(`No household membership for ${email}`);
      }
      membership = only;
    } else {
      // Two or more memberships and no header: never guess. Fail closed and
      // name the header the caller needs to send.
      throw new AuthError(
        `Ambiguous household membership for ${email}; specify the ${HOUSEHOLD_HEADER} header.`,
      );
    }

    return {
      userId: membership.user_id,
      email: membership.email,
      householdId: membership.household_id,
      role: membership.role,
    };
  };
}

/**
 * Resolves the human verifier from the Worker env. Development must be opted
 * INTO explicitly (TRAVEL_HQ_ENV === "development" AND TRAVEL_HQ_DEV_EMAIL
 * set); TRAVEL_HQ_DEV_EMAIL set with any other (or missing) TRAVEL_HQ_ENV is
 * refused outright rather than silently falling through to production
 * verification -- a wrangler.toml or CI env misconfiguration must fail loud,
 * not quietly disable the bypass. The bypass resolves an identity exactly as
 * createAccessVerifier does once a JWT checks out -- via a confirmed
 * household membership -- it just skips the JWT because a laptop has no
 * Cloudflare Access in front of it.
 */
export type WorkerAuthEnv = {
  DB: D1Database;
  TRAVEL_HQ_ENV?: string;
  TRAVEL_HQ_DEV_EMAIL?: string;
  CF_ACCESS_TEAM_DOMAIN?: string;
  CF_ACCESS_AUD?: string;
};

export function resolveVerifier(env: WorkerAuthEnv): (req: Request) => Promise<Identity> {
  const isDevelopment = env.TRAVEL_HQ_ENV === "development";
  const devEmail = env.TRAVEL_HQ_DEV_EMAIL;

  if (devEmail) {
    if (!isDevelopment) {
      throw new Error("TRAVEL_HQ_DEV_EMAIL must never be set outside development");
    }
    console.warn(`[dev] AUTH BYPASS ACTIVE -- every request acts as ${devEmail}`);
    return async function verifyDev(): Promise<Identity> {
      const identity = await resolveDevIdentity(env.DB, devEmail);
      if (!identity) {
        throw new AuthError(`No household membership for ${devEmail}.`);
      }
      return identity;
    };
  }

  const teamDomain = env.CF_ACCESS_TEAM_DOMAIN;
  const audience = env.CF_ACCESS_AUD;
  if (!teamDomain || !audience) {
    throw new Error("CF_ACCESS_TEAM_DOMAIN and CF_ACCESS_AUD must be set");
  }
  return createAccessVerifier({ teamDomain, audience, db: env.DB });
}
