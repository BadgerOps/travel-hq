# Travel HQ Data Entry and Import Implementation Plan — Part B: inbound email

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A confirmation email forwarded to the household address becomes a reviewable draft booking, parsed locally, never written into a trip record without a human approving it.

**Architecture:** Cloudflare Email Routing hands the message to a deliberately dumb Worker, which verifies the sender and `POST`s the raw MIME to `/api/inbound-email` authenticated with a Cloudflare Access **service token**. The app parses it: `.ics` attachment first, a **local** OpenAI-compatible model second, and Claude third — only as an explicit per-message escalation a human presses in the review UI. Results land in an `inbound_email` row for review; approving one creates real `booking` rows at `status='draft'`.

**Tech Stack:** Node 22, Hono, SQLite, Zod 4, an OpenAI-compatible local model server (Ollama by default), `@anthropic-ai/sdk` (escalation only), React 19, `wouter`, Vitest.

**Read Part A first.** `docs/superpowers/plans/2026-07-21-data-entry-and-import.md` holds the Goal/Architecture framing, the Global Constraints, and Tasks 1–8. **Every constraint in Part A's "Global Constraints" section applies here unchanged** and is not repeated. Part B adds the constraints below on top of them.

## Prerequisites

Part A Tasks 1–8 complete and green (`npm run test:all`). Task 14 consumes Part A Task 3's API client and Part A Task 6's `TravelerToggles`.

## Additional constraints for Part B

- **Extraction is local-first, and this is a privacy decision, not a performance one.** See "Why local-first" below. Do not "simplify" it back to a Claude-first design.
- **Everything lands as a draft.** No parser output ever becomes a `booking` row without a human pressing a button. A flaky parser must never write into a trip record.
- **Extraction fails soft.** If the local model server is down, slow, or returns garbage, the email still lands as a reviewable row — minimally populated and flagged as needing manual completion. An email that vanishes because Ollama was not running is the worst outcome available here.
- **Tests never contact a model.** Every test injects a fake `Extractor`. A suite that needs a running LLM is a suite nobody runs, and it would make the CI result depend on a GPU.
- **`src/server/ingest/` is not on the architecture test's raw-SQL allowlist.** Parsing and extraction modules take strings and return values; persistence is `InboundEmailRepo`'s job.
- **The stored email body is encrypted at rest.** A confirmation email contains full legal names, confirmation numbers, frequent-flyer numbers, addresses, and card last-4. It goes through the same `Keyring` envelope as passport numbers, and is returned to the UI only on an explicit single-record read.

## Why local-first — record this, it is load-bearing

The architecture already rejected full Cloudflare (D1 + Workers) **specifically** to keep passport numbers, DOBs, and Known Traveler numbers off third-party infrastructure, accepting guiltyspark-as-a-travel-dependency as the price (see `docs/HANDOFF.md`, "Why the architecture changed").

Travel confirmation emails are among the most PII-dense documents this family will ever produce: full legal names as they appear on passports, confirmation numbers, frequent-flyer numbers, sometimes KTN or passport digits, home and destination addresses, and card last-4. **Routing them to an external API by default would reintroduce exactly the custody change that was already declined, just through a different door.** Local-by-default is what keeps the stated privacy posture coherent.

Claude remains available, because a local 7B model will occasionally lose to a badly-formatted email and a human staring at an unparsed message deserves one more option. But it is an escalation a person chooses, per message, after seeing that local extraction failed — never a default, never automatic, and never silent.

**Schema-constrained decoding is what makes a small local model viable.** Ollama, llama.cpp's server, vLLM, and LM Studio all accept a JSON schema and constrain generation to it, so the model *cannot* emit a shape the Zod schema would reject. That removes the failure mode small models are worst at — malformed JSON, invented keys, prose wrapped around the object — and leaves only the failure mode a human review step already covers: getting a value wrong. Zod validation still runs on the result regardless; constrained decoding guarantees shape, not correctness.

## Model configuration

