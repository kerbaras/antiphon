// Mixing desk UI — /session/:uuid
// Hosts the session: QR code for joiners, chirp calibration, ingest monitor,
// and (later) the multitrack timeline.

import { useParams } from "react-router";

export function DeskRoute() {
  const { uuid } = useParams();
  return (
    <main className="p-8">
      <h1 className="text-xl font-semibold">Desk — session {uuid}</h1>
    </main>
  );
}
