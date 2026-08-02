import React from "react";
// styles.css is the base sheet: every page/component stylesheet builds on its
// primitives (.booking-row, .seg, .card, …) and must come AFTER it in the
// bundle to win the cascade. Vite orders CSS by module graph position, so this
// import has to sit before any component import — moving it below them puts
// the base sheet last and silently overrides page-level media-query rules
// (e.g. trip.css's mobile .booking-main drop).
import "./styles.css";
import { createRoot } from "react-dom/client";
import { Route, Switch } from "wouter";
import { Shell } from "./components/Shell.js";
import { Home } from "./pages/Home.js";
import { Trips } from "./pages/Trips.js";
import { TripDetail } from "./pages/TripDetail.js";
import { Checklist } from "./pages/Checklist.js";
import { People } from "./pages/People.js";
import { Cards } from "./pages/Cards.js";
import { Import } from "./pages/Import.js";
import { Settings } from "./pages/Settings.js";
import { IdentityProvider, useIdentity } from "./api/identity.js";
import { api } from "./api/client.js";
import { createTimezoneReporter, ensureServiceWorker } from "./lib/push.js";

function ShellWithIdentity({ children }: { children: React.ReactNode }) {
  return <Shell identity={useIdentity()}>{children}</Shell>;
}

function App() {
  return (
    <IdentityProvider>
      <ShellWithIdentity>
        <Switch>
          {/* Home, Trips, and People all take optional props (api/today/…)
              for testing; the real mount uses the defaults — the module
              singleton and the actual clock — so each is wired via a thunk
              rather than `component={Home}`, which would hand it wouter's
              RouteComponentProps instead. */}
          <Route path="/" component={() => <Home />} />
          <Route path="/trips" component={() => <Trips />} />
          <Route path="/trips/:id">
            {(params) => <TripDetail id={params.id!} />}
          </Route>
          <Route path="/checklist" component={() => <Checklist />} />
          <Route path="/people" component={() => <People />} />
          <Route path="/cards" component={() => <Cards />} />
          <Route path="/import" component={() => <Import />} />
          <Route path="/settings" component={() => <Settings />} />
          <Route>
            <h3>Not found</h3>
          </Route>
        </Switch>
      </ShellWithIdentity>
    </IdentityProvider>
  );
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

// PROD-only so dev HMR never fights a cached shell. The registration itself is
// memoized by ensureServiceWorker(), so the "Enable notifications" button in
// Settings — which needs the ServiceWorkerRegistration to call
// pushManager.subscribe() — shares this one rather than racing a second
// registration of the same script. (In dev nothing is registered until that
// button is actually pressed.)
if ("serviceWorker" in navigator && import.meta.env.PROD) {
  ensureServiceWorker().catch(() => {});
}

/**
 * Tell the server where this device is, on open and on every return to the
 * foreground.
 *
 * The second half is the point. A session that was opened in Boise and
 * survives in a background tab through a flight to Amsterdam would otherwise
 * keep reporting Boise until the tab was closed — and the daily digest fires
 * at a LOCAL wall clock, so it would arrive at 08:00 in a timezone the reader
 * left yesterday. `visibilitychange` is the one event that fires when someone
 * takes their phone off airplane mode and opens the app at the gate.
 *
 * Sent as `source: "device"`, which the server refuses to let overwrite a
 * `manual` pin — so someone who deliberately set their zone keeps it through
 * every layover. The reporter itself only posts when the zone actually
 * differs; see createTimezoneReporter.
 */
const reportTimezone = createTimezoneReporter(api);
void reportTimezone();
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") void reportTimezone();
});
