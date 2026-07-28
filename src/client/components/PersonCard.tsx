import { PencilSimple, WarningCircle } from "@phosphor-icons/react";
import type { api as defaultApi } from "../api/client.js";
import type { Person } from "../api/types.js";
import { personColor } from "./PersonChip.js";
import { MaskedValue } from "./MaskedValue.js";
import { passportStatus, passportWarningText } from "../lib/passport.js";

/**
 * The single rendering of a person's travel documents, shared by the People
 * page and the trip-detail Travelers tab. There is deliberately no second
 * component that knows how to draw a masked passport.
 *
 * `onEdit` is optional: the People page supplies it, the Travelers tab does
 * not, because editing a person is not a trip-detail flow and a pencil that
 * does nothing is worse than no pencil.
 */
export function PersonCard({
  person,
  arrivalOn,
  today,
  api,
  onEdit,
}: {
  person: Person;
  /** The trip's start date, or null on the People page where there is no trip. */
  arrivalOn: string | null;
  today: string;
  api: typeof defaultApi;
  onEdit?: (person: Person) => void;
}) {
  const status = passportStatus(person, arrivalOn, today);
  const warning = passportWarningText(person, status);
  // The identity header wants an avatar bigger than the 22px PersonChip;
  // same palette (personColor keyed by id), page-scale geometry inline.
  const { bg, fg } = personColor(person.id);

  return (
    <div className="card">
      <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
        <span
          className="person-chip"
          style={{ width: 44, height: 44, fontSize: 18, background: bg, color: fg }}
          title={person.displayName}
        >
          {person.displayName.slice(0, 1).toUpperCase()}
        </span>
        <span className="card-title">{person.displayName}</span>
        {onEdit && (
          <button
            type="button"
            className="btn btn-secondary btn-icon"
            style={{ marginLeft: "auto" }}
            aria-label={`Edit ${person.displayName}`}
            onClick={() => onEdit(person)}
          >
            <PencilSimple size={14} />
          </button>
        )}
      </div>
      <hr className="hr" style={{ margin: "2px 0" }} />

      {(person.email || person.phone) && (
        <div className="card-meta" style={{ flexWrap: "wrap" }}>
          {person.email && <a href={`mailto:${person.email}`}>{person.email}</a>}
          {person.phone && <a href={`tel:${person.phone}`}>{person.phone}</a>}
        </div>
      )}

      {person.passportNumberMasked === null && person.passportExpiry === null ? (
        <div className="card-meta">No passport on file</div>
      ) : (
        <div className="card-meta">
          <span>Passport</span>
          <MaskedValue
            masked={person.passportNumberMasked}
            onReveal={async () => (await api.people.reveal(person.id, "passport_number")).value}
          />
          {person.passportCountry && <span>{person.passportCountry}</span>}
          {status.expiry && <span>expires {status.expiry}</span>}
        </div>
      )}

      {person.knownTravelerNumberMasked && (
        <div className="card-meta">
          <span>Known Traveler</span>
          <MaskedValue
            masked={person.knownTravelerNumberMasked}
            onReveal={async () =>
              (await api.people.reveal(person.id, "known_traveler_number")).value
            }
          />
        </div>
      )}

      {person.redressNumberMasked && (
        <div className="card-meta">
          <span>Redress</span>
          <MaskedValue
            masked={person.redressNumberMasked}
            onReveal={async () => (await api.people.reveal(person.id, "redress_number")).value}
          />
        </div>
      )}

      {warning && (
        <div className="card-meta warning">
          <WarningCircle size={12} /> {warning}
        </div>
      )}
    </div>
  );
}
