import { describe, it, expect, vi, afterEach } from "vitest";
import type { ReactNode } from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Me } from "../../../src/client/pages/Me.js";
import { ApiError } from "../../../src/client/api/client.js";
import { IdentityProvider } from "../../../src/client/api/identity.js";
import type { Identity, Person, UpdatePersonInput } from "../../../src/client/api/types.js";

const AVA: Person = {
  id: "p1",
  displayName: "Ava",
  dob: "2008-04-02",
  email: "ava@example.com",
  phone: "+1 208 555 0123",
  notes: null,
  passportExpiry: "2027-01-15",
  passportCountry: "US",
  passportNumberMasked: "••••2119",
  driverLicenseExpiry: null,
  driverLicenseJurisdiction: null,
  driverLicenseNumberMasked: null,
  knownTravelerNumberMasked: null,
  redressNumberMasked: null,
};

const NOTIFICATION_STATE = {
  preferences: {
    digestEnabled: false,
    digestSendTime: null as string | null,
    remindersEnabled: true,
    reminderLeadMinutes: 60,
  },
  timezone: { timezone: null as string | null, source: null, updatedAt: null as string | null },
  vapidPublicKey: "test-key",
};

function makeApi(over: Record<string, unknown> = {}) {
  return {
    people: {
      me: vi.fn(async (): Promise<Person | undefined> => AVA),
      update: vi.fn(async (_id: string, input: UpdatePersonInput) => ({ ...AVA, ...input })),
      reveal: vi.fn(async () => ({ value: "C03X72119" })),
      ...over,
    },
    notifications: {
      preferences: vi.fn(async () => NOTIFICATION_STATE),
      update: vi.fn(async () => NOTIFICATION_STATE),
      setTimezone: vi.fn(async () => NOTIFICATION_STATE),
      devices: vi.fn(async () => ({ devices: [] as unknown[] })),
      registerDevice: vi.fn(),
      removeDevice: vi.fn(),
      test: vi.fn(async () => ({ results: [] as unknown[] })),
      forBooking: vi.fn(),
      setBooking: vi.fn(),
      setTrip: vi.fn(),
    },
  };
}

function asRole(role: Identity["role"], ui: ReactNode) {
  const me = async () => ({
    userId: "u1",
    email: "ava@example.com",
    householdId: "hh-a",
    role,
  });
  return render(<IdentityProvider api={{ me } as never}>{ui}</IdentityProvider>);
}

function renderMe(api = makeApi(), role: Identity["role"] = "viewer") {
  asRole(role, <Me api={api as never} />);
  return api;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Me — no profile", () => {
  /**
   * The state a shared-trip guest sees. `ensureCurrentUser` stopped creating
   * rows, so an empty form here would save nowhere while looking like it
   * worked — the reason this is asserted rather than left to the eye.
   */
  it("explains that there is no profile instead of rendering an empty form", async () => {
    const api = makeApi({ me: vi.fn(async () => undefined) });
    renderMe(api);
    expect(await screen.findByText(/no profile yet/i)).toBeInTheDocument();
    expect(screen.getByText(/ask a household owner to add you/i)).toBeInTheDocument();
    expect(screen.queryByLabelText("Name")).toBeNull();
    expect(screen.queryByRole("button", { name: /save your profile/i })).toBeNull();
  });

  it("still offers notification settings, which are keyed by the account and not the person row", async () => {
    const api = makeApi({ me: vi.fn(async () => undefined) });
    renderMe(api);
    await screen.findByText(/no profile yet/i);
    expect(await screen.findByRole("region", { name: /notifications/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/reminder lead time/i)).toBeInTheDocument();
  });

  /**
   * 204-means-nothing and "the request failed" are different answers with
   * different remedies, and the page must never present one as the other.
   */
  it("distinguishes a failed load from having no profile", async () => {
    const api = makeApi({
      me: vi.fn(async () => {
        throw new ApiError("/api/people/me failed", 500);
      }),
    });
    renderMe(api);
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.queryByText(/no profile yet/i)).toBeNull();
  });
});

