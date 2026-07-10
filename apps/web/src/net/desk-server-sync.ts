// The desk→server sync channel (antiphon-sync/1): connect/retry loop, HAVE
// exchange (§6.8), and backpressured backfill pushes from the desk's store.

import { type Conn, openServerSync, pumpFramesToChannel } from "./desk-conns";
import type { SinkWorkerLink } from "./desk-sink-worker";
import type { SignalingClient } from "./signaling-client";

const RECONNECT_DELAY_MS = 2_000;
const HIGH_WATERMARK = 1 << 20;

export interface ServerSyncLink {
  /** Idempotent connect: no-op while connecting or already open. */
  ensure(): void;
  /** Send our HAVE frames to the server (no-op while the link is down). */
  exchangeHaves(): void;
  /** Push backfill frames, respecting the channel watermark. */
  pushFrames(frames: ArrayBuffer[]): void;
}

export function createServerSync(opts: {
  signaling: SignalingClient;
  worker: SinkWorkerLink;
  conns: Map<number, Conn>;
  nextConnId(): number;
  /** Meter telemetry filter — returns true when the frame was consumed. */
  interceptMeter(bytes: ArrayBuffer): boolean;
  onStatus(status: "connected" | "connecting" | "down"): void;
}): ServerSyncLink {
  const { signaling, worker, conns, nextConnId, interceptMeter, onStatus } = opts;
  let serverConn: Conn | null = null;
  let connecting = false;

  const exchangeHaves = () => {
    const server = serverConn;
    if (server?.channel.readyState !== "open") return;
    worker.request("haves", (frames) => {
      for (const frame of frames) {
        try {
          server.channel.send(frame);
        } catch {
          break; // channel died mid-burst; the reconnect loop re-exchanges
        }
      }
    });
  };

  const onFrame = (bytes: ArrayBuffer, connId: number) => {
    // Meter telemetry (teed by the server for recorders without a P2P leg)
    // never reaches the protocol worker.
    if (interceptMeter(bytes)) return;
    // Frame dispatch happens in the worker for chunks/gaps; HAVEs from the
    // server additionally trigger a push plan from OUR store.
    const view = new Uint8Array(bytes);
    const isHave = view.length >= 4 && view[3] === 0x07;
    if (isHave) {
      const copy = bytes.slice(0);
      worker.post({ type: "plan-push", haveBytes: copy }, [copy]);
    }
    worker.post({ type: "frame", connId, bytes }, [bytes]);
  };

  const ensure = () => {
    if (connecting || serverConn?.channel.readyState === "open") return;
    if (!signaling.state.connected) return;
    connecting = true;
    onStatus("connecting");
    void openServerSync(signaling, nextConnId(), onFrame, (conn) => {
      if (serverConn !== conn) return;
      serverConn = null;
      conns.delete(conn.id);
      conn.dispose();
      onStatus("down");
      window.setTimeout(ensure, RECONNECT_DELAY_MS);
    })
      .then((conn) => {
        serverConn = conn;
        conns.set(conn.id, conn);
        connecting = false;
        onStatus("connected");
        // Announce our HAVEs immediately (§6.8).
        exchangeHaves();
      })
      .catch(() => {
        // Silent by design: "down" shows in the top bar and this retry
        // fires every ~2s while the server is away — per-attempt logging
        // would flood the console during a restart.
        connecting = false;
        onStatus("down");
        window.setTimeout(ensure, RECONNECT_DELAY_MS);
      });
  };

  return {
    ensure,
    exchangeHaves,
    pushFrames(frames) {
      const channel = serverConn?.channel;
      if (channel?.readyState !== "open") return;
      pumpFramesToChannel(channel, frames, HIGH_WATERMARK);
    },
  };
}
