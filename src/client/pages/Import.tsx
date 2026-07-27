import { useState } from "react";
import { EnvelopeSimple, Files, UploadSimple } from "@phosphor-icons/react";
import { api as defaultApi, ApiError } from "../api/client.js";
import type { FileImportResult } from "../api/types.js";
import { useCanWrite } from "../api/identity.js";
import { DraftBookingCard } from "../components/DraftBookingCard.js";
import { ImportReviewQueue } from "../imports/ImportReviewQueue.js";
import { errorMessage } from "../lib/errors.js";

export function Import({ api = defaultApi }: { api?: typeof defaultApi }) {
  const canWrite = useCanWrite();
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<FileImportResult | null>(null);
  const [queueRefresh, setQueueRefresh] = useState(0);

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
      <header style={{ marginBottom: 20 }}>
        <h3 style={{ marginBottom: 4 }}>Import bookings</h3>
        <p className="text-muted" style={{ margin: 0 }}>
          Upload an itinerary or forward a confirmation. Everything lands as a draft for review.
        </p>
      </header>

      {!canWrite ? (
        <div className="card" style={{ maxWidth: 560, alignItems: "flex-start", gap: 10 }}>
          <span className="card-title">Owners and adults only</span>
          <p className="card-body" style={{ margin: 0 }}>
            Viewers can see trips, but only owners and adults can import new draft bookings.
          </p>
        </div>
      ) : (
        <form
          className="card"
          style={{ maxWidth: 620, alignItems: "flex-start", gap: 12 }}
          onSubmit={upload}
        >
          <span className="card-title">
            <Files size={18} style={{ marginRight: 6, verticalAlign: "-3px" }} />
            Import an itinerary file
          </span>
          <p className="card-body" style={{ margin: 0 }}>
            Choose a PDF up to 10 MiB or an EML email up to 1 MB. Travel HQ reads it with your
            configured extraction model.
          </p>
          <label>
            Itinerary file
            <input
              type="file"
              accept=".pdf,.eml,application/pdf,message/rfc822"
              disabled={busy}
              onChange={(event) => {
                setFile(event.currentTarget.files?.[0] ?? null);
                setError(null);
                setResult(null);
              }}
            />
          </label>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            <UploadSimple size={14} />
            {busy ? "Importing…" : "Import file"}
          </button>
          {error && (
            <p className="warning" role="alert" style={{ margin: 0 }}>
              {error}
            </p>
          )}
        </form>
      )}

      {result?.status === "extracted" && (
        <section style={{ marginTop: 24 }}>
          <h4 style={{ marginBottom: 4 }}>
            {result.bookings.length} {result.bookings.length === 1 ? "draft" : "drafts"} ready for
            review
          </h4>
          <p className="text-muted" style={{ marginTop: 0 }}>
            Check each booking before adding it to a trip.
          </p>
          <div style={{ display: "grid", gap: 12 }}>
            {result.bookings.map((booking, index) => (
              <DraftBookingCard
                key={`${result.inboundEmailId}-${index}`}
                booking={booking}
              />
            ))}
          </div>
        </section>
      )}

      {result?.status === "received" && (
        <p className="text-muted" role="status" style={{ marginTop: 16 }}>
          The import was saved and is waiting for extraction. It will appear in recent ingest
          activity while it is queued.
        </p>
      )}

      <div className="card" style={{ maxWidth: 620, alignItems: "flex-start", gap: 8, marginTop: 16 }}>
        <span className="card-title">
          <EnvelopeSimple size={16} style={{ marginRight: 6, verticalAlign: "-2px" }} />
          Email import
        </span>
        <p className="card-body" style={{ margin: 0 }}>
          Forward confirmations to the address configured in Settings. Authenticated messages use
          the same extractor and appear as drafts.
        </p>
      </div>

      {canWrite && <ImportReviewQueue api={api} refreshToken={queueRefresh} />}
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
