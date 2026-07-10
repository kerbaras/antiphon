// Desk sink worker: the SAME SinkEngine as the server, persisting to OPFS
// (store helpers in sink-store.ts). Persist-before-ack: all work serializes
// on a chain and ACK generation joins it, so an ACK never claims an
// unpersisted chunk.

import { init, SinkEngine } from "@antiphon/core-wasm";
import {
  assembleFlacFromStore,
  digestFor,
  energyFor,
  type MetaStore,
  persistChunk,
  rebuild,
  streamDirName,
  uuidBytes,
  writeFile,
} from "./sink-store";
import type { DeskStreamStatus, FromSinkWorker, ToSinkWorker } from "./sink-worker-protocol";

let engine: SinkEngine | null = null;
let root: FileSystemDirectoryHandle | null = null;
const metas: MetaStore = new Map();

let chain: Promise<void> = Promise.resolve();

function post(msg: FromSinkWorker, transfer: Transferable[] = []) {
  (self as unknown as Worker).postMessage(msg, transfer);
}

function nowUs(): number {
  return performance.now() * 1_000;
}

async function handle(msg: ToSinkWorker): Promise<void> {
  switch (msg.type) {
    case "configure": {
      await init();
      engine = new SinkEngine();
      const opfs = await navigator.storage.getDirectory();
      const base = await opfs.getDirectoryHandle("antiphon", { create: true });
      root = await base.getDirectoryHandle(msg.sessionId, { create: true });
      const rebuiltChunks = await rebuild(root, engine, metas);
      post({ type: "ready", rebuiltChunks });
      break;
    }
    case "frame": {
      if (!engine) return;
      const bytes = new Uint8Array(msg.bytes);
      const result = engine.ingest(bytes, nowUs());
      try {
        switch (result.kind) {
          case "stored":
          case "continuity": {
            const meta = JSON.parse(result.json) as {
              takeId: string;
              streamId: string;
              seq: number;
              crc32c: number;
              payloadLen: number;
              sampleCount: number;
            };
            if (root) await persistChunk(root, metas, meta.takeId, meta.streamId, meta, bytes);
            else throw new Error("no OPFS root");
            break;
          }
          case "gap-report": {
            const list = JSON.parse(result.json) as {
              takeId: string;
              streamId: string;
              ranges: Array<[number, number]>;
            };
            if (root) {
              const dir = await root.getDirectoryHandle(streamDirName(list.takeId, list.streamId), {
                create: true,
              });
              for (const [s, e] of list.ranges) {
                await writeFile(dir, `gap_${s}_${e}`, new Uint8Array(0));
              }
            }
            break;
          }
          case "time-ping": {
            const reply = result.reply;
            if (reply) {
              const buf = reply.buffer as ArrayBuffer;
              post({ type: "reply", connId: msg.connId, bytes: buf }, [buf]);
            }
            break;
          }
          default:
            break;
        }
      } finally {
        result.free();
      }
      break;
    }
    case "set-final": {
      if (!engine || !root) return;
      engine.set_final_seq(uuidBytes(msg.takeId), uuidBytes(msg.streamId), msg.finalSeq);
      const dir = await root.getDirectoryHandle(streamDirName(msg.takeId, msg.streamId), {
        create: true,
      });
      await writeFile(
        dir,
        "final.json",
        new TextEncoder().encode(JSON.stringify({ finalSeq: msg.finalSeq })),
      );
      break;
    }
    case "acks": {
      if (!engine) return;
      const frames = [...engine.ack_frames()].map((f) => (f as Uint8Array).buffer as ArrayBuffer);
      post({ type: "acks-result", frames }, frames);
      break;
    }
    case "haves": {
      if (!engine) return;
      const frames = [...engine.have_frames()].map((f) => (f as Uint8Array).buffer as ArrayBuffer);
      post({ type: "haves-result", frames }, frames);
      break;
    }
    case "plan-push": {
      if (!engine) return;
      const plan = JSON.parse(engine.plan_push(new Uint8Array(msg.haveBytes))) as {
        takeId: string;
        streamId: string;
        ranges: Array<[number, number]>;
      };
      post({ type: "push-plan", ...plan });
      break;
    }
    case "get-frames": {
      if (!root) return;
      const frames: ArrayBuffer[] = [];
      try {
        const dir = await root.getDirectoryHandle(streamDirName(msg.takeId, msg.streamId));
        for (const [start, end] of msg.ranges) {
          for (let seq = start; seq <= end; seq++) {
            try {
              const fh = await dir.getFileHandle(String(seq));
              frames.push(await (await fh.getFile()).arrayBuffer());
            } catch {
              // not held; skip
            }
          }
        }
      } catch {
        // stream dir missing entirely
      }
      post({ type: "frames-result", frames }, frames);
      break;
    }
    case "assemble-flac": {
      if (!root) {
        post({ type: "flac-result", requestId: msg.requestId, flac: null, reason: "no store" });
        return;
      }
      const result = await assembleFlacFromStore(root, metas, msg.takeId, msg.streamId);
      if (result.flac !== null) {
        post({ type: "flac-result", requestId: msg.requestId, flac: result.flac }, [result.flac]);
        return;
      }
      post({ type: "flac-result", requestId: msg.requestId, flac: null, reason: result.reason });
      break;
    }
    case "delete-streams": {
      // Server-confirmed deletion: drop engine state (so the streams leave
      // ACK/HAVE traffic and can't be re-pushed to us) and the OPFS copy.
      for (const { takeId, streamId } of msg.streams) {
        engine?.remove_stream(uuidBytes(takeId), uuidBytes(streamId));
        metas.delete(streamDirName(takeId, streamId));
        try {
          await root?.removeEntry(streamDirName(takeId, streamId), { recursive: true });
        } catch {
          // Directory never existed (stream lived only at the server).
        }
      }
      break;
    }
    case "status": {
      if (!engine) {
        post({ type: "status-result", streams: [] });
        return;
      }
      const raw = JSON.parse(engine.status_json()) as Array<
        Omit<DeskStreamStatus, "digest" | "energy" | "totalSamples">
      >;
      const streams: DeskStreamStatus[] = [];
      for (const s of raw) {
        streams.push({
          ...s,
          digest: await digestFor(metas, s.takeId, s.streamId),
          ...energyFor(metas, s.takeId, s.streamId),
        });
      }
      post({ type: "status-result", streams });
      break;
    }
  }
}

self.onmessage = (event: MessageEvent<ToSinkWorker>) => {
  chain = chain
    .then(() => handle(event.data))
    .catch((e) => post({ type: "error", message: String(e) }));
};
