// F1 — cold-desk attribution rebuild. Live stream-announces exist only in
// the memory of desks that were present when a take rolled; everything
// they carry (stream→peer mapping, take chronology, peer identity) is
// ALSO persisted server-side. This module turns the session-summary
// payload (GET /api/sessions/:sessionId) into the lookups the desk uses to
// rebuild lanes, take ordering/numbering, and its status-polling set after
// a reload — or on a second desk that never saw the announces.

/** Wire shape of the attribution extension of GET /api/sessions/:id. */
export interface SessionSummaryPayload {
  sessionId: string;
  takes: Array<{
    id: string;
    startedAt: string;
    stoppedAt?: string | null;
    wallClockHint?: string | null;
    streams: Array<{ streamId: string; peerId: string | null; finalSeq: number | null }>;
  }>;
  peers: Array<{
    peerId: string;
    role: "desk" | "recorder";
    userAgent: string;
    label: string | null;
    deviceId: string | null;
    joinedAt: string;
  }>;
}

export interface ArchivedPeer {
  peerId: string;
  role: "desk" | "recorder";
  userAgent: string;
  label: string | null;
  deviceId: string | null;
}

/** Rebuilt lookups. All maps are complete for whatever the archive holds;
 * live announces layer OVER these (fresher for the rolling take). */
export interface SessionAttribution {
  /** streamId → peerId (only streams the server attributed). */
  peerByStream: Map<string, string>;
  /** takeId → startedAt (epoch ms) — the chronological ordering key. */
  takeStartedAt: Map<string, number>;
  /** peerId → identity (label / device fallback name / role). */
  peers: Map<string, ArchivedPeer>;
}

export function emptyAttribution(): SessionAttribution {
  return { peerByStream: new Map(), takeStartedAt: new Map(), peers: new Map() };
}

/** Announce-equivalent stream metadata to seed a cold desk's sink with
 * (DeskSession.seedArchivedStreams) so HAVE reconciliation covers the
 * archive's history and the server backfills the local copy. */
export function archivedStreamMetas(
  payload: SessionSummaryPayload,
): Array<{ takeId: string; streamId: string; peerId: string | null; finalSeq: number | null }> {
  return payload.takes.flatMap((take) =>
    take.streams.map((stream) => ({
      takeId: take.id,
      streamId: stream.streamId,
      peerId: stream.peerId,
      finalSeq: stream.finalSeq,
    })),
  );
}

export function buildAttribution(payload: SessionSummaryPayload): SessionAttribution {
  const peerByStream = new Map<string, string>();
  const takeStartedAt = new Map<string, number>();
  for (const take of payload.takes) {
    const startedAt = Date.parse(take.startedAt);
    if (Number.isFinite(startedAt)) takeStartedAt.set(take.id, startedAt);
    for (const stream of take.streams) {
      if (stream.peerId) peerByStream.set(stream.streamId, stream.peerId);
    }
  }
  const peers = new Map<string, ArchivedPeer>();
  for (const p of payload.peers) {
    peers.set(p.peerId, {
      peerId: p.peerId,
      role: p.role,
      userAgent: p.userAgent,
      label: p.label,
      deviceId: p.deviceId,
    });
  }
  return { peerByStream, takeStartedAt, peers };
}

/** Order take ids chronologically by archive startedAt; takes the archive
 * doesn't know yet (a take that JUST started, or history while the server
 * is unreachable) keep their observed order AFTER every dated take — live
 * announces arrive in take order, so the newest stays last. The sort is
 * stable: equal timestamps keep observed order, so numbering never
 * shuffles under a viewer. */
export function orderTakeIds(
  observed: readonly string[],
  takeStartedAt: ReadonlyMap<string, number>,
): string[] {
  const rank = new Map(observed.map((id, i) => [id, i]));
  return [...observed].sort((a, b) => {
    const aStarted = takeStartedAt.get(a);
    const bStarted = takeStartedAt.get(b);
    if (aStarted !== undefined && bStarted !== undefined && aStarted !== bStarted) {
      return aStarted - bStarted;
    }
    if (aStarted === undefined && bStarted !== undefined) return 1;
    if (aStarted !== undefined && bStarted === undefined) return -1;
    return (rank.get(a) as number) - (rank.get(b) as number);
  });
}
