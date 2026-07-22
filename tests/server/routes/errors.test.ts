import { describe, it, expect } from "vitest";
import { z } from "zod";
import { mapError } from "../../../src/server/routes/errors.js";
import {
  ForbiddenError,
  NotFoundError,
  TenantScopeError,
  ValidationError,
} from "../../../src/server/repos/base.js";
import { AuthError, HouseholdAccessError } from "../../../src/server/auth.js";

describe("mapError", () => {
  it("maps ForbiddenError to 403", () => {
    const mapped = mapError(new ForbiddenError("Viewers may not modify data"));
    expect(mapped.status).toBe(403);
  });

  it("maps NotFoundError to 404", () => {
    const mapped = mapError(new NotFoundError("Trip not found in this household"));
    expect(mapped.status).toBe(404);
  });

  it("maps AuthError to 401", () => {
    const mapped = mapError(new AuthError("Missing Cf-Access-Jwt-Assertion"));
    expect(mapped.status).toBe(401);
  });

  // M10: household-selection failure is authorization (403), not
  // authentication (401), even though it's still a subclass of AuthError.
  it("maps HouseholdAccessError to 403, not 401", () => {
    const message = "Not a member of the requested household.";
    const mapped = mapError(new HouseholdAccessError(message));
    expect(mapped.status).toBe(403);
  });

  it("maps ValidationError to 400", () => {
    const mapped = mapError(new ValidationError("startsAt requires startsAtTz (an IANA timezone)"));
    expect(mapped.status).toBe(400);
    expect(mapped.body.error).toMatch(/timezone/i);
  });

  it("maps a Zod validation failure to 400 and names the invalid field", () => {
    const result = z.object({ title: z.string().min(1) }).safeParse({ title: "" });
    if (result.success) throw new Error("expected this parse to fail");
    const mapped = mapError(result.error);
    expect(mapped.status).toBe(400);
    expect(JSON.stringify(mapped.body)).toContain("title");
  });

  it("maps TenantScopeError to 500 without disclosing schema detail", () => {
    // A realistic message: base.ts's scopeBug() never puts SQL or column
    // names in a TenantScopeError's own .message, but this test guards the
    // boundary even if that ever slipped — the client-facing body must stay
    // generic regardless of what the message says.
    const mapped = mapError(
      new TenantScopeError(
        "Query must contain exactly one {scope} token outside comments and string literals",
      ),
    );
    expect(mapped.status).toBe(500);
    const serialized = JSON.stringify(mapped.body);
    expect(serialized).toBe(JSON.stringify({ error: "Internal error" }));
    expect(serialized).not.toContain("token");
    expect(serialized).not.toContain("household_id");
    expect(serialized).not.toMatch(/select|insert|update|delete/i);
  });

  it("maps an unrecognized error to 500 generic", () => {
    const mapped = mapError(new Error("something unexpected"));
    expect(mapped.status).toBe(500);
    expect(mapped.body).toEqual({ error: "Internal error" });
  });
});
