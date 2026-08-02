import { useEffect, useRef, useState } from "react";
import { Camera, IdentificationBadge, IdentificationCard } from "@phosphor-icons/react";
import {
  readDriversLicense,
  readPassport,
  supportsPdf417Format,
} from "../lib/document-reading.js";
import type { PersonFieldsState } from "./PersonFields.js";

type ScanKind = "passport" | "licence";

export function DocumentReader({ fields }: { fields: PersonFieldsState }) {
  const passportInput = useRef<HTMLInputElement>(null);
  const licenceInput = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<ScanKind | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [canReadLicence, setCanReadLicence] = useState<boolean | null>(null);

  useEffect(() => {
    let live = true;
    supportsPdf417Format().then(
      (supported) => live && setCanReadLicence(supported),
      () => live && setCanReadLicence(false),
    );
    return () => {
      live = false;
    };
  }, []);

  async function selected(kind: ScanKind, file: File | undefined) {
    if (!file) return;
    setBusy(kind);
    setMessage(
      kind === "passport"
        ? "Reading the passport on this device…"
        : "Reading the licence barcode on this device…",
    );
    try {
      if (kind === "passport") {
        const result = await readPassport(file);
        fields.setDocuments((documents) => ({
          ...documents,
          passportNumber: result.documentNumber,
        }));
        fields.setPassportExpiry(result.expiry);
        fields.setPassportCountry(result.nationality);
        fields.setDob(result.dob);
        setMessage("Passport checks passed. Review the suggested values below before saving.");
      } else {
        const result = await readDriversLicense(file);
        fields.setDocuments((documents) => ({
          ...documents,
          driverLicenseNumber: result.documentNumber,
        }));
        fields.setDriverLicenseExpiry(result.expiry);
        fields.setDriverLicenseJurisdiction(result.issuingJurisdiction);
        fields.setDob(result.dob);
        setMessage("Licence barcode read. Review the suggested values below before saving.");
      }
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "The document could not be read. Enter the details manually.",
      );
    } finally {
      // The input is the only element retaining the File. Clearing it makes
      // the read-and-discard promise concrete and permits retaking the same
      // photo after a failed scan.
      const input = kind === "passport" ? passportInput.current : licenceInput.current;
      if (input) input.value = "";
      setBusy(null);
    }
  }

  return (
    <div className="document-reader" aria-label="Read a document">
      <div className="document-reader-heading">
        <Camera size={16} />
        <strong>Fill from a photo</strong>
      </div>
      <p className="text-muted">
        Reading happens in this browser. The photo is discarded after reading and is
        never uploaded.
      </p>
      <div className="document-reader-actions">
        <button
          type="button"
          className="btn btn-secondary"
          disabled={busy !== null}
          onClick={() => passportInput.current?.click()}
        >
          <IdentificationBadge size={16} />
          {busy === "passport" ? "Reading passport…" : "Photograph passport"}
        </button>
        <input
          ref={passportInput}
          hidden
          type="file"
          accept="image/*"
          capture="environment"
          disabled={busy !== null}
          onChange={(event) => void selected("passport", event.target.files?.[0])}
        />
        {canReadLicence === true && (
          <>
            <button
              type="button"
              className="btn btn-secondary"
              disabled={busy !== null}
              onClick={() => licenceInput.current?.click()}
            >
              <IdentificationCard size={16} />
              {busy === "licence" ? "Reading licence…" : "Photograph licence back"}
            </button>
            <input
              ref={licenceInput}
              hidden
              type="file"
              accept="image/*"
              capture="environment"
              disabled={busy !== null}
              onChange={(event) => void selected("licence", event.target.files?.[0])}
            />
          </>
        )}
      </div>
      {canReadLicence === false && (
        <p className="text-muted document-reader-fallback">
          This browser cannot read the barcode on a US licence. You can still enter those
          fields manually.
        </p>
      )}
      {message && (
        <p className="document-reader-message" role="status" aria-live="polite">
          {message}
        </p>
      )}
    </div>
  );
}
