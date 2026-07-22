import { EnvelopeSimple } from "@phosphor-icons/react";

/**
 * Email import (forwarding a confirmation email in, parsing it, and
 * reviewing the extracted draft) is DEFERRED — it depends on the ingest
 * subsystem (src/server/ingest/, the inbound-email repo/route), which is not
 * part of this deployment. Rebuilt in the deferred ingest plan, alongside the
 * server-side pieces it needs. This stub keeps the `/import` route and nav
 * entry alive so linking to it never 404s, without promising a feature that
 * is not there yet.
 */
export function Import() {
  return (
    <>
      <header style={{ marginBottom: 20 }}>
        <h3 style={{ marginBottom: 4 }}>Import bookings</h3>
        <p className="text-muted" style={{ margin: 0 }}>
          Everything would land as a draft for review — nothing writes silently.
        </p>
      </header>

      <div className="card" style={{ maxWidth: 560, alignItems: "flex-start", gap: 10 }}>
        <span className="card-title">
          <EnvelopeSimple size={16} style={{ marginRight: 6, verticalAlign: "-2px" }} />
          Not available yet
        </span>
        <p className="card-body" style={{ margin: 0 }}>
          Email import isn't available on this deployment yet.
        </p>
      </div>
    </>
  );
}
