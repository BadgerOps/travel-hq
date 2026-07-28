import { useEffect, useState } from "react";
import { Copy, Trash, UserPlus } from "@phosphor-icons/react";
import { api as defaultApi } from "../api/client.js";
import type { Trip, TripMember, TripMemberRole } from "../api/types.js";
import { Dialog } from "../components/Dialog.js";
import { errorMessage } from "../lib/errors.js";

export function TripAccessDialog({
  trip,
  api = defaultApi,
  onClose,
}: {
  trip: Trip;
  api?: typeof defaultApi;
  onClose: () => void;
}) {
  const [members, setMembers] = useState<TripMember[] | null>(null);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<TripMemberRole>("viewer");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const link = `${window.location.origin}/trips/${encodeURIComponent(trip.id)}`;

  useEffect(() => {
    let cancelled = false;
    api.trips.members(trip.id).then(
      (result) => {
        if (!cancelled) setMembers(result);
      },
      (err) => {
        if (!cancelled) setError(errorMessage(err));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [api, trip.id]);

  async function invite() {
    setBusy(true);
    setError(null);
    try {
      const member = await api.trips.invite(trip.id, email, role);
      setMembers((current) => [
        ...(current ?? []).filter((item) => item.userId !== member.userId),
        member,
      ].sort((a, b) => a.email.localeCompare(b.email)));
      setEmail("");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function remove(member: TripMember) {
    setBusy(true);
    setError(null);
    try {
      await api.trips.removeMember(trip.id, member.userId);
      setMembers((current) => current?.filter((item) => item.userId !== member.userId) ?? []);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
    } catch {
      setError("Couldn't copy the link. Select and copy it manually.");
    }
  }

  return (
    <Dialog title={`Share ${trip.title}`} onClose={onClose}>
      <p className="text-muted" style={{ marginTop: 0 }}>
        Invite an email first, then send this link. The link does not grant access by itself.
      </p>

      <label className="field">
        <span>Trip link</span>
        <span className="trip-access-link">
          <input value={link} readOnly aria-label="Trip link" />
          <button type="button" className="btn btn-secondary" onClick={() => void copyLink()}>
            <Copy size={14} /> {copied ? "Copied" : "Copy"}
          </button>
        </span>
      </label>

      <div className="trip-access-form">
        <label className="field">
          <span>Email</span>
          <input
            type="email"
            value={email}
            placeholder="traveler@example.com"
            onChange={(event) => setEmail(event.target.value)}
          />
        </label>
        <label className="field">
          <span>Access</span>
          <select value={role} onChange={(event) => setRole(event.target.value as TripMemberRole)}>
            <option value="viewer">Can view</option>
            <option value="editor">Can edit</option>
          </select>
        </label>
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy || email.trim() === ""}
          onClick={() => void invite()}
        >
          <UserPlus size={14} /> Invite
        </button>
      </div>

      {error && <p className="warning" role="alert">{error}</p>}

      <div style={{ display: "grid", gap: 6 }}>
        <strong style={{ fontSize: 13 }}>People with access</strong>
        {members === null && !error && <span className="text-muted">Loading…</span>}
        {members?.length === 0 && <span className="text-muted">Only household owners have access.</span>}
        {members?.map((member) => (
          <div
            key={member.userId}
            className="card"
            style={{ padding: "10px 12px", display: "flex", alignItems: "center", gap: 10 }}
          >
            <span style={{ flex: 1 }}>{member.email}</span>
            <span className="tag tag-neutral">{member.role === "editor" ? "Can edit" : "Can view"}</span>
            <button
              type="button"
              className="btn btn-ghost btn-icon"
              aria-label={`Remove ${member.email}`}
              disabled={busy}
              onClick={() => void remove(member)}
            >
              <Trash size={15} />
            </button>
          </div>
        ))}
      </div>

      <p className="text-muted" style={{ marginBottom: 0 }}>
        Cloudflare Access must also allow the email to authenticate.
      </p>
    </Dialog>
  );
}
