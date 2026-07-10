// Presence (awareness) types + sanitizers for the collab provider. Awareness
// state comes from other desks' builds, so every field is validated on read.

import type { Awareness } from "y-protocols/awareness";

export type CollabStatus = "connecting" | "connected" | "offline";

/** What each desk publishes about itself (awareness; never in the doc). */
export interface PresenceState {
  /** Operator label (the comment-author preference; "Desk" by default). */
  name: string;
  /** Track-palette hex, derived from the clientID. */
  color: string;
  /** Account profile picture — the top-bar face of a remote desk. */
  avatarUrl: string | null;
  /** Ghost-cursor position on the shared arrangement timeline. */
  playheadSec: number | null;
  activeTakeId: string | null;
  /** What the desk is touching: "mix:<channelKey>" | "markers" | "comments". */
  editing: string | null;
}

export interface CollabPeer extends PresenceState {
  clientId: number;
}

export interface CollabSnapshot {
  status: CollabStatus;
  synced: boolean;
  /** OTHER desks in the room (never includes this client). */
  peers: CollabPeer[];
}

export function defaultPresence(): PresenceState {
  return {
    name: "Desk",
    color: "#c8c9cb",
    avatarUrl: null,
    playheadSec: null,
    activeTakeId: null,
    editing: null,
  };
}

/** Every OTHER desk's presence, sanitized field-by-field and sorted by
 * clientId for a stable render order. */
export function readPeers(awareness: Awareness, selfClientId: number): CollabPeer[] {
  const peers: CollabPeer[] = [];
  for (const [clientId, state] of awareness.getStates()) {
    if (clientId === selfClientId || !state) continue;
    const p = state as Partial<PresenceState>;
    peers.push({
      clientId,
      name: typeof p.name === "string" && p.name ? p.name : "Desk",
      color: typeof p.color === "string" ? p.color : "#c8c9cb",
      // https only — the same bound the wire schema enforces for hellos.
      avatarUrl:
        typeof p.avatarUrl === "string" && p.avatarUrl.startsWith("https://") ? p.avatarUrl : null,
      playheadSec: typeof p.playheadSec === "number" ? p.playheadSec : null,
      activeTakeId: typeof p.activeTakeId === "string" ? p.activeTakeId : null,
      editing: typeof p.editing === "string" ? p.editing : null,
    });
  }
  peers.sort((a, b) => a.clientId - b.clientId);
  return peers;
}
