import { useEffect, useState } from "react";
import { Link } from "wouter";
import {
  Check,
  Copy,
  EnvelopeSimple,
  FileArrowUp,
  UploadSimple,
} from "@phosphor-icons/react";
import { api as defaultApi, ApiError } from "../api/client.js";
import type { FileImportResult } from "../api/types.js";
import { useCanWrite } from "../api/identity.js";
import { DraftBookingCard } from "../components/DraftBookingCard.js";
import { ImportReviewQueue } from "../imports/ImportReviewQueue.js";
import { errorMessage } from "../lib/errors.js";
import "./import.css";

export function Import({ api = defaultApi }: { api?: typeof defaultApi }) {
  const canWrite = useCanWrite();
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<FileImportResult | null>(null);
  const [queueRefresh, setQueueRefresh] = useState(0);
  const [forwardAddress, setForwardAddress] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!canWrite) return;
    let cancelled = false;
    // The forward chip is informational. Reading settings can 403 for admins
    // (owner-only), and test harnesses stub a partial api — fall back to the
    // static chip in both cases.
    api.settings
      ?.get()
      .then(
        (settings) => {
          if (!cancelled) setForwardAddress(settings.forwardAddress);
        },
        () => {},
      );
    return () => {
      cancelled = true;
    };
  }, [api, canWrite]);

  function pickFile(next: File | null) {
    setFile(next);
    setError(null);
    setResult(null);
  }

  async function copyForwardAddress() {
    if (!forwardAddress) return;
    try {
      await navigator.clipboard.writeText(forwardAddress);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard unavailable — the address is still visible to copy by hand */
    }
  }

  async function upload(event: React.FormEvent) {
    event.preventDefault();
    if (!file) {
      setError("Choose a PDF or EML file to import.");
      return;
    }
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const imported = await api.imports.file(file);
      setResult(imported);
      if (imported.status === "extracted") {
        setQueueRefresh((value) => value + 1);
      }
      if (imported.status === "failed") {
        setError(imported.error ?? "The itinerary could not be extracted.");
      }
    } catch (err) {
      setError(importErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <header className="page-header">
        <div className="page-title-group">
          <h3>Import bookings</h3>
          <p className="page-subline">
            Three ways in — everything lands as a draft for review
          </p>
        </div>
        <div className="page-actions import-methods">
          <span className="tag tag-outline import-chip">
            <FileArrowUp size={13} aria-hidden="true" />
            Upload .eml / PDF
          </span>
          {forwardAddress ? (
            <button
              type="button"
              className="tag import-chip import-chip--muted"
              title="Copy the forwarding address"
              onClick={() => void copyForwardAddress()}
            >
              <EnvelopeSimple size={13} aria-hidden="true" />
              Forward to <span className="import-chip-addr">{forwardAddress}</span>
              {copied ? (
                <Check size={12} aria-hidden="true" />
              ) : (
                <Copy size={12} aria-hidden="true" />
              )}
            </button>
          ) : canWrite ? (
            <Link href="/settings" className="tag import-chip import-chip--muted">
              <EnvelopeSimple size={13} aria-hidden="true" />
              Forward by email · set up in Settings
            </Link>
          ) : (
            <span className="tag import-chip import-chip--muted">
              <EnvelopeSimple size={13} aria-hidden="true" />
              Forward by email
            </span>
          )}
        </div>
      </header>

      {!canWrite ? (
        <div className="card import-viewer-card">
          <span className="card-title">Owners and admins only</span>
          <p className="card-body" style={{ margin: 0 }}>
            Viewers can see trips, but only owners and admins can import new draft bookings.
          </p>
        </div>
      ) : (
        <div className="import-grid">
          <section className="import-pane">
            <h6 className="section-kicker">Upload a confirmation</h6>
            <form className="import-upload" onSubmit={upload}>
              <label
                className={`import-dropzone${dragging ? " is-dragover" : ""}${
                  busy ? " is-busy" : ""
                }`}
                onDragOver={(event) => {
                  event.preventDefault();
                  if (!busy) setDragging(true);
                }}
                onDragLeave={() => setDragging(false)}
                onDrop={(event) => {
                  event.preventDefault();
                  setDragging(false);
                  if (busy) return;
                  const dropped = event.dataTransfer.files?.[0] ?? null;
                  if (dropped) pickFile(dropped);
                }}
              >
                <input
                  type="file"
                  accept=".pdf,.eml,application/pdf,message/rfc822"
                  aria-label="Itinerary file"
                  disabled={busy}
                  onChange={(event) => pickFile(event.currentTarget.files?.[0] ?? null)}
                />
                <FileArrowUp size={26} aria-hidden="true" className="dz-icon" />
                {file ? (
                  <>
                    <strong className="dz-title dz-file">{file.name}</strong>
                    <span className="dz-hint">
                      Ready to import — or choose a different file
                    </span>
                  </>
                ) : (
                  <>
                    <strong className="dz-title">Drop a confirmation here, or browse</strong>
                    <span className="dz-hint">PDF up to 10 MiB · EML email up to 1 MB</span>
                  </>
                )}
              </label>
              <p className="import-note">
                Travel HQ reads the file with your configured extraction model. Nothing
                writes silently — every booking waits below as a draft.
              </p>
              <button type="submit" className="btn btn-primary" disabled={busy}>
                <UploadSimple size={14} />
                {busy ? "Importing…" : "Import file"}
              </button>
              {error && (
                <p className="warning" role="alert">
                  {error}
                </p>
              )}
            </form>
          </section>

          <section className="import-pane">
            <h6 className="section-kicker">Parsed drafts · review before saving</h6>

            {result?.status === "extracted" && (
              <div className="import-fresh">
                <h4>
                  {result.bookings.length}{" "}
                  {result.bookings.length === 1 ? "draft" : "drafts"} ready for review
                </h4>
                <p className="text-muted">Check each booking before adding it to a trip.</p>
                <div className="import-draft-list">
                  {result.bookings.map((booking, index) => (
                    <DraftBookingCard
                      key={`${result.inboundEmailId}-${index}`}
                      booking={booking}
                    />
                  ))}
                </div>
              </div>
            )}

            {result?.status === "received" && (
              <p className="import-note" role="status">
                The import was saved and is waiting for extraction. It will appear in
                recent ingest activity while it is queued.
              </p>
            )}

            <ImportReviewQueue api={api} refreshToken={queueRefresh} />
          </section>
        </div>
      )}
    </>
  );
}

function importErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 413) {
      return "That file is too large. PDFs may be 10 MiB; EML files may be 1 MB.";
    }
    if (err.status === 415) return "Only PDF and EML itinerary files can be imported.";
    if (err.status === 422 || err.status === 502) {
      return "Travel HQ could not read that file. Try exporting it again, then re-upload it.";
    }
    if (err.status === 503) {
      return "The extraction provider is unavailable. Check the model settings and try again.";
    }
  }
  return errorMessage(err);
}
