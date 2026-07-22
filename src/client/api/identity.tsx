import { createContext, useContext, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { api as defaultApi } from "./client.js";
import type { Identity } from "./types.js";

const IdentityContext = createContext<Identity | null>(null);

export function useIdentity(): Identity | null {
  return useContext(IdentityContext);
}

/**
 * Whether to offer a reveal affordance at all. The reveal endpoints return
 * 403 for `viewer`, so showing one to a viewer is an affordance that can only
 * ever fail.
 *
 * Unknown identity (still loading, or /api/me itself failed) fails OPEN, and
 * deliberately: this governs presentation only, and the server is the thing
 * that actually enforces the rule. Failing closed would hide a working button
 * from an owner for as long as the request is in flight.
 */
export function useCanReveal(): boolean {
  return useIdentity()?.role !== "viewer";
}

/**
 * Whether to offer a write affordance at all (toggling a checklist item,
 * editing a booking, ...). Every mutating repo method throws ForbiddenError
 * for `viewer`, so a button that can only 403 is the same false offer
 * `useCanReveal` exists to avoid — see MaskedValue.
 *
 * Unknown identity fails OPEN for the same reason as useCanReveal: this
 * governs presentation only, the server enforces the rule, and failing
 * closed would hide a working control from an owner while /api/me is still
 * in flight.
 */
export function useCanWrite(): boolean {
  return useIdentity()?.role !== "viewer";
}

export function IdentityProvider({
  api = defaultApi,
  children,
}: {
  api?: Pick<typeof defaultApi, "me">;
  children: ReactNode;
}) {
  const [identity, setIdentity] = useState<Identity | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.me().then(
      (me) => {
        if (!cancelled) setIdentity(me);
      },
      () => {
        // Swallowed on purpose. A failing /api/me means the session is gone,
        // which every data-fetching page reports for itself with a much more
        // useful message than a nav chip could -- see Home's error panel.
        // Duplicating it here would show two errors for one cause.
      },
    );
    return () => {
      cancelled = true;
    };
  }, [api]);

  return <IdentityContext.Provider value={identity}>{children}</IdentityContext.Provider>;
}
