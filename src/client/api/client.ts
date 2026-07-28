import type {
  Booking,
  BookingStatus,
  Card,
  CardWithPerks,
  CatalogModel,
  ChecklistItem,
  CreateBookingInput,
  CreateCardInput,
  CreatePersonInput,
  CreatePerkInput,
  CreateTripInput,
  DocumentField,
  HouseholdSettings,
  Identity,
  InboundEmailDetail,
  InboundEmailMetadata,
  ItineraryDay,
  Person,
  PerkWithStatus,
  Trip,
  TripRollup,
  UpdateCardInput,
  UpdateHouseholdSettingsInput,
  UpdatePersonInput,
  UpdatePerkInput,
  UpdateTripInput,
  UpdateBookingInput,
  ExtractedBooking,
  FileImportResult,
  PendingImportDraft,
  CreateTripFromDraftsInput,
  ImportReviewResult,
  BookingSourceArtifact,
  TripDuplicateGroup,
} from "./types.js";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /**
     * The server's own `error` string, unprefixed. `message` is for logs and
     * carries the path; this is the sentence the body actually contained.
     * Almost every status maps to a written-here message instead (see
     * lib/errors.ts) — 409 is the exception, where the server knows something
     * the client cannot phrase for itself.
     */
    readonly detail?: string,
  ) {
    super(message);
  }
}

export type ApiConfig = {
  fetch?: typeof globalThis.fetch;
  baseUrl?: string;
};

