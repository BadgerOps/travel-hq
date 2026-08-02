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

  /**
   * The two halves of 400. A repository ValidationError is written for a
   * person and routes/errors.ts returns it verbatim for exactly that reason —
   * replacing it with "this is a bug" told a reviewer whose own action was
   * correctly refused that the app had broken.
   */
  it("shows a validation refusal in the server's own words", () => {
    expect(
      errorMessage(
        new ApiError(
          "/api/imports/accept failed: Only pending imports can be reviewed",
          400,
          "Only pending imports can be reviewed",
        ),
      ),
    ).toBe("Only pending imports can be reviewed");
  });

  /**
   * ...but a 400 carrying a Zod issue list means this client sent the wrong
   * SHAPE. "Invalid import acceptance" plus an issue path is unactionable for
   * whoever is looking at the screen, so it stays behind the generic sentence.
   */
  it("hides a schema rejection behind the generic bug sentence", () => {
    expect(
      errorMessage(
        new ApiError("/api/imports/accept failed: Invalid import acceptance", 400,
          "Invalid import acceptance",
          [{ code: "invalid_type", path: ["tripId"], message: "Required" }]),
      ),
    ).toMatch(/This is a bug/);
  });
});
