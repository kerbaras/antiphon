// Request/response bridge over the sink worker protocol: FIFO waiters for
// acks/haves/frames (the worker answers strictly in request order) and
// request-id-keyed waiters for FLAC assembly.

import type { DeskStreamStatus, FromSinkWorker, ToSinkWorker } from "../audio/sink-worker-protocol";

export interface SinkWorkerEvents {
  onReady(rebuiltChunks: number): void;
  onReply(connId: number, bytes: ArrayBuffer): void;
  onPushPlan(plan: { takeId: string; streamId: string; ranges: Array<[number, number]> }): void;
  onStatus(streams: DeskStreamStatus[]): void;
  onError(message: string): void;
}

export interface SinkWorkerLink {
  post(msg: ToSinkWorker, transfer?: Transferable[]): void;
  /** Ask for ACK/HAVE frames; the handler receives the matching result. */
  request(kind: "acks" | "haves", handler: (frames: ArrayBuffer[]) => void): void;
  /** Fetch stored frames for the given seq ranges. */
  getFrames(
    takeId: string,
    streamId: string,
    ranges: Array<[number, number]>,
    handler: (frames: ArrayBuffer[]) => void,
  ): void;
  /** Reassemble a stream's playable FLAC from the desk's own OPFS store. */
  assembleFlac(takeId: string, streamId: string): Promise<ArrayBuffer | null>;
  terminate(): void;
}

export function createSinkWorkerLink(events: SinkWorkerEvents): SinkWorkerLink {
  const worker = new Worker(new URL("../audio/sink.worker.ts", import.meta.url), {
    type: "module",
  });
  const waiters = {
    acks: [] as Array<(f: ArrayBuffer[]) => void>,
    haves: [] as Array<(f: ArrayBuffer[]) => void>,
    frames: [] as Array<(f: ArrayBuffer[]) => void>,
  };
  const flacWaiters = new Map<number, (flac: ArrayBuffer | null) => void>();
  let nextRequestId = 1;

  const post = (msg: ToSinkWorker, transfer: Transferable[] = []) => {
    worker.postMessage(msg, transfer);
  };

  worker.onmessage = (e: MessageEvent<FromSinkWorker>) => {
    const msg = e.data;
    switch (msg.type) {
      case "ready":
        events.onReady(msg.rebuiltChunks);
        break;
      case "reply":
        events.onReply(msg.connId, msg.bytes);
        break;
      case "acks-result":
        waiters.acks.shift()?.(msg.frames);
        break;
      case "haves-result":
        waiters.haves.shift()?.(msg.frames);
        break;
      case "push-plan":
        events.onPushPlan(msg);
        break;
      case "frames-result":
        waiters.frames.shift()?.(msg.frames);
        break;
      case "flac-result": {
        const waiter = flacWaiters.get(msg.requestId);
        flacWaiters.delete(msg.requestId);
        waiter?.(msg.flac);
        break;
      }
      case "status-result":
        events.onStatus(msg.streams);
        break;
      case "error":
        events.onError(msg.message);
        break;
    }
  };

  return {
    post,
    request(kind, handler) {
      waiters[kind].push(handler);
      post({ type: kind });
    },
    getFrames(takeId, streamId, ranges, handler) {
      waiters.frames.push(handler);
      post({ type: "get-frames", takeId, streamId, ranges });
    },
    assembleFlac(takeId, streamId) {
      const requestId = nextRequestId++;
      return new Promise((resolve) => {
        flacWaiters.set(requestId, resolve);
        post({ type: "assemble-flac", requestId, takeId, streamId });
      });
    },
    terminate() {
      worker.terminate();
    },
  };
}
