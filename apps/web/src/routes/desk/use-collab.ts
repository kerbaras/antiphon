// W3-A desk↔doc bindings: the mixer loop-guarded two-way sync, the clip
// arrangement hook, and the presence subscription. Transport plumbing lives
// in net/collab.ts; doc shape/mutation rules in net/collab-doc.ts; the
// markers/comments hooks stay in use-desk.ts at their documented
// persistence boundary.

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import type { CollabClient, CollabSnapshot } from "../../net/collab";
import {
  MASTER_KEY,
  type MixStripState,
  readArrange,
  readLaneOrder,
  readMix,
  writeArrange,
  writeLaneOrder,
  writeMixIfChanged,
} from "../../net/collab-doc";
import type { ChannelStrip, TakePlayer } from "./player";

/** Two-way mixer sync. The player stays the AUDIO authority (all gains/EQ
 * still flow through its graph); the doc is the STATE source. Local knob
 * moves surface as player snapshots and are diffed into the doc; remote doc
 * changes apply back through the player's public setters. Loop guard is
 * twofold: local writes carry `collab.origin` (the observer skips them) and
 * doc→player application sets `applying` so the resulting player notify
 * can't echo — plus writeMixIfChanged never writes an equal state, so the
 * cycle terminates by construction. */
export function bindMixToCollab(collab: CollabClient, player: TakePlayer): () => void {
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

/** Deliberate lane order (W4-E) through the doc: a Move up/down writes the
 * complete laneKey → ordinal map; remote desks' moves land here live and a
 * reload restores the persisted order. Same read/observe shape as
 * useCollabArrange — the setter takes the full map since every move
 * reassigns every lane's position anyway. */
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
