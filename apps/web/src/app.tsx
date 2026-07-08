import { BrowserRouter, Route, Routes } from "react-router";
import { CapabilityGate } from "./capability-gate";
import { DeskRoute } from "./routes/desk";
import { HomeRoute } from "./routes/home";
import { JoinRoute } from "./routes/join";

// Audio-bearing routes sit behind the capability gate (COOP/COEP →
// SharedArrayBuffer, AudioWorklet); the landing page renders anywhere.
const desk = (
  <CapabilityGate>
    <DeskRoute />
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
