import React from "react";
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
import { IdentityProvider, useIdentity } from "./api/identity.js";
import "./styles.css";

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
