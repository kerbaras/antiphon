// Local rehearsal take: record/stop/download without any session joined.

import type { CaptureSnapshot } from "../../audio/capture-controller";
import { randomId } from "../../audio/capture-controller";
import { Badge, Button, Panel, SectionLabel } from "../../components";
import { getCaptureController } from "./use-capture";

function armLocal() {
  getCaptureController().arm({
    takeId: randomId(),
    streamId: randomId(),
    retainLocal: true,
  });
}

function stop() {
  getCaptureController().stopTake();
}

async function download() {
  const flac = await getCaptureController().exportLocalFlac();
  if (!flac) return;
  const url = URL.createObjectURL(new Blob([flac], { type: "audio/flac" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `antiphon-take-${Date.now()}.flac`;
  a.click();
  URL.revokeObjectURL(url);
}

export function LocalTakePanel({ snap }: { snap: CaptureSnapshot }) {
  const state = snap.stats?.state ?? "idle";
  const recording = state === "streaming";
  return (
    <Panel className="p-4">
      <div className="flex items-center justify-between">
        <SectionLabel>Local take</SectionLabel>
        <Badge>rehearsal</Badge>
      </div>
      <div className="mt-3 flex gap-2">
        {state === "idle" || state === "closed" ? (
          <Button variant="rec" className="flex-1" onClick={armLocal}>
            ● Record
          </Button>
        ) : (
          <Button
            variant="outline"
            className="flex-1"
            onClick={stop}
            disabled={state === "draining"}
          >
            ■ Stop
          </Button>
        )}
        <Button
          variant="outline"
          className="flex-1"
          onClick={download}
          disabled={snap.localChunks === 0 || recording}
        >
          ↓ FLAC
        </Button>
      </div>
    </Panel>
  );
}
