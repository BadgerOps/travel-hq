import type {
  Booking,
  BookingStatus,
  ChecklistItem,
  CreateBookingInput,
  CreatePersonInput,
  CreateTripInput,
  DocumentField,
  Identity,
  ItineraryDay,
  Person,
  Trip,
  TripRollup,
  UpdatePersonInput,
  UpdateTripInput,
} from "./types.js";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
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
      try {
        const body = (await res.json()) as { error?: string };
        if (body.error) detail = body.error;
      } catch {
        // Non-JSON error body; the status line is all we have.
      }
      throw new ApiError(`${path} failed: ${detail}`, res.status);
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
      reveal: (id: string, field: DocumentField) =>
        request<{ value: string | null }>(`/api/people/${seg(id)}/reveal/${seg(field)}`),
      create: (input: CreatePersonInput) =>
        request<Person>("/api/people", jsonBody("POST", input)),
      update: (id: string, input: UpdatePersonInput) =>
        request<Person>(`/api/people/${seg(id)}`, jsonBody("PUT", input)),
    },
    trips: {
      list: () => request<Trip[]>("/api/trips"),
      bookings: (tripId: string) =>
        request<Booking[]>(`/api/trips/${seg(tripId)}/bookings`),
      revealConfirmation: (tripId: string, bookingId: string) =>
        request<{ value: string | null }>(
          `/api/trips/${seg(tripId)}/bookings/${seg(bookingId)}/reveal`,
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
    },
    bookings: {
      assignPerson: (bookingId: string, personId: string) =>
        request<void>(
          `/api/bookings/${seg(bookingId)}/people/${seg(personId)}`,
          { method: "PUT" },
        ),
      setStatus: (bookingId: string, status: BookingStatus) =>
        request<void>(`/api/bookings/${seg(bookingId)}/status`, jsonBody("PUT", { status })),
    },
    checklist: {
      list: () => request<ChecklistItem[]>("/api/checklist"),
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
  };
}

export const api = createApi();