| Setting | Env var | Default |
| --- | --- | --- |
| Base URL | `TRAVEL_HQ_EXTRACT_BASE_URL` | `http://127.0.0.1:11434/v1` (Ollama's OpenAI-compatible endpoint) |
| Model | `TRAVEL_HQ_EXTRACT_MODEL` | `qwen2.5:7b-instruct` |
| Request timeout (ms) | `TRAVEL_HQ_EXTRACT_TIMEOUT_MS` | `45000` |
| API key (sent as `Authorization: Bearer`, ignored by Ollama) | `TRAVEL_HQ_EXTRACT_API_KEY` | unset |

Because every one of those servers speaks the same `POST {base}/chat/completions` shape, **changing model or runtime is configuration, not code.**

Target hardware is a discrete GPU with **8–12GB VRAM**, so the 7–14B tier at q4:

| VRAM | Model | Approx. q4 weights | Notes |
| --- | --- | --- | --- |
| 8 GB | `qwen2.5:7b-instruct` | ~4.7 GB | The default. Leaves room for KV cache on a long email. |
| 10 GB | `qwen2.5:7b-instruct` | ~4.7 GB | Same model, more context headroom. |
| 12 GB | `qwen2.5:14b-instruct` | ~9 GB | The upgrade at the top of the range. Noticeably better on unusual layouts; tighter on context. |

Nothing here needs more than 12GB. Do not specify a model that does.

---

## File Structure — Part B

```
src/server/
  db/migrations/
    002_inbound_email.sql   ← NEW
  repos/
    inbound-email.ts        ← NEW
  ingest/                   ← NEW dir. No SQL, ever.
    mime.ts                 ← minimal MIME splitter
    ics.ts                  ← minimal iCalendar VEVENT reader
    extracted.ts            ← the Zod schema every extractor validates against
    extractor.ts            ← the Extractor interface + the fail-soft chain
    ics-extractor.ts        ← IcsExtractor
    local-llm-extractor.ts  ← LocalLlmExtractor (OpenAI-compatible)
    claude-extractor.ts     ← ClaudeExtractor (manual escalation only)
  routes/
    inbound-email.ts        ← NEW: POST /api/inbound-email, the queue, approve, escalate
  auth.ts                   ← MODIFIED: service-token verifier, householdExists()
  repos/base.ts             ← MODIFIED: the "machine" role, requireIngestWrite(),
                                        insert()'s guard parameter
  index.ts                  ← MODIFIED: mount the ingest path (POST only) outside
                                        the human middleware
  schemas/booking-kinds.ts  ← MODIFIED: BOOKING_KINDS as a literal tuple
src/client/
  pages/Import.tsx          ← REPLACED: the draft queue (Import prototype)
  import/
    DraftCard.tsx           ← NEW: one parsed draft, reviewable and editable
workers/
  inbound-email/            ← NEW, BLOCKED on the hostname decision
    src/index.ts
    wrangler.toml
```

---

### Task 9: The Access service token, and what a machine caller is allowed to be

**Files:**
- Modify: `src/server/repos/base.ts`
- Modify: `src/server/auth.ts`
- Modify: `src/server/index.ts`
- Modify: `src/server/serve.ts`
- Test: `tests/server/auth-service-token.test.ts`
- Test: `tests/server/serve.test.ts` (extend)

**Interfaces:**
- Consumes: `createLocalJWKSet` / `jwtVerify` from `jose`, already used by `createAccessVerifier`
- Produces:
  - `Role` gains `"machine"`; `TenantRepo.requireIngestWrite()`; `TenantRepo.insert()` gains a guard parameter
  - `createServiceTokenVerifier(config): (req: Request) => Promise<Identity>`
  - `householdExists(db, householdId): boolean` from `src/server/auth.ts`
  - `INBOUND_EMAIL_PATH` exported from `src/server/index.ts`
  - `resolveIngestVerifier(env)` from `src/server/serve.ts`

**This task runs FIRST, before the schema and repository task, and that ordering is deliberate.** It depends on nothing Task 10 produces: it touches `base.ts`, `auth.ts`, `index.ts`, and `serve.ts`, and its tests need only `household`, `user`, `household_member`, and `createApp` — not the `inbound_email` table and not `InboundEmailRepo`. The `app.route(INBOUND_EMAIL_PATH, inboundEmail)` mount belongs to Task 13, not here. Running the auth change first means **every commit in Part B is green**, `git bisect` keeps working, and the security decision still gets its own reviewable commit with its own message — which is the property the ordering was originally trying to protect by other means.

**This is a security-critical design decision. The reasoning below is the deliverable as much as the code is.**

#### How the credential actually arrives

The Worker sends `CF-Access-Client-Id` and `CF-Access-Client-Secret`. **Those headers never reach the origin as the thing we validate.** Cloudflare Access validates them at the edge against an Access policy that permits that service token on `/api/inbound-email`, and then forwards the request with the same `Cf-Access-Jwt-Assertion` header a human request carries — signed by the same team keys, with the same issuer and audience. The difference is in the claims: a human token carries `email`; a service-token JWT carries **`common_name`** (the token's client id) and no `email`.

That is the fact the whole design rests on, and it is a good fact: **the signature-verification path is byte-identical for both callers.** Nothing about the human path is loosened, softened, or made conditional. `jose` verifies the same JWKS, the same `issuer`, the same `audience`. Only the claim-to-identity mapping branches, and it branches *after* verification.

#### What identity a machine caller gets, and why

`verify()` returns an `Identity` with a `householdId` and a `role`. Three options were considered:

1. **Reuse `adult`.** Rejected. `requireWrite()` would then let the ingest credential create people, trips, and bookings, and `requireReveal()` would let it decrypt a passport number. A stolen service token — a static secret sitting in a Cloudflare Worker's environment — would be a full household compromise.
2. **Reuse `viewer`.** Rejected for the opposite reason: `viewer` cannot write at all, and the ingest path's entire job is to write one row.
3. **Add a fourth role, `machine`.** Chosen.

`machine` is not a weaker `adult`; it is a *differently-shaped* principal, and the permission model inverts to say so:

| Guard | `owner` / `adult` | `viewer` | `machine` |
| --- | --- | --- | --- |
| `requireWrite()` — every existing repository, and `TenantRepo.run()` on any write SQL | allow | **deny** | **deny** |
| `requireIngestWrite()` — `InboundEmailRepo.create` only | allow | deny | **allow** |
| `requireReveal()` — every encrypted read | allow | deny | **deny** |
| **`all()` / `get()` / `unscoped()` — every READ** | allow | allow | **allow** |

**The default is deny, and the opt-in is per-method.** `PersonRepo`, `TripRepo`, `BookingRepo`, `ChecklistRepo`, and `InboundEmailRepo.resolve/setExtraction` all call `requireWrite()` and therefore refuse a machine caller **with no edits to any of them**. Exactly one method in the codebase calls `requireIngestWrite()`. That is the entire blast radius of the ingest credential's *writes*, enforced by the guard and by a test, rather than by the route file happening not to construct the wrong repository.

**Read the last row of that table carefully; it is not a formality.** `TenantRepo`'s read methods — `all()`, `get()`, `unscoped()` — carry **no role guard at all**. They scope by household and nothing else. Only mutations (`run()`/`insert()`, via `requireWrite()`) and plaintext reveals (via `requireReveal()`) consult the role. So `InboundEmailRepo.list()`, which is built on `all()`, would happily serve the whole pending queue to a machine identity — including the `extracted` JSON, which holds a **plaintext `confirmationNumber` and `costCents`**, because only `body_text` is enveloped.

**Containment for reads therefore comes from routing, not from `TenantRepo`.** The "write-only credential" property is true only because the ingest middleware is scoped to `POST` on exactly one path (Step 5), so a service token has no way to issue the `GET` that would read the queue back. That is a real and sufficient control, but it is a *routing* control, and anyone who widens the ingest middleware to another method or another path removes it silently. Do not describe the machine role as read-proof; describe it as write-only-by-routing, which is what it is.

#### Why `insert()` needs a guard parameter

`TenantRepo.insert()` (base.ts, ~line 300) unconditionally calls `this.requireWrite()`. Once `requireWrite()` denies `machine`, `InboundEmailRepo.create()` — the *one* write the machine role exists to perform — calls `requireIngestWrite()`, passes, then reaches `insert()` and **403s on itself**. Task 13's ingest endpoint would answer 403 instead of 202, no row would ever be stored, and every fail-soft guarantee in Part B would collapse: an email that cannot be written is an email that is lost.

So `insert()` takes its guard as a parameter, defaulting to `requireWrite()`:

```ts
protected insert(table: string, values: Record<string, unknown>, guard: () => void = () => this.requireWrite()): void
```

Every existing call site is unchanged and keeps the default. `InboundEmailRepo.create` passes `() => this.requireIngestWrite()`.

**Do NOT instead override `requireWrite()` inside `InboundEmailRepo`.** That would look tidier and would be wrong: `setExtraction()` and `resolve()` call `this.run()`, which calls `this.requireWrite()`, so an override re-opens *both* of them to the machine identity — and those are precisely the two methods this design closes, because approving and discarding are human acts. The whole point is that the opt-in is per *method*, not per *class*.

**The machine's household comes from configuration, never from a header.** `verify()` resolves a human's household from a confirmed `household_member` row and honours an `X-Travel-HQ-Household` selector. A machine has no membership row and gets no selector: its `householdId` is `TRAVEL_HQ_INBOUND_HOUSEHOLD_ID`. Letting an ingest credential name its own tenant would be a tenancy hole with a static secret in front of it. Phase 1 has one household; when that stops being true, this becomes one env var per Worker, which is the correct shape anyway.

`userId` is `service:<common_name>` — a sentinel, deliberately not a `user` row. It exists so the audit trail names the *credential* that queued an email rather than a person who did not. Nothing joins on it. (`Role` is also the type of `household_member.role`, whose CHECK constraint still permits only the three human roles — so `"machine"` can never come out of the database, only out of `createServiceTokenVerifier`. No migration is needed and none should be added.)

#### Keeping the two paths from touching

`createApp` currently runs one middleware over `/api/*`. Two changes:

- A second middleware runs the service-token verifier on `POST` to `/api/inbound-email` — **that method and that path only**.
- The human middleware **skips exactly that method-and-path pair**, by a named constant rather than by a regex, so the skip is greppable and testable.

**The method scoping is not tidiness; it is load-bearing, in two directions.** `app.use(INBOUND_EMAIL_PATH, mw)` matches *every* method on that path, and a skip condition written as `c.req.path === INBOUND_EMAIL_PATH` skips the human middleware for every method too. Verified empirically against the installed Hono, that combination produces:

```
INGEST POST /api/inbound-email
INGEST GET  /api/inbound-email        ← wrong
HUMAN  GET  /api/inbound-email/x/body
HUMAN  POST /api/inbound-email/x/approve
```

The `GET` line breaks two things at once:

1. **The Import page could never load in production.** `api.inbound.list()` (Task 14) issues `GET /api/inbound-email` from a browser. Routed to the service-token verifier, it carries no service token and 401s — permanently, for every human, on a screen Task 14 otherwise ships as working.
2. **The "write-only credential" claim would be false.** Per the permission table above, `all()` has no role guard, so `GET /api/inbound-email` under a stolen service token would return every pending row, `extracted` JSON included — plaintext confirmation numbers and costs.

So the ingest middleware is registered with `app.post(INBOUND_EMAIL_PATH, …)` (or, equivalently, an early `if (c.req.method !== "POST") return next();`), and the human middleware's skip tests method *and* path. Both spellings are fine; what is not fine is either half being method-blind.

And, symmetrically: **`verify()` rejects a service-token JWT.** A token carrying `common_name` throws `AuthError` on the human path. Without that, a service token would be a valid credential for `/api/people` the moment somebody widened the Access policy by accident — the human path would look it up, find no membership, and 401, which is the right answer *today* but only by luck. Making it an explicit refusal means the human path states its own precondition instead of inheriting it.

**The `common_name` check must come BEFORE the existing `email` check**, and this is the difference between a real control and dead code. A genuine Access service-token JWT carries no `email` claim, so the existing `if (typeof payload.email !== "string") throw` fires first and the `common_name` branch is unreachable — a refusal that can never run, "covered" by a test asserting only `.rejects.toThrow(AuthError)`, which the *email* check satisfies just as well. Order it first, and assert on its specific message so the test can actually fail.

#### One note on `aud`

Cloudflare's documented Access JWT payload types `aud` as an **array** of AUD tags, not a string. No code change is needed — `jose`'s `audience` option accepts a payload whose `aud` is an array and passes if any element matches — but the plan should say so rather than leave a reader to discover it against production. At least one test fixture below therefore signs an array-valued `aud`, so the array shape is exercised rather than assumed.

- [ ] **Step 1: Write the failing test**

Create `tests/server/auth-service-token.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { randomBytes } from "node:crypto";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import type { JSONWebKeySet, KeyLike } from "jose";
import type { DatabaseSync } from "node:sqlite";
import { createTestDatabase } from "../../src/server/db/migrate.js";
import { Keyring } from "../../src/server/crypto/envelope.js";
import { createApp, INBOUND_EMAIL_PATH } from "../../src/server/index.js";
import {
  AuthError,
  createAccessVerifier,
  createServiceTokenVerifier,
} from "../../src/server/auth.js";
import type { Identity } from "../../src/server/auth.js";

const TEAM = "https://badgerops.cloudflareaccess.com";
const AUD = "aud-tag";
const ring = new Keyring("server-v1", { "server-v1": randomBytes(32) });

let db: DatabaseSync;
let privateKey: KeyLike;
let jwks: JSONWebKeySet;

async function token(
  claims: Record<string, unknown>,
  // Cloudflare's documented Access payload types `aud` as an ARRAY of AUD
  // tags. `jose` accepts either, so no production code branches on it — but
  // the array shape is what actually arrives, so it must be exercised rather
  // than assumed. Callers that pass nothing get the array form.
  audience: string | string[] = [AUD],
): Promise<string> {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256" })
    .setIssuer(TEAM)
    .setAudience(audience)
    .setExpirationTime("5m")
    .sign(privateKey);
}

function serviceVerifier(overrides: Record<string, unknown> = {}) {
  return createServiceTokenVerifier({
    teamDomain: TEAM,
    audience: AUD,
    householdId: "hh-a",
    allowedClientIds: ["worker.access"],
    fetchJwks: async () => jwks,
    ...overrides,
  });
}

function request(jwt?: string): Request {
  return new Request("http://localhost/api/inbound-email", {
    method: "POST",
    headers: jwt ? { "Cf-Access-Jwt-Assertion": jwt } : {},
  });
}

beforeEach(async () => {
  db = createTestDatabase();
  const now = new Date().toISOString();
  db.prepare("INSERT INTO household (id, name, created_at) VALUES (?, ?, ?)").run(
    "hh-a", "Badger", now,
  );
  db.prepare("INSERT INTO user (id, email, created_at) VALUES (?, ?, ?)").run(
    "u1", "badger@example.com", now,
  );
  db.prepare(
    "INSERT INTO household_member (household_id, user_id, role) VALUES (?, ?, ?)",
  ).run("hh-a", "u1", "owner");

  const pair = await generateKeyPair("RS256");
  privateKey = pair.privateKey;
  jwks = { keys: [{ ...(await exportJWK(pair.publicKey)), alg: "RS256", use: "sig" }] };
});

describe("createServiceTokenVerifier", () => {
  it("accepts an allowlisted service token whose aud is an array", async () => {
    // Cloudflare sends `aud` as an array. This is the shape production
    // actually produces, so it is the default in the `token` helper.
    const identity = await serviceVerifier()(request(await token({ common_name: "worker.access" })));
    expect(identity.role).toBe("machine");
    expect(identity.householdId).toBe("hh-a");
    expect(identity.userId).toBe("service:worker.access");
  });

  it("accepts a scalar aud too, so nothing depends on the array shape", async () => {
    const identity = await serviceVerifier()(
      request(await token({ common_name: "worker.access" }, AUD)),
    );
    expect(identity.role).toBe("machine");
  });

  it("rejects a token signed by a different key", async () => {
    const other = await generateKeyPair("RS256");
    const forged = await new SignJWT({ common_name: "worker.access" })
      .setProtectedHeader({ alg: "RS256" })
      .setIssuer(TEAM)
      .setAudience(AUD)
      .setExpirationTime("5m")
      .sign(other.privateKey);
    await expect(serviceVerifier()(request(forged))).rejects.toThrow(AuthError);
  });

  it("rejects a token for the wrong audience", async () => {
    const wrong = await new SignJWT({ common_name: "worker.access" })
      .setProtectedHeader({ alg: "RS256" })
      .setIssuer(TEAM)
      .setAudience("some-other-app")
      .setExpirationTime("5m")
      .sign(privateKey);
    await expect(serviceVerifier()(request(wrong))).rejects.toThrow(AuthError);
  });

  it("rejects a valid token whose client id is not allowlisted", async () => {
    // Access having minted it is not enough. Any service token in the account
    // would otherwise be able to post email into this household.
    await expect(
      serviceVerifier()(request(await token({ common_name: "some.other.token" }))),
    ).rejects.toThrow(AuthError);
  });

  it("rejects a HUMAN token on the service path", async () => {
    // Symmetry with the check below. A person's browser must not be able to
    // reach the ingest endpoint just because they are signed in.
    await expect(
      serviceVerifier()(request(await token({ email: "badger@example.com" }))),
    ).rejects.toThrow(AuthError);
  });

  it("rejects a missing token", async () => {
    await expect(serviceVerifier()(request())).rejects.toThrow(AuthError);
  });

  it("never consults household_member", async () => {
    // The machine's household is configuration. If this resolved through a
    // membership lookup, a service token would inherit a human's role.
    const identity = await serviceVerifier({ householdId: "hh-configured" })(
      request(await token({ common_name: "worker.access" })),
    );
    expect(identity.householdId).toBe("hh-configured");
  });
});

describe("the human verifier refuses a machine credential", () => {
  function humanVerifier() {
    return createAccessVerifier({
      teamDomain: TEAM,
      audience: AUD,
      db,
      fetchJwks: async () => jwks,
    });
  }

  it("rejects a service-token JWT on the human path, by the service-token check", async () => {
    // The assertion is on the MESSAGE, not just the class, and that is the
    // whole value of this test. A real service token carries no `email`, so
    // if the common_name check is placed after the email check it can never
    // run -- and a bare `.rejects.toThrow(AuthError)` would still pass,
    // satisfied by the email check, proving nothing. This fails if the
    // refusal is dead code.
    await expect(
      humanVerifier()(new Request("http://localhost/api/people", {
        headers: { "Cf-Access-Jwt-Assertion": await token({ common_name: "worker.access" }) },
      })),
    ).rejects.toThrow(/Service tokens may not use the human API/);
  });

  it("still rejects a token with neither claim, by the email check", async () => {
    // The other branch, so reordering the two checks cannot silently disable
    // the original one.
    await expect(
      humanVerifier()(new Request("http://localhost/api/people", {
        headers: { "Cf-Access-Jwt-Assertion": await token({}) },
      })),
    ).rejects.toThrow(/carries no email claim/);
  });
});

describe("the machine role's blast radius", () => {
  it("cannot reach any human endpoint even though it is mounted on /api", async () => {
    const app = createApp({
      db,
      ring,
      verify: async () => {
        throw new AuthError("human verifier should not run here");
      },
      verifyIngest: async () => ({
        userId: "service:worker.access",
        email: "",
        householdId: "hh-a",
        role: "machine" as const,
      }),
    });
    // The human middleware is what guards /api/people, and it throws.
    expect((await app.request("/api/people")).status).toBe(401);
  });

  it("cannot write a person, a trip, or a booking", async () => {
    const machineApp = createApp({
      db,
      ring,
      verify: async () => ({
        userId: "service:worker.access",
        email: "",
        householdId: "hh-a",
        role: "machine" as const,
      }),
      verifyIngest: async () => {
        throw new AuthError("not used");
      },
    });
    // Even if the machine identity somehow reached the human middleware, every
    // repository's requireWrite() refuses it. 403, not 201.
    for (const [path, body] of [
      ["/api/people", { displayName: "Injected" }],
      ["/api/trips", { title: "Injected" }],
    ] as const) {
      const res = await machineApp.request(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(403);
    }
  });
});

describe("the ingest middleware is scoped to POST", () => {
  /**
   * The ingest credential is described as write-only. That property does NOT
   * come from TenantRepo -- `all()`/`get()`/`unscoped()` carry no role guard
   * at all -- it comes from this routing decision. If the ingest middleware
   * ever matches GET on this path, a stolen service token can read the whole
   * pending queue, `extracted` JSON included, which holds plaintext
   * confirmation numbers.
   *
   * (No route is mounted at INBOUND_EMAIL_PATH until Task 13. That is fine
   * and is the point: these assertions are about which MIDDLEWARE runs, and
   * middleware runs before routing resolves to a handler or a 404.)
   */
  function app(onHuman: () => never, onIngest: () => Identity) {
    return createApp({
      db,
      ring,
      verify: async () => onHuman(),
      verifyIngest: async () => onIngest(),
    });
  }

  const machine = {
    userId: "service:worker.access",
    email: "",
    householdId: "hh-a",
    role: "machine" as const,
  };

  it("routes POST /api/inbound-email to the ingest verifier", async () => {
    const built = app(
      () => {
        throw new AuthError("human verifier must not run on ingest POST");
      },
      () => machine,
    );
    // 404, not 401: the ingest verifier accepted it and no handler is mounted
    // yet. A 401 here would mean the human middleware ran.
    expect((await built.request(INBOUND_EMAIL_PATH, { method: "POST" })).status).toBe(404);
  });

  it("does NOT route GET /api/inbound-email to the ingest verifier", async () => {
    const built = app(
      () => {
        throw new AuthError("no human credential");
      },
      () => machine,
    );
    // The human middleware owns this, and with no human credential it 401s.
    // If this returns 404 the ingest middleware answered a GET, and the
    // service token is no longer write-only.
    expect((await built.request(INBOUND_EMAIL_PATH)).status).toBe(401);
  });

  it("does NOT route the sub-paths to the ingest verifier", async () => {
    const built = app(
      () => {
        throw new AuthError("no human credential");
      },
      () => machine,
    );
    for (const [path, init] of [
      [`${INBOUND_EMAIL_PATH}/ie1/body`, {}],
      [`${INBOUND_EMAIL_PATH}/ie1/approve`, { method: "POST" }],
    ] as const) {
      expect((await built.request(path, init)).status).toBe(401);
    }
  });
});
```

`INBOUND_EMAIL_PATH` and `Identity` come from `../../src/server/index.js` and `../../src/server/auth.js`; add them to this file's imports.

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -- auth-service-token`
Expected: FAIL — `createServiceTokenVerifier` is not exported.

- [ ] **Step 3: Add the machine role and the ingest guard**

In `src/server/repos/base.ts`:

Replace the `Role` type and `ROLES` constant:

```ts
/**
 * `machine` is not a human role and has no `household_member` row — the CHECK
 * constraint on that table still permits only owner/adult/viewer, so this
 * value can only ever originate from `createServiceTokenVerifier`. It exists
 * so a machine caller is a differently-shaped principal rather than a human
 * one with a borrowed name.
 */
export type Role = "owner" | "adult" | "viewer" | "machine";

const ROLES: readonly Role[] = ["owner", "adult", "viewer", "machine"];
```

Replace `requireWrite()` and `requireReveal()`, and add `requireIngestWrite()`:

```ts
  /**
   * The default write guard, used by every repository. Denies `viewer` (who
   * may read but not modify) and `machine` (whose only legitimate write is
   * `InboundEmailRepo.create`, which uses `requireIngestWrite()` instead).
   *
   * The default is DENY and the opt-in is per-method. That inversion is what
   * bounds the ingest credential's blast radius to exactly one method,
   * without needing an edit in PersonRepo, TripRepo, BookingRepo, or
   * ChecklistRepo — and without depending on a route file happening not to
   * construct the wrong repository.
   */
  protected requireWrite(): void {
    if (this.ctx.role === "viewer") {
      throw new ForbiddenError("Viewers may not modify data");
    }
    if (this.ctx.role === "machine") {
      throw new ForbiddenError("Machine callers may not modify domain data");
    }
  }

  /**
   * The single opt-in for the ingest credential. Exactly one method in this
   * codebase calls it. If you find yourself adding a second call site, that
   * is the moment to re-read the reasoning in plan 4 Part B Task 9 rather
   * than to add it.
   */
  protected requireIngestWrite(): void {
    if (this.ctx.role === "viewer") {
      throw new ForbiddenError("Viewers may not modify data");
    }
  }

  /**
   * Guards reads of encrypted/sensitive fields. Denies `viewer` — someone who
   * should not see plaintext secrets — and `machine`, which makes the ingest
   * credential write-only: a stolen service token can queue an email and can
   * never read one, a passport number, or a confirmation number back out.
   */
  protected requireReveal(): void {
    if (this.ctx.role === "viewer") {
      throw new ForbiddenError("Viewers may not reveal encrypted fields");
    }
    if (this.ctx.role === "machine") {
      throw new ForbiddenError("Machine callers may not reveal encrypted fields");
    }
  }
```

Finally — and this one is not optional, it is what stops the machine role from being unable to perform the single write it exists for — give `insert()` its guard as a parameter. Change the signature and the first line only; the body below is untouched:

```ts
  /**
   * Inserts are the one case with no WHERE clause to scope. The household id is
   * supplied by the context rather than the caller, so a caller cannot insert
   * into another tenant even if they try.
   *
   * `guard` defaults to `requireWrite()`, so every existing call site keeps
   * exactly the behaviour it had. It exists for one caller:
   * `InboundEmailRepo.create`, whose whole purpose is the one write the
   * machine role is permitted, and which therefore passes
   * `() => this.requireIngestWrite()`.
   *
   * Without this parameter, `InboundEmailRepo.create()` would call
   * `requireIngestWrite()` (pass), reach `insert()`, hit the hard-coded
   * `requireWrite()`, and throw ForbiddenError -- 403ing on itself. The ingest
   * endpoint would answer 403 instead of 202, no row would ever be stored, and
   * every fail-soft guarantee in this plan would be vacuous.
   *
   * The tempting alternative -- overriding `requireWrite()` inside
   * `InboundEmailRepo` -- is WRONG. `setExtraction()` and `resolve()` reach
   * `run()`, which calls `requireWrite()`, so an override silently re-opens
   * both of them to the machine identity. Approval is a human act; the opt-in
   * has to be per method, which is what this parameter makes it.
   */
  protected insert(
    table: string,
    values: Record<string, unknown>,
    guard: () => void = () => this.requireWrite(),
  ): void {
    guard();
    // ... the rest of the existing body is unchanged.
```

- [ ] **Step 4: Add the service-token verifier**

In `src/server/auth.ts`, add below `createAccessVerifier`:

```ts
export type ServiceTokenConfig = {
  /** Same team domain and AUD as the human path: the same signature check. */
  teamDomain: string;
  audience: string;
  /** Configuration, never a header. See plan 4 Part B Task 9. */
  householdId: string;
  /** The `common_name` values (Access service-token client ids) permitted here. */
  allowedClientIds: string[];
  fetchJwks?: () => Promise<JSONWebKeySet>;
};

/**
 * Verifies a Cloudflare Access **service token** and maps it to a machine
 * `Identity`.
 *
 * The Worker sends CF-Access-Client-Id / CF-Access-Client-Secret; Access
 * validates those at the edge and forwards the same signed
 * Cf-Access-Jwt-Assertion header a human request carries, from the same
 * keys, issuer, and audience. What differs is the claims: a human token has
 * `email`, a service token has `common_name` and no `email`.
 *
 * So the signature path here is IDENTICAL to the human one -- nothing about
 * the human path is loosened to accommodate this -- and only the
 * claim-to-identity mapping differs, after verification.
 */
export function createServiceTokenVerifier(config: ServiceTokenConfig) {
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

  return async function verifyIngest(req: Request): Promise<Identity> {
    const token = req.headers.get(HEADER);
    if (!token) {
      throw new AuthError(
        `Missing ${HEADER}. The ingest endpoint is reached through Cloudflare Access.`,
      );
    }

    let commonName: string;
    try {
      const { payload } = await jwtVerify(token, await keys(), {
        issuer: config.teamDomain,
        audience: config.audience,
      });
      // A human token on this path is a refusal, not a fallback. The ingest
      // endpoint is for one credential; a signed-in person reaching it would
      // mean the Access policy is wrong, and answering 401 says so.
      if (typeof payload.common_name !== "string") {
        throw new AuthError("Ingest requires an Access service token, not a user token");
      }
      commonName = payload.common_name;
    } catch (err) {
      if (err instanceof AuthError) throw err;
      throw new AuthError(`Invalid Access token: ${String(err)}`);
    }

    // Access having minted the token is not sufficient: every service token in
    // the account would otherwise be able to post into this household.
    if (!config.allowedClientIds.includes(commonName)) {
      throw new AuthError("This service token is not permitted to submit inbound email");
    }

    return {
      // A sentinel, deliberately not a `user` row. It names the CREDENTIAL in
      // the audit trail rather than a person who did nothing.
      userId: `service:${commonName}`,
      email: "",
      // Configuration, never a header. A machine that could name its own
      // tenant is a tenancy hole with a static secret in front of it.
      householdId: config.householdId,
      role: "machine",
    };
  };
}
```

And, in `createAccessVerifier`'s `verify`, add the symmetric refusal **immediately BEFORE the existing `payload.email` type check**, so the block reads:

```ts
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
```

Note that `jose` is already doing the right thing with Cloudflare's array-valued `aud` — the `audience` option matches if any element of the array equals the configured AUD — so nothing above changes for it. See the `aud` note earlier in this task.

Also add, beside `resolveDevIdentity`, a bootstrap existence check for the ingest household:

```ts
/**
 * True if `householdId` names a real `household` row.
 *
 * Used at startup to validate `TRAVEL_HQ_INBOUND_HOUSEHOLD_ID`. Nothing else
 * checks it: `createServiceTokenVerifier` takes the id as configuration and
 * hands it straight to `InboundEmailRepo`, so a typo does not surface until a
 * message actually arrives -- as a foreign-key violation, a 500, and a Worker
 * that bounces the mail to the fallback mailbox. Failing loudly at boot turns
 * a silent mail-loss bug into a server that refuses to start.
 *
 * This lives in auth.ts for the same reason `resolveDevIdentity` does: it is
 * the documented bootstrap exception that owns raw SQL before a household is
 * known, and `serve.ts` is NOT on the architecture test's raw-SQL allowlist.
 */
export function householdExists(db: DatabaseSync, householdId: string): boolean {
  return (
    db.prepare("SELECT 1 AS ok FROM household WHERE id = ?").get(householdId) !== undefined
  );
}
```

- [ ] **Step 5: Mount the two paths separately**

In `src/server/index.ts`:

```ts
/**
 * The one path served by the service-token verifier instead of the human one,
 * and only for POST. A named constant rather than a regex so the mount, the
 * skip below, and the tests all refer to the same string.
 */
export const INBOUND_EMAIL_PATH = "/api/inbound-email";

/**
 * The one method on that path the service token owns. Everything else under
 * /api/inbound-email -- the queue GET, the body reveal, approve, escalate,
 * discard -- is a HUMAN endpoint and goes through the human middleware.
 */
export const INBOUND_EMAIL_METHOD = "POST";
```

Extend `AppDeps`:

```ts
  /** The Access service-token verifier. Guards INBOUND_EMAIL_PATH only. */
  verifyIngest: (req: Request) => Promise<Identity>;
```

Replace the existing `/api/*` middleware with the pair:

```ts
  /**
   * True for the one method-and-path pair the service token owns.
   *
   * Both middlewares below key off this SAME predicate, so they cannot
   * disagree about what "the ingest request" is -- which is exactly how the
   * gap opens: `app.use(INBOUND_EMAIL_PATH, …)` matches every method, and a
   * skip written as `c.req.path === INBOUND_EMAIL_PATH` skips every method,
   * so GET /api/inbound-email would be handed to the service-token verifier.
   * That 401s the Import page for every human forever, AND -- because
   * TenantRepo's read methods carry no role guard -- lets a stolen service
   * token read the whole pending queue, plaintext confirmation numbers
   * included.
   */
  const isIngestRequest = (c: Context<AppEnv>): boolean =>
    c.req.method === INBOUND_EMAIL_METHOD && c.req.path === INBOUND_EMAIL_PATH;

  // Ingest first, on its exact path AND its exact method. `app.post`, not
  // `app.use`, is what makes the method scoping structural rather than a
  // comment. Registered before the human middleware so ordering is explicit
  // rather than incidental.
  app.post(INBOUND_EMAIL_PATH, async (c, next) => {
    c.set("identity", await deps.verifyIngest(c.req.raw));
    c.set("db", deps.db);
    c.set("ring", deps.ring);
    await next();
  });

  app.use("/api/*", async (c, next) => {
    // The ingest request has its own credential shape and its own verifier.
    // This skip is explicit, greppable, and METHOD-AWARE; a request that
    // reaches it here has already been authenticated by the middleware above.
    // Every other method on that path -- and every sub-path -- is a human
    // endpoint and must fall through to the human verifier.
    if (isIngestRequest(c)) return next();
    c.set("identity", await deps.verify(c.req.raw));
    c.set("db", deps.db);
    c.set("ring", deps.ring);
    await next();
  });
```

`Context` is a type-only import from `hono`; add `import type { Context } from "hono";` beside the existing `Hono` import.

(`app.post(path, handler)` registered before any route at that path runs as middleware when the handler calls `next()` — this is the same mechanism `app.use` uses, narrowed to one method. If you prefer to keep `app.use`, the equivalent is an early `if (!isIngestRequest(c)) return next();` as the middleware's first line. Either is fine. A method-blind ingest middleware is not.)

- [ ] **Step 6: Wire it in serve.ts**

In `src/server/serve.ts`, add to `resolveVerifier`'s neighbourhood:

```ts
/**
 * The ingest verifier. Unlike the human one there is no development bypass:
 * the inbound path is only ever exercised by a Worker, and a laptop that
 * wants to test it posts a fixture through `app.request()` in a test rather
 * than through a loosened credential check. A dev bypass here would be a
 * permanently unauthenticated write endpoint on the deployed host if the
 * environment variable were ever set by mistake.
 */
export function resolveIngestVerifier(
  env: NodeJS.ProcessEnv,
): (req: Request) => Promise<Identity> {
  const allowed = (env.TRAVEL_HQ_INBOUND_CLIENT_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  if (allowed.length === 0) {
    // Fail closed and loudly. An empty allowlist that accepted everything
    // would be a static-secret-free write endpoint.
    return async () => {
      throw new AuthError(
        "Inbound email is not configured: set TRAVEL_HQ_INBOUND_CLIENT_IDS",
      );
    };
  }

  return createServiceTokenVerifier({
    teamDomain: required(env, "CF_ACCESS_TEAM_DOMAIN"),
    // A SEPARATE Access application, with its own AUD, scoped to
    // /api/inbound-email. Reusing the human app's AUD would mean one policy
    // change could grant the Worker the whole API.
    audience: required(env, "CF_ACCESS_INBOUND_AUD"),
    householdId: required(env, "TRAVEL_HQ_INBOUND_HOUSEHOLD_ID"),
    allowedClientIds: allowed,
  });
}
```

Add the imports of `createServiceTokenVerifier` and `householdExists` to the existing `auth.js` import, and in the `isMain` block validate the configured household **before** constructing the app:

```ts
  // TRAVEL_HQ_INBOUND_HOUSEHOLD_ID is configuration that nothing else checks:
  // createServiceTokenVerifier takes it on trust and hands it to
  // InboundEmailRepo, so a typo surfaces only when a real message arrives --
  // as a foreign-key violation on inbound_email.household_id, a 500, and a
  // Worker that bounces the mail to the fallback mailbox. By then the failure
  // looks like "email ingestion is broken", not "one env var has a typo".
  // Fail at boot instead.
  const inboundHousehold = process.env.TRAVEL_HQ_INBOUND_HOUSEHOLD_ID;
  if (inboundHousehold && !householdExists(db, inboundHousehold)) {
    throw new Error(
      `TRAVEL_HQ_INBOUND_HOUSEHOLD_ID=${inboundHousehold} does not name a household ` +
        `in this database. Inbound email would fail with a foreign-key error on every ` +
        `message. Check the id from \`npm run seed\`.`,
    );
  }

  const app = createApp({ db, ring, verify, verifyIngest: resolveIngestVerifier(process.env) });
```

The guard is conditional on the variable being *set*, not on it being valid: an instance with inbound email switched off entirely must still start, and `resolveIngestVerifier` already fails closed for that case.

- [ ] **Step 7: Test that the ingest verifier fails closed**

`tests/server/serve.test.ts` already exists and already fences `resolveVerifier`'s dev bypass, for exactly this reason: a credential check whose fencing is never exercised is one careless refactor from being unfenced with nothing failing to say so. `resolveIngestVerifier`'s empty-allowlist branch is the same shape and is currently untested — and it is the *only* control standing between an unconfigured deploy and an open write endpoint.

Add the mirror:

```ts
import { resolveIngestVerifier } from "../../src/server/serve.js";
import { AuthError } from "../../src/server/auth.js";

describe("resolveIngestVerifier", () => {
  const configured = {
    CF_ACCESS_TEAM_DOMAIN: "https://badgerops.cloudflareaccess.com",
    CF_ACCESS_INBOUND_AUD: "ingest-aud",
    TRAVEL_HQ_INBOUND_HOUSEHOLD_ID: "hh-a",
  };

  it("rejects everything when the allowlist is unset", async () => {
    // An unconfigured deploy must be CLOSED, not open. This is the single
    // control between "nobody set the env var" and "anyone who can reach the
    // origin can post email into the household".
    const verify = resolveIngestVerifier({ ...configured } as NodeJS.ProcessEnv);
    await expect(
      verify(new Request("http://localhost/api/inbound-email", { method: "POST" })),
    ).rejects.toThrow(AuthError);
  });

  it("rejects everything when the allowlist is empty or only separators", async () => {
    for (const value of ["", "   ", ",", " , ,"]) {
      const verify = resolveIngestVerifier({
        ...configured,
        TRAVEL_HQ_INBOUND_CLIENT_IDS: value,
      } as NodeJS.ProcessEnv);
      await expect(
        verify(new Request("http://localhost/api/inbound-email", { method: "POST" })),
      ).rejects.toThrow(AuthError);
    }
  });

  it("names the variable an operator has to set", async () => {
    const verify = resolveIngestVerifier({ ...configured } as NodeJS.ProcessEnv);
    await expect(
      verify(new Request("http://localhost/api/inbound-email", { method: "POST" })),
    ).rejects.toThrow(/TRAVEL_HQ_INBOUND_CLIENT_IDS/);
  });

  it("builds a real verifier once the allowlist is configured", async () => {
    // Not a stub that rejects: a configured deploy must reach the JWKS path.
    // With no token on the request that still rejects, but with the
    // verifier's own message rather than the not-configured one.
    const verify = resolveIngestVerifier({
      ...configured,
      TRAVEL_HQ_INBOUND_CLIENT_IDS: "worker.access",
    } as NodeJS.ProcessEnv);
    await expect(
      verify(new Request("http://localhost/api/inbound-email", { method: "POST" })),
    ).rejects.toThrow(/Missing Cf-Access-Jwt-Assertion/);
  });
});
```

- [ ] **Step 8: Run the tests**

Run: `npm test -- auth-service-token`
Expected: PASS, 15 tests — 8 for the verifier, 2 for the human path's refusal, 2 for the blast radius, 3 for the method scoping.

Run: `npm test -- serve`
Expected: PASS — plan 2's existing `resolveVerifier` cases plus the 4 new `resolveIngestVerifier` ones.

- [ ] **Step 9: Fix the now-broken createApp callers**

`AppDeps` gained one required field, `verifyIngest`, so every existing `createApp` construction fails to typecheck. Add `verifyIngest: async () => { throw new AuthError("not used"); }` to each. This is mechanical and expected — a required field is the right shape, because a `createApp` that silently defaulted the ingest verifier to something permissive is precisely the accident this task exists to prevent.

**Count them before you start, so you do not stop at the first failure.** As of Part A being complete there are **10 constructions across 3 files**:

| File | Constructions |
| --- | --- |
| `tests/server/routes/api.test.ts` | 5 |
| `tests/server/routes/people-update.test.ts` (Part A Task 1) | 2 — `app` in `beforeEach`, `viewerApp` |
| `tests/server/routes/booking-status.test.ts` (Part A Task 2) | 3 — `app` in `beforeEach`, `otherApp`, `viewerApp` |

`tsc` reports one error per site, so `npm run typecheck` lists all ten at once; work the list, do not iterate. Task 13 adds a second required field (`ingest`) and touches **the same ten sites** plus `src/server/serve.ts`.

Run: `npm test && npm run typecheck`
Expected: all PASS, typecheck exits 0. **This commit is green** — nothing here depends on the `inbound_email` table or on `InboundEmailRepo`, which Task 10 adds next.

- [ ] **Step 10: Commit**

```bash
git add src/server/repos/base.ts src/server/auth.ts src/server/index.ts src/server/serve.ts tests/server
git commit -m "feat: add an Access service-token identity that cannot touch domain data"
```

---

### Task 10: The inbound_email table and its repository

**Files:**
- Create: `src/server/db/migrations/002_inbound_email.sql`
- Create: `src/server/repos/inbound-email.ts`
- Test: `tests/server/repos/inbound-email.test.ts`

**Interfaces:**
- Consumes: `TenantRepo`, `Keyring`, `newId`, and from Task 9: the `machine` role, `requireIngestWrite()`, and `insert()`'s `guard` parameter
- Produces:
  - `type InboundEmail`, `type InboundStatus = "pending" | "approved" | "discarded"`
  - `class InboundEmailRepo` with `create(input)`, `list()`, `findById(id)`, `revealBody(id)`, `setExtraction(id, patch)`, `resolve(id, status)`

**Why parsed results are parked here rather than written straight to `booking` rows at `status='draft'`.** The spec says "everything lands as `status='draft'` and requires approval". Holding them *out* of `booking` entirely is a strictly stronger reading of the same intent — "a flaky parser must never write directly into the trip record" — and it is the only reading that works: `booking.trip_id` is `NOT NULL`, and a forwarded email frequently matches no existing trip. There would be nowhere to put it.

So: the parser writes `inbound_email`, a human reviews it and picks a trip, and **approval creates the `booking` rows at `status='draft'`** — where the Overview tab already renders them with a `Draft` tag (plan 3 tests that) and Part A's `Book →` promotes them. `draft` keeps its meaning and there is exactly one path.

**Task 9 landed first, so everything this task needs already exists and this commit is green.** The `machine` role, `requireIngestWrite()`, and `insert()`'s `guard` parameter are all in `base.ts` before a line of this task is written. Write the tests, watch them fail on the missing module, implement, watch them pass — the ordinary loop, with no red commit.

**Schema notes:**
- `household_id` is present, per the tenancy rule.
- `body_text` is an **encrypted envelope**, not plaintext. It is returned only by `revealBody`, which is role-guarded and logged like every other reveal.
- `extracted` is a JSON array of `ExtractedBooking` (Task 11's schema), or `NULL` when nothing was extracted.
- `source` records which extractor produced the result, so the review UI can say "parsed from a calendar attachment" versus "read by the local model" versus "escalated to Claude" — the operator's trust in the values should differ.

- [ ] **Step 1: Write the migration**

Create `src/server/db/migrations/002_inbound_email.sql`:

```sql
CREATE TABLE inbound_email (
  id            TEXT PRIMARY KEY,
  household_id  TEXT NOT NULL REFERENCES household(id) ON DELETE CASCADE,
  received_at   TEXT NOT NULL,
  from_address  TEXT,
  subject       TEXT,
  body_text     TEXT,           -- encrypted envelope; NULL when the message had no text part
  source        TEXT NOT NULL
                  CHECK (source IN ('ics','local','claude','none')),
  extracted     TEXT,           -- JSON array of ExtractedBooking, or NULL
  confidence    TEXT NOT NULL
                  CHECK (confidence IN ('high','low')),
  error         TEXT,           -- why extraction produced nothing, shown to the reviewer
  status        TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','approved','discarded')),
  resolved_at   TEXT,
  created_at    TEXT NOT NULL
);
CREATE INDEX idx_inbound_household_status ON inbound_email(household_id, status);
```

- [ ] **Step 2: Write the failing repository test**

Create `tests/server/repos/inbound-email.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { createTestDatabase } from "../../../src/server/db/migrate.js";
import { Keyring } from "../../../src/server/crypto/envelope.js";
import { InboundEmailRepo } from "../../../src/server/repos/inbound-email.js";
import { ForbiddenError, NotFoundError } from "../../../src/server/repos/base.js";
import type { HouseholdContext } from "../../../src/server/repos/base.js";

const ring = new Keyring("server-v1", { "server-v1": randomBytes(32) });
const owner: HouseholdContext = { householdId: "hh-a", userId: "u1", role: "owner" };
const machine: HouseholdContext = {
  householdId: "hh-a",
  userId: "service:inbound",
  role: "machine",
};

let db: DatabaseSync;
let repo: InboundEmailRepo;

function sample() {
  return {
    receivedAt: "2026-07-21T10:00:00.000Z",
    fromAddress: "reservations@dawnranch.com",
    subject: "Reservation Confirmed",
    bodyText: "Confirmation number: D7WN88",
    source: "ics" as const,
    confidence: "high" as const,
    extracted: [{ kind: "lodging", title: "Dawn Ranch Lodge" }],
  };
}

beforeEach(() => {
  db = createTestDatabase();
  const now = new Date().toISOString();
  for (const id of ["hh-a", "hh-b"]) {
    db.prepare("INSERT INTO household (id, name, created_at) VALUES (?, ?, ?)").run(id, id, now);
  }
  repo = new InboundEmailRepo(db, owner, ring);
});

describe("InboundEmailRepo", () => {
  it("stores a parsed email and lists it as pending", () => {
    repo.create(sample());
    const rows = repo.list();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("pending");
    expect(rows[0]?.subject).toBe("Reservation Confirmed");
  });

  it("never returns the body in the list output", () => {
    // The body is the PII-dense part. It is encrypted at rest and read only
    // through revealBody(), one record at a time.
    repo.create(sample());
    expect(JSON.stringify(repo.list())).not.toContain("D7WN88");
  });

  it("returns the body through the explicit reveal", () => {
    const row = repo.create(sample());
    expect(repo.revealBody(row.id)).toBe("Confirmation number: D7WN88");
  });

  it("refuses a body reveal to a viewer", () => {
    const row = repo.create(sample());
    const viewer = new InboundEmailRepo(db, { ...owner, role: "viewer" }, ring);
    expect(() => viewer.revealBody(row.id)).toThrow(ForbiddenError);
  });

  it("refuses a body reveal to the machine identity", () => {
    // The ingest credential writes emails; it must never be able to read one
    // back out. A stolen service token is then write-only.
    const row = repo.create(sample());
    const asMachine = new InboundEmailRepo(db, machine, ring);
    expect(() => asMachine.revealBody(row.id)).toThrow(ForbiddenError);
  });

  it("lets the machine identity CREATE — the one write it exists for", () => {
    // This is the assertion that catches the whole-feature failure. `create()`
    // calls requireIngestWrite() (which permits machine) and then insert().
    // If insert() still hard-codes requireWrite(), this throws ForbiddenError
    // and the machine role 403s on itself: the ingest route answers 403
    // instead of 202, no row is ever stored, and every fail-soft guarantee in
    // this plan is vacuous. See Task 9's `insert()` guard parameter.
    const asMachine = new InboundEmailRepo(db, machine, ring);
    const row = asMachine.create(sample());
    expect(row.status).toBe("pending");
    expect(asMachine.findById(row.id)?.subject).toBe("Reservation Confirmed");
  });

  it("refuses to let the machine identity resolve", () => {
    // Approval and discard are human acts by definition.
    const asMachine = new InboundEmailRepo(db, machine, ring);
    const row = asMachine.create(sample());
    expect(() => asMachine.resolve(row.id, "approved")).toThrow(ForbiddenError);
    expect(() => asMachine.resolve(row.id, "discarded")).toThrow(ForbiddenError);
  });

  it("refuses to let the machine identity replace an extraction", () => {
    // The other half of the pair, and the reason the opt-in is per METHOD.
    // Overriding requireWrite() inside this class instead of passing insert()
    // a guard would make BOTH this and resolve() succeed for the machine —
    // which is precisely what the design closes.
    const asMachine = new InboundEmailRepo(db, machine, ring);
    const row = asMachine.create(sample());
    expect(() =>
      asMachine.setExtraction(row.id, {
        source: "claude",
        confidence: "high",
        extracted: [{ kind: "flight", title: "Injected" }],
        error: null,
      }),
    ).toThrow(ForbiddenError);
    // And the stored extraction is untouched.
    expect(repo.findById(row.id)?.source).toBe("ics");
  });

  it("refuses writes from a viewer", () => {
    const viewer = new InboundEmailRepo(db, { ...owner, role: "viewer" }, ring);
    expect(() => viewer.create(sample())).toThrow(ForbiddenError);
  });

  it("round-trips the extracted array", () => {
    const row = repo.create(sample());
    expect(repo.findById(row.id)?.extracted).toEqual([
      { kind: "lodging", title: "Dawn Ranch Lodge" },
    ]);
  });

  it("stores an email that produced no extraction at all", () => {
    // The fail-soft path. An email nobody could parse must still be here.
    const row = repo.create({
      ...sample(),
      source: "none",
      confidence: "low",
      extracted: null,
      error: "The local extraction service did not respond.",
    });
    expect(repo.findById(row.id)?.extracted).toBe(null);
    expect(repo.findById(row.id)?.error).toMatch(/did not respond/);
  });

  it("replaces the extraction on escalation", () => {
    const row = repo.create({ ...sample(), source: "none", confidence: "low", extracted: null });
    repo.setExtraction(row.id, {
      source: "claude",
      confidence: "high",
      extracted: [{ kind: "flight", title: "DL2214" }],
      error: null,
    });
    const after = repo.findById(row.id);
    expect(after?.source).toBe("claude");
    expect(after?.extracted).toEqual([{ kind: "flight", title: "DL2214" }]);
    expect(after?.error).toBe(null);
  });

  it("marks a row approved and drops it from the pending list", () => {
    const row = repo.create(sample());
    repo.resolve(row.id, "approved");
    expect(repo.list()).toEqual([]);
    expect(repo.findById(row.id)?.status).toBe("approved");
  });

  it("refuses to resolve an unknown row", () => {
    expect(() => repo.resolve("ie-nope", "approved")).toThrow(NotFoundError);
  });

  it("does not leak another household's inbox", () => {
    repo.create(sample());
    const other = new InboundEmailRepo(
      db,
      { householdId: "hh-b", userId: "u2", role: "owner" },
      ring,
    );
    expect(other.list()).toEqual([]);
    expect(other.findById(repo.list()[0]!.id)).toBeUndefined();
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npm test -- repos/inbound-email`
Expected: FAIL — cannot resolve `src/server/repos/inbound-email.js`, and nothing else. The `"machine"` role, `requireIngestWrite()`, and `insert()`'s guard parameter all landed in Task 9, so this is an ordinary missing-module RED.

- [ ] **Step 4: Write the repository**

Create `src/server/repos/inbound-email.ts`:

```ts
import type { DatabaseSync } from "node:sqlite";
import { TenantRepo, NotFoundError } from "./base.js";
import type { HouseholdContext } from "./base.js";
import { Keyring } from "../crypto/envelope.js";
import { newId } from "../ids.js";

export type InboundSource = "ics" | "local" | "claude" | "none";
export type InboundConfidence = "high" | "low";
export type InboundStatus = "pending" | "approved" | "discarded";

/** The list/detail shape. Deliberately carries no body text. */
export type InboundEmail = {
  id: string;
  receivedAt: string;
  fromAddress: string | null;
  subject: string | null;
  source: InboundSource;
  confidence: InboundConfidence;
  extracted: unknown[] | null;
  error: string | null;
  status: InboundStatus;
  resolvedAt: string | null;
};

export type CreateInboundEmailInput = {
  receivedAt: string;
  fromAddress?: string | null;
  subject?: string | null;
  bodyText?: string | null;
  source: InboundSource;
  confidence: InboundConfidence;
  extracted?: unknown[] | null;
  error?: string | null;
};

export type SetExtractionInput = {
  source: InboundSource;
  confidence: InboundConfidence;
  extracted: unknown[] | null;
  error: string | null;
};

type Row = {
  id: string;
  received_at: string;
  from_address: string | null;
  subject: string | null;
  source: InboundSource;
  confidence: InboundConfidence;
  extracted: string | null;
  error: string | null;
  status: InboundStatus;
  resolved_at: string | null;
};

export class InboundEmailRepo extends TenantRepo {
  constructor(
    db: DatabaseSync,
    ctx: HouseholdContext,
    private readonly ring: Keyring,
  ) {
    super(db, ctx);
  }

  /**
   * The one write the machine identity is allowed to make anywhere in this
   * codebase. `requireIngestWrite()` (base.ts, Task 9) permits `machine` and
   * still refuses `viewer`; every other repository uses `requireWrite()`,
   * which refuses both. That inversion is what keeps the ingest credential
   * from being able to touch a person, a trip, or a booking.
   *
   * The third argument to `insert()` is not optional decoration. `insert()`
   * defaults its guard to `requireWrite()`, which denies `machine` — so
   * without this override the call below would throw ForbiddenError and this
   * method would 403 on itself, making the single permitted write impossible.
   *
   * Do NOT "simplify" this by overriding `requireWrite()` on this class
   * instead. `setExtraction()` and `resolve()` reach `run()`, which calls
   * `requireWrite()`, so an override silently re-opens both of them to the
   * ingest credential. The opt-in is per method precisely so that cannot
   * happen; there are tests for all three.
   */
  create(input: CreateInboundEmailInput): InboundEmail {
    this.requireIngestWrite();
    const id = newId();
    this.insert(
      "inbound_email",
      {
        id,
        received_at: input.receivedAt,
        from_address: input.fromAddress ?? null,
        subject: input.subject ?? null,
        // Encrypted at rest: a confirmation email carries legal names,
        // confirmation numbers, frequent-flyer numbers, and card last-4.
        body_text: input.bodyText ? this.ring.encrypt(input.bodyText) : null,
        source: input.source,
        confidence: input.confidence,
        extracted: input.extracted ? JSON.stringify(input.extracted) : null,
        error: input.error ?? null,
        status: "pending",
        resolved_at: null,
        created_at: new Date().toISOString(),
      },
      // The guard override. Without it `insert()` applies requireWrite(),
      // which denies `machine`, and the ingest path 403s on its own write.
      () => this.requireIngestWrite(),
    );
    const created = this.findById(id);
    if (!created) throw new Error("Inbound email disappeared immediately after creation");
    return created;
  }

  /** The review queue: pending rows only, oldest first. */
  list(): InboundEmail[] {
    return this.all<Row>(
      `SELECT * FROM inbound_email
        WHERE {scope} AND status = 'pending'
        ORDER BY received_at`,
    ).map(toInbound);
  }

  findById(id: string): InboundEmail | undefined {
    const row = this.get<Row>("SELECT * FROM inbound_email WHERE {scope} AND id = ?", id);
    return row ? toInbound(row) : undefined;
  }

  /**
   * The original text, for a reviewer completing a draft by hand. Guarded and
   * logged like every other reveal — and denied to `machine`, so the ingest
   * credential is write-only: a stolen service token can post email in, never
   * read email back out.
   */
  revealBody(id: string): string | null {
    this.requireReveal();
    const row = this.get<{ value: string | null }>(
      "SELECT body_text AS value FROM inbound_email WHERE {scope} AND id = ?",
      id,
    );
    if (!row) throw new NotFoundError("Inbound email not found in this household");
    return row.value === null ? null : this.ring.decrypt(row.value);
  }

  /** Replaces the extraction result. Used by the manual Claude escalation. */
  setExtraction(id: string, patch: SetExtractionInput): InboundEmail {
    this.requireWrite();
    const existing = this.get<{ id: string }>(
      "SELECT id FROM inbound_email WHERE {scope} AND id = ?",
      id,
    );
    if (!existing) throw new NotFoundError("Inbound email not found in this household");

    this.run(
      `UPDATE inbound_email
          SET source = ?, confidence = ?, extracted = ?, error = ?
        WHERE {scope} AND id = ?`,
      patch.source,
      patch.confidence,
      patch.extracted ? JSON.stringify(patch.extracted) : null,
      patch.error,
      id,
    );

    const updated = this.findById(id);
    if (!updated) throw new Error("Inbound email disappeared immediately after update");
    return updated;
  }

  /**
   * Approval and discard are human acts. `requireWrite()` (not
   * `requireIngestWrite()`) is what makes that true in code: the machine
   * identity can queue an email and can never clear it.
   */
  resolve(id: string, status: Exclude<InboundStatus, "pending">): void {
    this.requireWrite();
    const existing = this.get<{ id: string }>(
      "SELECT id FROM inbound_email WHERE {scope} AND id = ?",
      id,
    );
    if (!existing) throw new NotFoundError("Inbound email not found in this household");

    this.run(
      "UPDATE inbound_email SET status = ?, resolved_at = ? WHERE {scope} AND id = ?",
      status,
      new Date().toISOString(),
      id,
    );
  }
}

function toInbound(r: Row): InboundEmail {
  return {
    id: r.id,
    receivedAt: r.received_at,
    fromAddress: r.from_address,
    subject: r.subject,
    source: r.source,
    confidence: r.confidence,
    extracted: r.extracted === null ? null : (JSON.parse(r.extracted) as unknown[]),
    error: r.error,
    status: r.status,
    resolvedAt: r.resolved_at,
  };
}
```

- [ ] **Step 5: Run the test**

Run: `npm test -- repos/inbound-email`
Expected: PASS, 15 tests. The three role cases — machine can `create`, machine cannot `resolve`, machine cannot `setExtraction` — are the ones worth watching; if the first fails with `ForbiddenError`, `insert()` did not get its `guard` parameter in Task 9.

Run: `npm test && npm run typecheck`
Expected: all PASS, typecheck exits 0.

- [ ] **Step 6: Commit**

```bash
git add src/server/db/migrations/002_inbound_email.sql src/server/repos/inbound-email.ts tests/server/repos/inbound-email.test.ts
git commit -m "feat: add the inbound_email table and repository"
```

**This commit is green, and so is Task 9's.** An earlier draft of this plan ran the two in the opposite order and accepted one deliberately-red commit, on the reasoning that the repository and the role change are one design that should not be squashed into a single reviewable unit. That reasoning is sound and is preserved — they are still two commits with two messages, and the security decision still gets its own. Reordering, rather than merging, was all that was needed: Task 9 depends on nothing here, so putting it first keeps both commits separate *and* both green, which keeps `git bisect` usable across the whole of Part B.

---

### Task 11: MIME, iCalendar, and the extractor interface

**Files:**
- Create: `src/server/ingest/mime.ts`, `src/server/ingest/ics.ts`, `src/server/ingest/extracted.ts`, `src/server/ingest/extractor.ts`, `src/server/ingest/ics-extractor.ts`
- Modify: `src/server/schemas/booking-kinds.ts` — `BOOKING_KINDS` as a literal tuple (Step 8)
- Test: `tests/server/ingest/mime.test.ts`, `tests/server/ingest/ics.test.ts`, `tests/server/ingest/extractor.test.ts`

**Interfaces:**
- Consumes: `parseDetails` and `BOOKING_KINDS` from `src/server/schemas/booking-kinds.js`
- Produces:
  - `parseMime(raw: string): ParsedEmail`
  - `parseIcs(text: string): IcsEvent[]`
  - `type ExtractedBooking`, `validateExtracted(raw: unknown): ExtractedBooking[]`, `EXTRACTED_JSON_SCHEMA`
  - `interface Extractor`, `type ExtractionResult`, `runExtractionChain(extractors, email)`
  - `class IcsExtractor implements Extractor`

**Nothing in `src/server/ingest/` may spell `.exec(` — not even `RegExp.prototype.exec`.** `tests/server/architecture.test.ts` bans two substrings, `.prepare(` and `.exec(`, anywhere under `src/server/` outside `repos/`, `db/`, and `auth.ts`. It matches on *text*, after stripping comments and string literals — it is not a type-aware check and cannot tell a database call from a regex one. `src/server/ingest/` is not on the allowlist, so the natural spelling of every regex in this task (`/\r?\n\r?\n/.exec(raw)`, `/boundary="?([^";]+)"?/i.exec(contentType)`, `/^(\d{4})…/.exec(value)`) fails the build. This was verified by replicating that test's own comment-stripping logic against the proposed sources: `banned hits: [ '.exec(' ]`.

**Use `str.match(re)`, `str.matchAll(re)`, or `re.test(str)` instead.** `String.prototype.match` with a non-global regex returns the identical `RegExpMatchArray` — capture groups, `.index`, and all — so this is a spelling change, not a behaviour change, and every parser below is already written that way. Keep it that way; the shorter form is not an improvement.

**Do not narrow the architecture test to a receiver-qualified form to make this go away.** Its bluntness is the feature: matching only `db.` + the banned method name is defeated the moment somebody names a variable `sqlite`, `conn`, or `handle`, and the entire value of that test is that it cannot be talked out of a violation by renaming. A parser spelling its regexes differently is a far smaller cost than a raw-SQL guard that catches one identifier.

**No dependency is added for MIME or iCalendar.** Both parsers here are deliberately narrow: this needs the `text/plain` part and any `text/calendar` attachment, and from an ICS it needs `DTSTART`/`DTEND` with their `TZID`, `SUMMARY`, and `LOCATION`. That is a bounded, directly testable problem. A general-purpose MIME library would be a large dependency whose failure modes we would not understand, for a surface we use ten percent of.

**`.ics` is preferred because it is the only source that carries real timezone data.** An airline's calendar attachment states `DTSTART;TZID=America/Boise:20261009T094000` — a wall clock and a named zone, exactly the pair `booking` stores and `assertTimezonePaired` demands. Prose in an email body says "9:40 AM" and leaves the zone to inference. This is not a mild preference; it is the difference between a correct itinerary and a plausible one.

- [ ] **Step 1: Write the failing MIME test**

Create `tests/server/ingest/mime.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { parseMime } from "../../../src/server/ingest/mime.js";

const MULTIPART = [
  "From: reservations@dawnranch.com",
  "Subject: Reservation Confirmed",
  'Content-Type: multipart/mixed; boundary="BOUND1"',
  "",
  "--BOUND1",
  "Content-Type: text/plain; charset=utf-8",
  "",
  "Confirmation number: D7WN88",
  "",
  "--BOUND1",
  'Content-Type: text/calendar; name="invite.ics"',
  "Content-Transfer-Encoding: base64",
  "",
  Buffer.from("BEGIN:VCALENDAR\r\nEND:VCALENDAR").toString("base64"),
  "",
  "--BOUND1--",
].join("\r\n");

describe("parseMime", () => {
  it("reads the headers it needs", () => {
    const mail = parseMime(MULTIPART);
    expect(mail.from).toBe("reservations@dawnranch.com");
    expect(mail.subject).toBe("Reservation Confirmed");
  });

  it("reads the plain-text part", () => {
    expect(parseMime(MULTIPART).textBody).toContain("D7WN88");
  });

  it("decodes a base64 calendar attachment", () => {
    const [ics] = parseMime(MULTIPART).calendars;
    expect(ics).toContain("BEGIN:VCALENDAR");
  });

  it("handles a message with no multipart wrapper at all", () => {
    const plain = ["Subject: Hi", "Content-Type: text/plain", "", "Just text."].join("\r\n");
    const mail = parseMime(plain);
    expect(mail.textBody).toBe("Just text.");
    expect(mail.calendars).toEqual([]);
  });

  it("unfolds a header split across lines", () => {
    const folded = ["Subject: Reservation", "  Confirmed", "", "body"].join("\r\n");
    expect(parseMime(folded).subject).toBe("Reservation Confirmed");
  });

  it("strips display-name syntax from From", () => {
    const withName = ['From: "Dawn Ranch" <res@dawnranch.com>', "", "body"].join("\r\n");
    expect(parseMime(withName).from).toBe("res@dawnranch.com");
  });

  it("survives a truncated message rather than throwing", () => {
    // The Worker posts whatever Email Routing hands it. A parser that throws
    // here 500s the ingest route and loses the email.
    expect(() => parseMime("")).not.toThrow();
    expect(parseMime("").textBody).toBe(null);
  });

  it("prefers text/plain over text/html when both are present", () => {
    const both = [
      'Content-Type: multipart/alternative; boundary="B"',
      "",
      "--B",
      "Content-Type: text/html",
      "",
      "<p>markup</p>",
      "",
      "--B",
      "Content-Type: text/plain",
      "",
      "the words",
      "",
      "--B--",
    ].join("\r\n");
    expect(parseMime(both).textBody).toBe("the words");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -- ingest/mime`
Expected: FAIL — cannot resolve `src/server/ingest/mime.js`.

- [ ] **Step 3: Write the MIME splitter**

Create `src/server/ingest/mime.ts`:

```ts
export type ParsedEmail = {
  from: string | null;
  subject: string | null;
  /** The text/plain body, or null when the message carried none. */
  textBody: string | null;
  /** Decoded text/calendar parts, in the order they appeared. */
  calendars: string[];
};

/**
 * Splits a raw part into its header block and its body.
 *
 * `.match(re)` rather than the shorter regex-side spelling: everything under
 * src/server/ outside repos/, db/, and auth.ts is banned from that method
 * name by tests/server/architecture.test.ts, which matches on text and cannot
 * distinguish a regex call from a database one. A non-global `.match` returns
 * the identical object, `.index` included, so nothing else changes.
 */
function splitPart(raw: string): { headers: string; body: string } {
  const match = raw.match(/\r?\n\r?\n/);
  if (match?.index === undefined) return { headers: raw, body: "" };
  return {
    headers: raw.slice(0, match.index),
    body: raw.slice(match.index + match[0].length),
  };
}

/** Unfolds continuation lines (a leading space or tab) into their header. */
function unfold(headers: string): string[] {
  return headers.replace(/\r?\n[ \t]+/g, " ").split(/\r?\n/);
}

function headerValue(headers: string, name: string): string | null {
  const lower = name.toLowerCase();
  for (const line of unfold(headers)) {
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    if (line.slice(0, colon).trim().toLowerCase() === lower) {
      return line.slice(colon + 1).trim();
    }
  }
  return null;
}

function decode(body: string, encoding: string | null): string {
  const how = (encoding ?? "").toLowerCase();
  if (how === "base64") {
    return Buffer.from(body.replace(/\s+/g, ""), "base64").toString("utf8");
  }
  if (how === "quoted-printable") {
    return body
      // A trailing `=` is a soft line break, not data.
      .replace(/=\r?\n/g, "")
      .replace(/=([0-9A-Fa-f]{2})/g, (_, hex: string) =>
        String.fromCharCode(Number.parseInt(hex, 16)),
      );
  }
  return body;
}

/**
 * A deliberately narrow MIME reader: the text/plain body, any text/calendar
 * part, and three headers. Recurses into nested multiparts, ignores
 * everything else, and never throws — the Worker posts whatever Email
 * Routing handed it, and a parser that throws loses the email.
 */
export function parseMime(raw: string): ParsedEmail {
  const { headers, body } = splitPart(raw);
  const fromRaw = headerValue(headers, "from");
  const result: ParsedEmail = {
    // `"Dawn Ranch" <res@dawnranch.com>` -> `res@dawnranch.com`
    from: fromRaw === null ? null : (fromRaw.match(/<([^>]+)>/)?.[1] ?? fromRaw),
    subject: headerValue(headers, "subject"),
    textBody: null,
    calendars: [],
  };

  walk(headers, body, result);
  return result;
}

function walk(headers: string, body: string, out: ParsedEmail): void {
  const contentType = (headerValue(headers, "content-type") ?? "text/plain").toLowerCase();
  const encoding = headerValue(headers, "content-transfer-encoding");

  if (contentType.startsWith("multipart/")) {
    const boundary = contentType.match(/boundary="?([^";]+)"?/i)?.[1];
    if (boundary === undefined) return;
    // Split on the delimiter lines rather than on the bare boundary string,
    // so a boundary value appearing inside a body cannot split the message.
    const parts = body.split(new RegExp(`\r?\n?--${escapeRe(boundary)}(?:--)?\r?\n?`));
    for (const part of parts) {
      if (part.trim() === "") continue;
      const inner = splitPart(part);
      walk(inner.headers, inner.body, out);
    }
    return;
  }

  if (contentType.startsWith("text/calendar")) {
    out.calendars.push(decode(body, encoding).trim());
    return;
  }

  // First text/plain wins; text/html is ignored entirely rather than
  // stripped, because a tag-stripped marketing template is worse input for
  // an extractor than no input at all.
  if (contentType.startsWith("text/plain") && out.textBody === null) {
    const text = decode(body, encoding).trim();
    out.textBody = text === "" ? null : text;
  }
}

function escapeRe(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
```

- [ ] **Step 4: Run the MIME test**

Run: `npm test -- ingest/mime`
Expected: PASS, 8 tests.

- [ ] **Step 5: Write the failing ICS test**

Create `tests/server/ingest/ics.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { parseIcs } from "../../../src/server/ingest/ics.js";

const FLIGHT = [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "BEGIN:VEVENT",
  "UID:dl2214@delta.com",
  "SUMMARY:Delta 2214 BOI to STS",
  "LOCATION:Boise Airport",
  "DTSTART;TZID=America/Boise:20261009T094000",
  "DTEND;TZID=America/Los_Angeles:20261009T125500",
  "END:VEVENT",
  "END:VCALENDAR",
].join("\r\n");

describe("parseIcs", () => {
  it("reads summary and location", () => {
    const [event] = parseIcs(FLIGHT);
    expect(event?.summary).toBe("Delta 2214 BOI to STS");
    expect(event?.location).toBe("Boise Airport");
  });

  it("converts a TZID wall clock to a UTC instant and keeps the zone", () => {
    // 9:40 MDT is 15:40 UTC. Keeping the zone alongside is the entire reason
    // .ics is preferred over the email body.
    const [event] = parseIcs(FLIGHT);
    expect(event?.startsAt).toBe("2026-10-09T15:40:00.000Z");
    expect(event?.startsAtTz).toBe("America/Boise");
  });

  it("keeps each endpoint's own zone", () => {
    const [event] = parseIcs(FLIGHT);
    expect(event?.endsAtTz).toBe("America/Los_Angeles");
    expect(event?.endsAt).toBe("2026-10-09T19:55:00.000Z");
  });

  it("reads a UTC value written with a trailing Z", () => {
    const utc = [
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "SUMMARY:Checkout",
      "DTSTART:20261011T180000Z",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");
    const [event] = parseIcs(utc);
    expect(event?.startsAt).toBe("2026-10-11T18:00:00.000Z");
    expect(event?.startsAtTz).toBe("UTC");
  });

  it("unfolds a summary split across lines", () => {
    const folded = [
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "SUMMARY:Delta 2214 ",
      " BOI to STS",
      "DTSTART:20261009T154000Z",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");
    expect(parseIcs(folded)[0]?.summary).toBe("Delta 2214 BOI to STS");
  });

  it("returns every VEVENT in a multi-leg itinerary", () => {
    const two = FLIGHT.replace(
      "END:VCALENDAR",
      [
        "BEGIN:VEVENT",
        "SUMMARY:Delta 2215 STS to BOI",
        "DTSTART;TZID=America/Los_Angeles:20261011T130000",
        "END:VEVENT",
        "END:VCALENDAR",
      ].join("\r\n"),
    );
    expect(parseIcs(two)).toHaveLength(2);
  });

  it("skips an event whose DTSTART is unparseable rather than emitting a bad instant", () => {
    // An unparseable starts_at is stored, then throws inside
    // ItineraryRepo.localDateOf on every future read of that trip's day view.
    // Dropping the event and letting a human enter it is strictly better.
    const bad = [
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "SUMMARY:Nonsense",
      "DTSTART;TZID=Mars/Olympus:whenever",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");
    expect(parseIcs(bad)).toEqual([]);
  });

  it("returns nothing for text that is not a calendar", () => {
    expect(parseIcs("Dear customer, your stay is confirmed.")).toEqual([]);
  });
});
```

- [ ] **Step 6: Write the ICS reader**

Create `src/server/ingest/ics.ts`:

```ts
export type IcsEvent = {
  summary: string | null;
  location: string | null;
  startsAt: string;
  startsAtTz: string;
  endsAt: string | null;
  endsAtTz: string | null;
};

/** The offset `timeZone` was on at `instant`, in milliseconds. */
function offsetAt(instant: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(instant));
  const read = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? "0");
  return (
    Date.UTC(read("year"), read("month") - 1, read("day"), read("hour") % 24, read("minute"), read("second")) -
    instant
  );
}

/**
 * `20261009T094000` in a named zone -> a UTC instant. Two passes settle a
 * guess that lands on the wrong side of a DST transition. Mirrors the
 * client's `zonedToUtc`; they are not shared because this module is server
 * only and importing across that boundary for eight lines would be worse
 * than the duplication.
 */
function toUtc(value: string, timeZone: string): string {
  const m = value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z?$/);
  if (!m) throw new RangeError(`Unparseable iCalendar date-time: ${value}`);
  const [, y, mo, d, h, mi, s] = m as unknown as string[];

  if (timeZone === "UTC") {
    return new Date(
      Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)),
    ).toISOString();
  }

  // Throws for an unrecognised zone, which the caller turns into "skip this
  // event" rather than "store a value that bricks the day view".
  new Intl.DateTimeFormat("en-US", { timeZone });

  const naive = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
  let instant = naive - offsetAt(naive, timeZone);
  instant = naive - offsetAt(instant, timeZone);
  return new Date(instant).toISOString();
}

/** RFC 5545 line unfolding: a leading space or tab continues the line above. */
function unfold(text: string): string[] {
  return text.replace(/\r?\n[ \t]/g, "").split(/\r?\n/);
}

type Prop = { name: string; params: Record<string, string>; value: string };

function parseProp(line: string): Prop | null {
  const colon = line.indexOf(":");
  if (colon === -1) return null;
  const [name, ...paramParts] = line.slice(0, colon).split(";");
  const params: Record<string, string> = {};
  for (const part of paramParts) {
    const eq = part.indexOf("=");
    if (eq !== -1) params[part.slice(0, eq).toUpperCase()] = part.slice(eq + 1).replace(/"/g, "");
  }
  return { name: (name ?? "").toUpperCase(), params, value: line.slice(colon + 1) };
}

/**
 * Reads VEVENTs. Deliberately narrow — SUMMARY, LOCATION, DTSTART, DTEND —
 * because that is the whole of what a booking needs, and because .ics is the
 * one source that states a real IANA zone per endpoint.
 *
 * An event whose DTSTART will not parse is DROPPED, not emitted with a bad
 * value: a stored unparseable timestamp throws inside ItineraryRepo on every
 * future read of that trip's day view, permanently, with no API route to
 * repair it. A missing event that a human retypes is a far smaller problem.
 */
export function parseIcs(text: string): IcsEvent[] {
  const events: IcsEvent[] = [];
  let current: Partial<IcsEvent> & { rawStart?: Prop; rawEnd?: Prop } = {};
  let inEvent = false;

  for (const line of unfold(text)) {
    const prop = parseProp(line);
    if (prop === null) continue;

    if (prop.name === "BEGIN" && prop.value === "VEVENT") {
      inEvent = true;
      current = {};
      continue;
    }
    if (prop.name === "END" && prop.value === "VEVENT") {
      inEvent = false;
      const start = current.rawStart;
      if (!start) continue;
      try {
        const startTz = start.params.TZID ?? "UTC";
        const end = current.rawEnd;
        events.push({
          summary: current.summary ?? null,
          location: current.location ?? null,
          startsAt: toUtc(start.value, startTz),
          startsAtTz: startTz,
          endsAt: end ? toUtc(end.value, end.params.TZID ?? "UTC") : null,
          endsAtTz: end ? (end.params.TZID ?? "UTC") : null,
        });
      } catch {
        // Unparseable date-time or unknown zone: drop the event.
      }
      continue;
    }
    if (!inEvent) continue;

    // Unescape RFC 5545 text escapes in the two free-text fields.
    const unescaped = prop.value.replace(/\\([,;\\])/g, "$1").replace(/\\n/gi, "\n");
    if (prop.name === "SUMMARY") current.summary = unescaped.trim();
    else if (prop.name === "LOCATION") current.location = unescaped.trim();
    else if (prop.name === "DTSTART") current.rawStart = prop;
    else if (prop.name === "DTEND") current.rawEnd = prop;
  }

  return events;
}
```

- [ ] **Step 7: Run the ICS test**

Run: `npm test -- ingest/ics`
Expected: PASS, 8 tests.

- [ ] **Step 8: Make `BOOKING_KINDS` a real literal tuple, then write the extraction contract**

First, a one-line fix at the source in `src/server/schemas/booking-kinds.ts`. It currently reads:

```ts
export const BOOKING_KINDS = [...Object.keys(SCHEMAS), "other"] as const;
```

`Object.keys()` is typed `string[]`, so spreading it produces `readonly string[]` — `as const` cannot recover literals that were erased before it ran. Every downstream `z.enum(BOOKING_KINDS)` therefore infers `kind: string`, not the literal union `"flight" | "lodging" | "car" | "activity" | "other"`. Runtime validation is unaffected (Zod still checks membership against the actual array), but the *type* is useless: `ExtractedBooking["kind"]` is `string`, so `DraftCard`'s `as ExtractedBooking["kind"]` cast is a no-op that widens nothing and narrows nothing, and a typo in a kind literal anywhere in the client compiles clean.

Replace it with an explicit tuple, and keep it honest with a compile-time check rather than a comment:

```ts
export const BOOKING_KINDS = ["flight", "lodging", "car", "activity", "other"] as const;

export type BookingKind = (typeof BOOKING_KINDS)[number];

/**
 * Written out rather than derived from `Object.keys(SCHEMAS)`, because
 * `Object.keys` is typed `string[]` and erases the literals before `as const`
 * can preserve them — which silently degrades every `z.enum(BOOKING_KINDS)`
 * to `z.enum(string[])`, inferring `kind: string`.
 *
 * The cost of writing it out is that this list and SCHEMAS could drift. The
 * line below makes that a typecheck failure: every key of SCHEMAS must be a
 * BookingKind. (The reverse does not hold and must not — `other` is the
 * freeform escape hatch and deliberately has no per-kind schema.)
 */
const _schemasAreKinds: Record<keyof typeof SCHEMAS, BookingKind> = {
  flight: "flight",
  lodging: "lodging",
  car: "car",
  activity: "activity",
};
void _schemasAreKinds;
```

This is pre-existing — `src/server/routes/trips.ts` has the same weakened enum today — and fixing it at the source fixes both callers plus everything Part B adds. Run `npm test && npm run typecheck` after this edit and before continuing; nothing should change, because the runtime value is identical.

Then create `src/server/ingest/extracted.ts`:

```ts
import { z } from "zod";
import { BOOKING_KINDS, parseDetails } from "../schemas/booking-kinds.js";

/**
 * What every extractor produces, whatever produced it. Deliberately the
 * subset of CreateBookingInput a parser can honestly know: no tripId (a
 * human picks the trip) and no status (approval decides that).
 */
const schema = z.object({
  kind: z.enum(BOOKING_KINDS),
  title: z.string().min(1),
  location: z.string().nullish(),
  startsAt: z.string().nullish(),
  startsAtTz: z.string().nullish(),
  endsAt: z.string().nullish(),
  endsAtTz: z.string().nullish(),
  confirmationNumber: z.string().nullish(),
  costCents: z.number().int().nullish(),
  details: z.unknown().optional(),
});

export type ExtractedBooking = z.infer<typeof schema>;

function isValidTimestamp(value: string): boolean {
  return !Number.isNaN(Date.parse(value));
}

function isValidTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/**
 * Validates whatever an extractor produced — an .ics reading, a local model's
 * constrained JSON, or Claude's — against ONE schema, plus the same per-kind
 * `parseDetails` the booking route uses. That single funnel is what stops a
 * new extractor from quietly widening what can enter the system.
 *
 * Timestamps and zones are checked here as well as at `BookingRepo.create`,
 * because an extractor is exactly the kind of caller that produces a
 * plausible-looking unparseable date, and a bad pair is dropped rather than
 * shown to a reviewer as if it were fine.
 */
export function validateExtracted(raw: unknown): ExtractedBooking[] {
  const items = Array.isArray(raw) ? raw : [raw];
  const out: ExtractedBooking[] = [];

  for (const item of items) {
    const parsed = schema.safeParse(item);
    if (!parsed.success) continue;
    const value = parsed.data;

    // A timestamp without its zone, an unparseable timestamp, or an
    // unrecognised zone: drop the field rather than the whole booking. The
    // title and confirmation number are still worth a human's time.
    const startOk =
      !value.startsAt ||
      (!!value.startsAtTz && isValidTimestamp(value.startsAt) && isValidTimezone(value.startsAtTz));
    const endOk =
      !value.endsAt ||
      (!!value.endsAtTz && isValidTimestamp(value.endsAt) && isValidTimezone(value.endsAtTz));

    try {
      out.push({
        ...value,
        ...(startOk ? {} : { startsAt: null, startsAtTz: null }),
        ...(endOk ? {} : { endsAt: null, endsAtTz: null }),
        // The same per-kind Zod schemas the booking route enforces. An
        // extractor that invents a `details` shape fails here, not at insert.
        details: parseDetails(value.kind, value.details ?? {}),
      });
    } catch {
      // Per-kind details did not validate. A flight with no carrier is not a
      // flight; drop it and let the human enter one.
    }
  }

  return out;
}

/**
 * The JSON Schema handed to a constrained-decoding model server. It mirrors
 * the Zod schema above; a model literally cannot emit a shape outside it,
 * which is what makes a 7B model viable for this at all. Zod still validates
 * the result — constrained decoding guarantees shape, not correctness.
 */
export const EXTRACTED_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["bookings"],
  properties: {
    bookings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        // STRICT MODE REQUIRES EVERY KEY IN `properties` TO APPEAR HERE.
        // OpenAI-strict -- and vLLM and LM Studio, which this plan claims are
        // drop-in replacements -- reject a schema whose `required` omits any
        // declared property when `additionalProperties: false` is set. An
        // earlier draft listed only ["kind", "title"] with eleven properties,
        // which most servers answer by ignoring the schema entirely: decoding
        // silently falls back to unconstrained JSON, and the central claim of
        // this design -- that a small model CANNOT emit a shape Zod would
        // reject -- quietly stops being true, with nothing failing to say so.
        //
        // Optionality is expressed by the `["string", "null"]` unions below,
        // not by omission from `required`. That matches the Zod side, where
        // every one of these is `.nullish()`, so a null is a valid answer and
        // "I could not work this out" remains expressible.
        required: [
          "kind",
          "title",
          "location",
          "startsAt",
          "startsAtTz",
          "endsAt",
          "endsAtTz",
          "confirmationNumber",
          "costCents",
          "details",
        ],
        properties: {
          kind: { type: "string", enum: [...BOOKING_KINDS] },
          title: { type: "string" },
          location: { type: ["string", "null"] },
          startsAt: {
            type: ["string", "null"],
            description: "UTC ISO-8601 instant, e.g. 2026-10-09T15:40:00.000Z",
          },
          startsAtTz: {
            type: ["string", "null"],
            description: "IANA zone for startsAt, e.g. America/Boise. Required if startsAt is set.",
          },
          endsAt: { type: ["string", "null"] },
          endsAtTz: { type: ["string", "null"] },
          confirmationNumber: { type: ["string", "null"] },
          costCents: { type: ["integer", "null"], description: "Total cost in cents" },
          details: { type: "object", additionalProperties: true },
        },
      },
    },
  },
} as const;
```

- [ ] **Step 9: Write the extractor interface, the chain, and IcsExtractor**

Create `src/server/ingest/extractor.ts`:

```ts
import type { ParsedEmail } from "./mime.js";
import type { ExtractedBooking } from "./extracted.js";

export type ExtractionSource = "ics" | "local" | "claude" | "none";

export type ExtractionResult = {
  source: ExtractionSource;
  confidence: "high" | "low";
  bookings: ExtractedBooking[];
  /** Why nothing came back, in words a reviewer can act on. */
  error: string | null;
};

/**
 * Every extraction strategy behind one interface, all validated against the
 * same Zod schemas. Adding vLLM, LM Studio, or a different local model is
 * configuration; adding a genuinely new STRATEGY is one class.
 */
export interface Extractor {
  readonly name: ExtractionSource;
  extract(email: ParsedEmail): Promise<ExtractedBooking[]>;
}

export const EMPTY_RESULT: ExtractionResult = {
  source: "none",
  confidence: "low",
  bookings: [],
  error: null,
};

/**
 * Runs extractors in order and stops at the first that returns anything.
 *
 * FAIL SOFT, and this is the point of the function. Every extractor is
 * wrapped: a thrown error, a timeout, a model server that is not running are
 * all logged and stepped over. The chain always returns a result, and the
 * caller always writes a row. A home LLM server WILL be down sometimes, and
 * an email that vanishes because Ollama was not running is the worst outcome
 * available here — far worse than a row a human has to complete by hand.
 */
export async function runExtractionChain(
  extractors: Extractor[],
  email: ParsedEmail,
): Promise<ExtractionResult> {
  const failures: string[] = [];

  for (const extractor of extractors) {
    try {
      const bookings = await extractor.extract(email);
      if (bookings.length > 0) {
        return {
          source: extractor.name,
          // Only a calendar attachment is trusted enough to arrive
          // unflagged: it states real zones rather than inferring them. A
          // model's reading is always shown as needing a look.
          confidence: extractor.name === "ics" ? "high" : "low",
          bookings,
          error: null,
        };
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      failures.push(`${extractor.name}: ${message}`);
      console.error(`[ingest] ${extractor.name} extractor failed`, err);
    }
  }

  return {
    ...EMPTY_RESULT,
    error:
      failures.length > 0
        ? `Nothing could be extracted (${failures.join("; ")}). Fill this in by hand, or escalate it.`
        : "Nothing recognisable was found in this email. Fill it in by hand, or escalate it.",
  };
}
```

Create `src/server/ingest/ics-extractor.ts`:

```ts
import type { Extractor } from "./extractor.js";
import type { ParsedEmail } from "./mime.js";
import type { ExtractedBooking } from "./extracted.js";
import { validateExtracted } from "./extracted.js";
import { parseIcs } from "./ics.js";

/**
 * First in the chain, and the only extractor with no model behind it. Most
 * airline and hotel confirmations attach a calendar invite, which is
 * structured and carries a real IANA zone per endpoint — the exact pair
 * `booking` stores.
 */
export class IcsExtractor implements Extractor {
  readonly name = "ics" as const;

  async extract(email: ParsedEmail): Promise<ExtractedBooking[]> {
    const events = email.calendars.flatMap((text) => parseIcs(text));
    // Kind is genuinely unknown from a VEVENT — a calendar invite does not
    // say "this is a flight". `other` is the freeform escape hatch and the
    // reviewer changes it in one click; guessing from the summary text would
    // be the model's job, done badly, with no model.
    return validateExtracted(
      events.map((e) => ({
        kind: "other",
        title: e.summary ?? "Calendar event",
        location: e.location,
        startsAt: e.startsAt,
        startsAtTz: e.startsAtTz,
        endsAt: e.endsAt,
        endsAtTz: e.endsAtTz,
        details: {},
      })),
    );
  }
}
```

- [ ] **Step 10: Write the chain test**

Create `tests/server/ingest/extractor.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { runExtractionChain } from "../../../src/server/ingest/extractor.js";
import type { Extractor } from "../../../src/server/ingest/extractor.js";
import { IcsExtractor } from "../../../src/server/ingest/ics-extractor.js";
import { validateExtracted } from "../../../src/server/ingest/extracted.js";
import { parseMime } from "../../../src/server/ingest/mime.js";

const EMPTY = { from: null, subject: null, textBody: null, calendars: [] };

function fake(
  name: Extractor["name"],
  impl: Extractor["extract"],
): Extractor {
  return { name, extract: impl };
}

const ONE = [{ kind: "lodging" as const, title: "Dawn Ranch Lodge", details: { propertyName: "Dawn Ranch Lodge" } }];

describe("runExtractionChain", () => {
  it("stops at the first extractor that returns something", async () => {
    const second = vi.fn(async () => ONE);
    const result = await runExtractionChain(
      [fake("ics", async () => ONE), fake("local", second)],
      EMPTY,
    );
    expect(result.source).toBe("ics");
    expect(second).not.toHaveBeenCalled();
  });

  it("falls through an extractor that returns nothing", async () => {
    const result = await runExtractionChain(
      [fake("ics", async () => []), fake("local", async () => ONE)],
      EMPTY,
    );
    expect(result.source).toBe("local");
  });

  it("fails soft when an extractor throws", async () => {
    // The local model server being down must NOT lose the email.
    const result = await runExtractionChain(
      [
        fake("ics", async () => []),
        fake("local", async () => {
          throw new Error("fetch failed: ECONNREFUSED 127.0.0.1:11434");
        }),
      ],
      EMPTY,
    );
    expect(result.source).toBe("none");
    expect(result.bookings).toEqual([]);
    expect(result.error).toMatch(/ECONNREFUSED/);
    expect(result.error).toMatch(/by hand/);
  });

  it("keeps going past a thrower to a later extractor", async () => {
    const result = await runExtractionChain(
      [
        fake("local", async () => {
          throw new Error("timeout");
        }),
        fake("claude", async () => ONE),
      ],
      EMPTY,
    );
    expect(result.source).toBe("claude");
  });

  it("trusts an .ics reading and flags a model reading", async () => {
    expect((await runExtractionChain([fake("ics", async () => ONE)], EMPTY)).confidence).toBe("high");
    expect((await runExtractionChain([fake("local", async () => ONE)], EMPTY)).confidence).toBe("low");
  });

  it("returns an actionable message when everything came back empty", async () => {
    const result = await runExtractionChain([fake("ics", async () => [])], EMPTY);
    expect(result.source).toBe("none");
    expect(result.error).toMatch(/Nothing recognisable/);
  });
});

describe("IcsExtractor", () => {
  const raw = [
    'Content-Type: multipart/mixed; boundary="B"',
    "",
    "--B",
    "Content-Type: text/calendar",
    "",
    "BEGIN:VCALENDAR",
    "BEGIN:VEVENT",
    "SUMMARY:Delta 2214 BOI to STS",
    "DTSTART;TZID=America/Boise:20261009T094000",
    "END:VEVENT",
    "END:VCALENDAR",
    "",
    "--B--",
  ].join("\r\n");

  it("produces a booking with a real zone from the attachment", async () => {
    const [booking] = await new IcsExtractor().extract(parseMime(raw));
    expect(booking?.title).toBe("Delta 2214 BOI to STS");
    expect(booking?.startsAt).toBe("2026-10-09T15:40:00.000Z");
    expect(booking?.startsAtTz).toBe("America/Boise");
  });

  it("returns nothing when there is no calendar part", async () => {
    expect(await new IcsExtractor().extract(EMPTY)).toEqual([]);
  });
});

describe("validateExtracted", () => {
  it("drops a booking whose per-kind details do not validate", () => {
    // A flight with no carrier is not a flight. The same Zod schemas the
    // booking route enforces are the ones that decide this.
    expect(validateExtracted([{ kind: "flight", title: "DL2214", details: {} }])).toEqual([]);
  });

  it("drops a timestamp that has no zone rather than the whole booking", () => {
    const [booking] = validateExtracted([
      { kind: "other", title: "Dinner", startsAt: "2026-10-10T02:00:00Z", details: {} },
    ]);
    expect(booking?.title).toBe("Dinner");
    expect(booking?.startsAt).toBe(null);
  });

  it("drops an unparseable timestamp rather than storing one that bricks the day view", () => {
    const [booking] = validateExtracted([
      { kind: "other", title: "Dinner", startsAt: "next tuesday", startsAtTz: "America/Boise", details: {} },
    ]);
    expect(booking?.startsAt).toBe(null);
  });

  it("drops an unrecognised timezone", () => {
    const [booking] = validateExtracted([
      { kind: "other", title: "Dinner", startsAt: "2026-10-10T02:00:00Z", startsAtTz: "Mars/Olympus", details: {} },
    ]);
    expect(booking?.startsAtTz).toBe(null);
  });

  it("rejects a kind outside BOOKING_KINDS", () => {
    expect(validateExtracted([{ kind: "spaceship", title: "X", details: {} }])).toEqual([]);
  });
});
```

- [ ] **Step 11: Run the tests**

Run: `npm test -- ingest/`
Expected: PASS — 8 mime, 8 ics, 6 chain, 2 IcsExtractor, 5 validateExtracted.

- [ ] **Step 12: Confirm the architecture test still passes**

Run: `npm test -- architecture`
Expected: PASS. `src/server/ingest/` is not on the raw-SQL allowlist and contains no SQL — these modules take strings and return values.

**If it fails, it will name `ingest/mime.ts` or `ingest/ics.ts`, and the cause will be a regex.** That test bans two literal substrings, and one of them is the method name this task's parsers would naturally use on a `RegExp`. Fix the parser (switch to `str.match(re)` / `re.test(str)`), never the test — see the note at the top of this task for why narrowing it to a receiver-qualified form would be a real regression.

- [ ] **Step 13: Commit**

```bash
git add src/server/ingest src/server/schemas/booking-kinds.ts tests/server/ingest
git commit -m "feat: add MIME and iCalendar parsing behind a fail-soft extractor chain"
```

---

### Task 12: The local extractor, and Claude as a manual escalation

**Files:**
- Create: `src/server/ingest/prompt.ts`, `src/server/ingest/local-llm-extractor.ts`, `src/server/ingest/claude-extractor.ts`
- Modify: `package.json`
- Test: `tests/server/ingest/local-llm-extractor.test.ts`, `tests/server/ingest/claude-extractor.test.ts`

**Interfaces:**
- Consumes: `Extractor`, `validateExtracted`, `EXTRACTED_JSON_SCHEMA`
- Produces:
  - `class LocalLlmExtractor implements Extractor` (`name = "local"`)
  - `class ClaudeExtractor implements Extractor` (`name = "claude"`)
  - `buildExtractionPrompt(email): { system: string; user: string }`

**Tests never contact a model.** `LocalLlmExtractor` takes an injectable `fetch`; `ClaudeExtractor` takes an injectable client shaped as `{ messages: { create } }`. A suite that needs Ollama running is a suite nobody runs, and it would make CI depend on a GPU.

**Both extractors share one prompt and one JSON schema.** That is the point of the interface: the difference between them is which HTTP endpoint the same instructions go to. It is also why the strict-mode `required` fix in Task 11's `EXTRACTED_JSON_SCHEMA` covers the escalation path for free: Anthropic's `json_schema` output format applies the same rule as the OpenAI-compatible servers — an object with `additionalProperties: false` must list every declared property in `required` — and both extractors hand over that one constant. Both test files assert it recursively, so a future edit that adds a property and forgets `required` fails in two places rather than degrading to unconstrained decoding in silence.

- [ ] **Step 1: Add the SDK**

Run: `npm install @anthropic-ai/sdk`

Only the escalation path imports it. The local path is a plain `fetch` against an OpenAI-compatible endpoint and takes no dependency at all — which is also why swapping Ollama for vLLM, llama.cpp's server, or LM Studio is two environment variables.

- [ ] **Step 2: Write the shared prompt**

Create `src/server/ingest/prompt.ts`:

```ts
import type { ParsedEmail } from "./mime.js";

/**
 * One prompt, used by both the local model and the Claude escalation, so the
 * two paths differ only in where the request goes. Written for a 7B model:
 * short, concrete, and leaning on the constrained JSON schema to carry the
 * shape rather than describing the shape in prose.
 */
export function buildExtractionPrompt(email: ParsedEmail): { system: string; user: string } {
  return {
    system: [
      "You read travel confirmation emails and extract the bookings they describe.",
      "",
      "Rules:",
      "- Return one entry per booking. A round trip is two flights, not one.",
      '- kind is one of: flight, lodging, car, activity, other. Use "other" if unsure.',
      "- startsAt and endsAt are UTC ISO-8601 instants. Convert from the local time in the email.",
      "- startsAtTz and endsAtTz are IANA zone names for the LOCATION OF THE EVENT",
      "  (a departure uses the departure airport's zone, an arrival the arrival airport's).",
      "- If you cannot work out the zone, set both the timestamp and the zone to null.",
      "  A booking with no time is useful; a booking with the wrong time is not.",
      "- costCents is the total in cents: $612.40 is 61240.",
      "- Copy the confirmation number exactly. Do not invent one.",
      "- details carries kind-specific fields: flight needs carrier, flightNumber,",
      "  originIata, destinationIata; lodging needs propertyName; car needs vendor.",
      "- Never guess a value to fill a field. Null is a correct answer.",
    ].join("\n"),
    user: [
      email.subject ? `Subject: ${email.subject}` : "",
      email.from ? `From: ${email.from}` : "",
      "",
      email.textBody ?? "(no text body)",
    ]
      .filter((line) => line !== "")
      .join("\n"),
  };
}
```

- [ ] **Step 3: Write the failing local-extractor test**

Create `tests/server/ingest/local-llm-extractor.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { LocalLlmExtractor } from "../../../src/server/ingest/local-llm-extractor.js";

const EMAIL = {
  from: "reservations@dawnranch.com",
  subject: "Reservation Confirmed",
  textBody: "Confirmation number: D7WN88. Check-in Friday, October 9, 2026, 3:00 PM.",
  calendars: [],
};

function completion(content: unknown) {
  return vi.fn(async () =>
    new Response(
      JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }),
      { status: 200, headers: { "content-type": "application/json" } },
    ),
  );
}

function extractor(fetchImpl: typeof globalThis.fetch, over: Record<string, unknown> = {}) {
  return new LocalLlmExtractor({
    baseUrl: "http://127.0.0.1:11434/v1",
    model: "qwen2.5:7b-instruct",
    timeoutMs: 1000,
    fetch: fetchImpl,
    ...over,
  });
}

describe("LocalLlmExtractor", () => {
  it("posts an OpenAI-compatible chat completion to the configured endpoint", async () => {
    const fetchMock = completion({ bookings: [] });
    await extractor(fetchMock).extract(EMAIL);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:11434/v1/chat/completions");
    expect(init.method).toBe("POST");
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.model).toBe("qwen2.5:7b-instruct");
    expect(body.messages).toHaveLength(2);
  });

  it("constrains decoding with the JSON schema", async () => {
    // This is what makes a 7B model viable: it cannot emit a shape the Zod
    // schema would reject. Without it the same model returns prose-wrapped
    // JSON often enough to be useless.
    const fetchMock = completion({ bookings: [] });
    await extractor(fetchMock).extract(EMAIL);
    const body = JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body)) as {
      response_format: {
        type: string;
        strict?: unknown;
        json_schema: { name: string; schema: Record<string, unknown>; strict: boolean };
      };
    };
    expect(body.response_format.type).toBe("json_schema");
    // INSIDE json_schema, which is where the OpenAI-compatible contract puts
    // it. A `strict` at the top level is an unknown key servers drop on the
    // floor, leaving decoding unconstrained while this test still passed.
    expect(body.response_format.json_schema.strict).toBe(true);
    expect(body.response_format).not.toHaveProperty("strict");
    expect(body.response_format.json_schema.name).toBe("extracted_bookings");
    expect(body.response_format.json_schema.schema).toBeTruthy();
  });

  it("sends a schema that is legal under strict mode", async () => {
    // Strict mode rejects an object that sets additionalProperties: false and
    // omits any declared property from `required`. A server that rejects the
    // schema falls back to unconstrained decoding, which is the failure this
    // whole design rests on not happening -- and it fails silently.
    const fetchMock = completion({ bookings: [] });
    await extractor(fetchMock).extract(EMAIL);
    const body = JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body)) as {
      response_format: { json_schema: { schema: Record<string, unknown> } };
    };

    const walk = (node: unknown): void => {
      if (typeof node !== "object" || node === null) return;
      const obj = node as Record<string, unknown>;
      if (obj.type === "object" && obj.additionalProperties === false) {
        const props = Object.keys((obj.properties ?? {}) as Record<string, unknown>);
        expect([...((obj.required ?? []) as string[])].sort()).toEqual([...props].sort());
      }
      for (const value of Object.values(obj)) walk(value);
    };
    walk(body.response_format.json_schema.schema);
  });

  it("validates the model's output against the Zod schemas", async () => {
    const fetchMock = completion({
      bookings: [
        {
          kind: "lodging",
          title: "Dawn Ranch Lodge",
          confirmationNumber: "D7WN88",
          costCents: 61240,
          details: { propertyName: "Dawn Ranch Lodge" },
        },
      ],
    });
    const [booking] = await extractor(fetchMock).extract(EMAIL);
    expect(booking?.title).toBe("Dawn Ranch Lodge");
    expect(booking?.confirmationNumber).toBe("D7WN88");
  });

  it("drops an entry the schemas reject rather than passing it through", async () => {
    // Constrained decoding guarantees shape, not correctness: the schema
    // permits `kind: "flight"` with an empty details object, and the flight
    // Zod schema does not.
    const fetchMock = completion({
      bookings: [{ kind: "flight", title: "DL2214", details: {} }],
    });
    expect(await extractor(fetchMock).extract(EMAIL)).toEqual([]);
  });

  it("returns nothing when there is no text body to read", async () => {
    const fetchMock = completion({ bookings: [] });
    const result = await extractor(fetchMock).extract({ ...EMAIL, textBody: null });
    expect(result).toEqual([]);
    // And does not spend a model call on an empty prompt.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws a readable error when the server is not running", async () => {
    // The chain catches this and the email still lands. The message ends up
    // in front of a human, so it must say what to do.
    const fetchMock = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    await expect(extractor(fetchMock as never).extract(EMAIL)).rejects.toThrow(
      /extraction service/i,
    );
  });

  it("throws on a non-2xx response", async () => {
    const fetchMock = vi.fn(async () => new Response("model not found", { status: 404 }));
    await expect(extractor(fetchMock as never).extract(EMAIL)).rejects.toThrow(/404/);
  });

  it("throws rather than hanging when the server never answers", async () => {
    // A wedged model server must not hold the ingest request open until the
    // Worker times out and Email Routing gives up on the message.
    const fetchMock = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        }),
    );
    await expect(
      extractor(fetchMock as never, { timeoutMs: 10 }).extract(EMAIL),
    ).rejects.toThrow(/timed out|aborted/i);
  });

  it("throws on a response that is not JSON at all", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: "sure, here you go!" } }] }), {
        status: 200,
      }),
    );
    await expect(extractor(fetchMock as never).extract(EMAIL)).rejects.toThrow(/JSON/i);
  });
});
```

- [ ] **Step 4: Write LocalLlmExtractor**

Create `src/server/ingest/local-llm-extractor.ts`:

```ts
import type { Extractor } from "./extractor.js";
import type { ParsedEmail } from "./mime.js";
import type { ExtractedBooking } from "./extracted.js";
import { EXTRACTED_JSON_SCHEMA, validateExtracted } from "./extracted.js";
import { buildExtractionPrompt } from "./prompt.js";

export type LocalLlmConfig = {
  /** An OpenAI-compatible base URL. Ollama, vLLM, llama.cpp, LM Studio all fit. */
  baseUrl: string;
  model: string;
  timeoutMs: number;
  apiKey?: string;
  fetch?: typeof globalThis.fetch;
};

/**
 * The DEFAULT extraction path for anything without a calendar attachment,
 * and deliberately a local one.
 *
 * Travel confirmations are among the most PII-dense documents this household
 * produces — legal names as printed on passports, confirmation numbers,
 * frequent-flyer numbers, addresses, card last-4. The architecture already
 * rejected D1 + Workers to keep that class of data off third-party
 * infrastructure; sending the same content to a hosted model by default
 * would reintroduce exactly that custody change through a different door.
 *
 * Every OpenAI-compatible server accepts the same request shape, so changing
 * runtime or model is configuration rather than code.
 */
export class LocalLlmExtractor implements Extractor {
  readonly name = "local" as const;

  constructor(private readonly config: LocalLlmConfig) {}

  async extract(email: ParsedEmail): Promise<ExtractedBooking[]> {
    if (email.textBody === null || email.textBody.trim() === "") return [];

    const doFetch = this.config.fetch ?? globalThis.fetch;
    const { system, user } = buildExtractionPrompt(email);

    // A wedged model server must not hold the ingest request open until the
    // Worker gives up and Email Routing drops the message.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);

    let res: Response;
    try {
      res = await doFetch(`${this.config.baseUrl}/chat/completions`, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "content-type": "application/json",
          ...(this.config.apiKey ? { authorization: `Bearer ${this.config.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: this.config.model,
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
          // Schema-constrained decoding. THIS is what makes a 7B model
          // viable: it cannot emit a shape the Zod schema would reject, so
          // the failure mode small models are worst at -- malformed JSON,
          // invented keys, prose around the object -- is gone. Zod still
          // validates the result; this guarantees shape, not correctness.
          // `strict` goes INSIDE `json_schema`. The OpenAI-compatible
          // contract is
          //   { type: "json_schema", json_schema: { name, schema, strict } }
          // and a `strict` sitting beside `type` is an unknown top-level key
          // that most servers silently ignore -- at which point decoding is
          // NOT constrained, the model is free to wrap the object in prose or
          // invent keys, and the whole reason a 7B model is viable here has
          // quietly evaporated with a 200 response and no error anywhere.
          response_format: {
            type: "json_schema",
            json_schema: {
              name: "extracted_bookings",
              schema: EXTRACTED_JSON_SCHEMA,
              strict: true,
            },
          },
        }),
      });
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new Error(
          `The local extraction service at ${this.config.baseUrl} timed out after ` +
            `${this.config.timeoutMs}ms.`,
        );
      }
      throw new Error(
        `The local extraction service at ${this.config.baseUrl} could not be reached ` +
          `(${err instanceof Error ? err.message : String(err)}). Is the model server running?`,
      );
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      throw new Error(
        `The local extraction service answered ${res.status}. ` +
          `Check that ${this.config.model} is pulled and loaded.`,
      );
    }

    const payload = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const content = payload.choices?.[0]?.message?.content ?? "";

    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      throw new Error(
        "The local extraction service did not return JSON. The model may not support " +
          "constrained decoding on this server.",
      );
    }

    const bookings = (parsed as { bookings?: unknown }).bookings;
    return validateExtracted(bookings ?? []);
  }
}
```

- [ ] **Step 5: Run the local-extractor test**

Run: `npm test -- local-llm-extractor`
Expected: PASS, 10 tests. **No model server is running and none is needed.**

- [ ] **Step 6: Write the failing Claude test**

Create `tests/server/ingest/claude-extractor.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { ClaudeExtractor } from "../../../src/server/ingest/claude-extractor.js";

const EMAIL = {
  from: "reservations@dawnranch.com",
  subject: "Reservation Confirmed",
  textBody: "Confirmation number: D7WN88",
  calendars: [],
};

function client(content: unknown) {
  return {
    messages: {
      create: vi.fn(async () => ({
        content: [{ type: "text", text: JSON.stringify(content) }],
      })),
    },
  };
}

describe("ClaudeExtractor", () => {
  it("calls the current model with structured output", async () => {
    const api = client({ bookings: [] });
    await new ClaudeExtractor({ client: api as never }).extract(EMAIL);
    const params = api.messages.create.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(params.model).toBe("claude-opus-4-8");
    expect(params.output_config).toMatchObject({ format: { type: "json_schema" } });
    // Sampling parameters were removed on this model family and are rejected.
    expect(params).not.toHaveProperty("temperature");
    expect(params).not.toHaveProperty("top_p");
  });

  it("validates the response against the same Zod schemas as every other extractor", async () => {
    const api = client({
      bookings: [
        { kind: "lodging", title: "Dawn Ranch Lodge", details: { propertyName: "Dawn Ranch Lodge" } },
      ],
    });
    const [booking] = await new ClaudeExtractor({ client: api as never }).extract(EMAIL);
    expect(booking?.title).toBe("Dawn Ranch Lodge");
  });

  it("drops an entry the per-kind schemas reject", async () => {
    const api = client({ bookings: [{ kind: "flight", title: "DL2214", details: {} }] });
    expect(await new ClaudeExtractor({ client: api as never }).extract(EMAIL)).toEqual([]);
  });

  it("hands over a schema that is legal under strict structured output", async () => {
    // Same constant, same rule: an object with additionalProperties: false
    // must list every declared property in `required`. Anthropic's
    // json_schema output format enforces this exactly as the
    // OpenAI-compatible servers do, and a rejected schema means the response
    // is not constrained at all.
    const api = client({ bookings: [] });
    await new ClaudeExtractor({ client: api as never }).extract(EMAIL);
    const params = api.messages.create.mock.calls[0]?.[0] as {
      output_config: { format: { schema: Record<string, unknown> } };
    };

    const walk = (node: unknown): void => {
      if (typeof node !== "object" || node === null) return;
      const obj = node as Record<string, unknown>;
      if (obj.type === "object" && obj.additionalProperties === false) {
        const props = Object.keys((obj.properties ?? {}) as Record<string, unknown>);
        expect([...((obj.required ?? []) as string[])].sort()).toEqual([...props].sort());
      }
      for (const value of Object.values(obj)) walk(value);
    };
    walk(params.output_config.format.schema);
  });

  it("returns nothing rather than calling out when there is no body", async () => {
    const api = client({ bookings: [] });
    expect(
      await new ClaudeExtractor({ client: api as never }).extract({ ...EMAIL, textBody: null }),
    ).toEqual([]);
    expect(api.messages.create).not.toHaveBeenCalled();
  });

  it("reports a refusal rather than pretending nothing was found", async () => {
    const api = {
      messages: {
        create: vi.fn(async () => ({ stop_reason: "refusal", content: [] })),
      },
    };
    await expect(
      new ClaudeExtractor({ client: api as never }).extract(EMAIL),
    ).rejects.toThrow(/declined/i);
  });

  it("surfaces an API failure so the chain can record it", async () => {
    const api = {
      messages: {
        create: vi.fn(async () => {
          throw new Error("401 authentication_error");
        }),
      },
    };
    await expect(
      new ClaudeExtractor({ client: api as never }).extract(EMAIL),
    ).rejects.toThrow(/401/);
  });
});
```

- [ ] **Step 7: Write ClaudeExtractor**

Create `src/server/ingest/claude-extractor.ts`:

```ts
import Anthropic from "@anthropic-ai/sdk";
import type { Extractor } from "./extractor.js";
import type { ParsedEmail } from "./mime.js";
import type { ExtractedBooking } from "./extracted.js";
import { EXTRACTED_JSON_SCHEMA, validateExtracted } from "./extracted.js";
import { buildExtractionPrompt } from "./prompt.js";

/**
 * The model id comes from the claude-api skill's current-models table, not
 * from memory. Do not append a date suffix; these ids are complete as-is.
 */
const MODEL = "claude-opus-4-8";

export type ClaudeExtractorConfig = {
  /** Injectable so tests never contact the API. */
  client?: Pick<Anthropic, "messages">;
  apiKey?: string;
};

/**
 * THIRD in the chain, and never automatic.
 *
 * This extractor is only ever constructed by the escalation endpoint, which
 * a human triggers from the review UI after seeing that local extraction
 * produced nothing usable. It is not in the chain the ingest route runs.
 *
 * The reason is custody, not cost: a confirmation email carries legal names,
 * confirmation numbers, frequent-flyer numbers, addresses, and card last-4,
 * and the whole architecture exists to keep that class of data on
 * guiltyspark. Sending one message to a hosted model because a person looked
 * at it and decided it was worth it is a different act from routing every
 * message there by default. Keep it that way.
 */
export class ClaudeExtractor implements Extractor {
  readonly name = "claude" as const;
  private readonly client: Pick<Anthropic, "messages">;

  constructor(config: ClaudeExtractorConfig = {}) {
    this.client =
      config.client ?? new Anthropic(config.apiKey ? { apiKey: config.apiKey } : {});
  }

  async extract(email: ParsedEmail): Promise<ExtractedBooking[]> {
    if (email.textBody === null || email.textBody.trim() === "") return [];

    const { system, user } = buildExtractionPrompt(email);

    const response = await this.client.messages.create({
      model: MODEL,
      max_tokens: 16000,
      // Adaptive thinking is the only on-mode on this model family, and it is
      // off unless requested. `budget_tokens`, temperature, top_p, and top_k
      // are all removed on 4.7+ and return 400 if sent.
      thinking: { type: "adaptive" },
      output_config: {
        effort: "medium",
        format: { type: "json_schema", schema: EXTRACTED_JSON_SCHEMA },
      },
      system,
      messages: [{ role: "user", content: user }],
    } as Anthropic.MessageCreateParamsNonStreaming);

    // Safety classifiers can decline with HTTP 200 and an empty content
    // array. Reading content[0] unconditionally would throw here.
    if (response.stop_reason === "refusal") {
      throw new Error("Claude declined to process this email.");
    }

    const text = response.content.find((block) => block.type === "text");
    if (!text || text.type !== "text") {
      throw new Error("Claude returned no text content.");
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text.text);
    } catch {
      throw new Error("Claude did not return JSON.");
    }

    // The same funnel as every other extractor. An escalation does not get
    // to widen what can enter the system.
    return validateExtracted((parsed as { bookings?: unknown }).bookings ?? []);
  }
}
```

- [ ] **Step 8: Run the Claude test**

Run: `npm test -- claude-extractor`
Expected: PASS, 7 tests. **No API key is set and no request is made.**

- [ ] **Step 9: Run the whole ingest suite**

Run: `npm test -- ingest/ && npm run typecheck`
Expected: PASS — 8 mime, 8 ics, 6 chain, 2 IcsExtractor, 5 validateExtracted, 10 local, 7 Claude. Typecheck exits 0.

- [ ] **Step 10: Commit**

```bash
git add package.json package-lock.json src/server/ingest tests/server/ingest
git commit -m "feat: add local-first extraction with Claude as a manual escalation"
```

---

### Task 13: The ingest route and the review endpoints

**Files:**
- Create: `src/server/routes/inbound-email.ts`
- Modify: `src/server/index.ts`, `src/server/serve.ts`
- Test: `tests/server/routes/inbound-email.test.ts`

**Interfaces:**
- Consumes: `InboundEmailRepo` (Task 10), `INBOUND_EMAIL_PATH` and the ingest middleware (Task 9), `parseMime` / `runExtractionChain` / `IcsExtractor` / `LocalLlmExtractor` / `ClaudeExtractor` (Tasks 11–12), `BookingRepo`
- Produces:
  - `POST /api/inbound-email` — service token only; raw MIME in, `202` out
  - `GET /api/inbound-email` — the pending queue
  - `GET /api/inbound-email/:id/body` — the original text, logged
  - `POST /api/inbound-email/:id/escalate` — the manual Claude escalation
  - `POST /api/inbound-email/:id/approve` — creates `booking` rows at `status='draft'`
  - `POST /api/inbound-email/:id/discard`
  - `GET /api/inbound-email/address` — the configured forward address, or `null`

**Extraction is injected, not imported, by the route.** `AppDeps` gains an `ingest` object holding `extract` and `escalate` functions. `serve.ts` builds the real ones from environment configuration; tests pass fakes. That is what keeps the whole suite model-free.

**`POST /api/inbound-email` answers `202`, and answers it even when extraction found nothing.** The Worker's only job is to hand over the message; a non-2xx tells it to fall back to forwarding the mail to a real mailbox, which should happen when we could not *store* the message, not when we could not *parse* it. A parse failure is a row a human completes.

- [ ] **Step 1: Write the failing test**

Create `tests/server/routes/inbound-email.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import { randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { createTestDatabase } from "../../../src/server/db/migrate.js";
import { Keyring } from "../../../src/server/crypto/envelope.js";
import { createApp } from "../../../src/server/index.js";
import { AuthError } from "../../../src/server/auth.js";
import type { Identity } from "../../../src/server/auth.js";

const ring = new Keyring("server-v1", { "server-v1": randomBytes(32) });
const owner: Identity = {
  userId: "u1", email: "badger@example.com", householdId: "hh-a", role: "owner",
};
const machine: Identity = {
  userId: "service:worker.access", email: "", householdId: "hh-a", role: "machine",
};

const RAW = [
  "From: reservations@dawnranch.com",
  "Subject: Reservation Confirmed",
  "Content-Type: text/plain",
  "",
  "Confirmation number: D7WN88",
].join("\r\n");

const LODGING = {
  kind: "lodging" as const,
  title: "Dawn Ranch Lodge",
  confirmationNumber: "D7WN88",
  costCents: 61240,
  details: { propertyName: "Dawn Ranch Lodge" },
};

let db: DatabaseSync;
let extract: ReturnType<typeof vi.fn>;
let escalate: ReturnType<typeof vi.fn>;

function build(over: Record<string, unknown> = {}) {
  return createApp({
    db,
    ring,
    verify: async () => owner,
    verifyIngest: async () => machine,
    ingest: { extract, escalate, forwardAddress: null },
    ...over,
  });
}

async function post(app: ReturnType<typeof createApp>, path: string, body: unknown) {
  return app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/**
 * Ingests one message, then reads the queue back.
 *
 * Note which identity each half uses, because it is the whole point of the
 * method scoping: the POST is the MACHINE (verifyIngest), the GET is the
 * HUMAN (verify). An earlier draft of the middleware was method-blind, so the
 * GET also resolved as the machine — which made these tests pass while the
 * real Import page 401'd in a browser, and while a stolen service token could
 * read the queue. If a change makes the GET below start resolving as the
 * machine again, that is the bug, not the test.
 */
async function ingestOne(app: ReturnType<typeof createApp>) {
  await app.request("/api/inbound-email", {
    method: "POST",
    headers: { "content-type": "text/plain" },
    body: RAW,
  });
  const queue = (await (await app.request("/api/inbound-email")).json()) as { id: string }[];
  return queue[0]!.id;
}

beforeEach(() => {
  db = createTestDatabase();
  db.prepare("INSERT INTO household (id, name, created_at) VALUES (?, ?, ?)").run(
    "hh-a", "Badger", new Date().toISOString(),
  );
  extract = vi.fn(async () => ({
    source: "local" as const, confidence: "low" as const, bookings: [LODGING], error: null,
  }));
  escalate = vi.fn(async () => [LODGING]);
});

describe("POST /api/inbound-email", () => {
  it("accepts raw MIME and queues a pending row", async () => {
    const app = build();
    const res = await app.request("/api/inbound-email", {
      method: "POST", headers: { "content-type": "text/plain" }, body: RAW,
    });
    expect(res.status).toBe(202);
    const queue = (await (await app.request("/api/inbound-email")).json()) as {
      subject: string; source: string; extracted: unknown[];
    }[];
    expect(queue).toHaveLength(1);
    expect(queue[0]?.subject).toBe("Reservation Confirmed");
    expect(queue[0]?.source).toBe("local");
    expect(queue[0]?.extracted).toHaveLength(1);
  });

  it("still answers 202 and still queues when extraction found nothing", async () => {
    // Fail soft. A 5xx here tells the Worker to bounce the mail to a real
    // mailbox, which is the right response to "we could not STORE it", not
    // to "we could not PARSE it".
    extract = vi.fn(async () => ({
      source: "none" as const,
      confidence: "low" as const,
      bookings: [],
      error: "The local extraction service could not be reached.",
    }));
    const app = build();
    const res = await app.request("/api/inbound-email", {
      method: "POST", headers: { "content-type": "text/plain" }, body: RAW,
    });
    expect(res.status).toBe(202);
    const queue = (await (await app.request("/api/inbound-email")).json()) as {
      error: string; extracted: unknown;
    }[];
    expect(queue).toHaveLength(1);
    expect(queue[0]?.extracted).toBe(null);
    expect(queue[0]?.error).toMatch(/could not be reached/);
  });

  it("still queues when the extractor itself throws", async () => {
    // The chain is supposed to absorb this, but the route must not depend on
    // that: an email is never lost because a parser was written badly.
    extract = vi.fn(async () => {
      throw new Error("boom");
    });
    const app = build();
    expect(
      (await app.request("/api/inbound-email", {
        method: "POST", headers: { "content-type": "text/plain" }, body: RAW,
      })).status,
    ).toBe(202);
    expect((await (await app.request("/api/inbound-email")).json()).length).toBe(1);
  });

  it("rejects an empty body", async () => {
    const app = build();
    const res = await app.request("/api/inbound-email", {
      method: "POST", headers: { "content-type": "text/plain" }, body: "",
    });
    expect(res.status).toBe(400);
  });

  it("rejects a body over the size cap", async () => {
    const app = build();
    const res = await app.request("/api/inbound-email", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "x".repeat(2_000_001),
    });
    expect(res.status).toBe(413);
  });

  it("is not reachable with a human credential", async () => {
    const app = createApp({
      db, ring,
      verify: async () => owner,
      verifyIngest: async () => {
        throw new AuthError("service token required");
      },
      ingest: { extract, escalate, forwardAddress: null },
    });
    const res = await app.request("/api/inbound-email", {
      method: "POST", headers: { "content-type": "text/plain" }, body: RAW,
    });
    expect(res.status).toBe(401);
  });
});

describe("the review endpoints", () => {
  it("reveals the original body to a human", async () => {
    const app = build();
    const id = await ingestOne(app);
    const body = (await (await app.request(`/api/inbound-email/${id}/body`)).json()) as {
      value: string;
    };
    expect(body.value).toContain("D7WN88");
  });

  it("escalates to Claude only when asked, and replaces the extraction", async () => {
    const app = build();
    const id = await ingestOne(app);
    expect(escalate).not.toHaveBeenCalled();
    const res = await post(app, `/api/inbound-email/${id}/escalate`, {});
    expect(res.status).toBe(200);
    expect(escalate).toHaveBeenCalledTimes(1);
    expect((await res.json()).source).toBe("claude");
  });

  it("reports an escalation failure without destroying the existing row", async () => {
    escalate = vi.fn(async () => {
      throw new Error("401 authentication_error");
    });
    const app = build();
    const id = await ingestOne(app);
    expect((await post(app, `/api/inbound-email/${id}/escalate`, {})).status).toBe(502);
    const queue = (await (await app.request("/api/inbound-email")).json()) as { id: string }[];
    expect(queue.map((r) => r.id)).toContain(id);
  });

  it("creates draft bookings on approval and clears the row", async () => {
    const app = build();
    const trip = (await (await post(app, "/api/trips", { title: "Guerneville" })).json()) as {
      id: string;
    };
    const person = (await (await post(app, "/api/people", { displayName: "Ava" })).json()) as {
      id: string;
    };
    const id = await ingestOne(app);

    const res = await post(app, `/api/inbound-email/${id}/approve`, {
      tripId: trip.id,
      personIds: [person.id],
      bookings: [LODGING],
    });
    expect(res.status).toBe(201);

    const bookings = (await (await app.request(`/api/trips/${trip.id}/bookings`)).json()) as {
      status: string; title: string; personIds: string[]; confirmationNumberMasked: string;
    }[];
    expect(bookings).toHaveLength(1);
    // Draft, not planned: approval means "this is real enough to sit in the
    // trip", not "this is booked". Book -> promotes it from the Overview tab.
    expect(bookings[0]?.status).toBe("draft");
    expect(bookings[0]?.personIds).toEqual([person.id]);
    // And the confirmation number went through the same encryption as any
    // hand-entered one.
    expect(bookings[0]?.confirmationNumberMasked).toBe("••••WN88");

    expect(await (await app.request("/api/inbound-email")).json()).toEqual([]);
  });

  it("answers 404 for an approval naming an unknown trip, and leaves the row pending", async () => {
    const app = build();
    const id = await ingestOne(app);
    expect(
      (await post(app, `/api/inbound-email/${id}/approve`, {
        tripId: "t-nope", personIds: [], bookings: [LODGING],
      })).status,
    ).toBe(404);
    expect((await (await app.request("/api/inbound-email")).json()).length).toBe(1);
  });

  it("answers 400 for an approval whose bookings fail the per-kind schema", async () => {
    const app = build();
    const trip = (await (await post(app, "/api/trips", { title: "G" })).json()) as { id: string };
    const id = await ingestOne(app);
    expect(
      (await post(app, `/api/inbound-email/${id}/approve`, {
        tripId: trip.id, personIds: [], bookings: [{ kind: "flight", title: "DL2214", details: {} }],
      })).status,
    ).toBe(400);
  });

  it("answers 404 for discarding an unknown row", async () => {
    // Every sibling endpoint has this case; without it a stale link 204s and
    // the UI removes a card that was never resolved server-side.
    const app = build();
    expect((await post(app, "/api/inbound-email/ie-nope/discard", {})).status).toBe(404);
  });

  it("answers 403 for a viewer discarding", async () => {
    const app = build();
    const id = await ingestOne(app);
    const viewerApp = createApp({
      db, ring,
      verify: async () => ({ ...owner, role: "viewer" as const }),
      verifyIngest: async () => machine,
      ingest: { extract, escalate, forwardAddress: null },
    });
    expect((await post(viewerApp, `/api/inbound-email/${id}/discard`, {})).status).toBe(403);
  });

  it("serves the configured forward address to a human", async () => {
    const app = createApp({
      db, ring,
      verify: async () => owner,
      verifyIngest: async () => machine,
      ingest: { extract, escalate, forwardAddress: "trips@configured.example" },
    });
    const body = (await (await app.request("/api/inbound-email/address")).json()) as {
      address: string | null;
    };
    expect(body.address).toBe("trips@configured.example");
  });

  it("serves a null address when none is configured", async () => {
    // The Cloudflare zone is still an open question. An honest null is what
    // lets the UI say "not configured yet" instead of guessing.
    const app = build();
    const body = (await (await app.request("/api/inbound-email/address")).json()) as {
      address: string | null;
    };
    expect(body.address).toBe(null);
  });

  it("discards a row without writing a booking", async () => {
    const app = build();
    const trip = (await (await post(app, "/api/trips", { title: "G" })).json()) as { id: string };
    const id = await ingestOne(app);
    expect((await post(app, `/api/inbound-email/${id}/discard`, {})).status).toBe(204);
    expect(await (await app.request("/api/inbound-email")).json()).toEqual([]);
    expect(await (await app.request(`/api/trips/${trip.id}/bookings`)).json()).toEqual([]);
  });

  it("answers 403 for a viewer approving", async () => {
    const app = build();
    const id = await ingestOne(app);
    const viewerApp = createApp({
      db, ring,
      verify: async () => ({ ...owner, role: "viewer" as const }),
      verifyIngest: async () => machine,
      ingest: { extract, escalate, forwardAddress: null },
    });
    expect(
      (await post(viewerApp, `/api/inbound-email/${id}/approve`, {
        tripId: "t1", personIds: [], bookings: [LODGING],
      })).status,
    ).toBe(403);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -- routes/inbound-email`
Expected: FAIL — no `/api/inbound-email` route is registered.

- [ ] **Step 3: Write the route file**

Create `src/server/routes/inbound-email.ts`:

```ts
import { Hono } from "hono";
import { z } from "zod";
import { InboundEmailRepo } from "../repos/inbound-email.js";
import { BookingRepo } from "../repos/booking.js";
import { parseMime } from "../ingest/mime.js";
import type { AppEnv } from "../index.js";

/** Email Routing caps a message well below this; the cap is a floor for sanity. */
const MAX_BODY_BYTES = 2_000_000;

/**
 * Rejects an oversized message from the `Content-Length` header, BEFORE
 * `c.req.text()` buffers the whole thing into memory. A cap checked only
 * after buffering has already paid the cost it exists to avoid.
 *
 * Returns false when the header is absent or unparseable -- a chunked request
 * has no length to check -- in which case the post-read byte check below is
 * the backstop.
 */
function declaredTooLarge(header: string | undefined): boolean {
  if (header === undefined) return false;
  const declared = Number(header);
  return Number.isFinite(declared) && declared > MAX_BODY_BYTES;
}

const approveSchema = z.object({
  tripId: z.string().min(1),
  personIds: z.array(z.string().min(1)).default([]),
  bookings: z.array(z.record(z.string(), z.unknown())).min(1),
});

export const inboundEmail = new Hono<AppEnv>();

/**
 * The ingest endpoint. Reached only by the Access service token; the human
 * middleware skips this METHOD on this path, and nothing else (see index.ts).
 * Every other route in this file — the queue, the body reveal, escalate,
 * approve, discard, the address — is a human endpoint on the human
 * middleware.
 *
 * Answers 202 whenever the message was STORED, including when nothing could
 * be parsed out of it. A non-2xx is the Worker's signal to fall back to
 * forwarding the mail to a real mailbox, which is right for "we could not
 * keep this" and wrong for "we could not read this" — the second is a row a
 * human completes in the UI.
 */
inboundEmail.post("/", async (c) => {
  // Cheap check first, from the header, so a 20MB body is refused without
  // being buffered.
  if (declaredTooLarge(c.req.header("content-length"))) {
    return c.json({ error: "Message too large" }, 413);
  }

  const raw = await c.req.text();
  if (raw.trim() === "") return c.json({ error: "Empty message" }, 400);
  // Byte length, not `raw.length`. `String.length` counts UTF-16 code units,
  // so a message full of non-ASCII (an accented hotel name, a CJK itinerary,
  // an emoji in a subject line) is measured smaller than it is, and one full
  // of astral-plane characters larger. The cap is in BYTES and must be
  // measured in bytes. This is also the backstop for a chunked request that
  // declared no Content-Length above.
  if (Buffer.byteLength(raw, "utf8") > MAX_BODY_BYTES) {
    return c.json({ error: "Message too large" }, 413);
  }

  const email = parseMime(raw);

  // The chain is already fail-soft; this catch means a badly written
  // extractor cannot lose an email either.
  let result;
  try {
    result = await c.get("ingest").extract(email);
  } catch (err) {
    console.error("[ingest] extraction chain threw", err);
    result = {
      source: "none" as const,
      confidence: "low" as const,
      bookings: [],
      error: "Extraction failed unexpectedly. Complete this by hand, or escalate it.",
    };
  }

  new InboundEmailRepo(c.get("db"), c.get("identity"), c.get("ring")).create({
    receivedAt: new Date().toISOString(),
    fromAddress: email.from,
    subject: email.subject,
    bodyText: email.textBody,
    source: result.source,
    confidence: result.confidence,
    extracted: result.bookings.length > 0 ? result.bookings : null,
    error: result.error,
  });

  return c.body(null, 202);
});

inboundEmail.get("/", (c) =>
  c.json(new InboundEmailRepo(c.get("db"), c.get("identity"), c.get("ring")).list()),
);

inboundEmail.get("/:id/body", (c) => {
  const identity = c.get("identity");
  const repo = new InboundEmailRepo(c.get("db"), identity, c.get("ring"));
  // ForbiddenError (viewer or machine) and NotFoundError both reach
  // app.onError before the log line runs — a denied read is not a read.
  const value = repo.revealBody(c.req.param("id"));

  console.info(
    JSON.stringify({
      event: "inbound_body_reveal",
      at: new Date().toISOString(),
      user: identity.email,
      household: identity.householdId,
      inboundEmail: c.req.param("id"),
    }),
  );

  return c.json({ value });
});

/**
 * The manual Claude escalation. Nothing calls this automatically; a human
 * presses a button in the review UI after seeing that local extraction came
 * back empty. See the local-first reasoning in the plan header.
 */
inboundEmail.post("/:id/escalate", async (c) => {
  const identity = c.get("identity");
  const repo = new InboundEmailRepo(c.get("db"), identity, c.get("ring"));
  const id = c.req.param("id");

  const row = repo.findById(id);
  if (!row) return c.json({ error: "Not found" }, 404);

  // revealBody is role-guarded, so a viewer pressing escalate is refused
  // here by ForbiddenError before any external call is made.
  const body = repo.revealBody(id);

  // The log line is written AFTER the call, and carries the outcome. Logging
  // "escalated to Claude" before the request is made records a success for
  // every failure too -- a 401 from Anthropic, a network error, a refusal --
  // which makes this log actively misleading about where data went. That
  // matters more here than almost anywhere else in the app: this is the audit
  // record of the one moment a confirmation email leaves the household's
  // hardware, and "did this message go to a hosted API" is exactly the
  // question it will be asked.
  const logEscalation = (outcome: "succeeded" | "failed", detail?: string): void => {
    console.info(
      JSON.stringify({
        event: "inbound_escalated_to_claude",
        outcome,
        ...(detail === undefined ? {} : { detail }),
        at: new Date().toISOString(),
        user: identity.email,
        household: identity.householdId,
        inboundEmail: id,
      }),
    );
  };

  let bookings;
  try {
    bookings = await c.get("ingest").escalate({
      from: row.fromAddress,
      subject: row.subject,
      textBody: body,
      calendars: [],
    });
  } catch (err) {
    // 502, not 500: the failure is an upstream service, and the existing row
    // is untouched so the operator can retry or complete it by hand.
    const detail = err instanceof Error ? err.message : String(err);
    logEscalation("failed", detail);
    console.error("[ingest] escalation failed", err);
    return c.json({ error: `Escalation failed: ${detail}` }, 502);
  }

  logEscalation("succeeded");

  return c.json(
    repo.setExtraction(id, {
      source: "claude",
      confidence: "low",
      extracted: bookings.length > 0 ? bookings : null,
      error: bookings.length > 0 ? null : "Claude found nothing in this email either.",
    }),
  );
});

/**
 * Approval: the only path from a parsed email to a `booking` row.
 *
 * Bookings are created at `status: 'draft'` — approval means "this is real
 * enough to sit in the trip", not "this is booked". The Overview tab renders
 * them with a Draft tag and `Book →` promotes them.
 *
 * The row is resolved LAST, so a rejected booking (unknown trip, per-kind
 * schema failure) leaves the email in the queue rather than clearing it and
 * losing the work.
 */
inboundEmail.post("/:id/approve", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const parsed = approveSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Invalid approval", details: parsed.error.issues }, 400);
  }

  const db = c.get("db");
  const identity = c.get("identity");
  const ring = c.get("ring");
  const inbox = new InboundEmailRepo(db, identity, ring);
  const id = c.req.param("id");

  if (!inbox.findById(id)) return c.json({ error: "Not found" }, 404);

  const bookingRepo = new BookingRepo(db, identity, ring);
  const created: unknown[] = [];
  for (const booking of parsed.data.bookings) {
    // Unknown trip -> NotFoundError (404); bad per-kind details -> ZodError
    // (400). Both reach app.onError, and neither has resolved the row yet.
    const saved = bookingRepo.create({
      ...(booking as Record<string, unknown>),
      tripId: parsed.data.tripId,
      status: "draft",
    } as Parameters<BookingRepo["create"]>[0]);
    for (const personId of parsed.data.personIds) {
      bookingRepo.assignPerson(saved.id, personId);
    }
    created.push(saved);
  }

  inbox.resolve(id, "approved");
  return c.json(created, 201);
});

inboundEmail.post("/:id/discard", (c) => {
  // NotFoundError (404) for an unknown or cross-household id, ForbiddenError
  // (403) for a viewer -- both raised by resolve() and both handled by
  // app.onError, exactly as approve/escalate/body are.
  new InboundEmailRepo(c.get("db"), c.get("identity"), c.get("ring")).resolve(
    c.req.param("id"),
    "discarded",
  );
  return c.body(null, 204);
});

/**
 * The forward address, served rather than baked in.
 *
 * This is a HUMAN endpoint on a sub-path, so it goes through the human
 * middleware like every other route in this file; only `POST /` belongs to
 * the service token. It sits under /api so an unauthenticated caller gets the
 * same 401 here as anywhere else and cannot use it to probe the deployment.
 *
 * Registered BEFORE `/:id/body` would be a concern if the paths could
 * collide; they cannot -- `/address` is a single segment and `/:id/body` is
 * two -- but keeping it here, next to the other reads, is clearer than
 * scattering it.
 */
inboundEmail.get("/address", (c) => c.json({ address: c.get("ingest").forwardAddress }));
```

**Why an endpoint rather than a build-time variable.** The forward address is *deployment* configuration, not build configuration: it is decided when the Cloudflare zone is decided, it is set on the host by the systemd unit alongside `CF_ACCESS_INBOUND_AUD` and `TRAVEL_HQ_INBOUND_HOUSEHOLD_ID`, and it can change without the application changing. A Vite variable is the opposite of all three — it is frozen into the bundle at `npm run build`, so a value the server learns at boot is invisible to it, and changing the address would mean a rebuild and redeploy of the frontend to alter one string. An earlier draft of this plan had the preamble naming `TRAVEL_HQ_INBOUND_ADDRESS`, the Import page reading `import.meta.env.VITE_INBOUND_ADDRESS`, and Task 15 setting `TRAVEL_HQ_INBOUND_ADDRESS` on the host, with nothing bridging them — so the deployed UI would have said "not configured yet" permanently, and the test asserting it renders the configured address would have passed the whole time, because it injects the prop directly. **One mechanism, `TRAVEL_HQ_INBOUND_ADDRESS`, read by the server and served from here. There is no `VITE_INBOUND_ADDRESS`.**

- [ ] **Step 4: Wire it into createApp**

In `src/server/index.ts`:

Add the types and imports:

```ts
import { inboundEmail } from "./routes/inbound-email.js";
import type { ParsedEmail } from "./ingest/mime.js";
import type { ExtractionResult } from "./ingest/extractor.js";
import type { ExtractedBooking } from "./ingest/extracted.js";

export type IngestDeps = {
  /** The fail-soft chain: .ics, then the local model. Never Claude. */
  extract: (email: ParsedEmail) => Promise<ExtractionResult>;
  /** The manual escalation. Only the escalate route calls this. */
  escalate: (email: ParsedEmail) => Promise<ExtractedBooking[]>;
  /**
   * The address the UI tells people to forward confirmations to, from
   * TRAVEL_HQ_INBOUND_ADDRESS. `null` when unset, which the Import page
   * renders as an honest "not configured yet" rather than a guessed zone.
   *
   * It lives on IngestDeps rather than on AppDeps deliberately: AppDeps
   * gains exactly two required fields across all of Part B (`verifyIngest`
   * in Task 9, `ingest` here), and every one of those is a call-site fix in
   * ten places. Deployment config for this feature belongs with the rest of
   * this feature's config.
   */
  forwardAddress: string | null;
};
```

Add `ingest: IngestDeps` to `AppDeps`, and `ingest: IngestDeps` to `AppEnv["Variables"]`.

Set it in **both** middlewares, beside `db` and `ring`:

```ts
    c.set("ingest", deps.ingest);
```

And mount the router:

```ts
  app.route(INBOUND_EMAIL_PATH, inboundEmail);
```

- [ ] **Step 5: Build the real extractors in serve.ts**

In `src/server/serve.ts`, add:

```ts
/**
 * The default chain: .ics first, then the LOCAL model. Claude is NOT here —
 * it is reached only through the escalate route, which a human triggers.
 * See the local-first reasoning in plan 4 Part B.
 */
export function resolveIngest(env: NodeJS.ProcessEnv): IngestDeps {
  const local = new LocalLlmExtractor({
    baseUrl: env.TRAVEL_HQ_EXTRACT_BASE_URL ?? "http://127.0.0.1:11434/v1",
    model: env.TRAVEL_HQ_EXTRACT_MODEL ?? "qwen2.5:7b-instruct",
    timeoutMs: Number(env.TRAVEL_HQ_EXTRACT_TIMEOUT_MS ?? 45_000),
    ...(env.TRAVEL_HQ_EXTRACT_API_KEY ? { apiKey: env.TRAVEL_HQ_EXTRACT_API_KEY } : {}),
  });

  return {
    // Deployment configuration, read at boot and served from
    // GET /api/inbound-email/address. Deliberately NOT a Vite build-time
    // variable: the address is decided with the Cloudflare zone and set by
    // the systemd unit, and a value baked into the bundle at `npm run build`
    // cannot see it.
    forwardAddress: env.TRAVEL_HQ_INBOUND_ADDRESS ?? null,
    extract: (email) => runExtractionChain([new IcsExtractor(), local], email),
    escalate: async (email) => {
      if (!env.ANTHROPIC_API_KEY) {
        throw new Error(
          "Escalation is not configured: set ANTHROPIC_API_KEY to enable it. " +
            "Local extraction and .ics parsing work without it.",
        );
      }
      return new ClaudeExtractor({ apiKey: env.ANTHROPIC_API_KEY }).extract(email);
    },
  };
}
```

with the matching imports, and pass `ingest: resolveIngest(process.env)` in the `isMain` block's `createApp` call.

Escalation being unconfigured is an ordinary, expected state: the primary path needs no key at all, and the button reports the message above rather than the app refusing to start.

- [ ] **Step 6: Run the tests**

Run: `npm test -- routes/inbound-email`
Expected: PASS, 18 tests — 6 for the ingest endpoint, 12 for the review endpoints (including the two address cases and the discard 404/403 pair). **No model server and no API key are involved.**

- [ ] **Step 7: Fix the remaining createApp callers and run everything**

`AppDeps` gained a second required field, `ingest`. Add a fake to each existing `createApp` call in `tests/server/`:

```ts
  ingest: {
    extract: async () => ({ source: "none" as const, confidence: "low" as const, bookings: [], error: null }),
    escalate: async () => [],
    forwardAddress: null,
  },
```

**The same ten sites as Task 9 Step 9**, plus the ones Task 9 itself added: `tests/server/routes/api.test.ts` (5), `tests/server/routes/people-update.test.ts` (2), `tests/server/routes/booking-status.test.ts` (3), and `tests/server/auth-service-token.test.ts` (4 — two in the blast-radius block, one helper in the method-scoping block). Plus `src/server/serve.ts`'s own `createApp` call in the `isMain` block. `npm run typecheck` lists them all at once; work the list rather than iterating.

Run: `npm test && npm run typecheck`
Expected: all PASS, typecheck exits 0.

- [ ] **Step 8: Commit**

```bash
git add src/server/routes/inbound-email.ts src/server/index.ts src/server/serve.ts tests/server
git commit -m "feat: add the inbound email ingest route and the review endpoints"
```

---

### Task 14: The draft-approval queue

**Files:**
- Modify: `src/client/api/types.ts`, `src/client/api/client.ts`
- Create: `src/client/import/DraftCard.tsx`
- Replace: `src/client/pages/Import.tsx`
- Test: `tests/client/import/DraftCard.test.tsx`, `tests/client/pages/Import.test.tsx`

**Interfaces:**
- Consumes: `Dialog`-free layout, `TravelerToggles` (Part A Task 6), `MaskedValue`, `errorMessage`
- Produces:
  - `api.inbound.list()`, `api.inbound.body(id)`, `api.inbound.escalate(id)`, `api.inbound.approve(id, input)`, `api.inbound.discard(id)`
  - `DraftCard({ email, trips, people, api, onResolved })`
  - `Import()` — the queue

**Scope, disclosed.** The Import prototype has three method chips: **Paste email**, **Forward to inbox**, and **Upload .eml / PDF**. This task ships **the queue** (which is what the prototype's right-hand column — the draft review card — actually is) and **Forward** (the address card). **Paste and Upload are deferred**, because each needs a second, human-authenticated parse endpoint that this plan does not build: `POST /api/inbound-email` accepts a service token only, deliberately, and widening it to accept a human credential would undo Task 9. Forwarding is the delivery path the spec specifies; paste and upload are conveniences on top of it. Recorded under "Not in this plan".

**The draft card follows the prototype**: icon + title + a `Draft` / `Low confidence` tag, a 2×2 uppercase-labelled field grid, a confidence note (amber `#d9b98a` for low), a fading rule, "Who's on it — tap to toggle" traveller chips, an "Attach to trip" control, and Discard / "Add to trip" buttons. Two additions the prototype could not have: an **Escalate to Claude** control, present only when local extraction produced nothing; and a **Show original email** control, because a reviewer completing a draft by hand needs the text.

**Every field in the card is editable before approval.** A low-confidence extraction whose fields cannot be corrected is a draft the operator has to discard and retype — which is worse than no import at all.

- [ ] **Step 1: Extend the API client**

In `src/client/api/types.ts`, append:

```ts
export type { InboundEmail, InboundSource } from "../../server/repos/inbound-email.js";
export type { ExtractedBooking } from "../../server/ingest/extracted.js";
```

In `src/client/api/client.ts`, add the types to the import and a new `inbound` object alongside `bookings`:

```ts
    inbound: {
      list: () => request<InboundEmail[]>("/api/inbound-email"),
      // Deployment config, fetched rather than baked in at build time. See
      // Task 13 for why there is no VITE_INBOUND_ADDRESS.
      address: () => request<{ address: string | null }>("/api/inbound-email/address"),
      body: (id: string) => request<{ value: string | null }>(`/api/inbound-email/${seg(id)}/body`),
      escalate: (id: string) =>
        request<InboundEmail>(`/api/inbound-email/${seg(id)}/escalate`, jsonBody("POST", {})),
      approve: (
        id: string,
        input: { tripId: string; personIds: string[]; bookings: ExtractedBooking[] },
      ) => request<unknown[]>(`/api/inbound-email/${seg(id)}/approve`, jsonBody("POST", input)),
      discard: (id: string) =>
        request<void>(`/api/inbound-email/${seg(id)}/discard`, jsonBody("POST", {})),
    },
```

- [ ] **Step 2: Write the failing DraftCard test**

Create `tests/client/import/DraftCard.test.tsx`:

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DraftCard } from "../../../src/client/import/DraftCard.js";

const TRIPS = [
  { id: "t1", title: "Mary & Winter Wedding", destination: null,
    startsOn: "2026-10-09", endsOn: "2026-10-11", status: "planning" as const, notes: null },
];
const PEOPLE = [{ id: "p1", displayName: "Badger" }];

const BOOKING = {
  kind: "lodging",
  title: "Dawn Ranch Lodge",
  confirmationNumber: "D7WN88",
  costCents: 61240,
  startsAt: "2026-10-09T22:00:00.000Z",
  startsAtTz: "America/Los_Angeles",
  endsAt: null,
  endsAtTz: null,
  location: null,
  details: { propertyName: "Dawn Ranch Lodge" },
};

function email(over: Record<string, unknown> = {}) {
  return {
    id: "ie1",
    receivedAt: "2026-07-21T10:00:00.000Z",
    fromAddress: "reservations@dawnranch.com",
    subject: "Reservation Confirmed",
    source: "local",
    confidence: "low",
    extracted: [BOOKING],
    error: null,
    status: "pending",
    resolvedAt: null,
    ...over,
  };
}

function makeApi() {
  return {
    inbound: {
      body: vi.fn(async () => ({ value: "Confirmation number: D7WN88" })),
      escalate: vi.fn(async () => email({ source: "claude", extracted: [BOOKING] })),
      approve: vi.fn(async () => [{ id: "b1" }]),
      discard: vi.fn(async () => undefined),
    },
  };
}

function renderCard(over: Record<string, unknown> = {}, api = makeApi(), onResolved = vi.fn()) {
  render(
    <DraftCard
      email={email(over) as never}
      trips={TRIPS}
      people={PEOPLE as never}
      api={api as never}
      onResolved={onResolved}
    />,
  );
  return { api, onResolved };
}

describe("DraftCard", () => {
  it("renders the extracted title and confirmation number", () => {
    renderCard();
    expect(screen.getByDisplayValue("Dawn Ranch Lodge")).toBeInTheDocument();
    expect(screen.getByDisplayValue("D7WN88")).toBeInTheDocument();
  });

  it("flags a low-confidence extraction", () => {
    renderCard();
    expect(screen.getByText("Low confidence")).toBeInTheDocument();
    expect(screen.getByText(/check every field/i)).toBeInTheDocument();
  });

  it("does not flag an .ics extraction", () => {
    renderCard({ source: "ics", confidence: "high" });
    expect(screen.queryByText("Low confidence")).not.toBeInTheDocument();
    expect(screen.getByText(/calendar attachment/i)).toBeInTheDocument();
  });

  it("shows why nothing was extracted, and offers an empty draft to fill in", () => {
    renderCard({ extracted: null, error: "The local extraction service could not be reached." });
    expect(screen.getByText(/could not be reached/)).toBeInTheDocument();
    // Still editable: an email nobody could parse is still worth keeping.
    expect(screen.getByLabelText(/Title/)).toHaveValue("");
  });

  it("offers escalation only when local extraction produced nothing", async () => {
    renderCard({ extracted: null, error: "Nothing recognisable was found." });
    expect(screen.getByRole("button", { name: /escalate to claude/i })).toBeInTheDocument();
  });

  it("hides escalation when there is already a usable extraction", () => {
    renderCard();
    expect(screen.queryByRole("button", { name: /escalate to claude/i })).not.toBeInTheDocument();
  });

  it("escalates on request and re-renders with the new extraction", async () => {
    const { api } = renderCard({ extracted: null, error: "Nothing recognisable was found." });
    await userEvent.click(screen.getByRole("button", { name: /escalate to claude/i }));
    expect(api.inbound.escalate).toHaveBeenCalledWith("ie1");
    expect(await screen.findByDisplayValue("Dawn Ranch Lodge")).toBeInTheDocument();
  });

  it("withdraws the escalate control once escalation has succeeded", async () => {
    // `unparsed` must derive from the CURRENT booking/source, not from the
    // immutable `email` prop. Deriving it from the prop leaves this button on
    // screen after a successful escalation, offering to send the message to a
    // hosted model a second time -- for a message that has just been read.
    renderCard({ extracted: null, error: "Nothing recognisable was found." });
    await userEvent.click(screen.getByRole("button", { name: /escalate to claude/i }));
    await screen.findByDisplayValue("Dawn Ranch Lodge");
    expect(screen.queryByRole("button", { name: /escalate to claude/i })).not.toBeInTheDocument();
  });

  it("reports a failed escalation without losing the card", async () => {
    const api = makeApi();
    api.inbound.escalate = vi.fn(async () => {
      throw new Error("502");
    });
    renderCard({ extracted: null, error: "Nothing recognisable." }, api);
    await userEvent.click(screen.getByRole("button", { name: /escalate to claude/i }));
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.getByLabelText(/Title/)).toBeInTheDocument();
  });

  it("fetches and shows the original email on request", async () => {
    const { api } = renderCard();
    await userEvent.click(screen.getByRole("button", { name: /show original/i }));
    expect(api.inbound.body).toHaveBeenCalledWith("ie1");
    expect(await screen.findByText(/Confirmation number: D7WN88/)).toBeInTheDocument();
  });

  it("refuses to approve without a trip", async () => {
    const { api } = renderCard();
    await userEvent.click(screen.getByRole("button", { name: /add to trip/i }));
    expect(api.inbound.approve).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent(/trip/i);
  });

  it("approves with the edited values, the chosen trip, and the toggled people", async () => {
    const { api, onResolved } = renderCard();
    const title = screen.getByLabelText(/Title/);
    await userEvent.clear(title);
    await userEvent.type(title, "Dawn Ranch Lodge — cabin 12");
    await userEvent.selectOptions(screen.getByLabelText(/Attach to trip/), "t1");
    await userEvent.click(screen.getByRole("button", { name: /Badger/ }));
    await userEvent.click(screen.getByRole("button", { name: /add to trip/i }));

    expect(api.inbound.approve).toHaveBeenCalledWith("ie1", {
      tripId: "t1",
      personIds: ["p1"],
      bookings: [expect.objectContaining({ title: "Dawn Ranch Lodge — cabin 12" })],
    });
    expect(onResolved).toHaveBeenCalledWith("ie1");
  });

  it("keeps the card when approval is rejected", async () => {
    const api = makeApi();
    api.inbound.approve = vi.fn(async () => {
      throw new Error("400");
    });
    const { onResolved } = renderCard({}, api);
    await userEvent.selectOptions(screen.getByLabelText(/Attach to trip/), "t1");
    await userEvent.click(screen.getByRole("button", { name: /add to trip/i }));
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(onResolved).not.toHaveBeenCalled();
  });

  it("discards on request", async () => {
    const { api, onResolved } = renderCard();
    await userEvent.click(screen.getByRole("button", { name: /discard/i }));
    expect(api.inbound.discard).toHaveBeenCalledWith("ie1");
    expect(onResolved).toHaveBeenCalledWith("ie1");
  });
});
```

- [ ] **Step 3: Write DraftCard**

Create `src/client/import/DraftCard.tsx`:

```tsx
import { useState } from "react";
import { AirplaneTakeoff, Bed, Car, Check, MagicWand, Question, Ticket } from "@phosphor-icons/react";
import { api as defaultApi } from "../api/client.js";
import type { ExtractedBooking, InboundEmail, Person, Trip } from "../api/types.js";
import { errorMessage } from "../lib/errors.js";
import { TravelerToggles } from "../components/TravelerToggles.js";

const ICONS: Record<string, typeof AirplaneTakeoff> = {
  flight: AirplaneTakeoff,
  lodging: Bed,
  car: Car,
  activity: Ticket,
};

const KINDS = ["flight", "lodging", "car", "activity", "other"] as const;

/** The prototype's per-kind field labels. */
function endpointLabels(kind: string): [string, string] {
  if (kind === "lodging") return ["Check-in", "Check-out"];
  if (kind === "car") return ["Pickup", "Drop-off"];
  if (kind === "flight") return ["Departs", "Arrives"];
  return ["Starts", "Ends"];
}

const EMPTY: ExtractedBooking = {
  kind: "other",
  title: "",
  location: null,
  startsAt: null,
  startsAtTz: null,
  endsAt: null,
  endsAtTz: null,
  confirmationNumber: null,
  costCents: null,
  details: {},
};

/**
 * One parsed email, reviewable and editable before anything is written.
 *
 * Every field is editable on purpose: a low-confidence extraction the
 * operator cannot correct is a draft they have to discard and retype, which
 * is worse than no import at all. Approving calls the one endpoint that
 * turns an email into `booking` rows, and those land at `status: 'draft'`.
 */
export function DraftCard({
  email,
  trips,
  people,
  api = defaultApi,
  onResolved,
}: {
  email: InboundEmail;
  trips: Trip[];
  people: Person[];
  api?: typeof defaultApi;
  onResolved: (id: string) => void;
}) {
  const initial = (email.extracted?.[0] as ExtractedBooking | undefined) ?? EMPTY;
  const [booking, setBooking] = useState<ExtractedBooking>(initial);
  const [source, setSource] = useState(email.source);
  const [note, setNote] = useState(email.error);
  const [tripId, setTripId] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [original, setOriginal] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const low = email.confidence === "low";
  /**
   * Derived from the CURRENT booking and source, not from the `email` prop.
   *
   * `email` is the row as it arrived and never changes; `booking`/`source`
   * are what escalation replaces. Reading `email.extracted` here would leave
   * "Escalate to Claude" on screen after a successful escalation had already
   * filled the card in — offering to send the message to a hosted model a
   * second time, for a message that has just been read. Escalation is a
   * per-message custody decision, so offering it when it has already been
   * made and answered is exactly the wrong affordance.
   */
  const unparsed = source === "none" || booking.title.trim() === "";
  const Icon = ICONS[booking.kind] ?? Question;

  function set<K extends keyof ExtractedBooking>(key: K, value: ExtractedBooking[K]) {
    setBooking((b) => ({ ...b, [key]: value }));
  }

  async function run(work: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const [startLabel, endLabel] = endpointLabels(booking.kind);

  return (
    <div
      className="card"
      style={{
        border: `1px solid ${low ? "#8a6d3b" : "var(--color-accent-800)"}`,
        gap: 12,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <Icon size={20} style={{ color: "var(--color-accent)" }} />
        <span style={{ fontSize: 15, fontWeight: 500 }}>
          {booking.title || email.subject || "Unrecognised booking"}
        </span>
        <span className={low ? "tag tag-neutral" : "tag tag-accent"} style={{ marginLeft: "auto" }}>
          {low ? "Low confidence" : "Draft"}
        </span>
      </div>

      <p
        className={low ? "warning" : "text-muted"}
        style={{ margin: 0, fontSize: 11.5 }}
      >
        {note
          ? note
          : source === "ics"
            ? "Read from the calendar attachment — times and zones came from the airline."
            : source === "claude"
              ? "Read by Claude after escalation — check every field before saving."
              : "Read by the local model — check every field before saving."}
      </p>

      {error && (
        <p className="warning" role="alert" style={{ margin: 0 }}>
          {error}
        </p>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px 18px" }}>
        <div className="field">
          <label htmlFor={`d-${email.id}-title`}>Title</label>
          <input
            id={`d-${email.id}-title`}
            className="input"
            value={booking.title}
            onChange={(e) => set("title", e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor={`d-${email.id}-kind`}>Kind</label>
          <select
            id={`d-${email.id}-kind`}
            className="input"
            value={booking.kind}
            // A real narrowing cast now that BOOKING_KINDS is a literal tuple
            // (Task 11 Step 8). Before that fix `ExtractedBooking["kind"]` was
            // just `string` and this cast asserted nothing at all.
            onChange={(e) => set("kind", e.target.value as ExtractedBooking["kind"])}
          >
            {KINDS.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor={`d-${email.id}-start`}>{startLabel}</label>
          <input
            id={`d-${email.id}-start`}
            className="input"
            readOnly
            value={
              booking.startsAt
                ? `${booking.startsAt} · ${booking.startsAtTz ?? "?"}`
                : "not detected"
            }
          />
        </div>
        <div className="field">
          <label htmlFor={`d-${email.id}-end`}>{endLabel}</label>
          <input
            id={`d-${email.id}-end`}
            className="input"
            readOnly
            value={booking.endsAt ? `${booking.endsAt} · ${booking.endsAtTz ?? "?"}` : "not detected"}
          />
        </div>
        <div className="field">
          <label htmlFor={`d-${email.id}-conf`}>
            Confirmation <span className="text-muted">· stored masked</span>
          </label>
          <input
            id={`d-${email.id}-conf`}
            className="input"
            autoComplete="off"
            value={booking.confirmationNumber ?? ""}
            onChange={(e) => set("confirmationNumber", e.target.value || null)}
          />
        </div>
        <div className="field">
          <label htmlFor={`d-${email.id}-cost`}>Cost</label>
          <input
            id={`d-${email.id}-cost`}
            className="input"
            inputMode="decimal"
            value={booking.costCents === null || booking.costCents === undefined ? "" : String(booking.costCents / 100)}
            onChange={(e) => {
              const value = Number(e.target.value.replace(/[$,]/g, ""));
              set("costCents", e.target.value.trim() === "" || !Number.isFinite(value) ? null : Math.round(value * 100));
            }}
          />
        </div>
      </div>

      <hr className="hr" />

      <div>
        <h6 className="card-kicker">Who's on it — tap to toggle</h6>
        <TravelerToggles
          people={people}
          selected={selected}
          onToggle={(id) =>
            setSelected((prev) => (prev.includes(id) ? prev.filter((p) => p !== id) : [...prev, id]))
          }
        />
      </div>

      <div className="field">
        <label htmlFor={`d-${email.id}-trip`}>Attach to trip</label>
        <select
          id={`d-${email.id}-trip`}
          className="input"
          value={tripId}
          onChange={(e) => setTripId(e.target.value)}
        >
          <option value="">Pick a trip…</option>
          {trips.map((t) => (
            <option key={t.id} value={t.id}>
              {t.title}
            </option>
          ))}
        </select>
      </div>

      {original !== null && (
        <pre
          className="input"
          style={{ whiteSpace: "pre-wrap", fontSize: 11.5, maxHeight: 220, overflow: "auto" }}
        >
          {original}
        </pre>
      )}

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button
          type="button"
          className="btn btn-ghost"
          style={{ fontSize: 12 }}
          disabled={busy}
          onClick={() =>
            void run(async () => {
              const body = await api.inbound.body(email.id);
              setOriginal(body.value ?? "(this message had no text part)");
            })
          }
        >
          Show original email
        </button>

        {/*
          Escalation is offered ONLY when local extraction produced nothing.
          It sends this email's text to a hosted model, which is a custody
          decision a person makes per message — never a default and never
          automatic. See the local-first reasoning in the plan header.
        */}
        {unparsed && (
          <button
            type="button"
            className="btn btn-ghost"
            style={{ fontSize: 12 }}
            disabled={busy}
            onClick={() =>
              void run(async () => {
                const updated = await api.inbound.escalate(email.id);
                const next = (updated.extracted?.[0] as ExtractedBooking | undefined) ?? EMPTY;
                setBooking(next);
                setSource(updated.source);
                setNote(updated.error);
              })
            }
          >
            <MagicWand size={13} /> Escalate to Claude
          </button>
        )}

        <span style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
          <button
            type="button"
            className="btn btn-secondary"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                await api.inbound.discard(email.id);
                onResolved(email.id);
              })
            }
          >
            Discard
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy}
            onClick={() => {
              if (tripId === "") {
                setError("Pick a trip to attach this to.");
                return;
              }
              if (booking.title.trim() === "") {
                setError("A title is required.");
                return;
              }
              void run(async () => {
                await api.inbound.approve(email.id, {
                  tripId,
                  personIds: selected,
                  bookings: [booking],
                });
                onResolved(email.id);
              });
            }}
          >
            <Check size={14} /> Add to trip
          </button>
        </span>
      </div>
    </div>
  );
}
```

Timestamps render read-only. Editing a UTC instant and its zone in a text field is a worse experience than the booking dialog's datetime-plus-zone pair, and wiring that pair in here would duplicate it; an extraction with no usable time is approved without one and the time is added from the trip's Overview tab. Disclosed under "Not in this plan".

- [ ] **Step 4: Write the failing Import test**

Create `tests/client/pages/Import.test.tsx`:

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Import } from "../../../src/client/pages/Import.js";

const EMAIL = {
  id: "ie1", receivedAt: "2026-07-21T10:00:00.000Z",
  fromAddress: "reservations@dawnranch.com", subject: "Reservation Confirmed",
  source: "local", confidence: "low",
  extracted: [{ kind: "lodging", title: "Dawn Ranch Lodge", details: { propertyName: "Dawn Ranch Lodge" } }],
  error: null, status: "pending", resolvedAt: null,
};

function makeApi(queue = [EMAIL]) {
  return {
    inbound: {
      list: vi.fn(async () => queue),
      body: vi.fn(), escalate: vi.fn(),
      approve: vi.fn(async () => [{ id: "b1" }]),
      discard: vi.fn(async () => undefined),
      address: vi.fn(async () => ({ address: "trips@fetched.example" })),
    },
    trips: { list: vi.fn(async () => []) },
    people: { list: vi.fn(async () => []) },
  };
}

function renderImport(api = makeApi(), address: string | null = "trips@example.test") {
  render(<Import api={api as never} forwardAddress={address} />);
  return api;
}

/** No injected prop: the component must fetch the address itself. */
function renderImportUninjected(api = makeApi()) {
  render(<Import api={api as never} />);
  return api;
}

describe("Import", () => {
  it("shows the pending queue", async () => {
    renderImport();
    expect(await screen.findByDisplayValue("Dawn Ranch Lodge")).toBeInTheDocument();
  });

  it("shows an empty state when nothing is waiting", async () => {
    renderImport(makeApi([]));
    expect(await screen.findByText(/nothing waiting/i)).toBeInTheDocument();
  });

  it("reports a failed load rather than looking like an empty queue", async () => {
    const api = makeApi();
    api.inbound.list = vi.fn(async () => {
      throw new Error("500");
    });
    renderImport(api);
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.queryByText(/nothing waiting/i)).not.toBeInTheDocument();
  });

  it("removes a card from the queue once it is resolved", async () => {
    renderImport();
    await userEvent.click(await screen.findByRole("button", { name: /discard/i }));
    expect(await screen.findByText(/nothing waiting/i)).toBeInTheDocument();
  });

  it("shows the configured forward address, never a hardcoded one", async () => {
    // The Cloudflare zone is an open question. Nothing in the UI may guess it.
    renderImport(makeApi(), "trips@configured.example");
    await userEvent.click(await screen.findByRole("button", { name: /forward to inbox/i }));
    expect(screen.getByText("trips@configured.example")).toBeInTheDocument();
  });

  it("says so when the server reports no forward address", async () => {
    renderImport(makeApi(), null);
    await userEvent.click(await screen.findByRole("button", { name: /forward to inbox/i }));
    expect(screen.getByText(/not configured yet/i)).toBeInTheDocument();
  });

  it("FETCHES the address when none is injected", async () => {
    // The regression this guards: an earlier draft read the address from
    // `import.meta.env.VITE_INBOUND_ADDRESS`, which a Vite build freezes at
    // build time and which therefore can never see the runtime
    // TRAVEL_HQ_INBOUND_ADDRESS the systemd unit sets. The deployed UI would
    // have said "not configured yet" forever -- and every test above would
    // still have passed, because they all inject the prop. This one does not.
    const api = renderImportUninjected();
    await userEvent.click(await screen.findByRole("button", { name: /forward to inbox/i }));
    expect(await screen.findByText("trips@fetched.example")).toBeInTheDocument();
    expect(api.inbound.address).toHaveBeenCalled();
  });

  it("says not configured rather than guessing when the address lookup fails", async () => {
    const api = makeApi();
    api.inbound.address = vi.fn(async () => {
      throw new Error("500");
    });
    renderImportUninjected(api);
    await userEvent.click(await screen.findByRole("button", { name: /forward to inbox/i }));
    expect(await screen.findByText(/not configured yet/i)).toBeInTheDocument();
  });

  it("opens on the review queue, not on Forward", async () => {
    // A disclosed departure from the prototype, which defaults to the Paste
    // chip. Paste is deferred, so defaulting there would open the screen on
    // a control this build does not ship.
    renderImport();
    expect(await screen.findByDisplayValue("Dawn Ranch Lodge")).toBeInTheDocument();
  });
});
```

- [ ] **Step 5: Write the Import page**

Replace `src/client/pages/Import.tsx`:

```tsx
import { useEffect, useState } from "react";
import { ClipboardText, EnvelopeSimple } from "@phosphor-icons/react";
import { api as defaultApi } from "../api/client.js";
import type { InboundEmail, Person, Trip } from "../api/types.js";
import { errorMessage } from "../lib/errors.js";
import { DraftCard } from "../import/DraftCard.js";

/**
 * The forward address is never hardcoded and never baked in at build time.
 *
 * The Cloudflare zone/hostname is still an open question (docs/HANDOFF.md)
 * and the spec's `badgerops.foo` is an assumption, so the address is
 * DEPLOYMENT configuration: `TRAVEL_HQ_INBOUND_ADDRESS` on the host, read by
 * the server at boot, served from GET /api/inbound-email/address. A Vite
 * `import.meta.env` variable would be frozen into the bundle at build time
 * and could not see a value the systemd unit sets at run time — the deployed
 * UI would say "not configured yet" forever while the server knew the answer.
 *
 * The prop is here so tests can inject; when it is omitted the component
 * fetches. `undefined` means "still loading", `null` means "the server says
 * it is not configured" — two different messages.
 */
export function Import({
  api = defaultApi,
  forwardAddress,
}: {
  api?: typeof defaultApi;
  forwardAddress?: string | null;
}) {
  /**
   * The review queue is the default tab, where the design prototype defaults
   * to Paste. That is a deliberate, disclosed departure: Paste and Upload are
   * both deferred (see "Scope, disclosed" above), so defaulting to a chip
   * this build does not ship would open the screen on nothing. The queue is
   * also the tab that has content when there is content — mail arrives
   * unattended, and the first question on opening /import is "what came in".
   */
  const [tab, setTab] = useState<"queue" | "forward">("queue");
  const [address, setAddress] = useState<string | null | undefined>(forwardAddress);
  const [queue, setQueue] = useState<InboundEmail[] | null>(null);
  const [trips, setTrips] = useState<Trip[]>([]);
  const [people, setPeople] = useState<Person[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [q, t, p] = await Promise.all([
          api.inbound.list(),
          api.trips.list(),
          api.people.list(),
        ]);
        if (cancelled) return;
        setQueue(q);
        setTrips(t);
        setPeople(p);
      } catch (err) {
        // "Nothing waiting" and "we could not find out" are very different
        // messages when the whole point is that mail arrives unattended.
        if (!cancelled) setError(errorMessage(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api]);

  useEffect(() => {
    // Only when the caller did not inject one. Separate from the load effect
    // above on purpose: a failure to read the forward address must not blank
    // the review queue, and a failure to read the queue must not hide the
    // address. They answer different questions and fail independently.
    if (forwardAddress !== undefined) return;
    let cancelled = false;
    api.inbound
      .address()
      .then((res) => {
        if (!cancelled) setAddress(res.address);
      })
      // Treated as "not configured": the Forward tab then says so rather than
      // sitting blank. It never guesses a zone, which is the property that
      // matters while the hostname is undecided.
      .catch(() => {
        if (!cancelled) setAddress(null);
      });
    return () => {
      cancelled = true;
    };
  }, [api, forwardAddress]);

  return (
    <>
      <header style={{ display: "flex", alignItems: "flex-start", gap: 16, marginBottom: 20, flexWrap: "wrap" }}>
        <div>
          <h3 style={{ marginBottom: 4 }}>Import bookings</h3>
          <p className="text-muted" style={{ margin: 0 }}>
            Everything lands as a draft for review — nothing writes silently.
          </p>
        </div>
        <div style={{ marginLeft: "auto", display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button
            type="button"
            className={tab === "queue" ? "tag tag-outline" : "tag"}
            style={{ padding: "6px 12px", cursor: "pointer", background: "none", border: tab === "queue" ? undefined : "1px solid var(--color-divider)", color: tab === "queue" ? undefined : "var(--color-neutral-400)" }}
            onClick={() => setTab("queue")}
          >
            <ClipboardText size={13} /> Review queue
            {queue && queue.length > 0 ? ` · ${queue.length}` : ""}
          </button>
          <button
            type="button"
            className={tab === "forward" ? "tag tag-outline" : "tag"}
            style={{ padding: "6px 12px", cursor: "pointer", background: "none", border: tab === "forward" ? undefined : "1px solid var(--color-divider)", color: tab === "forward" ? undefined : "var(--color-neutral-400)" }}
            onClick={() => setTab("forward")}
          >
            <EnvelopeSimple size={13} /> Forward to inbox
          </button>
        </div>
      </header>

      {error && (
        <p className="warning" role="alert">
          {error}
        </p>
      )}

      {tab === "forward" && (
        <div className="card" style={{ maxWidth: 560, gap: 12 }}>
          <span className="card-title">Forward confirmations to your instance</span>
          <p className="card-body" style={{ margin: 0 }}>
            Forward any booking email to the address below. It is parsed on this machine and shows
            up here as a draft for review — nothing is written into a trip until you approve it.
          </p>
          {address === undefined ? (
            <p className="text-muted" style={{ margin: 0 }}>Loading…</p>
          ) : address === null || address === "" ? (
            <p className="warning" style={{ margin: 0 }}>
              The forward address is not configured yet — the Cloudflare hostname has not been
              decided. Set <code>TRAVEL_HQ_INBOUND_ADDRESS</code> on the server once it is.
            </p>
          ) : (
            <code
              style={{
                fontSize: 13.5,
                padding: "8px 14px",
                borderRadius: "var(--radius-md)",
                background: "var(--color-bg)",
                border: "1px solid var(--color-divider)",
                color: "var(--color-accent-300)",
                alignSelf: "flex-start",
              }}
            >
              {address}
            </code>
          )}
        </div>
      )}

      {tab === "queue" && !error && queue === null && <p className="text-muted">Loading…</p>}

      {tab === "queue" && !error && queue !== null && queue.length === 0 && (
        <div className="card" style={{ alignItems: "flex-start", gap: 10 }}>
          <span className="card-title">Nothing waiting</span>
          <p className="card-body" style={{ margin: 0 }}>
            Forwarded confirmations show up here as drafts. Nothing is written into a trip until
            you approve it.
          </p>
        </div>
      )}

      {tab === "queue" && queue !== null && queue.length > 0 && (
        <div style={{ display: "grid", gap: 14, maxWidth: 720 }}>
          {queue.map((email) => (
            <DraftCard
              key={email.id}
              email={email}
              trips={trips}
              people={people}
              api={api}
              onResolved={(id) => setQueue((prev) => (prev ?? []).filter((e) => e.id !== id))}
            />
          ))}
        </div>
      )}
    </>
  );
}
```

- [ ] **Step 6: Run the tests**

Run: `npm run test:client -- "(DraftCard|pages/Import)"`
Expected: PASS — 14 DraftCard, 9 Import.

- [ ] **Step 7: Run everything**

Run: `npm run test:all && npm run typecheck && npm run build`
Expected: all PASS, both exit 0.

- [ ] **Step 8: Verify end to end without Cloudflare**

With the dev server running and a local model server up, post a fixture straight at the app, bypassing the Worker entirely:

```bash
curl -s -o /dev/null -w '%{http_code}\n' \
  -X POST http://127.0.0.1:8787/api/inbound-email \
  -H 'content-type: text/plain' \
  --data-binary @tests/fixtures/dawn-ranch.eml
```

Expected: `202`, and the message appears at `/import` as a reviewable draft. Then **stop the model server and repeat**: still `202`, still a row, now flagged with the extraction error and offering *Escalate to Claude*. That second run is the fail-soft requirement, verified by hand as well as by test.

(The `curl` will 401 against a production build, which is correct — it has no service token. Run this against a dev server whose `verifyIngest` you have pointed at a stub, or assert it in `tests/server/routes/inbound-email.test.ts`, which already does exactly this over `app.request`.)

- [ ] **Step 9: Commit**

```bash
git add src/client/api src/client/import src/client/pages/Import.tsx tests/client/import tests/client/pages/Import.test.tsx
git commit -m "feat: add the inbound email draft review queue"
```

---

### Task 15: The Cloudflare Worker and Email Routing — **BLOCKED**

> **Do not start this task until the Cloudflare zone/hostname is decided.** It is open question 4 in `docs/HANDOFF.md`; the spec assumes `badgerops.foo` and nobody has confirmed it. Everything else in both parts is executable without that decision, which is why this is last. If you have reached here and it is still open, **stop and ask.** Do not guess a zone.

**Files:**
- Create: `workers/inbound-email/src/index.ts`, `workers/inbound-email/wrangler.toml`, `workers/inbound-email/README.md`

**Interfaces:**
- Consumes: `POST /api/inbound-email` (Task 13), the Access service token (Task 9)
- Produces: an `email()` handler, and the Access/Email-Routing configuration to go with it

**The Worker stays deliberately dumb.** It verifies the sender and forwards the raw message. All parsing happens in the app, where the Zod schemas already live — splitting domain logic across a Worker and the server is what would make this expensive to maintain, and the Worker has no way to reach the encryption key or the database anyway.

**Sender verification is not optional.** Anyone on the internet can email that address and `From:` is trivially spoofed, so the Worker requires *both* a DMARC/SPF pass **and** a match against a family allowlist. Either alone is insufficient: DMARC alone means any domain that publishes a policy can inject bookings, and an allowlist alone means anyone who can spell a family member's address can.

**Failed deliveries go somewhere.** If guiltyspark is down or the tunnel is flapping, the `POST` fails and the message would otherwise be lost. The Worker falls back to `message.forward()` to a real mailbox. Cloudflare Queues is the more thorough answer if retries become necessary; this is the honest minimum.

- [ ] **Step 1: Confirm the blocker is cleared**

Record the decided zone and the addresses in `docs/HANDOFF.md`, replacing open question 4. Every value below comes from that decision; none is written into the code.

- [ ] **Step 2: Create the Access application and the service token**

In the Cloudflare dashboard:

1. A **service token** for the Worker. Note the Client ID (`<something>.access`) and the Client Secret; the secret is shown once.
2. A **second Access application**, separate from the human one, whose path is exactly `/api/inbound-email`, with **one** policy: *Service Auth* → *Include* → the service token above. Note its AUD.

A separate application with its own AUD is deliberate. Reusing the human application's AUD would mean one policy edit could grant the Worker the entire API, and the origin's `CF_ACCESS_INBOUND_AUD` check would not notice.

> **Do not add a Bypass policy — to either application — and do not "temporarily" add one to debug a 401.**
>
> Access evaluates Bypass and Service Auth policies **first**, before anything else, and a **Bypass policy mints no JWT at all**. It waves the request through with no `Cf-Access-Jwt-Assertion` header. So a Bypass policy added anywhere that happens to cover `/api/inbound-email` — including a broad one on a parent path, added for something unrelated — silently strips the assertion this entire design authenticates on.
>
> The origin fails closed: `createServiceTokenVerifier` finds no header and throws `AuthError`, which maps to 401. That is the correct answer. It is also a deeply confusing one, because the symptom (every ingest request 401s) points at the service token, the allowlist, or the AUD, and the cause is a policy that appears to *loosen* access. The same trap exists on the human application, where a Bypass would strip `email` and turn every request into "Missing Cf-Access-Jwt-Assertion" on a URL that looks wide open.
>
> If ingest 401s, check for a Bypass policy on either application before you touch `TRAVEL_HQ_INBOUND_CLIENT_IDS`.

Then set on guiltyspark, via agenix and the systemd unit:

```
CF_ACCESS_INBOUND_AUD=<the ingest application's AUD>
TRAVEL_HQ_INBOUND_HOUSEHOLD_ID=<the household id from `npm run seed`>
TRAVEL_HQ_INBOUND_CLIENT_IDS=<the service token client id>
TRAVEL_HQ_INBOUND_ADDRESS=<the forward address>
```

`TRAVEL_HQ_INBOUND_CLIENT_IDS` being unset makes the ingest verifier reject everything (Task 9 Step 6, and Task 9 Step 7's tests) — the endpoint is closed until it is configured, not open.

`TRAVEL_HQ_INBOUND_HOUSEHOLD_ID` is validated at boot against the `household` table (Task 9 Step 6). A typo makes the server refuse to start with a message naming the id, rather than accepting mail and failing with a foreign-key error on every message — which would surface as the Worker bouncing everything to `FALLBACK_FORWARD_TO` and look like "email ingestion is broken".

`TRAVEL_HQ_INBOUND_ADDRESS` is read by the **server** and served from `GET /api/inbound-email/address` (Task 13). **There is no `VITE_INBOUND_ADDRESS` and none should be added** — a Vite variable is frozen at build time and cannot see a value set here, so adding one would reintroduce a UI that reports "not configured yet" no matter what this file says. Changing the address later needs only a restart, not a frontend rebuild.

- [ ] **Step 3: Write the Worker**

Create `workers/inbound-email/src/index.ts`:

```ts
/**
 * Cloudflare Email Routing -> this Worker -> POST /api/inbound-email.
 *
 * Deliberately dumb: verify the sender, forward the bytes. Every parsing
 * decision belongs in the app, where the Zod schemas live and where the
 * database and the encryption key are.
 */
export interface Env {
  /** The app's public hostname behind the tunnel, e.g. https://travel-hq.example */
  APP_ORIGIN: string;
  /** Comma-separated sender allowlist. */
  ALLOWED_SENDERS: string;
  /** Where to send anything we could not deliver or would not accept. */
  FALLBACK_FORWARD_TO: string;
  CF_ACCESS_CLIENT_ID: string;
  CF_ACCESS_CLIENT_SECRET: string;
}

type ForwardableEmailMessage = {
  from: string;
  to: string;
  headers: Headers;
  raw: ReadableStream;
  forward: (to: string) => Promise<void>;
};

/**
 * BOTH checks, not either.
 *
 * `From:` is trivially spoofed, so an allowlist alone means anyone who can
 * spell a family member's address can inject bookings. A DMARC pass alone
 * means any domain that publishes a policy can. Requiring both means a sender
 * must be on the list AND have proved they own that domain.
 */
function senderIsTrusted(message: ForwardableEmailMessage, env: Env): boolean {
  const allowed = env.ALLOWED_SENDERS.split(",").map((s) => s.trim().toLowerCase());
  if (!allowed.includes(message.from.toLowerCase())) return false;

  const results = (message.headers.get("Authentication-Results") ?? "").toLowerCase();
  return results.includes("dmarc=pass") || results.includes("spf=pass");
}

export default {
  async email(message: ForwardableEmailMessage, env: Env): Promise<void> {
    if (!senderIsTrusted(message, env)) {
      // Not an error: unsolicited mail to a published address is expected.
      // Forward it so a human can look, and do not touch the app.
      await message.forward(env.FALLBACK_FORWARD_TO);
      return;
    }

    const raw = new Response(message.raw);

    try {
      const res = await fetch(`${env.APP_ORIGIN}/api/inbound-email`, {
        method: "POST",
        headers: {
          "content-type": "text/plain",
          // The purpose-built machine-to-machine mechanism. Access validates
          // these at the edge and forwards a signed JWT carrying
          // `common_name`; the origin never sees these headers. A bypass
          // policy with a shared secret is not the right tool for this.
          "CF-Access-Client-Id": env.CF_ACCESS_CLIENT_ID,
          "CF-Access-Client-Secret": env.CF_ACCESS_CLIENT_SECRET,
        },
        body: await raw.text(),
      });

      if (!res.ok) {
        // The app answers 202 whenever it STORED the message, including when
        // it could not parse it. A non-2xx therefore means the message is not
        // safe anywhere, so fall back rather than dropping it.
        throw new Error(`origin answered ${res.status}`);
      }
    } catch (err) {
      // guiltyspark is down, or the tunnel is flapping. Without this the mail
      // is simply lost, which is the worst outcome available.
      console.error("inbound-email: forwarding to fallback", err);
      await message.forward(env.FALLBACK_FORWARD_TO);
    }
  },
};
```

- [ ] **Step 4: Write the configuration**

Create `workers/inbound-email/wrangler.toml`. **Fill the placeholders from Step 1's decision; do not commit real secrets** — `CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET` are set with `wrangler secret put`, not here.

```toml
name = "travel-hq-inbound-email"
main = "src/index.ts"
compatibility_date = "2026-07-21"

[vars]
# The app's hostname behind the Cloudflare Tunnel. BLOCKED on the zone
# decision -- see docs/HANDOFF.md open question 4.
APP_ORIGIN = "https://REPLACE-ME"
ALLOWED_SENDERS = "REPLACE-ME@example.com"
FALLBACK_FORWARD_TO = "REPLACE-ME@example.com"
```

```bash
cd workers/inbound-email
wrangler secret put CF_ACCESS_CLIENT_ID
wrangler secret put CF_ACCESS_CLIENT_SECRET
wrangler deploy
```

Then, in the dashboard, add an Email Routing **custom address** rule for the forward address that sends to this Worker.

- [ ] **Step 5: Verify the whole path**

Send a real confirmation email to the address from a family member's mailbox.
Expected: it appears at `/import` as a reviewable draft within a few seconds; approving it creates a `booking` at `status='draft'` on the chosen trip; the confirmation number renders masked. **This is spec success criterion 5.**

Then verify the two failure paths by hand, because they are the ones that lose mail:

1. Stop `travel-hq` on guiltyspark and send another email. Expected: it arrives in `FALLBACK_FORWARD_TO`, not nowhere.
2. Send from an address not on `ALLOWED_SENDERS`. Expected: same — forwarded to the fallback, and nothing queued at `/import`.

- [ ] **Step 6: Commit**

```bash
git add workers/inbound-email docs/HANDOFF.md
git commit -m "feat: add the inbound email Worker and Access service-token configuration"
```

---

## Not in this plan (Part B)

1. **Paste and Upload tabs on `/import`.** The prototype shows three method chips; this ships the queue and Forward. Both deferred tabs need a second, human-authenticated parse endpoint, and widening `POST /api/inbound-email` to accept a human credential would undo Task 9. The right shape is a separate `POST /api/inbound-email/paste` under the human middleware, reusing the same chain.
2. **Editing extracted timestamps in the draft card.** They render read-only; an extraction with no usable time is approved without one and the time is added from the trip's Overview tab. Doing it properly means reusing the booking dialog's datetime-plus-zone pair, which is a component extraction rather than a new control.
3. **Multiple bookings from one email.** A round-trip itinerary extracts as two entries; the draft card reviews the first. `POST /api/inbound-email/:id/approve` already accepts an array, so this is a UI change only.
4. **Cloudflare Queues** for retrying a failed delivery. The Worker forwards to a mailbox instead, which is the honest minimum.
5. **Auto-matching an email to a trip by date.** The prototype shows "auto-matched by dates"; the reviewer picks the trip from a select. The matching rule is a one-line date-overlap check whenever it is wanted.
6. **Re-running extraction with a different local model** from the UI.
7. **Attachment storage.** A PDF confirmation is discarded after parsing; blob storage is backlogged with the attachments work.

## Self-review notes (Part B)

- **Spec coverage.** Success criterion 5 — a forwarded confirmation email produces a draft booking awaiting approval — is met end to end by Tasks 9–15. The spec's email-ingestion section is followed on every point: a dumb Worker doing DMARC/SPF plus an allowlist, an Access **service token** rather than a bypass policy with a shared secret, all parsing in the app, `.ics` preferred, everything landing as a draft requiring approval, and a fallback mailbox for failed deliveries.
- **One deliberate, disclosed departure from the spec's letter.** The spec says LLM extraction hands the body "to Claude". This plan makes the LLM step **local-first**, with Claude as a manual per-message escalation. The reasoning is in the plan header and is the same reasoning that rejected D1 + Workers: confirmation emails are among the most PII-dense documents this household produces, and routing them to a hosted API by default would reintroduce the custody change that was already declined. Claude is still in the design, reached by a human who has seen local extraction fail.
- **The auth design is the security-critical piece and is written down, not just coded** (Task 9): the signature path is byte-identical to the human one, only the claim mapping branches; a machine gets a fourth role whose default is deny, with a single per-method opt-in used exactly once; the machine's household comes from configuration, never a header; and both paths explicitly refuse the other's credential shape. Fifteen tests cover it, including three asserting the ingest middleware is scoped to `POST` and two asserting a machine identity cannot create a person or a trip.
- **The `machine` role can actually perform its one permitted write.** `TenantRepo.insert()` takes its guard as a parameter defaulting to `requireWrite()`, and `InboundEmailRepo.create` passes `requireIngestWrite()`. Without that, `create()` would 403 on itself, the ingest route would answer 403 rather than 202, and every fail-soft claim below would be vacuous. Overriding `requireWrite()` on the class instead would have re-opened `setExtraction`/`resolve` to the machine; there are three tests pinning all of it — create allowed, resolve denied, setExtraction denied.
- **The ingest credential is write-only *by routing*, and the plan says so rather than implying more.** `requireReveal()` denies `machine`, so no reveal is possible — but `TenantRepo`'s `all()`/`get()`/`unscoped()` carry **no role guard at all**, and `InboundEmailRepo.list()` is built on `all()` and returns `extracted` JSON holding plaintext confirmation numbers. What actually stops a stolen service token reading the queue is that the ingest middleware is scoped to `POST` on one path. That is a real control and it is tested; it is also a *routing* control, which is a different and more fragile thing than a role check, and describing it accurately is the point. The permission table in Task 9 carries an explicit row recording that reads are unguarded.
- **Fail-soft is tested at three levels**: the chain steps over a throwing extractor, the route still returns 202 and still writes a row when extraction found nothing *and* when it threw, and the local extractor aborts rather than hanging. A home model server being down must never lose an email.
- **No test contacts a model.** The local extractor takes an injectable `fetch`; the Claude extractor takes an injectable client; the routes take injected `extract`/`escalate` functions. `npm run test:all` needs no GPU, no Ollama, and no API key.
- **Timestamps.** `parseIcs` drops an event whose `DTSTART` will not parse rather than emitting a bad instant, and `validateExtracted` drops an unpaired, unparseable, or unknown-zone timestamp while keeping the rest of the booking. Both are tested. A stored unparseable timestamp bricks that trip's day view permanently, with no API route to repair it.
- **One extraction contract.** Every extractor's output funnels through `validateExtracted`, which runs one Zod schema plus the same per-kind `parseDetails` the booking route uses. An escalation does not get to widen what can enter the system.
- **The hostname is parameterised throughout, through exactly one mechanism per consumer.** `TRAVEL_HQ_INBOUND_ADDRESS` is read by the server and served from `GET /api/inbound-email/address`; `APP_ORIGIN` is the Worker's; `CF_ACCESS_INBOUND_AUD` and `TRAVEL_HQ_INBOUND_HOUSEHOLD_ID` are the origin's. **There is deliberately no `VITE_INBOUND_ADDRESS`**: the address is deployment configuration, decided with the zone and set by the systemd unit, and a Vite variable frozen into the bundle at build time cannot see it — the deployed UI would have said "not configured yet" permanently while the server knew the answer. The Import page has tests for all three states (injected, fetched, unavailable), including one that renders with **no** injected prop, because every test that injects one would have passed against the broken build-time version.
- **The `required` list of `EXTRACTED_JSON_SCHEMA` names every declared property.** Strict-mode structured output — OpenAI's, vLLM's, LM Studio's, and Anthropic's alike — rejects an object that sets `additionalProperties: false` and omits any declared property from `required`, and a rejected schema means decoding falls back to *unconstrained*. That would silently void this plan's central claim, that a small local model cannot emit a shape Zod would reject, with a 200 response and nothing failing. Optionality is carried by the `["string","null"]` unions, matching the Zod side's `.nullish()`. Both extractor tests assert it recursively.
- **`strict` sits inside `json_schema`, where the OpenAI-compatible contract puts it**, not beside `type` where most servers would drop it as an unknown key. The test asserts the nested position *and* the absence of the top-level one, so the assertion cannot agree with the bug.
- **`TRAVEL_HQ_INBOUND_HOUSEHOLD_ID` is validated at boot**, against the `household` table, via a bootstrap helper in `auth.ts` (the documented raw-SQL exception — `serve.ts` is not on that allowlist). An unvalidated typo would surface only when real mail arrived, as an FK error, a 500, and a Worker bouncing every message to the fallback mailbox.
- **The escalation log records an outcome and is written after the call.** Logging "escalated to Claude" before the request records a success for every failure too, which is unacceptable for the one audit line that answers "did this confirmation email leave the household's hardware".
- **The body cap is checked in bytes, and from `Content-Length` first.** `String.length` counts UTF-16 code units, so a non-ASCII message measures smaller than it is; and a cap applied only after `await c.req.text()` has buffered the whole body has already paid the cost it exists to avoid.
- **Every commit in Part B is green.** An earlier draft ran the schema/repository task before the auth task and accepted one deliberately-red commit, on the reasoning that folding the auth change into a schema task would bury a security-critical decision. That reasoning held; the ordering did not need to. The auth task depends on nothing the repository task produces, so running it first keeps the two units separately reviewable *and* keeps `git bisect` working across the whole plan.
