import { describe, expect, it } from "vitest";
import {
  mrzCheckDigit,
  parseAamvaPdf417,
  parsePassportMrz,
} from "../../../src/client/lib/document-reading.js";

const VALID_PASSPORT = [
  "P<UTOERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<<<",
  "L898902C36UTO7408122F1204159ZE184226B<<<<<10",
].join("\n");

describe("passport MRZ reading", () => {
  it("implements ICAO 9303 check digits", () => {
    expect(mrzCheckDigit("L898902C3")).toBe("6");
    expect(mrzCheckDigit("740812")).toBe("2");
    expect(mrzCheckDigit("120415")).toBe("9");
  });

  it("extracts only values whose individual and composite checks pass", () => {
    expect(parsePassportMrz(VALID_PASSPORT, new Date("2026-08-02T00:00:00Z"))).toEqual({
      documentNumber: "L898902C3",
      nationality: "UTO",
      dob: "1974-08-12",
      expiry: "2012-04-15",
    });
  });

  it("rejects an OCR substitution instead of confidently prefilling it", () => {
    const misread = VALID_PASSPORT.replace("L898902C3", "L898902C8");
    expect(() => parsePassportMrz(misread)).toThrow(/check digit/i);
  });

  it("fails clearly when the photo does not contain two MRZ lines", () => {
    expect(() => parsePassportMrz("UNITED STATES OF AMERICA\nPASSPORT")).toThrow(
      /two machine-readable lines/i,
    );
  });
});

describe("AAMVA PDF417 reading", () => {
  it("extracts structured licence fields without OCR", () => {
    const barcode = [
      "@\n\x1e\rANSI 636026080102DL00410288ZA03290015DL",
      "DAQD1234567",
      "DBA20310415",
      "DBB19870402",
      "DAJID",
      "DCGUSA",
    ].join("\n");
    expect(parseAamvaPdf417(barcode)).toEqual({
      documentNumber: "D1234567",
      expiry: "2031-04-15",
      dob: "1987-04-02",
      issuingJurisdiction: "ID",
    });
  });

  it("accepts the MMDDYYYY date layout used by older records", () => {
    const barcode = "ANSI 636000\nDAQX1\nDBA04152031\nDBB04021987\nDAJCO";
    expect(parseAamvaPdf417(barcode)).toMatchObject({
      expiry: "2031-04-15",
      dob: "1987-04-02",
    });
  });

  it("rejects an unrelated PDF417 payload", () => {
    expect(() => parseAamvaPdf417("boarding pass")).toThrow(/not an AAMVA/i);
  });
});
