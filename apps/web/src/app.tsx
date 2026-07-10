import {
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { CapabilityGate } from "./capability-gate";
import { DeskRoute } from "./routes/desk";
import { DeskAccessGate } from "./routes/desk/access-gate";
import { HomeRoute } from "./routes/home";
import { JoinRoute } from "./routes/join";

// Audio-bearing routes sit behind the capability gate (COOP/COEP →
// SharedArrayBuffer, AudioWorklet); the landing page renders anywhere.
// The desk additionally sits behind the access gate (owner/sharee in auth
// mode; pass-through keyless) — the join route NEVER does: mic join is a
// public bearer capability.
function GatedDesk() {
  return (
    <CapabilityGate>
      <DeskAccessGate>
        <DeskRoute />
      </DeskAccessGate>
    </CapabilityGate>
  );
}

function GatedJoin() {
  return (
    <CapabilityGate>
      <JoinRoute />
    </CapabilityGate>
  );
}

// Unknown paths render the landing page in place (no redirect), matching
// the previous catch-all behavior.
const rootRoute = createRootRoute({ component: Outlet, notFoundComponent: HomeRoute });

const routeTree = rootRoute.addChildren([
  createRoute({ getParentRoute: () => rootRoute, path: "/", component: HomeRoute }),
  createRoute({ getParentRoute: () => rootRoute, path: "/session/$uuid", component: GatedDesk }),
  createRoute({ getParentRoute: () => rootRoute, path: "/join/$uuid", component: GatedJoin }),
  // Capture verification without a session (iOS runbook).
  createRoute({ getParentRoute: () => rootRoute, path: "/rehearse", component: GatedJoin }),
]);

const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

export function App() {
  return <RouterProvider router={router} />;
}
