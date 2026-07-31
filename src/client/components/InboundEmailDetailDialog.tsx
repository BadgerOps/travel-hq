import { useEffect, useState } from "react";
import { api as defaultApi } from "../api/client.js";
import type {
  DraftBooking,
  InboundEmailDetail,
  InboundEmailMetadata,
} from "../api/types.js";
import { errorMessage } from "../lib/errors.js";
import { formatMoney } from "../lib/money.js";
import { Dialog } from "./Dialog.js";
import { StructuredDetails } from "./StructuredDetails.js";

/**
 * Click-through from the Recent ingest activity feed: what the extractor
 * parsed out of one stored email, alongside the readable message content.
 * The list row's metadata renders immediately; the parsed detail streams in.
 */
export function InboundEmailDetailDialog({
  email,
  api = defaultApi,
  onClose,
}: {
  email: InboundEmailMetadata;
  api?: typeof defaultApi;
  onClose: () => void;
}) {
  const [detail, setDetail] = useState<InboundEmailDetail | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.inboundEmails.get(email.id).then(
      (result) => {
        if (!cancelled) setDetail(result);
      },
      (err) => {
        if (!cancelled) setFetchError(errorMessage(err));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [api, email.id]);

  const shown = detail ?? email;

  return (
    <Dialog title={shown.subject || "(no subject)"} subtitle="Ingest activity" onClose={onClose}>
      <div style={{ display: "grid", gap: 10 }}>
        <div style={{ display: "flex", gap: 7, flexWrap: "wrap" }}>
          <span className={`tag ${shown.status === "extracted" ? "tag-accent" : "tag-neutral"}`}>
            {shown.status}
          </span>
        </div>
        <div className="card-meta" style={{ flexWrap: "wrap" }}>
          From {shown.from} · to {shown.to} · {formatWhen(shown.receivedAt)}
        </div>
        {shown.error && (
          <p className="warning" style={{ margin: 0 }}>{shown.error}</p>
        )}

        <hr className="hr" style={{ margin: "4px 0" }} />
        <h5 style={{ margin: 0 }}>Parsed bookings</h5>
        {fetchError && <p className="warning" role="alert" style={{ margin: 0 }}>{fetchError}</p>}
        {detail === null && !fetchError && (
          <p className="text-muted" role="status" style={{ margin: 0 }}>
            Loading parsed data…
          </p>
        )}
        {detail !== null && detail.drafts.length === 0 && (
          <p className="text-muted" style={{ margin: 0 }}>{noDraftsMessage(detail.status)}</p>
        )}
        {detail?.drafts.map((draft) => <ParsedDraft draft={draft} key={draft.id} />)}

        {detail !== null && (
          <>
            <hr className="hr" style={{ margin: "4px 0" }} />
            <h5 style={{ margin: 0 }}>Email content</h5>
            {detail.textBody ? (
              <details>
                <summary>Message text</summary>
                <pre style={preStyle}>{detail.textBody}</pre>
              </details>
            ) : (
              <p className="text-muted" style={{ margin: 0 }}>
                {/* The server distinguishes "purged on schedule" from "never
                    stored" and from "cannot be decrypted"; say which, because
                    only one of the three is a problem. */}
                {detail.rawUnavailableReason ?? "No readable message body was stored."}
              </p>
            )}
            <RetentionNote detail={detail} />
            {detail.calendars.map((calendar, index) => (
              <details key={index}>
                <summary>
                  Calendar attachment {detail.calendars.length > 1 ? index + 1 : ""}
                </summary>
                <pre style={preStyle}>{calendar}</pre>
              </details>
            ))}
          </>
        )}
      </div>
    </Dialog>
  );
}

/**
 * The retention promise, stated on the one screen where the forwarded message
 * itself is on display. A user who forwards a confirmation is entitled to
 * know how long the copy sticks around, and the honest place to say so is
 * next to the copy — not only buried in Settings.
 *
 * Rendered whether or not the message survives: when it does, this is the
 * deletion date; when it does not, the reason was already printed above and
 * repeating it here would be noise, so only the surviving-data reassurance is
 * left.
 */
function RetentionNote({ detail }: { detail: InboundEmailDetail }) {
  if (detail.rawState !== "retained") {
    return (
      <p className="text-muted" style={{ margin: 0, fontSize: 12 }}>
        The extracted bookings, the sender and the subject above are kept; only the message
        text is affected.
      </p>
    );
  }
  return (
    <p className="text-muted" style={{ margin: 0, fontSize: 12 }}>
      {detail.rawExpiresAt
        ? `This copy of the message is kept until ${formatWhen(detail.rawExpiresAt)}, then deleted automatically. The bookings extracted from it are kept.`
        : "This copy of the message is deleted automatically once its retention window passes. The bookings extracted from it are kept."}
    </p>
  );
}

/**
 * Fields the card already presents as its headline; everything else the
 * extractor produced renders below as readable label–value rows.
 */
const HEADLINE_FIELDS = [
  "kind", "title", "location",
  "startsAt", "startsAtTz", "endsAt", "endsAtTz",
  "confirmationNumber", "costCents", "extractionProvider", "details",
];

function ParsedDraft({ draft }: { draft: DraftBooking }) {
  const timing = [formatWhen(draft.startsAt), formatWhen(draft.endsAt)]
    .filter(Boolean)
    .join(" – ");
  const extracted = asRecord(draft.extracted);
  const costCents = extracted.costCents;
  const provider = extracted.extractionProvider;
  // Per-kind detail fields first (site, room type, flight number, …), then
  // anything unexpected at the top level, so no extracted value is dropped.
  const detailRows = { ...asRecord(extracted.details), ...extracted };
  return (
    <article className="card" style={{ alignItems: "flex-start", gap: 6 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 7, flexWrap: "wrap" }}>
        <span className="card-kicker">{draft.kind}</span>
        <span className="tag tag-neutral">
          {draft.source === "ics" ? "from calendar" : "from AI"}
        </span>
        {draft.status !== "pending" && <span className="tag tag-neutral">{draft.status}</span>}
      </div>
      <strong className="card-title">{draft.title}</strong>
      {draft.location && <span className="card-body">{draft.location}</span>}
      {timing && <span className="card-meta">{timing}</span>}
      {draft.confirmationNumber && (
        <span className="card-meta">Confirmation {draft.confirmationNumber}</span>
      )}
      {typeof costCents === "number" && Number.isInteger(costCents) && (
        <span className="card-meta">Cost {formatMoney(costCents)}</span>
      )}
      <StructuredDetails value={detailRows} omit={HEADLINE_FIELDS} />
      {typeof provider === "string" && (
        <span className="card-meta">Extracted by {provider}</span>
      )}
    </article>
  );
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function noDraftsMessage(status: InboundEmailMetadata["status"]): string {
  switch (status) {
    case "received":
      return "This email is still queued — nothing has been extracted yet.";
    case "rejected":
      return "This email was rejected before extraction, so there is no parsed data.";
    case "failed":
      return "Extraction failed for this email, so there is no parsed data.";
    default:
      return "The extractor found no bookings in this email.";
  }
}

function formatWhen(value: string | null | undefined): string {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString();
}

const preStyle = {
  whiteSpace: "pre-wrap",
  overflowWrap: "anywhere",
  maxHeight: 320,
  overflow: "auto",
  margin: "6px 0 0",
  padding: 10,
  borderRadius: "var(--radius-md)",
  background: "var(--color-bg)",
  fontSize: 12,
} as const;
