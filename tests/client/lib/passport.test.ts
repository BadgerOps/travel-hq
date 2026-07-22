import { describe, it, expect } from "vitest";
import { passportStatus, passportWarningText } from "../../../src/client/lib/passport.js";

function person(expiry: string | null) {
  return { id: "p1", displayName: "Finn", passportExpiry: expiry };
}

describe("passportStatus", () => {
  it("reports none when there is no expiry on file", () => {
    expect(passportStatus(person(null), "2026-10-09", "2026-07-21").kind).toBe("none");
  });

  it("reports ok with comfortable validity at arrival", () => {
    expect(passportStatus(person("2027-06-01"), "2026-10-09", "2026-07-21").kind).toBe("ok");
  });

  it("reports short when validity runs out within six months of arrival", () => {
    // 2027-01-15 is 98 days after the 2026-10-09 arrival — well under the
    // 183-day threshold. Measured from *today* it is 178 days away, which is
    // also under 183, but the gap is the point: an arrival two months later
    // would flip the answer while "days from today" stayed the same. That is
    // the bug the arrival-relative rule exists to prevent.
    expect(passportStatus(person("2027-01-15"), "2026-10-09", "2026-07-21").kind).toBe("short");
  });

  it("reports expired rather than short for a passport already dead today", () => {
    expect(passportStatus(person("2026-01-01"), "2026-10-09", "2026-07-21").kind).toBe("expired");
  });

  it("measures from today when the trip has no start date", () => {
    expect(passportStatus(person("2026-08-01"), null, "2026-07-21").kind).toBe("short");
  });

  it("returns no warning text for ok or none", () => {
    expect(
      passportWarningText(person("2027-06-01"), passportStatus(person("2027-06-01"), "2026-10-09", "2026-07-21")),
    ).toBe(null);
    expect(
      passportWarningText(person(null), passportStatus(person(null), "2026-10-09", "2026-07-21")),
    ).toBe(null);
  });

  it("names the person and the date in a short warning", () => {
    const p = person("2027-01-15");
    const text = passportWarningText(p, passportStatus(p, "2026-10-09", "2026-07-21"));
    expect(text).toContain("Finn");
    expect(text).toContain("2027-01-15");
    expect(text).toMatch(/under six months' validity at arrival/i);
  });

  it("names an expired passport as expired", () => {
    const p = person("2026-01-01");
    expect(passportWarningText(p, passportStatus(p, "2026-10-09", "2026-07-21"))).toMatch(
      /expired 2026-01-01/,
    );
  });
});
