import { BrowserRouter, Route, Routes, useNavigate } from "react-router";
import { DeskRoute } from "./routes/desk";
import { JoinRoute } from "./routes/join";
import { Button, Wordmark } from "./ui/kit";

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/session/:uuid" element={<DeskRoute />} />
        <Route path="/join/:uuid" element={<JoinRoute />} />
        {/* Capture verification without a session (M0 / iOS runbook). */}
        <Route path="/rehearse" element={<JoinRoute />} />
        <Route path="*" element={<Home />} />
      </Routes>
    </BrowserRouter>
  );
}

function Home() {
  const navigate = useNavigate();
  return (
    <main className="grid min-h-dvh place-items-center bg-void">
      <div className="flex flex-col items-center gap-6">
        <Wordmark />
        <p className="max-w-xs text-center text-[12px] leading-relaxed text-text-dim">
          Phones are the microphones. The desk is the console. Every take survives the network.
        </p>
        <Button variant="accent" onClick={() => navigate(`/session/${crypto.randomUUID()}`)}>
          Create session
        </Button>
        <p className="font-mono text-[9px] text-text-faint">
          cross-origin isolated: {String(globalThis.crossOriginIsolated)}
        </p>
      </div>
    </main>
  );
}
