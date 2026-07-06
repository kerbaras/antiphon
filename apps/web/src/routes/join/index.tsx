// Phone recorder UI — /join/:uuid
// Mobile Safari is the hostile baseline: build for it first.
// Capture flags: echoCancellation/noiseSuppression/autoGainControl all false.

import { useParams } from "react-router";

export function JoinRoute() {
  const { uuid } = useParams();
  return (
    <main className="p-8">
      <h1 className="text-xl font-semibold">Join — session {uuid}</h1>
    </main>
  );
}
