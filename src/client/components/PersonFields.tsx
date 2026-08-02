import { useState } from "react";
import type { CreatePersonInput, DocumentField, Person, UpdatePersonInput } from "../api/types.js";
import { MaskedValue } from "./MaskedValue.js";

/**
 * The three encrypted columns, in the order they appear on the form. Keyed by
 * the API's input-field name so a request body is assembled from this list
 * rather than from three near-identical hand-written branches.
 *
 * `field` is the server's column name, which is what the reveal endpoint takes
 * — the two spellings exist because the wire format for a *write* is camelCase
 * input keys while a *reveal* names the column directly.
 */
const DOCUMENTS = [
  {
    key: "passportNumber",
    label: "Passport number",
    masked: "passportNumberMasked",
    field: "passport_number",
  },
  {
    key: "knownTravelerNumber",
    label: "Known Traveler number",
    masked: "knownTravelerNumberMasked",
    field: "known_traveler_number",
  },
  {
    key: "redressNumber",
    label: "Redress number",
    masked: "redressNumberMasked",
    field: "redress_number",
  },
] as const;

type DocumentKey = (typeof DOCUMENTS)[number]["key"];

export type PersonFieldsState = ReturnType<typeof usePersonFields>;

/**
 * Every editable person field except `notes`, plus the tri-state document
 * handling, as one reusable piece of state.
 *
 * It is a hook rather than a prop bag because there are now two callers — the
 * roster dialog (`PersonForm`) and the profile page (`pages/Me`) — and the
 * rule they must not disagree about is not the markup, it is what ends up in
 * the request body. Sharing the fields but not `toUpdateInput()` would leave
 * the dangerous half duplicated.
 *
 * `notes` is deliberately NOT here. It is an annotation the household keeps
 * about a person, so it belongs to the roster dialog; the profile page does
 * not render it, and a field that is not on screen must not appear in the
 * update body — every supplied key is named in the activity log, and "you
 * edited notes" every time you saved your phone number would be a lie.
 *
 * The document inputs start EMPTY whatever `person` holds, and are never
 * seeded from it. `PersonRepo.list()` returns document numbers masked
 * (`••••2119`), so seeding an input from the loaded person and submitting the
 * whole object would encrypt the mask over the real passport number — a
 * silent, unrecoverable data loss with a 200 response. Instead:
 *
 *   typed nothing  -> the key is omitted     -> server leaves it alone
 *   pressed Clear  -> the key is null        -> server clears it
 *   typed a value  -> the key is that string -> server replaces it
 *
 * The server also rejects any document value containing the mask glyph
 * (`PersonRepo.update`), so this is belt and braces rather than the sole
 * defence — but it is the layer that means the bad request is never made.
 */
export function usePersonFields(person?: Person) {
  const [displayName, setDisplayName] = useState(person?.displayName ?? "");
  const [dob, setDob] = useState(person?.dob ?? "");
  const [email, setEmail] = useState(person?.email ?? "");
  const [phone, setPhone] = useState(person?.phone ?? "");
  const [passportExpiry, setPassportExpiry] = useState(person?.passportExpiry ?? "");
  const [passportCountry, setPassportCountry] = useState(person?.passportCountry ?? "");

  // Typed replacements, keyed by document. Empty string means "untouched".
  const [documents, setDocuments] = useState<Record<DocumentKey, string>>({
    passportNumber: "",
    knownTravelerNumber: "",
    redressNumber: "",
  });
  // Documents the operator explicitly asked to clear.
  const [cleared, setCleared] = useState<Record<DocumentKey, boolean>>({
    passportNumber: false,
    knownTravelerNumber: false,
    redressNumber: false,
  });

  /**
   * The document keys to send, as the tri-state: absent (untouched), a string
   * (replace), or — edit mode only — `null` (clear).
   *
   * The mode parameter is not cosmetic, it is what makes this typecheck.
   * `CreatePersonInput`'s document fields are `string | undefined`;
   * `UpdatePersonInput`'s are `string | null | undefined`. Spreading one
   * `string | null`-valued patch into both object literals fails
   * `satisfies CreatePersonInput` with TS1360 ("Type 'string | null |
   * undefined' is not assignable to type 'string | undefined'"). Two return
   * types, selected by the caller, keeps both branches honest.
   *
   * Runtime never hit this: the Clear button renders only when
   * `stored !== null`, which is never true in create mode. But `npm run
   * typecheck` would have.
   */
  function documentPatch(mode: "create"): Partial<Record<DocumentKey, string>>;
  function documentPatch(mode: "edit"): Partial<Record<DocumentKey, string | null>>;
  function documentPatch(
    mode: "create" | "edit",
  ): Partial<Record<DocumentKey, string | null>> {
    const patch: Partial<Record<DocumentKey, string | null>> = {};
    for (const { key } of DOCUMENTS) {
      const typed = documents[key].trim();
      // Order matters: a typed value wins over a stale Clear press, and an
      // untouched field contributes NO key at all rather than `undefined`.
      if (typed !== "") patch[key] = typed;
      // A clear is only expressible against a stored value, which only exists
      // in edit mode. In create mode the key is simply omitted.
      else if (mode === "edit" && cleared[key]) patch[key] = null;
    }
    return patch;
  }

  return {
    displayName,
    setDisplayName,
    dob,
    setDob,
    email,
    setEmail,
    phone,
    setPhone,
    passportExpiry,
    setPassportExpiry,
    passportCountry,
    setPassportCountry,
    documents,
    setDocuments,
    cleared,
    setCleared,

    /**
     * The one rule both callers enforce before they call the API: a person
     * without a name is unidentifiable in a roster and on a booking. Returned
     * as a message rather than thrown so each caller can put it wherever its
     * own error line lives.
     */
    validate(): string | null {
      return displayName.trim() === "" ? "A name is required." : null;
    },

    toCreateInput(): CreatePersonInput {
      return {
        displayName: displayName.trim(),
        ...(dob === "" ? {} : { dob }),
        ...(email.trim() === "" ? {} : { email: email.trim() }),
        ...(phone.trim() === "" ? {} : { phone: phone.trim() }),
        ...(passportExpiry === "" ? {} : { passportExpiry }),
        ...(passportCountry === "" ? {} : { passportCountry }),
        ...documentPatch("create"),
      };
    },

    toUpdateInput(): UpdatePersonInput {
      return {
        displayName: displayName.trim(),
        dob: dob === "" ? null : dob,
        email: email.trim() === "" ? null : email.trim(),
        phone: phone.trim() === "" ? null : phone.trim(),
        passportExpiry: passportExpiry === "" ? null : passportExpiry,
        passportCountry: passportCountry === "" ? null : passportCountry,
        ...documentPatch("edit"),
      };
    },
  };
}

