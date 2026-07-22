import { describe, it, expect } from "vitest";
import { ApiError } from "../../../src/client/api/client.js";
import { errorMessage } from "../../../src/client/lib/errors.js";

describe("errorMessage", () => {
  it("frames a 401 as an expired session", () => {
    expect(errorMessage(new ApiError("/api/trips failed: Unauthorized", 401))).toMatch(
      /session has expired/i,
    );
  });

  it("never leaks the underlying message or class name", () => {
    const message = errorMessage(new ApiError("/api/trips failed: Internal error", 500));
    expect(message).not.toMatch(/ApiError|\/api\/trips|Internal error/);
  });

  it("falls back to a generic sentence for a non-ApiError", () => {
    expect(errorMessage(new TypeError("Failed to fetch"))).toMatch(/Try again/i);
  });
});