export function createApi(config: ApiConfig = {}) {
  const doFetch = config.fetch ?? globalThis.fetch;
  const baseUrl = config.baseUrl ?? "";

  async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await doFetch(`${baseUrl}${path}`, {
      credentials: "same-origin",
      ...init,
    });
    if (!res.ok) {
      let detail = res.statusText;
      let fromBody: string | undefined;
      try {
        const body = (await res.json()) as { error?: string };
        if (body.error) {
          detail = body.error;
          fromBody = body.error;
        }
      } catch {
        // Non-JSON error body; the status line is all we have.
      }
      throw new ApiError(`${path} failed: ${detail}`, res.status, fromBody);
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  const seg = (s: string) => encodeURIComponent(s);

  /**
   * Every write in this client sends the same three things. Writing them out
   * per method is how one of them ends up missing its content-type and being
   * parsed as an empty body by Hono.
   */
  const jsonBody = (method: "POST" | "PUT", body: unknown): RequestInit => ({
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  return {
    me: () => request<Identity>("/api/me"),
    people: {
      list: () => request<Person[]>("/api/people"),
      ensureMe: () => request<Person>("/api/people/me", jsonBody("POST", {})),
      reveal: (id: string, field: DocumentField) =>
        request<{ value: string | null }>(
          `/api/people/${seg(id)}/reveal/${seg(field)}`,
          jsonBody("POST", {}),
        ),
      create: (input: CreatePersonInput) =>
        request<Person>("/api/people", jsonBody("POST", input)),
      update: (id: string, input: UpdatePersonInput) =>
        request<Person>(`/api/people/${seg(id)}`, jsonBody("PUT", input)),
    },
    trips: {
      list: () => request<Trip[]>("/api/trips"),
      get: (tripId: string) => request<Trip>(`/api/trips/${seg(tripId)}`),
      bookings: (tripId: string) =>
        request<Booking[]>(`/api/trips/${seg(tripId)}/bookings`),
      revealConfirmation: (tripId: string, bookingId: string) =>
        request<{ value: string | null }>(
          `/api/trips/${seg(tripId)}/bookings/${seg(bookingId)}/reveal`,
          jsonBody("POST", {}),
        ),
      itinerary: (tripId: string, personId?: string) =>
        request<ItineraryDay[]>(
          `/api/trips/${seg(tripId)}/itinerary${
            personId ? `?personId=${encodeURIComponent(personId)}` : ""
          }`,
        ),
      rollup: (tripId: string) => request<TripRollup>(`/api/trips/${seg(tripId)}/rollup`),
      travelers: (tripId: string) => request<Person[]>(`/api/trips/${seg(tripId)}/travelers`),
      create: (input: CreateTripInput) => request<Trip>("/api/trips", jsonBody("POST", input)),
      update: (tripId: string, input: UpdateTripInput) =>
        request<Trip>(`/api/trips/${seg(tripId)}`, jsonBody("PUT", input)),
      uploadPhoto: (tripId: string, file: File) => {
        const form = new FormData();
        form.set("photo", file);
        return request<Trip>(`/api/trips/${seg(tripId)}/photo`, {
          method: "POST",
          body: form,
        });
      },
      delete: (tripId: string) =>
        // No body: the route reads the id from the path and never calls
        // c.req.json(). Sending a content-type here would be a lie.
        request<void>(`/api/trips/${seg(tripId)}`, { method: "DELETE" }),
      addTraveler: (tripId: string, personId: string) =>
        // No body: the route reads both ids from the path and never calls
        // c.req.json(). Sending a content-type here would be a lie.
        request<void>(`/api/trips/${seg(tripId)}/people/${seg(personId)}`, { method: "PUT" }),
      removeTraveler: (tripId: string, personId: string) =>
        request<void>(`/api/trips/${seg(tripId)}/people/${seg(personId)}`, { method: "DELETE" }),
      createBooking: (tripId: string, input: Omit<CreateBookingInput, "tripId">) =>
        request<Booking>(`/api/trips/${seg(tripId)}/bookings`, jsonBody("POST", input)),
      duplicates: (tripId: string) =>
        request<{ groups: TripDuplicateGroup[] }>(`/api/trips/${seg(tripId)}/duplicates`),
      mergeDuplicates: (tripId: string, keepId: string, mergeIds: string[]) =>
        request<Booking>(
          `/api/trips/${seg(tripId)}/duplicates/merge`,
          jsonBody("POST", { keepId, mergeIds }),
        ),
      dismissDuplicates: (tripId: string, bookingIds: string[]) =>
        request<void>(
          `/api/trips/${seg(tripId)}/duplicates/dismiss`,
          jsonBody("POST", { bookingIds }),
        ),
    },
    bookings: {
      artifact: (bookingId: string) =>
        request<{ artifact: BookingSourceArtifact | null }>(
          `/api/bookings/${seg(bookingId)}/artifact`,
        ),
      assignPerson: (bookingId: string, personId: string) =>
        request<void>(
          `/api/bookings/${seg(bookingId)}/people/${seg(personId)}`,
          { method: "PUT" },
        ),
      unassignPerson: (bookingId: string, personId: string) =>
        request<void>(
          `/api/bookings/${seg(bookingId)}/people/${seg(personId)}`,
          { method: "DELETE" },
        ),
      setStatus: (bookingId: string, status: BookingStatus) =>
        request<void>(`/api/bookings/${seg(bookingId)}/status`, jsonBody("PUT", { status })),
      /**
       * Partial edit. The route's schema is `.strict()`, so send only the keys
       * being changed — echoing back a whole `Booking` (with its `id`,
       * `personIds` and MASKED confirmation number) is a 400, deliberately.
       */
      update: (bookingId: string, input: UpdateBookingInput) =>
        request<Booking>(`/api/bookings/${seg(bookingId)}`, jsonBody("PUT", input)),
      remove: (bookingId: string) =>
        // No body: the route reads the id from the path and never calls
        // c.req.json(). Sending a content-type here would be a lie.
        request<void>(`/api/bookings/${seg(bookingId)}`, { method: "DELETE" }),
    },
    cards: {
      list: () => request<CardWithPerks[]>("/api/cards"),
      create: (input: CreateCardInput) => request<Card>("/api/cards", jsonBody("POST", input)),
      update: (id: string, input: UpdateCardInput) =>
        request<Card>(`/api/cards/${seg(id)}`, jsonBody("PUT", input)),
      remove: (id: string) => request<void>(`/api/cards/${seg(id)}`, { method: "DELETE" }),
      createPerk: (cardId: string, input: CreatePerkInput) =>
        request<PerkWithStatus>(`/api/cards/${seg(cardId)}/perks`, jsonBody("POST", input)),
      updatePerk: (cardId: string, perkId: string, input: UpdatePerkInput) =>
        request<PerkWithStatus>(
          `/api/cards/${seg(cardId)}/perks/${seg(perkId)}`,
          jsonBody("PUT", input),
        ),
      removePerk: (cardId: string, perkId: string) =>
        request<void>(`/api/cards/${seg(cardId)}/perks/${seg(perkId)}`, { method: "DELETE" }),
      setPerkUsed: (cardId: string, perkId: string, used: boolean) =>
        request<void>(
          `/api/cards/${seg(cardId)}/perks/${seg(perkId)}/used`,
          jsonBody("PUT", { used }),
        ),
    },
    checklist: {
      list: (tripId?: string) =>
        request<ChecklistItem[]>(
          `/api/checklist${tripId ? `?tripId=${seg(tripId)}` : ""}`,
        ),
      create: (input: {
        tripId: string;
        label: string;
        personId?: string;
        dueOn?: string;
      }) =>
        request<ChecklistItem>("/api/checklist", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(input),
        }),
      setDone: (id: string, done: boolean) =>
        request<void>(`/api/checklist/${seg(id)}/done`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ done }),
        }),
    },
    settings: {
      get: () => request<HouseholdSettings>("/api/settings"),
      update: (input: UpdateHouseholdSettingsInput) =>
        request<HouseholdSettings>("/api/settings", jsonBody("PUT", input)),
      testExtraction: (input: { subject?: string; from?: string; text: string }) =>
        request<{ bookings: ExtractedBooking[] } | { error: string }>(
          "/api/settings/extraction-test",
          jsonBody("POST", input),
        ),
      aiModels: () =>
        request<{ models: CatalogModel[]; error?: string }>("/api/settings/ai-models"),
    },
    inboundEmails: {
      list: () => request<InboundEmailMetadata[]>("/api/inbound-emails"),
      get: (id: string) => request<InboundEmailDetail>(`/api/inbound-emails/${seg(id)}`),
    },
    imports: {
      pending: () => request<PendingImportDraft[]>("/api/imports/pending"),
      accept: (draftIds: string[], tripId: string, allowDuplicates = false) =>
        request<ImportReviewResult>(
          "/api/imports/accept",
          // The key is omitted rather than sent as false, so the ordinary
          // accept is byte-identical to what it was before the guard existed.
          jsonBody("POST", {
            draftIds,
            tripId,
            ...(allowDuplicates ? { allowDuplicates: true } : {}),
          }),
        ),
      createTrip: (input: CreateTripFromDraftsInput) =>
        request<ImportReviewResult>(
          "/api/imports/create-trip",
          jsonBody("POST", input),
        ),
      dismiss: (draftIds: string[]) =>
        request<{ dismissedDraftIds: string[] }>(
          "/api/imports/dismiss",
          jsonBody("POST", { draftIds }),
        ),
      file: (file: File) => {
        const form = new FormData();
        form.set("file", file);
        return request<FileImportResult>("/api/imports/file", {
          method: "POST",
          // The browser owns the multipart boundary; setting content-type
          // manually here would produce an unreadable request.
          body: form,
        });
      },
    },
  };
}

export const api = createApi();