/**
 * Name, date of birth, email and phone.
 *
 * `idPrefix` is the whole reason this is a component rather than a copied
 * block. `PersonForm` hard-coded `pf-*` element ids, which is fine inside a
 * dialog that only ever exists once, and wrong the moment the same fields are
 * dropped onto a page — two instances would collide their ids and every
 * `<label htmlFor>` would point at whichever input rendered first.
 */
export function PersonDetailFields({
  idPrefix,
  fields,
}: {
  idPrefix: string;
  fields: PersonFieldsState;
}) {
  return (
    <>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <div className="field">
          <label htmlFor={`${idPrefix}-name`}>Name</label>
          <input
            id={`${idPrefix}-name`}
            className="input"
            value={fields.displayName}
            onChange={(e) => fields.setDisplayName(e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor={`${idPrefix}-dob`}>Date of birth</label>
          <input
            id={`${idPrefix}-dob`}
            className="input"
            type="date"
            value={fields.dob}
            onChange={(e) => fields.setDob(e.target.value)}
          />
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <div className="field">
          <label htmlFor={`${idPrefix}-email`}>Email</label>
          <input
            id={`${idPrefix}-email`}
            className="input"
            type="email"
            autoComplete="email"
            value={fields.email}
            onChange={(e) => fields.setEmail(e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor={`${idPrefix}-phone`}>Phone</label>
          <input
            id={`${idPrefix}-phone`}
            className="input"
            type="tel"
            autoComplete="tel"
            value={fields.phone}
            onChange={(e) => fields.setPhone(e.target.value)}
          />
        </div>
      </div>
    </>
  );
}

/**
 * Passport expiry and country, then the three encrypted numbers.
 *
 * `onReveal` is optional and is supplied only by `/me`, where the row on
 * screen is by construction the caller's own. The roster dialog does not pass
 * it, because reveal there already belongs to `PersonCard` — a dialog whose
 * purpose is replacing a number should not also be where you read the old one
 * back.
 */
export function PersonDocumentFields({
  idPrefix,
  fields,
  person,
  onReveal,
}: {
  idPrefix: string;
  fields: PersonFieldsState;
  person?: Person;
  onReveal?: (field: DocumentField) => Promise<string | null>;
}) {
  return (
    <>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <div className="field">
          <label htmlFor={`${idPrefix}-expiry`}>Passport expiry</label>
          <input
            id={`${idPrefix}-expiry`}
            className="input"
            type="date"
            value={fields.passportExpiry}
            onChange={(e) => fields.setPassportExpiry(e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor={`${idPrefix}-country`}>Passport country</label>
          <input
            id={`${idPrefix}-country`}
            className="input"
            value={fields.passportCountry}
            onChange={(e) => fields.setPassportCountry(e.target.value)}
          />
        </div>
      </div>

      {DOCUMENTS.map(({ key, label, masked, field }) => {
        const stored = person?.[masked] ?? null;
        return (
          <div className="field" key={key}>
            <label htmlFor={`${idPrefix}-${key}`}>
              {label}{" "}
              <span className="text-muted" style={{ fontSize: 11 }}>
                · stored encrypted
              </span>
            </label>
            {stored !== null && (
              <div className="card-meta" style={{ marginBottom: 5 }}>
                <span>
                  currently{" "}
                  {onReveal ? (
                    <MaskedValue
                      own
                      masked={stored}
                      label={`your ${label.toLowerCase()}`}
                      onReveal={() => onReveal(field)}
                    />
                  ) : (
                    <strong>{stored}</strong>
                  )}
                </span>
                <button
                  type="button"
                  className="btn btn-ghost"
                  style={{ fontSize: 11 }}
                  aria-label={`Clear stored ${label.toLowerCase()}`}
                  aria-pressed={fields.cleared[key]}
                  onClick={() =>
                    fields.setCleared((c) => ({ ...c, [key]: !c[key] }))
                  }
                >
                  {fields.cleared[key] ? "Will be cleared — undo" : "Clear"}
                </button>
              </div>
            )}
            <input
              id={`${idPrefix}-${key}`}
              className="input"
              autoComplete="off"
              // Never seeded from `person`. See usePersonFields' docstring.
              value={fields.documents[key]}
              placeholder={stored === null ? "" : "unchanged"}
              onChange={(e) =>
                fields.setDocuments((d) => ({ ...d, [key]: e.target.value }))
              }
            />
          </div>
        );
      })}
    </>
  );
}

