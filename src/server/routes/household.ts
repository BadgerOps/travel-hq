import { Hono } from "hono";
import { z } from "zod";
import { HouseholdMemberRepo } from "../repos/household-member.js";
import type { InvitableRole } from "../repos/household-member.js";
import type { AppEnv } from "../index.js";

/**
 * `email` is checked here only for the things a schema can honestly check —
 * that it is a string, and that it is not absurdly long. Its actual shape is
 * `HouseholdMemberRepo`'s to judge, because that message ("Enter a valid email
 * address") is written for the person filling in the form and reaches them
 * verbatim through mapError's ValidationError branch, whereas a Zod failure
 * arrives as a generic "Invalid invitation" plus issue objects.
 *
 * `role` is the same bargain for the same reason: a `z.enum` here would refuse
 * `owner` with no explanation, and refusing to make someone an owner is
 * exactly the case that needs one.
 *
 * `.strict()`, as everywhere else, so a client sending a key we do not read
 * learns that rather than believing it took effect.
 */
const inviteMemberSchema = z
  .object({
    email: z.string().trim().min(1).max(320),
    role: z.string(),
    displayName: z.string().trim().min(1).max(200).optional(),
  })
  .strict();

/** Same bargain as the invite schema: the repository owns the role vocabulary and its message. */
const setRoleSchema = z.object({ role: z.string() }).strict();

export const household = new Hono<AppEnv>();

/**
 * Readable by every member of the household; the repository decides whether a
 * `viewer` counts as one (see requireRosterRead) and throws ForbiddenError if
 * not. Deliberately NOT behind `requireHouseholdWriter` like /api/settings: a
 * family viewer needs to see who else is here, and a role gate at the router
 * cannot tell a family viewer from a shared-trip guest.
 */
household.get("/members", async (c) =>
  c.json(await new HouseholdMemberRepo(c.get("db"), c.get("identity")).list()),
);

household.post("/members", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const parsed = inviteMemberSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Invalid invitation", details: parsed.error.issues }, 400);
  }
  // Owner-only, enforced in the repository rather than here, so a non-HTTP
  // caller gets the same answer -- the same arrangement as /api/audit.
  return c.json(
    await new HouseholdMemberRepo(c.get("db"), c.get("identity")).invite({
      email: parsed.data.email,
      role: parsed.data.role as InvitableRole,
      displayName: parsed.data.displayName,
    }),
    201,
  );
});

/**
 * PUT rather than PATCH, and `/role` rather than the member itself: the role is
 * the only part of a membership this endpoint can change, and naming it in the
 * URL keeps that true as the member shape grows. Idempotent, as PUT promises —
 * setting the role a member already has is a successful no-op.
 *
 * The `:userId` is the ACCOUNT id (`HouseholdMember.userId`), not the person
 * id. Roles live on `household_member`, which is keyed by account; an unclaimed
 * person row has no role to change.
 */
household.put("/members/:userId/role", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const parsed = setRoleSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Invalid role change", details: parsed.error.issues }, 400);
  }
  // A non-member (or a member of another household) is a 404 from the
  // repository, indistinguishable from an id that never existed.
  return c.json(
    await new HouseholdMemberRepo(c.get("db"), c.get("identity")).setRole(
      c.req.param("userId"),
      parsed.data.role as InvitableRole,
    ),
  );
});