describe("Me — a viewer editing their own row", () => {
  /**
   * The whole point of the feature. `PersonRepo.update` allows a row linked to
   * the caller before it consults the role at all, so gating this form on
   * `useCanWrite()` would hide a form the server would have accepted.
   */
  it("gives a viewer editable fields and a working save", async () => {
    const api = makeApi();
    renderMe(api, "viewer");
    const phone = await screen.findByLabelText("Phone");
    expect(phone).not.toHaveAttribute("readonly");
    await userEvent.clear(phone);
    await userEvent.type(phone, "+1 208 555 9999");
    await userEvent.click(screen.getByRole("button", { name: /save your profile/i }));

    expect(api.people.update).toHaveBeenCalledWith(
      "p1",
      expect.objectContaining({ phone: "+1 208 555 9999", displayName: "Ava" }),
    );
    expect(await screen.findByRole("status")).toHaveTextContent(/saved/i);
  });

  it("pre-fills the plain fields from the loaded profile", async () => {
    renderMe();
    expect(await screen.findByLabelText("Name")).toHaveValue("Ava");
    expect(screen.getByLabelText("Email")).toHaveValue("ava@example.com");
    expect(screen.getByLabelText(/passport expiry/i)).toHaveValue("2027-01-15");
    expect(screen.getByLabelText(/passport country/i)).toHaveValue("US");
  });

  it("refuses to submit an empty name without calling the API", async () => {
    const api = makeApi();
    renderMe(api);
    await userEvent.clear(await screen.findByLabelText("Name"));
    await userEvent.click(screen.getByRole("button", { name: /save your profile/i }));
    expect(api.people.update).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent(/name is required/i);
  });

  /**
   * A repository ValidationError is a 400 with no `details`, which
   * lib/errors.ts surfaces verbatim. Paraphrasing it here would throw away the
   * only sentence that names the offending field.
   */
  it("shows the server's own message when the save is rejected", async () => {
    const api = makeApi();
    api.people.update = vi.fn(async () => {
      throw new ApiError("/api/people/p1 failed", 400, "dob must be a calendar date (YYYY-MM-DD)");
    }) as never;
    renderMe(api);
    await screen.findByLabelText("Name");
    await userEvent.click(screen.getByRole("button", { name: /save your profile/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/calendar date/i);
  });
});

describe("Me — documents", () => {
  /**
   * The disaster case, restated for this page: `passportNumberMasked` reaching
   * the input would encrypt "••••2119" over a real passport number, silently,
   * with a 200.
   */
  it("NEVER pre-fills a document input with the masked value", async () => {
    renderMe();
    expect(await screen.findByLabelText(/^passport number/i)).toHaveValue("");
  });

  it("omits an untouched document from the update body entirely", async () => {
    const api = makeApi();
    renderMe(api);
    const name = await screen.findByLabelText("Name");
    await userEvent.clear(name);
    await userEvent.type(name, "Ava Wright");
    await userEvent.click(screen.getByRole("button", { name: /save your profile/i }));

    const body = api.people.update.mock.calls[0]?.[1] as Record<string, unknown>;
    // Absent, not null and above all not the masked string. `in` rather than a
    // truthiness check, because `null` here would mean "clear it".
    expect("passportNumber" in body).toBe(false);
    expect(JSON.stringify(body)).not.toContain("••••");
  });

  it("sends an explicit null when a stored document is cleared", async () => {
    const api = makeApi();
    renderMe(api);
    await userEvent.click(
      await screen.findByRole("button", { name: /clear stored passport number/i }),
    );
    await userEvent.click(screen.getByRole("button", { name: /save your profile/i }));
    const body = api.people.update.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body.passportNumber).toBe(null);
  });

  it("sends new plaintext when a replacement is typed", async () => {
    const api = makeApi();
    renderMe(api);
    await userEvent.type(await screen.findByLabelText(/^passport number/i), "X99Z00042");
    await userEvent.click(screen.getByRole("button", { name: /save your profile/i }));
    const body = api.people.update.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body.passportNumber).toBe("X99Z00042");
  });

  it("keeps driver's licence suggestions in dedicated editable fields", async () => {
    const api = makeApi();
    renderMe(api);
    await userEvent.type(await screen.findByLabelText(/^driver's licence number/i), "D1234567");
    fireEvent.change(screen.getByLabelText(/driver's licence expiry/i), {
      target: { value: "2031-04-15" },
    });
    await userEvent.type(screen.getByLabelText(/issuing state or country/i), "ID");
    await userEvent.click(screen.getByRole("button", { name: /save your profile/i }));
    expect(api.people.update).toHaveBeenCalledWith(
      "p1",
      expect.objectContaining({
        driverLicenseNumber: "D1234567",
        driverLicenseExpiry: "2031-04-15",
        driverLicenseJurisdiction: "ID",
      }),
    );
  });

  it("degrades licence scanning to honest manual entry when PDF417 is unsupported", async () => {
    renderMe();
    expect(await screen.findByText(/cannot read the barcode on a US licence/i)).toBeInTheDocument();
    expect(screen.queryByText(/photograph licence back/i)).toBeNull();
    expect(screen.getByLabelText(/^driver's licence number/i)).toBeInTheDocument();
  });

  /**
   * Self-reveal is allowed at any role (`PersonRepo.revealDocument`), so the
   * affordance must be offered at any role. A viewer who can store a number
   * and never read it back cannot tell a typo from a correct entry.
   */
  it("lets a VIEWER reveal their own passport number", async () => {
    const api = makeApi();
    renderMe(api, "viewer");
    await userEvent.click(
      await screen.findByRole("button", { name: /reveal your passport number/i }),
    );
    expect(api.people.reveal).toHaveBeenCalledWith("p1", "passport_number");
    expect(await screen.findByText("C03X72119")).toBeInTheDocument();
  });

  it("says the reveal did not happen rather than failing silently", async () => {
    const api = makeApi();
    api.people.reveal = vi.fn(async () => {
      throw new ApiError("/api/people/p1/reveal/passport_number failed", 403);
    }) as never;
    renderMe(api);
    await userEvent.click(
      await screen.findByRole("button", { name: /reveal your passport number/i }),
    );
    expect(await screen.findByText(/could not be revealed/i)).toBeInTheDocument();
  });

  it("offers no reveal for a document that has nothing stored", async () => {
    renderMe();
    await screen.findByLabelText(/^known traveler number/i);
    expect(screen.queryByRole("button", { name: /reveal your known traveler number/i })).toBeNull();
  });
});

/**
 * Notification settings moved here from /settings, which is where they belong:
 * they are per-user, and /settings is the household admin page. These are the
 * behaviours that used to be asserted against Settings.
 */
describe("Me — notifications", () => {
  function installedPwa() {
    Object.defineProperty(navigator, "userAgent", {
      value: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Safari/604",
      configurable: true,
    });
    Object.defineProperty(navigator, "standalone", { value: true, configurable: true });
    Object.defineProperty(navigator, "serviceWorker", {
      value: { getRegistration: async () => undefined },
      configurable: true,
    });
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true })));
    vi.stubGlobal("PushManager", class {});
    vi.stubGlobal("Notification", { permission: "default" });
  }

  afterEach(() => {
    Object.defineProperty(navigator, "userAgent", { value: "vitest", configurable: true });
    Object.defineProperty(navigator, "standalone", { value: undefined, configurable: true });
    Object.defineProperty(navigator, "serviceWorker", { value: undefined, configurable: true });
  });

  it("renders the notifications card alongside the profile", async () => {
    renderMe();
    const card = await screen.findByRole("region", { name: /notifications/i });
    expect(within(card).getByLabelText(/reminder lead time/i)).toBeInTheDocument();
  });

  it("shows install instructions, and NO enable button, on an iPhone in a Safari tab", async () => {
    Object.defineProperty(navigator, "userAgent", {
      value: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Safari/604",
      configurable: true,
    });
    Object.defineProperty(navigator, "standalone", { value: false, configurable: true });
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false })));
    renderMe();
    expect(await screen.findByTestId("push-install-instructions")).toHaveTextContent(
      /add to home screen/i,
    );
    expect(screen.queryByRole("button", { name: /enable notifications/i })).toBeNull();
  });

  it("offers the enable button once the PWA is installed to the home screen", async () => {
    installedPwa();
    renderMe();
    expect(
      await screen.findByRole("button", { name: /enable notifications on this device/i }),
    ).toBeInTheDocument();
  });

  it("saves the digest time and the lead time together", async () => {
    const api = makeApi();
    renderMe(api);

    // fireEvent.change, never userEvent.type: jsdom leaves a type="time" value
    // empty for typed keystrokes (see tests/client/trip/BookingDialog.test.tsx).
    const time = await screen.findByLabelText(/digest send time/i);
    fireEvent.change(time, { target: { value: "06:45" } });
    await userEvent.click(screen.getByLabelText(/send me a daily digest/i));
    const lead = screen.getByLabelText(/reminder lead time/i);
    fireEvent.change(lead, { target: { value: "0" } });
    await userEvent.click(screen.getByRole("button", { name: /save notification settings/i }));

    // 0 minutes is "right when it starts" — a real lead time, and it must
    // survive as the number 0 rather than being read as "nothing chosen".
    expect(api.notifications.update).toHaveBeenCalledWith({
      digestEnabled: true,
      digestSendTime: "06:45",
      remindersEnabled: true,
      reminderLeadMinutes: 0,
    });
  });

  it("pins a manually entered zone", async () => {
    const api = makeApi();
    renderMe(api);
    const field = await screen.findByLabelText(/^timezone$/i);
    await userEvent.type(field, "Asia/Tokyo");
    await userEvent.click(screen.getByRole("button", { name: /pin this timezone/i }));
    expect(api.notifications.setTimezone).toHaveBeenCalledWith("Asia/Tokyo", "manual");
  });
});
