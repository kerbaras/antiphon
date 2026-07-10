// DeskSession's published state shape + pure state-transition helpers,
// kept transport-free so the mutation rules read (and test) in isolation.

import type { SessionState } from "@antiphon/protocol";
import type { DeskStreamStatus } from "../audio/sink-worker-protocol";
import type { FatalSignalingError } from "./signaling-client";

export interface StreamMeta {
  takeId: string;
  streamId: string;
  peerId: string | null;
  finalSeq: number | null;
}

export interface DeskSessionState {
  signalingConnected: boolean;
  peerId: string | null;
  session: SessionState | null;
  serverSync: "connected" | "connecting" | "down";
  activeTakeId: string | null;
  takeStartedAt: number | null;
  streams: StreamMeta[];
  deskStatus: DeskStreamStatus[];
  rebuiltChunks: number;
  lastChirpAt: number | null;
  /** Transient, non-fatal errors: each dismissible and self-expiring. */
  errors: string[];
  /** Terminal control-plane halt, e.g. this desk's device identity
   * reconnected in another tab and superseded us. Signaling reconnect is
   * stopped for good; the UI renders a terminal state, not a banner. */
  fatal: FatalSignalingError | null;
  /** Live capture peaks per stream (METER telemetry): value + received-at. */
  liveLevels: Record<string, { peak: number; at: number }>;
  /** Lanes (peer ids) the desk disarmed: they sit out the next take. */
  disarmedPeers: string[];
}

export function initialDeskSessionState(): DeskSessionState {
  return {
    signalingConnected: false,
    peerId: null,
    session: null,
    serverSync: "down",
    activeTakeId: null,
    takeStartedAt: null,
    streams: [],
    deskStatus: [],
    rebuiltChunks: 0,
    lastChirpAt: null,
    errors: [],
    fatal: null,
    liveLevels: {},
    disarmedPeers: [],
  };
}

/** What seeding archive-known streams requires: set-final registrations for
 * the sink worker, and the replacement stream list (null = no change). */
export interface StreamSeedPlan {
  setFinal: Array<{ takeId: string; streamId: string; finalSeq: number }>;
  streams: StreamMeta[] | null;
}

/** Plan seeding streams the ARCHIVE knows but this desk never saw announced
 * (cold desk/reload): registering each with the sink worker lets the HAVE
 * exchange cover it so the server backfills our copy. Idempotent per
 * stream; live announces for the same stream win (they arrive first). */
export function planStreamSeed(current: StreamMeta[], metas: StreamMeta[]): StreamSeedPlan {
  const setFinal: StreamSeedPlan["setFinal"] = [];
  const added: StreamMeta[] = [];
  let finalized = false;
  for (const meta of metas) {
    const known = current.find((s) => s.streamId === meta.streamId);
    if (known && known.finalSeq !== null) continue; // fully known already
    if (meta.finalSeq !== null) {
      setFinal.push({ takeId: meta.takeId, streamId: meta.streamId, finalSeq: meta.finalSeq });
      if (known) finalized = true;
    }
    if (!known) added.push({ ...meta });
  }
  if (added.length === 0 && !finalized) return { setFinal, streams: null };
  const seededFinal = new Map(
    metas.filter((m) => m.finalSeq !== null).map((m) => [m.streamId, m.finalSeq]),
  );
  return {
    setFinal,
    streams: [
      ...current.map((s) =>
        s.finalSeq === null && seededFinal.has(s.streamId)
          ? { ...s, finalSeq: seededFinal.get(s.streamId) as number }
          : s,
      ),
      ...added,
    ],
  };
}

/** Replace-or-append the announced stream (announces re-arrive on rejoin). */
export function upsertAnnouncedStream(
  streams: StreamMeta[],
  meta: { takeId: string; streamId: string; fromPeerId?: string | undefined },
): StreamMeta[] {
  const next = streams.filter((s) => s.streamId !== meta.streamId);
  next.push({
    takeId: meta.takeId,
    streamId: meta.streamId,
    peerId: meta.fromPeerId ?? null,
    finalSeq: null,
  });
  return next;
}

export function withStreamFinal(
  streams: StreamMeta[],
  streamId: string,
  finalSeq: number,
): StreamMeta[] {
  return streams.map((s) => (s.streamId === streamId ? { ...s, finalSeq } : s));
}

/** Drop deleted streams from the list and their live meter levels. */
export function dropDeletedStreams(
  state: Pick<DeskSessionState, "streams" | "liveLevels">,
  ids: Set<string>,
): Pick<DeskSessionState, "streams" | "liveLevels"> {
  return {
    streams: state.streams.filter((s) => !ids.has(s.streamId)),
    liveLevels: Object.fromEntries(Object.entries(state.liveLevels).filter(([id]) => !ids.has(id))),
  };
}
