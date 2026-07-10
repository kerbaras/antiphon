// Desk data model: observed takes, stream→performer attribution, the
// frozen-order track rows, and chronological take slots.

import { useMemo, useRef } from "react";
import type { DeskStreamStatus } from "../../audio/sink-worker-protocol";
import type { CollabClient } from "../../net/collab";
import type { DeskSessionState } from "../../net/desk-session";
import { orderTakeIds } from "./attribution";
import {
  applyLaneMoves,
  deviceName,
  initialsOf,
  type LaneCandidate,
  SAMPLE_RATE,
  stableLaneOrder,
  TAKE_GAP_SECONDS,
  type TakeSlot,
  TRACK_COLORS,
  type TrackRow,
} from "./track-model";
import { useCollabLaneOrder } from "./use-collab";
import { useSessionAttribution } from "./use-desk";

type Recorder = NonNullable<DeskSessionState["session"]>["peers"][number];

export function useDeskRows({
  sessionId,
  state,
  collab,
  recorders,
  deskInputPeerId,
  receiving,
}: {
  sessionId: string;
  state: DeskSessionState;
  collab: CollabClient;
  recorders: Recorder[];
  deskInputPeerId: string | null;
  receiving: Set<string>;
}) {
  // Every take this desk can see: live announces first (arrival order),
  // then OPFS-rebuilt history, then the active take. Drives attribution
  // fetching and the server-status polling set.
  const observedTakeIds = useMemo(() => {
    const ids: string[] = [];
    for (const s of state.streams) if (!ids.includes(s.takeId)) ids.push(s.takeId);
    for (const s of state.deskStatus) if (!ids.includes(s.takeId)) ids.push(s.takeId);
    if (state.activeTakeId && !ids.includes(state.activeTakeId)) ids.push(state.activeTakeId);
    return ids;
  }, [state.streams, state.deskStatus, state.activeTakeId]);

  // Cold-desk attribution: the archive's stream→peer mapping, take
  // chronology, and peer identities — what live announces would have held.
  const attribution = useSessionAttribution(sessionId, observedTakeIds);

  // Stream → performer: archive first, live announces layered over
  // (fresher for the rolling take).
  const peerByStream = useMemo(() => {
    const map = new Map(attribution.peerByStream);
    for (const s of state.streams) if (s.peerId) map.set(s.streamId, s.peerId);
    return map;
  }, [attribution, state.streams]);

  // Lane order is FROZEN: rank assigned on first sight, held for the page
  // lifetime — takes, renames, reconnects and late attribution never move
  // a visible row. New lanes append ordered by the peer's joinedAt, so a
  // cold reload rebuilds the identical order (track-model.ts).
  const laneRanks = useRef(new Map<string, number>());
  const laneRanksSession = useRef(sessionId);
  if (laneRanksSession.current !== sessionId) {
    laneRanksSession.current = sessionId;
    laneRanks.current = new Map();
  }
  // Deliberate operator moves layer over the frozen ranks via the shared
  // doc, so they persist across reloads and sync across desks.
  const [laneOrder, writeLaneOrderMap] = useCollabLaneOrder(collab);

  const rows = useMemo(() => {
    const streamsByKey = new Map<string, DeskStreamStatus[]>();
    const aliasesByKey = new Map<string, string[]>();
    const streamKeyOrder: string[] = [];
    for (const stream of state.deskStatus) {
      const peerId = peerByStream.get(stream.streamId) ?? null;
      // Cold reload: OPFS-rebuilt streams can reach deskStatus before the
      // attribution fetch returns; hold them one round-trip so streamId
      // fallback lanes don't freeze in worker-iteration order.
      if (!peerId && !attribution.ready) continue;
      const key = peerId ?? stream.streamId;
      const bucket = streamsByKey.get(key);
      if (bucket) bucket.push(stream);
      else {
        streamsByKey.set(key, [stream]);
        streamKeyOrder.push(key);
      }
      if (peerId) {
        const aliases = aliasesByKey.get(key);
        if (aliases) aliases.push(stream.streamId);
        else aliasesByKey.set(key, [stream.streamId]);
      }
    }
    const joinedAtOf = (peerId: string): number | null => {
      const live = recorders.find((p) => p.peerId === peerId);
      const liveMs = live ? Date.parse(live.joinedAt) : Number.NaN;
      if (Number.isFinite(liveMs)) return liveMs;
      return attribution.peers.get(peerId)?.joinedAtMs ?? null;
    };
    const candidates: LaneCandidate[] = [];
    const seen = new Set<string>();
    for (const peer of recorders) {
      if (seen.has(peer.peerId)) continue;
      seen.add(peer.peerId);
      candidates.push({
        key: peer.peerId,
        joinedAtMs: joinedAtOf(peer.peerId),
        aliases: aliasesByKey.get(peer.peerId) ?? [],
      });
    }
    for (const key of streamKeyOrder) {
      if (seen.has(key)) continue;
      seen.add(key);
      const attributed = aliasesByKey.has(key); // key is a peerId
      candidates.push({
        key,
        joinedAtMs: attributed ? joinedAtOf(key) : null,
        aliases: aliasesByKey.get(key) ?? [],
      });
    }
    // A lane the archive re-keyed (streamId fallback → attributed peer)
    // inherits the move ordinal written under its former key, so
    // attribution never undoes an operator's move.
    const ordinalOf = (key: string): number | undefined => {
      if (laneOrder[key] !== undefined) return laneOrder[key];
      const inherited = (aliasesByKey.get(key) ?? [])
        .map((alias) => laneOrder[alias])
        .filter((ordinal): ordinal is number => ordinal !== undefined);
      return inherited.length > 0 ? Math.min(...inherited) : undefined;
    };
    const frozen = stableLaneOrder(laneRanks.current, candidates);
    return applyLaneMoves(frozen, ordinalOf).map((key): TrackRow => {
      const index = laneRanks.current.get(key) as number;
      const streams = streamsByKey.get(key) ?? [];
      const peer = recorders.find((p) => p.peerId === key);
      const archived = attribution.peers.get(key);
      const attributed = peer !== undefined || archived !== undefined;
      const nickname = peer?.deviceInfo.label?.trim() || archived?.label?.trim();
      const userAgent = peer?.deviceInfo.userAgent ?? archived?.userAgent;
      return {
        key,
        index,
        peerId: peer?.peerId ?? archived?.peerId ?? null,
        name:
          nickname ||
          (userAgent !== undefined
            ? `${deviceName(userAgent)} ${index + 1}`
            : `Stream ${index + 1}`),
        color: TRACK_COLORS[index % TRACK_COLORS.length] as string,
        peerInitials:
          initialsOf(nickname) ??
          (attributed ? key : (streams[0]?.streamId ?? key)).slice(0, 2).toUpperCase(),
        // Live roster first, archive fallback — a lane keeps its face
        // after the phone disconnects.
        avatarUrl: peer?.deviceInfo.avatarUrl ?? archived?.avatarUrl ?? null,
        // The chip keeps device provenance even when a nickname rules the
        // lane title ("Maria" · chip "iPhone").
        peerLabel:
          attributed && key === deskInputPeerId
            ? "Desk"
            : userAgent !== undefined
              ? deviceName(userAgent)
              : null,
        streams,
        receiving: streams.some((s) => receiving.has(s.streamId)),
        armed: streams.some((s) => s.takeId === state.activeTakeId),
      };
    });
  }, [
    state.deskStatus,
    peerByStream,
    recorders,
    attribution,
    receiving,
    state.activeTakeId,
    deskInputPeerId,
    laneOrder,
  ]);

  // Takes in chronological order (archive startedAt) with sequential slot
  // offsets — stable across reloads and identical on every desk. Takes the
  // archive doesn't know yet keep observed order after the dated ones.
  const takes = useMemo(() => {
    const observed: string[] = [];
    for (const s of state.streams) {
      if (!observed.includes(s.takeId)) observed.push(s.takeId);
    }
    for (const s of state.deskStatus) {
      if (!observed.includes(s.takeId)) observed.push(s.takeId);
    }
    const present = new Set(state.deskStatus.map((s) => s.takeId));
    const seen = orderTakeIds(
      observed.filter((takeId) => present.has(takeId)),
      attribution.takeStartedAt,
    );
    const slots = new Map<string, TakeSlot>();
    let offset = 1; // leading second of lane
    for (const takeId of seen) {
      const live = takeId === state.activeTakeId;
      const streams = state.deskStatus.filter((s) => s.takeId === takeId);
      const bySamples = Math.max(0, ...streams.map((s) => s.totalSamples / SAMPLE_RATE));
      const byClock = live && state.takeStartedAt ? (Date.now() - state.takeStartedAt) / 1_000 : 0;
      const durationSec = Math.max(bySamples, byClock, 1.5);
      slots.set(takeId, { takeId, offsetSec: offset, durationSec, live });
      // Known cosmetic limit: slots are laid out from declared stream
      // lengths while boxes draw shifted by align verdicts — a shift
      // beyond the 2s gap can overlap the next take's box on screen.
      offset += durationSec + TAKE_GAP_SECONDS;
    }
    return slots;
  }, [state.streams, state.deskStatus, state.activeTakeId, state.takeStartedAt, attribution]);

  return { observedTakeIds, attribution, peerByStream, rows, takes, laneOrder, writeLaneOrderMap };
}
