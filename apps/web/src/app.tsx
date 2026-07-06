import { BrowserRouter, Route, Routes } from "react-router";
import { DeskRoute } from "./routes/desk";
import { JoinRoute } from "./routes/join";

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/session/:uuid" element={<DeskRoute />} />
        <Route path="/join/:uuid" element={<JoinRoute />} />
        <Route path="*" element={<Home />} />
      </Routes>
    </BrowserRouter>
  );
}

function Home() {
  return (
    <main className="grid min-h-dvh place-items-center">
      <div className="text-center">
        <h1 className="text-3xl font-semibold">Antiphon</h1>
        <p className="mt-2 text-sm opacity-70">
          cross-origin isolated: {String(globalThis.crossOriginIsolated)}
        </p>
      </div>
    </main>
  );
}
