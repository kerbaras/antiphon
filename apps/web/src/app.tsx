import { BrowserRouter, Route, Routes } from "react-router";
import { CapabilityGate } from "./capability-gate";
import { DeskRoute } from "./routes/desk";
import { DeskAccessGate } from "./routes/desk/access-gate";
import { HomeRoute } from "./routes/home";
import { JoinRoute } from "./routes/join";

// Audio-bearing routes sit behind the capability gate (COOP/COEP →
// SharedArrayBuffer, AudioWorklet); the landing page renders anywhere.
// The desk additionally sits behind the access gate (owner/sharee in auth
// mode; pass-through keyless) — the join route NEVER does: mic join is a
// public bearer capability (RFC §12).
const desk = (
  <CapabilityGate>
    <DeskAccessGate>
      <DeskRoute />
    </DeskAccessGate>
  </CapabilityGate>
);
const join = (
  <CapabilityGate>
    <JoinRoute />
  </CapabilityGate>
);

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/session/:uuid" element={desk} />
        <Route path="/join/:uuid" element={join} />
        {/* Capture verification without a session (M0 / iOS runbook). */}
        <Route path="/rehearse" element={join} />
        <Route path="*" element={<HomeRoute />} />
      </Routes>
    </BrowserRouter>
  );
}
