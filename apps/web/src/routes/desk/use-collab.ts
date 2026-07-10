// Desk↔doc bindings: the mixer loop-guarded two-way sync, the clip
// arrangement/region/lane-order hooks, and the presence subscription.
// Transport plumbing: net/collab.ts; doc mutation rules: net/collab-doc.ts.

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import type { CollabClient, CollabSnapshot } from "../../net/collab";
import {
  type ClipRegion,
  MASTER_KEY,
  type MixStripState,
  readArrange,
  readLaneOrder,
  readMix,
  readRegions,
  writeArrange,
  writeLaneOrder,
  writeMixIfChanged,
  writeStreamRegions,
} from "../../net/collab-doc";
import type { ChannelStrip, SessionPlayer } from "./player";

/** Two-way mixer sync: the player stays the AUDIO authority, the doc the
 * STATE source. Loop guard: local writes carry `collab.origin` (skipped by
 * the observer), doc→player application sets `applying` so the resulting
 * player notify can't echo, and equal states never write. */
export function bindMixToCollab(collab: CollabClient, player: SessionPlayer): () => void {
  let applying = false;
  const mixMap = collab.doc.getMap<MixStripState>("mix");

  const stripState = (c: ChannelStrip): MixStripState => ({
    gainDb: c.gainDb,
    pan: c.pan,
    muted: c.muted,
    soloed: c.soloed,
    eq: { ...c.eq },
  });

  const applyStrip = (key: string, state: MixStripState): void => {
    applying = true;
    try {
      const snap = player.snapshot();
      const bands = {
        lowDb: state.eq.lowDb,
        midDb: state.eq.midDb,
        midHz: state.eq.midHz,
        highDb: state.eq.highDb,
      };
      if (key === MASTER_KEY) {
        if (snap.masterDb !== state.gainDb) player.setMasterDb(state.gainDb);
        if (snap.masterPan !== state.pan) player.setMasterPan(state.pan);
        const eq = snap.masterEq;
        if (
          eq.lowDb !== bands.lowDb ||
          eq.midDb !== bands.midDb ||
          eq.midHz !== bands.midHz ||
          eq.highDb !== bands.highDb
        ) {
          player.setMasterEq(bands);
        }
        if (eq.bypassed !== state.eq.bypassed) player.toggleMasterEqBypass();
      } else {
        const strip = snap.channels.find((c) => c.key === key);
        if (!strip || strip.gainDb !== state.gainDb) player.setChannelDb(key, state.gainDb);
        if (!strip || strip.pan !== state.pan) player.setChannelPan(key, state.pan);
        if ((strip?.muted ?? false) !== state.muted) player.toggleChannelMute(key);
        if ((strip?.soloed ?? false) !== state.soloed) player.toggleChannelSolo(key);
        const eq = player.snapshot().channels.find((c) => c.key === key)?.eq;
        if (
          !eq ||
          eq.lowDb !== bands.lowDb ||
          eq.midDb !== bands.midDb ||
          eq.midHz !== bands.midHz ||
          eq.highDb !== bands.highDb
        ) {
          player.setChannelEq(key, bands);
        }
        if ((eq?.bypassed ?? false) !== state.eq.bypassed) player.toggleChannelEqBypass(key);
      }
    } finally {
      applying = false;
    }
  };

  // doc → player: remote (and persisted/seeded) strips apply through the
  // player's public setters; our own writes are origin-filtered out.
  const observer = (event: { keysChanged: Set<string> }, txn: { origin: unknown }): void => {
    if (txn.origin === collab.origin) return;
    for (const key of event.keysChanged) {
      const state = mixMap.get(key);
      if (state) applyStrip(key, state);
    }
  };
  mixMap.observe(observer);
  // Catch up with whatever the doc already holds (bind-after-load).
  for (const [key, state] of readMix(collab.doc)) applyStrip(key, state);

  // player → doc: diff every snapshot; only genuine local changes write
  // (equal states short-circuit, `applying` mutes our own application).
  const unsubscribe = player.subscribe((snap) => {
    if (applying) return;
    for (const c of snap.channels) {
      if (writeMixIfChanged(collab.doc, c.key, stripState(c), collab.origin)) {
        collab.markEditing(`mix:${c.key}`);
      }
    }
    const master: MixStripState = {
      gainDb: snap.masterDb,
      pan: snap.masterPan,
      muted: false,
      soloed: false,
      eq: { ...snap.masterEq },
    };
    if (writeMixIfChanged(collab.doc, MASTER_KEY, master, collab.origin)) {
      collab.markEditing(`mix:${MASTER_KEY}`);
    }
  });

  return () => {
    mixMap.unobserve(observer);
    unsubscribe();
  };
}

