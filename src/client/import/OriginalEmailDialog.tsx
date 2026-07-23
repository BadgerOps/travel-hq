import { useEffect, useState } from "react";
import type { api as defaultApi } from "../api/client.js";
import type { ImportQueueEmail, InboundEmail } from "../api/types.js";
import { errorMessage } from "../lib/errors.js";
import { Dialog } from "../components/Dialog.js";

/**
 * The "view original" link's destination: the stored message text the
 * drafts were extracted from, fetched on demand — the queue response
 * deliberately does not carry `raw`. Read-only, so viewers get it too.
 */
export function OriginalEmailDialog({
  email,
  api,
  onClose,
}: {
  email: ImportQueueEmail;
  api: typeof defaultApi;
  onClose: () => void;
}) {
  const [full, setFull] = useState<InboundEmail | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.import.email(email.id).then(
      (fetched) => {
        if (!cancelled) setFull(fetched);
      },
      (err: unknown) => {
        if (!cancelled) setFailed(errorMessage(err));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [api, email.id]);

  return (
    <Dialog title="Original message" subtitle={email.subject ?? email.from} onClose={onClose}>
      {failed && (
        <p className="warning" role="alert" style={{ margin: 0 }}>
          {failed}
        </p>
      )}
      {!failed && full === null && <p className="text-muted">Loading…</p>}
      {full !== null && (
        <div style={{ display: "grid", gap: 10 }}>
          <div className="card-meta">
            <span>From {full.from}</span>
            <span>to {full.to}</span>
            <span style={{ marginLeft: "auto" }}>{full.receivedAt.slice(0, 10)}</span>
          </div>
          <pre
            style={{
              margin: 0,
              maxHeight: "50vh",
              overflow: "auto",
              whiteSpace: "pre-wrap",
              overflowWrap: "anywhere",
              fontSize: 12,
              lineHeight: 1.5,
            }}
          >
            {full.raw}
          </pre>
        </div>
      )}
    </Dialog>
  );
}
