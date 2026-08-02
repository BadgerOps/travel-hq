import { Redirect, Route, Switch } from "wouter";
import { Home } from "./pages/Home.js";
import { Trips } from "./pages/Trips.js";
import { TripDetail } from "./pages/TripDetail.js";
import { Checklist } from "./pages/Checklist.js";
import { Me } from "./pages/Me.js";
import { Audit } from "./pages/Audit.js";
import { Cards } from "./pages/Cards.js";
import { Import } from "./pages/Import.js";
import { Settings } from "./pages/Settings.js";

/**
 * Every route in the app.
 *
 * Split out of main.tsx so it can be MOUNTED BY A TEST. main.tsx is a
 * bootstrap module — it calls `createRoot` on an element only index.html has,
 * registers the service worker and starts the timezone reporter, all at import
 * time — so importing it from a test runs all of that instead of the routing.
 * Which meant the redirect below, the one piece of routing with actual
 * behaviour rather than a one-to-one mapping, was the only thing in the file
 * that could not be asserted. It is here so it can be.
 */
export function AppRoutes() {
  return (
    <Switch>
      {/* Home, Trips, Me, Audit and the rest all take optional props
          (api/today/…) for testing; the real mount uses the defaults — the
          module singleton and the actual clock — so each is wired via a thunk
          rather than `component={Home}`, which would hand it wouter's
          RouteComponentProps instead. */}
      <Route path="/" component={() => <Home />} />
      <Route path="/trips" component={() => <Trips />} />
      <Route path="/trips/:id">{(params) => <TripDetail id={params.id!} />}</Route>
      <Route path="/checklist" component={() => <Checklist />} />
      <Route path="/me" component={() => <Me />} />
      <Route path="/audit" component={() => <Audit />} />
      {/* /people is gone: the roster it used to be is now a section of
          Settings, and everything personal about it lives on /me. The route
          stays as a redirect rather than falling through to "Not found"
          because it is bookmarkable, is what an older home-screen shortcut
          points at, and is still what a couple of empty states tell people to
          go and do. `replace` so the back button returns to wherever they came
          from instead of bouncing off the redirect again. The hash lands them
          on the members section rather than the top of a long page. */}
      <Route path="/people">
        <Redirect to="/settings#members" replace />
      </Route>
      <Route path="/cards" component={() => <Cards />} />
      <Route path="/import" component={() => <Import />} />
      <Route path="/settings" component={() => <Settings />} />
      <Route>
        <h3>Not found</h3>
      </Route>
    </Switch>
  );
}