/** Clip arrangement (stream → start seconds) through the doc: local drags
 * write; remote drags land in the returned overrides. Mirrors the
 * setState(updater) shape the timeline drag code already uses. */
export function useCollabArrange(
  collab: CollabClient,
): [
  Record<string, number>,
  (updater: (prev: Record<string, number>) => Record<string, number>) => void,
] {
  const [overrides, setOverrides] = useState<Record<string, number>>(() => readArrange(collab.doc));
  useEffect(() => {
    const map = collab.doc.getMap<number>("arrange");
    const refresh = () => setOverrides(readArrange(collab.doc));
    refresh();
    map.observe(refresh);
    return () => map.unobserve(refresh);
  }, [collab]);
  const update = useCallback(
    (updater: (prev: Record<string, number>) => Record<string, number>) => {
      writeArrange(collab.doc, updater(readArrange(collab.doc)), collab.origin);
    },
    [collab],
  );
  return [overrides, update];
}

/** Clip regions through the doc: streamId → split pieces. Local splits/
 * region drags write one stream's WHOLE list; remote edits land live.
 * Streams absent from the record are never-split — the caller derives
 * their implicit region and keeps the legacy `arrange` wire shape. */
export function useCollabRegions(
  collab: CollabClient,
): [Record<string, ClipRegion[]>, (streamId: string, regions: ClipRegion[]) => void] {
  const [regions, setRegions] = useState<Record<string, ClipRegion[]>>(() =>
    readRegions(collab.doc),
  );
  useEffect(() => {
    const map = collab.doc.getMap<ClipRegion[]>("regions");
    const refresh = () => setRegions(readRegions(collab.doc));
    refresh();
    map.observe(refresh);
    return () => map.unobserve(refresh);
  }, [collab]);
  const write = useCallback(
    (streamId: string, next: ClipRegion[]) => {
      writeStreamRegions(collab.doc, streamId, next, collab.origin);
    },
    [collab],
  );
  return [regions, write];
}

/** Deliberate lane order through the doc: a Move up/down writes the
 * complete laneKey → ordinal map (every move reassigns every position);
 * remote moves land live and a reload restores the persisted order. */
export function useCollabLaneOrder(
  collab: CollabClient,
): [Record<string, number>, (next: Record<string, number>) => void] {
  const [order, setOrder] = useState<Record<string, number>>(() => readLaneOrder(collab.doc));
  useEffect(() => {
    const map = collab.doc.getMap<number>("laneOrder");
    const refresh = () => setOrder(readLaneOrder(collab.doc));
    refresh();
    map.observe(refresh);
    return () => map.unobserve(refresh);
  }, [collab]);
  const write = useCallback(
    (next: Record<string, number>) => {
      writeLaneOrder(collab.doc, next, collab.origin);
    },
    [collab],
  );
  return [order, write];
}

/** Live presence: connection status + the OTHER desks in the room. */
export function useCollabPresence(collab: CollabClient): CollabSnapshot {
  const subscribe = useCallback(
    (onChange: () => void) => collab.subscribe(() => onChange()),
    [collab],
  );
  return useSyncExternalStore(subscribe, () => collab.snapshot());
}
