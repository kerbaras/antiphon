// Mixing desk — /session/:uuid. Layout, geometry, and visual language follow
// the prototype (docs/Antiphone DAW.dc.html) row for row: 48px top bar with
// a centered transport cluster, 40px toolbar, arrange timeline with 232px
// sticky track headers, a 272px right rail, and the mixer footer.
// Record/stop/chirp, playback with a moving playhead + click-to-seek,
// chirp auto-alignment, and the gain/mute/solo mixer are all live; only
// editing tools and pan (mono v1) remain visibly inert.
//
// This file is the orchestrator: session/player state, the timeline model,
// selection/marquee/drag/keyboard interaction, and export jobs. The chrome
// renders from the sibling modules (top-bar, toolbar, timeline, right-rail
// panels, mixer-dock).

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { useParams } from "react-router";
import type { DeskStreamStatus } from "../../audio/sink-worker-protocol";
import { type ClipRegion, deleteArrangeKeys } from "../../net/collab-doc";
import { recordRecentSession } from "../home/recent-sessions";
import { planAlignScopes, runAlignFlow } from "./align-flow";
import { orderTakeIds } from "./attribution";
import { loadAuthorPref, saveAuthorPref } from "./comments";
import { type CommentLane, CommentsPanel } from "./comments-panel";
import type { ClipModel, DeskTool } from "./daw";
import { RULER_H, TRACK_HEADER_W, TRACK_ROW_H } from "./daw";
import { DeleteConfirm, type DeleteSummaryTake } from "./delete-confirm";
import type { ExportJob, ExportMenuProps } from "./export-menu";
import { LaneContextMenu, type LaneMenuState } from "./lane-menu";
import { type Song, songFileName, songSlug, songsOf } from "./markers";
import { noteSpansOf } from "./midi";
import type { MidiLaneModel } from "./midi-lane";
import { MixerDock } from "./mixer-dock";
import { PerformersPanel } from "./performers-panel";
import type { DriftResult } from "./player";
import { regionsValid, seedRegion, selectionStreamIds, splitRegion } from "./regions";
import { type RailTab, RailTabs } from "./right-rail";
import { SinksPanel } from "./sinks-panel";
import { SongsPanel } from "./songs-panel";
import { type Marquee, TimelineSection } from "./timeline";
import { anchorAtSec, type RenderRange, type TakeAnchorSpan } from "./timeline-math";
import { DeskFatalPanel, DeskToolbar } from "./toolbar";
import { DeskTopBar, playActionReady } from "./top-bar";
import {
  applyLaneMoves,
  deviceName,
  fileSafe,
  initialsOf,
  type LaneCandidate,
  SAMPLE_RATE,
  stableLaneOrder,
  TAKE_GAP_SECONDS,
  type TakeSlot,
  TRACK_COLORS,
  type TrackRow,
  takeAtSec,
  useOrphanedStreams,
  useReceiving,
  useTick,
  withPositionalSongNames,
} from "./track-model";
import {
  useCollabArrange,
  useCollabLaneOrder,
  useCollabPresence,
  useCollabRegions,
} from "./use-collab";
import {
  ensureWaveform,
  exportAbletonProject,
  exportLogicPackage,
  exportMasterWav,
  exportMidiFile,
  exportProjectPackage,
  exportSessionMasterWav,
  exportSongsZip,
  exportStemsZip,
  getCachedWaveform,
  getDeskCollab,
  getDeskSession,
  getPlayer,
  publishUiMirror,
  requestTakeLoad,
  type StemFormat,
  useDeskState,
  usePlayer,
  useServerStatus,
  useSessionAttribution,
  useTakeAlignShifts,
  useTakeComments,
  useTakeMarkers,
  waveformCacheSize,
} from "./use-desk";
import { useDeskInput } from "./use-desk-input";
import { getDeskMidi, useDeskMidi } from "./use-desk-midi";

export function DeskRoute() {
  const { uuid } = useParams();
  if (!uuid) return null;
  return <Desk sessionId={uuid} />;
}

function Desk({ sessionId }: { sessionId: string }) {
  const state = useDeskState(sessionId);
  // Shared project doc (W3-A): mix/markers/comments/arrange sync + presence.
  // Idempotent page singleton, same pattern as getDeskSession above.
  const collab = getDeskCollab(sessionId);
  const collabSnap = useCollabPresence(collab);
  // Leave a trail for the home page's "recent sessions" list.
  useEffect(() => {
    recordRecentSession(sessionId);
  }, [sessionId]);
  // Every take this desk can see, live announces first (arrival order),
  // then the OPFS-rebuilt history, then the active take. Drives the
  // archive-attribution fetch AND the server-status polling set — rebuilt
  // takes poll exactly like announced ones (F1/F6).
  const observedTakeIds = useMemo(() => {
    const ids: string[] = [];
    for (const s of state.streams) if (!ids.includes(s.takeId)) ids.push(s.takeId);
    for (const s of state.deskStatus) if (!ids.includes(s.takeId)) ids.push(s.takeId);
    if (state.activeTakeId && !ids.includes(state.activeTakeId)) ids.push(state.activeTakeId);
    return ids;
  }, [state.streams, state.deskStatus, state.activeTakeId]);
  // Cold-desk attribution (F1): the archive's stream→peer mapping, take
  // chronology, and peer identities — what live announces would have held.
  const attribution = useSessionAttribution(sessionId, observedTakeIds);
  const serverStatus = useServerStatus(sessionId, observedTakeIds);
  const receiving = useReceiving(state.deskStatus);
  // A6-truncated streams (F9): a mid-take phone reload leaves the original
  // stream without a stream-final at EITHER sink — terminally incomplete
  // by design, presented as such instead of "syncing" forever.
  const orphanedStreams = useOrphanedStreams(state.deskStatus, serverStatus, state.activeTakeId);
  const [zoom, setZoom] = useState(1);
  const [tab, setTab] = useState<RailTab>("performers");
  const pxPerSec = 24 * zoom;

  const recording = state.activeTakeId !== null;
  useTick(recording, 100);
  // ---- editing tool (W7-B) ---------------------------------------------------
  // Select ↔ Split, desk-local UI state (a tool is a cursor, not project
  // state). C activates Split, V returns to Select, Escape exits too; a
  // take starting auto-reverts — the blade has no meaning over a rolling
  // take (the toolbar button and the C shortcut are disabled alongside).
  const [tool, setTool] = useState<DeskTool>("select");
  useEffect(() => {
    if (recording && tool === "split") setTool("select");
  }, [recording, tool]);
  const recorders = (state.session?.peers ?? []).filter((p) => p.role === "recorder");
  // The desk's own input joins as a recorder peer (W2-D); it gets a lane
  // like everyone else but is not a "phone" anywhere the copy says so.
  const deskInput = useDeskInput(sessionId);
  // Desk MIDI capture (W3-C) — desk-local data lane, never on the wire.
  const deskMidi = useDeskMidi(sessionId);
  const phones = recorders.filter((p) => p.peerId !== deskInput.peerId);
  // Stream → performer: archive attribution first (covers takes whose
  // announces this desk never saw — reloads, second desks), live announces
  // layered over (fresher for the rolling take).
  const peerByStream = useMemo(() => {
    const map = new Map(attribution.peerByStream);
    for (const s of state.streams) if (s.peerId) map.set(s.streamId, s.peerId);
    return map;
  }, [attribution, state.streams]);

  // Rows: one per CONNECTED performer (a lane appears the moment a phone —
  // or the desk input — joins, in join order) plus one per stream-derived
  // lane for archived history whose peer left or was never attributed.
  // Identity resolves from the live roster first, then the archived peer
  // (F1) — so lanes keep their nickname/device name after a phone
  // disconnects or a desk reload.
  //
  // ORDER IS FROZEN (F8): each lane's rank is assigned on first sight and
  // held in a ref for the page's lifetime — takes, renames, reconnects,
  // status-order churn and late attribution never move a visible row (the
  // mixer strips mirror rows, so they hold too). New lanes append, ordered
  // among themselves by the peer's joinedAt — live roster or archive — so
  // a cold reload rebuilds the identical order (see track-model.ts).
  const laneRanks = useRef(new Map<string, number>());
  const laneRanksSession = useRef(sessionId);
  if (laneRanksSession.current !== sessionId) {
    laneRanksSession.current = sessionId;
    laneRanks.current = new Map();
  }
  // Deliberate operator moves (W4-E context menu) layered OVER the frozen
  // ranks: laneKey → display ordinal in the shared doc, so the order
  // persists across reloads and syncs across desks (see applyLaneMoves).
  const [laneOrder, writeLaneOrderMap] = useCollabLaneOrder(collab);
  const rows = useMemo(() => {
    const streamsByKey = new Map<string, DeskStreamStatus[]>();
    const aliasesByKey = new Map<string, string[]>();
    const streamKeyOrder: string[] = [];
    for (const stream of state.deskStatus) {
      const peerId = peerByStream.get(stream.streamId) ?? null;
      // Cold reload: OPFS-rebuilt streams can reach deskStatus BEFORE the
      // attribution fetch returns. Freezing streamId-keyed lanes now would
      // lock in worker-iteration order; hold them one round-trip until the
      // archive has had its say (ready also flips on a failed fetch, so a
      // server-away desk still shows everything, observed order).
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
    // Doc-held move ordinals resolve by lane key; a lane the archive later
    // re-keyed (streamId fallback → attributed peer) inherits the ordinal
    // written under its former key — mirroring the rank inheritance above,
    // so attribution never undoes an operator's move.
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
      // Nickname first (A13); fall back to the device-derived name.
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
        // The chip keeps the device provenance even when a nickname rules
        // the lane title ("Maria" · chip "iPhone"; the desk input · "Desk").
        peerLabel:
          attributed && key === deskInput.peerId
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
    deskInput.peerId,
    laneOrder,
  ]);

  // Takes in CHRONOLOGICAL order with sequential timeline offsets, ordered
  // by the archive's startedAt (F1): stable across reloads and identical
  // on every desk — no more "new take draws as Take 1" scrambles. Takes
  // the archive doesn't know yet (just started, or history while the
  // server is unreachable) keep observed order after the dated ones —
  // announces arrive in take order, so the newest stays last.
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
      // KNOWN COSMETIC LIMIT (W7-C, still open after W7-A): slots are
      // laid out from DECLARED stream lengths only, while EVERY take's
      // boxes now draw shifted right by their align shifts (clipShiftSec
      // — live verdict for the loaded take, persisted for the rest,
      // W7-A) — when a take's arming spread exceeds this 2 s gap, its
      // longest-shifted box can overlap the next take's box on screen.
      // W7-A shipped the drawing, NOT the slot widening: offsetSec feeds
      // the session plan (W6-B audio placement), seeks and the parked
      // pin — and anchors still land asynchronously (align() settling,
      // verdict restore/sync), so a late anchor would reflow every
      // downstream take on screen AND on the transport clock
      // mid-session. Parked as cosmetic until someone owns that reflow.
      offset += durationSec + TAKE_GAP_SECONDS;
    }
    return slots;
  }, [state.streams, state.deskStatus, state.activeTakeId, state.takeStartedAt, attribution]);

  const timelineSeconds = Math.max(
    60,
    ...[...takes.values()].map((t) => t.offsetSec + t.durationSec + 10),
  );
  const laneWidth = timelineSeconds * pxPerSec;

  const elapsed = recording && state.takeStartedAt ? (Date.now() - state.takeStartedAt) / 1_000 : 0;

  const convergedCount = state.deskStatus.filter((desk) => {
    const server = serverStatus.get(desk.streamId);
    return desk.complete && server?.complete && desk.digest === server.digest;
  }).length;

  // ---- playback ----------------------------------------------------------
  const playerSnap = usePlayer();
  const [pickedTakeId, setPickedTakeId] = useState<string | null>(null);
  // Selected take: explicit pick, else the latest take fully complete at
  // the desk (loadable without holes).
  const selectedTakeId = useMemo(() => {
    if (pickedTakeId && takes.has(pickedTakeId)) return pickedTakeId;
    const completeTakes = [...takes.keys()].filter((takeId) => {
      const streams = state.deskStatus.filter((s) => s.takeId === takeId);
      return streams.length > 0 && streams.every((s) => s.complete);
    });
    return completeTakes[completeTakes.length - 1] ?? null;
  }, [pickedTakeId, takes, state.deskStatus]);
  // Stable IDENTITY across status polls (deskStatus is a fresh array every
  // second): effects keyed off this must not re-fire unless membership
  // actually changes — a spurious re-run reaches align()/re-schedule and
  // audibly cuts playback.
  const selectedStreamKey = useMemo(
    () =>
      state.deskStatus
        .filter((s) => s.takeId === selectedTakeId && s.complete)
        .map((s) => s.streamId)
        .sort()
        .join(","),
    [state.deskStatus, selectedTakeId],
  );
  const selectedStreamIds = useMemo(
    () => (selectedStreamKey ? selectedStreamKey.split(",") : []),
    [selectedStreamKey],
  );

  // Load AND auto-align the selected take as soon as it is complete at
  // the desk. Alignment always runs (W4-B): align() tries the chirp first
  // and falls back to content cross-correlation, so a chirpless session
  // aligns too — the verdict UX carries the honest outcome either way,
  // and a persisted verdict restored before the run satisfies align()'s
  // idempotence (no re-measure). Loads run through the latest-wins queue
  // (F5): a pick landing mid-decode is never dropped — the player
  // converges on the newest selection. Streams map to mixer lanes by
  // performer (read through a ref: mapping identity churns every poll and
  // must not re-fire this effect — see selectedStreamKey). Gated on the
  // attribution fetch settling so a cold desk's first load already lands
  // on performer lanes instead of streamId-keyed fallback strips.
  const peerByStreamRef = useRef(peerByStream);
  peerByStreamRef.current = peerByStream;
  useEffect(() => {
    if (!selectedTakeId || selectedStreamIds.length === 0 || recording || !attribution.ready) {
      return;
    }
    requestTakeLoad({
      sessionId,
      takeId: selectedTakeId,
      streamIds: selectedStreamIds,
      channelOf: (streamId) => peerByStreamRef.current.get(streamId) ?? streamId,
      align: true,
    });
  }, [sessionId, selectedTakeId, selectedStreamIds, recording, attribution.ready]);

  // Late attribution (F1): if the stream→peer mapping lands AFTER a take
  // was loaded, re-key its tracks onto the performer lanes so saved strips
  // and collab mixer sync attach — parameter-only, playback never cuts.
  const channelMapKey = selectedStreamIds
    .map((streamId) => peerByStream.get(streamId) ?? streamId)
    .join(",");
  // biome-ignore lint/correctness/useExhaustiveDependencies: channelMapKey re-keys loaded tracks when the mapping changes
  useEffect(() => {
    getPlayer().remapChannels((streamId) => peerByStreamRef.current.get(streamId) ?? streamId);
  }, [channelMapKey]);

  // Background-decode every completed stream so clips always draw the true
  // waveform, regardless of which take is selected/loaded.
  const [, bumpWaveforms] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      for (const stream of state.deskStatus) {
        if (!stream.complete || getCachedWaveform(stream.streamId)) continue;
        const added = await ensureWaveform(sessionId, stream.takeId, stream.streamId);
        if (cancelled) return;
        if (added) bumpWaveforms();
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionId, state.deskStatus]);

  const playerLoaded = playerSnap.loadedTakeId === selectedTakeId && playerSnap.tracks.length > 0;
  const alignmentByStream = useMemo(() => {
    const map = new Map<string, boolean>();
    for (const t of playerSnap.tracks) map.set(t.streamId, t.alignment?.applied ?? false);
    return map;
  }, [playerSnap.tracks]);
  // Visual alignment (W6-C): clip boxes shift right by their stream's
  // capture lateness so aligned waveforms LINE UP on screen — a read-only
  // display transform over the same deltas the schedule trims with.
  // Arrangement positions (overrides, clip delays, the drag write-back)
  // stay in the un-shifted audio domain: stored audio and stored positions
  // never move, only the boxes do. W7-A promotes the composition from
  // "loaded take only" to EVERY take: the loaded take reads the player's
  // LIVE verdict (player.alignShifts — doc-synced by F7b, fresher mid-run),
  // all others their PERSISTED verdict (useTakeAlignShifts) — identical
  // values once a run settles, so promoting a take from persisted to live
  // never moves a box.
  // biome-ignore lint/correctness/useExhaustiveDependencies: playerSnap.tracks carries the verdict state this reads
  const alignView = useMemo(
    () =>
      playerLoaded
        ? getPlayer().alignShifts()
        : { shiftSec: new Map<string, number>(), anchorSec: 0 },
    [playerLoaded, playerSnap.tracks],
  );
  const drawnTakeIdsKey = useMemo(
    () => [...takes.keys()].filter((takeId) => takeId !== state.activeTakeId).join(","),
    [takes, state.activeTakeId],
  );
  const persistedShiftsByTake = useTakeAlignShifts(sessionId, drawnTakeIdsKey);
  /** Seconds a clip's box draws right of its arrangement position (see the
   * W7-A note above): live verdict for the loaded take, persisted verdict
   * for every other (and for the selected one until its load settles — the
   * values agree, so the handover is seamless). Within a take, an
   * unmeasured/declined stream sits at the room-zero anchor — its audio
   * starts exactly there, unaligned; a take with no applied verdict draws
   * unshifted (anchor 0). */
  const clipShiftSec = (streamId: string, takeId: string): number => {
    if (takeId === selectedTakeId && playerLoaded) {
      return alignView.shiftSec.get(streamId) ?? alignView.anchorSec;
    }
    const persisted = persistedShiftsByTake.get(takeId);
    return persisted ? (persisted.shiftSec.get(streamId) ?? persisted.anchorSec) : 0;
  };
  const driftByStream = useMemo(() => {
    const map = new Map<string, DriftResult>();
    for (const t of playerSnap.tracks) {
      if (t.drift) map.set(t.streamId, t.drift);
    }
    return map;
  }, [playerSnap.tracks]);

  // Clip arrangement lives in the shared doc (W3-A): local drags write
  // through, remote desks' drags land here live. Same updater shape as the
  // useState it replaced. Declared up here (not with the other timeline
  // editing state) because the take-local↔session conversions below need
  // the selected take's base during render (W6-B).
  const [clipStartOverrides, setClipStartOverrides] = useCollabArrange(collab);
  // Split regions (W7-B): streamId → doc-held piece list. A stream absent
  // here is never-split — its ONE implicit region derives from the legacy
  // arrange override / take slot (collab-doc.ts compat stance), and its
  // drags keep writing `arrange` so the pre-split wire shape never churns.
  const [docRegions, writeStreamRegionsMap] = useCollabRegions(collab);

  /** A stream's arrangement start: leftmost region for split streams, the
   * legacy override ?? take slot otherwise. The one "where does this
   * stream's audio begin" rule every consumer below shares. */
  const streamStartSec = useCallback(
    (streamId: string, takeId: string): number => {
      const regions = docRegions[streamId];
      if (regions && regions.length > 0) return Math.min(...regions.map((r) => r.startSec));
      return clipStartOverrides[streamId] ?? takes.get(takeId)?.offsetSec ?? 0;
    },
    [docRegions, clipStartOverrides, takes],
  );

  /** The selected take's ARRANGEMENT base: leftmost of its clips in the
   * audio-domain (un-shifted) positions — the zero the take-local domains
   * (markers, comments, MIDI, render ranges) are measured from, and the
   * session position of the take's aligned audio head. */
  const selectedBaseSec = useMemo(() => {
    if (!selectedTakeId) return 0;
    const starts = state.deskStatus
      .filter((s) => s.takeId === selectedTakeId)
      .map((s) => streamStartSec(s.streamId, selectedTakeId));
    return starts.length > 0 ? Math.min(...starts) : 0;
  }, [selectedTakeId, state.deskStatus, streamStartSec]);
  // ---- THE W6-B × W6-C composition invariant (W7-A: every take) --------------
  // The SESSION clock (player position/seek/duration) is ANCHOR-FREE:
  // every take's aligned audio starts at its clips' arrangement positions
  // — schedule-identical whether the take is selected or a mounted
  // neighbor. The anchor is a DRAWING transform, scoped exactly where the
  // drawn geometry shifts — since W7-A that is EVERY take with an applied
  // verdict (live for the loaded one, persisted for the rest), so the
  // anchor is per-take everywhere:
  //   · audio at session t INSIDE a verdict-holding take draws at
  //     t + THAT take's anchor;
  //   · everywhere else (gaps, beyond the session, verdict-less takes)
  //     drawn x == session t;
  //   · the playhead and the drawn↔audio click mapping apply the anchor
  //     per-take (see playheadSec and the pin reconciliation below) — a
  //     session playhead crossing a neighbor take rides the NEIGHBOR's
  //     drawn waves (its own anchor), never the loaded take's. The honest
  //     consequence: the playhead steps by a take's anchor at its drawn
  //     boundary — the piecewise transform made visible, replacing the
  //     old (documented) step-left when leaving the loaded take over
  //     unshifted neighbor waves.
  /** Where the selected take's room-time ZERO draws on the arrangement
   * (W6-C): base + anchor. Room-timeline DRAWING (marker flags, comment
   * ticks, MIDI lane, active-song strip) maps through this; audio-domain
   * seeks use selectedBaseSec. */
  const timelineBaseSec = selectedBaseSec + alignView.anchorSec;

  // ---- song markers (W2-B) -------------------------------------------------
  // Marker positions stay in the TAKE's room-timeline domain (0 = take
  // head): they are properties of one recording, and the per-song render
  // ranges consume them unchanged. The transport clock is session-absolute
  // (W6-B) and anchor-free, so seeks ADD selectedBaseSec and playhead
  // reads SUBTRACT it; only drawing adds the anchored timelineBaseSec
  // (W6-C).
  const takeMarkers = useTakeMarkers(sessionId, selectedTakeId);
  // Display-level positional renumbering for auto-named songs (QA low:
  // delete "Song 1" and the panel used to read "01 Song 2"). The stored
  // model keeps its names; every consumer below — panel, ruler flags,
  // exports, ui mirror — reads THESE markers, so names agree everywhere.
  const displayMarkers = useMemo(
    () => withPositionalSongNames(takeMarkers.markers),
    [takeMarkers.markers],
  );
  const songs = useMemo(() => songsOf(displayMarkers), [displayMarkers]);
  const markersUsable = playerLoaded && !recording;
  // Take-local position of the playhead (markers/comments/songs domain):
  // the transport clock is session-absolute now (W6-B), the take-scoped
  // surfaces subtract the selected take's base. Clamped into the take —
  // the session playhead can honestly sit outside it (a gap, another
  // take), and a marker dropped then belongs to the nearest take edge.
  const takeLocalPlayhead = useCallback(
    () =>
      Math.max(0, Math.min(getPlayer().position() - selectedBaseSec, getPlayer().takeDuration())),
    [selectedBaseSec],
  );
  // The song under the playhead (panel highlight); the ruler's accent
  // strip additionally requires the transport to be rolling. QA M-2: a
  // session position OUTSIDE the selected take (the transport rolls
  // through neighbors and gaps now, W6-B) is under NO song of this take —
  // without the upper bound the last song stayed "current" forever.
  const takeLocalPositionSec = playerSnap.positionSec - selectedBaseSec;
  const currentSongId =
    markersUsable && takeLocalPositionSec <= playerSnap.takeDurationSec
      ? (songs.findLast((s) => takeLocalPositionSec >= s.startSec)?.id ?? null)
      : null;
  const activeSong = playerSnap.playing
    ? (songs.find((s) => s.id === currentSongId) ?? null)
    : null;

  function addMarkerAtPlayhead() {
    if (!markersUsable) return;
    takeMarkers.addAt(takeLocalPlayhead());
  }

  // ---- comments (W2-F) -------------------------------------------------------
  // Same interim status and position domain as markers: atSec is take
  // room-timeline (player.position()/seek()); drawing adds timelineBaseSec.
  const takeComments = useTakeComments(sessionId, selectedTakeId);
  const [commentAuthor, setCommentAuthor] = useState(() => loadAuthorPref());
  // Bumped by the C key / toolbar pill: the composer focuses its input.
  const [composerFocus, setComposerFocus] = useState(0);

  function openCommentComposer() {
    if (!markersUsable) return;
    setTab("comments");
    setComposerFocus((n) => n + 1);
  }

  function changeCommentAuthor(next: string) {
    setCommentAuthor(next);
    saveAuthorPref(next);
  }

  /** Stream → lane name (nickname when set), for the sinks cards: a human
   * label above the diagnostics instead of a bare UUID (QA low / F14). */
  const laneNameOf = useMemo(() => {
    const names = new Map<string, string>();
    for (const row of rows) {
      for (const s of row.streams) names.set(s.streamId, row.name);
    }
    return (streamId: string): string | undefined => names.get(streamId);
  }, [rows]);

  /** Lane → the archived mic(s) behind its AUDIBLE clips in the loaded
   * take (W5-B, W4-F follow-up): the seq-0 deviceDesc via the server-
   * status poll. Audible = the take's complete streams — exactly the set
   * the load effect hands the player (selectedStreamIds) — sorted, so the
   * claim is deterministic regardless of worker enumeration order, and an
   * F9 orphan sharing the lane can never lend the chip ITS mic (QA F1:
   * the orphan is unplayable; the operator hears the fresh stream). A
   * legit multi-clip lane enumerates its distinct mics. undefined = no
   * claim — no audible clip, or the archive hasn't answered for any of
   * them yet (QA F3); null = the archive answered but holds no device
   * description (pre-mic-metadata stream). Tooltips the lane-header chip;
   * the sinks panel shows the raw field per stream, orphans included. */
  const takeMicOf = (row: TrackRow): string | null | undefined => {
    const audible = row.streams
      .filter((s) => s.takeId === selectedTakeId && selectedStreamIds.includes(s.streamId))
      .map((s) => s.streamId)
      .sort();
    const claims: Array<string | null> = [];
    for (const streamId of audible) {
      const status = serverStatus.get(streamId);
      if (status !== undefined) claims.push(status.deviceDesc);
    }
    if (claims.length === 0) return undefined;
    const mics = [...new Set(claims.filter((desc): desc is string => desc !== null))];
    return mics.length > 0 ? mics.join(", ") : null;
  };

  /** The selected take's streams as comment-pin targets, labeled by lane. */
  const commentLanes = useMemo(() => {
    const lanes: CommentLane[] = [];
    for (const row of rows) {
      for (const s of row.streams) {
        if (s.takeId === selectedTakeId) {
          lanes.push({ streamId: s.streamId, name: row.name, color: row.color });
        }
      }
    }
    return lanes;
  }, [rows, selectedTakeId]);

  // ---- lane selection (W4-E) -------------------------------------------------
  // ONE selected lane, shared by the tracks sidebar and the mixer strips
  // (both highlight it; clicking either surface sets it). Desk-local UI
  // state by design — never in the shared doc: which lane an operator is
  // about to solo is their cursor, not project state. With a lane selected
  // S toggles its solo and M its mute (keyboard handler below); Escape
  // clears.
  const [selectedLaneKey, setSelectedLaneKey] = useState<string | null>(null);

  // ---- lane context menu (W4-E) ------------------------------------------------
  // Right-click on a lane (either surface) opens the cursor-anchored menu;
  // opening also selects the lane, so the highlight anchors the menu to a
  // visible target. The row is re-resolved from CURRENT rows every render —
  // a lane that vanishes mid-menu (remote delete) takes its menu with it.
  const [laneMenu, setLaneMenu] = useState<LaneMenuState | null>(null);
  const menuRow = laneMenu ? (rows.find((row) => row.key === laneMenu.laneKey) ?? null) : null;

  // A lane that leaves the console (stream delete, phone departure) takes
  // its selection and menu STATE with it — not just their rendering. A
  // stale selection would silently flip M back to marker-drop while the
  // ring is long gone, and a lingering menu state would resurrect the menu
  // at stale coordinates the moment a same-key lane rejoins (A12 resume).
  useEffect(() => {
    if (selectedLaneKey !== null && !rows.some((row) => row.key === selectedLaneKey)) {
      setSelectedLaneKey(null);
    }
    if (laneMenu !== null && !rows.some((row) => row.key === laneMenu.laneKey)) {
      setLaneMenu(null);
    }
  }, [rows, selectedLaneKey, laneMenu]);

  function openLaneMenu(key: string, x: number, y: number) {
    setSelectedLaneKey(key);
    setLaneMenu({ laneKey: key, x, y });
  }

  /** Move a lane one slot (W4-E): swap within the CURRENT display order,
   * then write the complete laneKey → ordinal map to the shared doc —
   * every on-screen lane gets its position pinned, later joiners append
   * (applyLaneMoves). Bounds-checked: the menu disables the impossible
   * direction anyway. */
  function moveLane(key: string, dir: -1 | 1) {
    const order = rows.map((row) => row.key);
    const from = order.indexOf(key);
    const to = from + dir;
    if (from < 0 || to < 0 || to >= order.length) return;
    const other = order[to] as string;
    order[to] = key;
    order[from] = other;
    writeLaneOrderMap(Object.fromEntries(order.map((laneKey, ordinal) => [laneKey, ordinal])));
  }

  // ---- timeline editing: selection, marquee, clip drag ---------------------
  const [selection, setSelection] = useState<string[]>([]);
  // Deletion staged behind the confirm dialog (F2): Delete/Backspace only
  // STAGES refs here; the durable streams-delete fires from the dialog's
  // explicit confirm. Escape/cancel drops the stage, selection preserved.
  const [pendingDelete, setPendingDelete] = useState<Array<{
    takeId: string;
    streamId: string;
  }> | null>(null);
  const [marquee, setMarquee] = useState<Marquee | null>(null);
  // W4-C click-to-seek: the operator's parked playhead, in ARRANGEMENT
  // seconds. Any bare-surface/ruler click parks it — even with nothing
  // loaded at all — and it renders as THE playhead until the player can
  // express the position itself (see the reconciliation effects below).
  const [parkedSeekSec, setParkedSeekSec] = useState<number | null>(null);
  /** The player's seek counter as of OUR last pin reconciliation; null
   * before it runs. The yield effect tells a FOREIGN seek (marker flag,
   * comment tick, songs panel, ⏮) from the pin's own clamped seek by this
   * counter — the position value can't carry that signal (⏮ with the
   * transport already parked at 0 moves nothing). */
  const parkedAppliedSeek = useRef<number | null>(null);
  // Session switch: the pick and the pin are per-session interaction state
  // (the laneRanks treatment above) — a stale pick would load the previous
  // session's take, a stale pin draws a playhead where nothing exists.
  const pinSession = useRef(sessionId);
  if (pinSession.current !== sessionId) {
    pinSession.current = sessionId;
    setPickedTakeId(null);
    setParkedSeekSec(null);
    parkedAppliedSeek.current = null;
  }
  const timelineRef = useRef<HTMLDivElement | null>(null);

  /** Arrangement position of a clip: user override, else its take slot —
   * the LEGACY (never-split) rule; split streams read their regions
   * (streamStartSec above composes the two). */
  const clipStartSec = (streamId: string, takeId: string): number =>
    clipStartOverrides[streamId] ?? takes.get(takeId)?.offsetSec ?? 0;

  /** A non-live stream's editable regions (W7-B): the doc list when split,
   * else the implicit whole-stream seed (id == streamId — the pre-region
   * identity every selection/spec key rests on). */
  interface StreamRegions {
    regions: ClipRegion[];
    split: boolean;
    streamDurationSec: number;
  }
  const streamRegionsOf = (stream: DeskStreamStatus): StreamRegions => {
    const streamDurationSec = Math.max(stream.totalSamples / SAMPLE_RATE, 1);
    const doc = docRegions[stream.streamId];
    if (doc && doc.length > 0) return { regions: doc, split: true, streamDurationSec };
    return {
      regions: [
        seedRegion(
          stream.streamId,
          clipStartSec(stream.streamId, stream.takeId),
          streamDurationSec,
        ),
      ],
      split: false,
      streamDurationSec,
    };
  };

  /** Every editable (non-live) region on the timeline, by region id — the
   * shared lookup for drags, the blade, and Delete's region→stream
   * resolution. Rebuilt per render like rowClips (same inputs). */
  interface RegionEntry extends StreamRegions {
    region: ClipRegion;
    streamId: string;
    takeId: string;
    /** Complete, not an F9 orphan, not the rolling take: cuttable. */
    splittable: boolean;
  }
  const regionIndex = new Map<string, RegionEntry>();
  for (const stream of state.deskStatus) {
    const slot = takes.get(stream.takeId);
    if (!slot || slot.live) continue;
    const streamRegions = streamRegionsOf(stream);
    const splittable = stream.complete && !orphanedStreams.has(stream.streamId);
    for (const region of streamRegions.regions) {
      regionIndex.set(region.id, {
        ...streamRegions,
        region,
        streamId: stream.streamId,
        takeId: stream.takeId,
        splittable,
      });
    }
  }

  /** Per-row clip models with geometry + interaction handlers: one box per
   * REGION (W7-B) — a never-split stream renders its single implicit
   * region with the exact pre-region geometry. */
  const rowClips: ClipModel[][] = rows.map((row) =>
    row.streams.flatMap((stream) => {
      const slot = takes.get(stream.takeId);
      if (!slot) return [];
      const server = serverStatus.get(stream.streamId);
      const converged =
        stream.complete && (server?.complete ?? false) && stream.digest === server?.digest;
      const aligned = alignmentByStream.get(stream.streamId) ?? false;
      const takeNumber = [...takes.keys()].indexOf(stream.takeId) + 1;
      // Completed streams ALWAYS draw the true decoded waveform (background
      // cache); the encoded-complexity proxy only covers the live take
      // still growing under the record head.
      const waveform = getCachedWaveform(stream.streamId) ?? stream.energy;
      const recordedSec = stream.totalSamples / SAMPLE_RATE;
      // Box position = arrangement position + the alignment shift (W6-C):
      // the box moves so aligned waveforms line up; the waveform itself
      // (and the stored audio it draws) never changes.
      const shiftSec = clipShiftSec(stream.streamId, stream.takeId);
      if (slot.live) {
        const durationSec = Math.max(recordedSec, slot.durationSec);
        return [
          {
            id: stream.streamId,
            streamId: stream.streamId,
            takeId: stream.takeId,
            name: "Incoming take",
            color: row.color,
            x: (clipStartSec(stream.streamId, stream.takeId) + shiftSec) * pxPerSec,
            width: durationSec * pxPerSec - 3,
            durationSec,
            live: true,
            badge: "rec" as const,
            energy: waveform,
            fillFraction: durationSec > 0 ? Math.min(1, recordedSec / durationSec) : 1,
            selected: false,
          },
        ];
      }
      const { regions, split, streamDurationSec } = streamRegionsOf(stream);
      // An orphaned stream (F9) can never align or converge — its
      // terminal "incomplete" outranks the transient "syncing".
      const badge = orphanedStreams.has(stream.streamId)
        ? ("incomplete" as const)
        : aligned
          ? ("aligned" as const)
          : converged
            ? ("converged" as const)
            : ("syncing" as const);
      return regions.map(
        (region): ClipModel => ({
          id: region.id,
          streamId: stream.streamId,
          takeId: stream.takeId,
          name: `Take ${takeNumber}`,
          color: row.color,
          x: (region.startSec + shiftSec) * pxPerSec,
          width: region.durationSec * pxPerSec - 3,
          durationSec: region.durationSec,
          live: false,
          splitting: tool === "split",
          badge,
          // Split pieces draw their SLICE of the stream waveform; the
          // unsplit seed keeps the verbatim array (zero-change parity).
          energy: split ? sliceEnergy(waveform, region, streamDurationSec) : waveform,
          fillFraction: 1,
          selected: selection.includes(region.id),
          onPointerDown: (e: React.PointerEvent) => onClipPointerDown(e, region.id),
          // Loading a take is an EXPLICIT action (QA E3): selection
          // (click/marquee) must not switch what the player has loaded —
          // double-click does. The blade suspends it: a split's two
          // clicks must never double up into a take switch.
          ...(tool === "split" ? {} : { onDoubleClick: () => setPickedTakeId(stream.takeId) }),
        }),
      );
    }),
  );

  // ---- captured MIDI (W3-C) --------------------------------------------------
  // The selected take's events, in the same room-timeline domain as markers
  // (drawing adds timelineBaseSec). `revision` bumps when a capture lands.
  // biome-ignore lint/correctness/useExhaustiveDependencies: revision re-reads the manager's store
  const takeMidi = useMemo(
    () =>
      selectedTakeId
        ? getDeskMidi(sessionId).takeMidi(selectedTakeId)
        : { events: [], overflow: false },
    [sessionId, selectedTakeId, deskMidi.revision],
  );
  const midiLane: MidiLaneModel | null = useMemo(() => {
    if (takeMidi.events.length === 0) return null;
    const lastSec = takeMidi.events[takeMidi.events.length - 1]?.atSec ?? 0;
    return {
      notes: noteSpansOf(takeMidi.events),
      eventCount: takeMidi.events.length,
      // Drawing base: the ANCHORED one (W6-C) — MIDI events live in the
      // same take-local room domain as markers; the take-scoped span
      // stays takeDurationSec (W6-B).
      baseSec: timelineBaseSec,
      durationSec: Math.max(playerSnap.takeDurationSec, lastSec),
      // Next palette slot after the audio lanes — the lane reads as a
      // sibling track, not a duplicate of one.
      color: TRACK_COLORS[rows.length % TRACK_COLORS.length] as string,
      overflow: takeMidi.overflow,
    };
  }, [takeMidi, timelineBaseSec, playerSnap.takeDurationSec, rows.length]);

  // Feed the SESSION PLAN into the engine (W6-B): every non-live take's
  // complete streams with their absolute arrangement starts and declared
  // lengths. This is the transport's whole-session map — duration, the
  // look-ahead decode window, and the session master render all read it.
  // The engine diffs internally, so the per-second status polls that
  // rebuild these arrays cost nothing when nothing changed.
  useEffect(() => {
    const plan = [...takes.keys()]
      .filter((takeId) => takeId !== state.activeTakeId)
      .map((takeId) => ({
        takeId,
        streams: state.deskStatus
          .filter((s) => s.takeId === takeId && s.complete)
          .map((s) => {
            // Split streams (W7-B) hand the engine their region list; the
            // clip start collapses to the leftmost piece. Never-split
            // streams keep the exact pre-region plan shape (no `regions`
            // key), so the engine's verbatim whole-stream path runs.
            const regions = docRegions[s.streamId];
            return {
              streamId: s.streamId,
              channelKey: peerByStream.get(s.streamId) ?? s.streamId,
              clipStartSec:
                regions && regions.length > 0
                  ? Math.min(...regions.map((r) => r.startSec))
                  : (clipStartOverrides[s.streamId] ?? takes.get(takeId)?.offsetSec ?? 0),
              declaredDurationSec: s.totalSamples / SAMPLE_RATE,
              ...(regions ? { regions } : {}),
            };
          }),
      }));
    getPlayer().setSessionPlan(plan);
  }, [state.activeTakeId, clipStartOverrides, docRegions, state.deskStatus, takes, peerByStream]);

  /** Apply the blade to one stream (W7-B): seed the implicit region on the
   * first cut, split, validate, write ONE whole-list doc update. Rejected
   * cuts — live/incomplete/orphan streams, or a cut within 100 ms of a
   * region edge — are a SILENT no-op by design (the blade misses; no error
   * spam for a near-edge click). */
  function cutStream(
    streamId: string,
    takeId: string,
    cuts: Array<{ regionId: string; atSourceSec: number }>,
  ): void {
    const stream = state.deskStatus.find((s) => s.streamId === streamId);
    if (!stream?.complete || stream.takeId === state.activeTakeId) return;
    if (orphanedStreams.has(streamId)) return; // F9: terminally incomplete
    const streamDurationSec = Math.max(stream.totalSamples / SAMPLE_RATE, 1);
    let list = docRegions[streamId] ?? [
      seedRegion(streamId, clipStartSec(streamId, takeId), streamDurationSec),
    ];
    let changed = false;
    for (const cut of cuts) {
      const next = splitRegion(list, cut.regionId, cut.atSourceSec);
      if (next && regionsValid(next, streamDurationSec)) {
        list = next;
        changed = true;
      }
    }
    if (changed) writeStreamRegionsMap(streamId, list);
  }

  /** The ruler / bare-surface blade (W7-B): cut EVERY region (across all
   * lanes) whose drawn box crosses content-second x. The geometry honors
   * the align-shift visual composition exactly like click-to-seek — the
   * cut lands where the operator sees the hairline over each waveform. */
  function splitAllAt(contentSec: number): void {
    const byStream = new Map<
      string,
      { takeId: string; cuts: Array<{ regionId: string; atSourceSec: number }> }
    >();
    for (const [regionId, entry] of regionIndex) {
      if (!entry.splittable) continue;
      const drawnLeft = entry.region.startSec + clipShiftSec(entry.streamId, entry.takeId);
      const within = contentSec - drawnLeft;
      if (within <= 0 || within >= entry.region.durationSec) continue;
      const bucket = byStream.get(entry.streamId) ?? { takeId: entry.takeId, cuts: [] };
      bucket.cuts.push({ regionId, atSourceSec: entry.region.sourceOffsetSec + within });
      byStream.set(entry.streamId, bucket);
    }
    for (const [streamId, { takeId, cuts }] of byStream) cutStream(streamId, takeId, cuts);
  }

  /** Clip press. SPLIT tool (W7-B): the press is the blade — cut this
   * region where the pointer sits on its drawn waveform (the box's own
   * rect already carries the align-shift composition, so the cut lands
   * exactly under the visible hairline). SELECT tool: pressing an
   * unselected clip selects it; dragging moves every selected region
   * together. A press without movement is just selection — it deliberately
   * does NOT switch the loaded take (QA E3); double-click is the explicit
   * load action.
   *
   * F17 — additive selection: shift/cmd/ctrl-press TOGGLES the region in
   * or out of the current selection and never starts a drag (a toggle is a
   * selection edit, not a grab — dragging still works from a plain press). */
  function onClipPointerDown(e: React.PointerEvent, regionId: string) {
    if (e.button !== 0) return;
    e.stopPropagation();
    const entry = regionIndex.get(regionId);
    if (!entry) return;
    if (tool === "split") {
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      const atSourceSec = entry.region.sourceOffsetSec + (e.clientX - rect.left) / pxPerSec;
      cutStream(entry.streamId, entry.takeId, [{ regionId, atSourceSec }]);
      return;
    }
    if (e.shiftKey || e.metaKey || e.ctrlKey) {
      setSelection((prev) =>
        prev.includes(regionId) ? prev.filter((id) => id !== regionId) : [...prev, regionId],
      );
      return;
    }
    const dragIds = selection.includes(regionId) ? selection : [regionId];
    if (!selection.includes(regionId)) setSelection([regionId]);
    const originX = e.clientX;
    // Snapshot the down-state: legacy starts for never-split streams (the
    // arrange write path, wire-compat), whole region lists for split ones
    // (the regions write path). Moves derive from this snapshot — never
    // accumulated — so a drag is exact regardless of doc echo timing.
    const dragged = new Set(dragIds);
    const unsplitStarts = new Map<string, number>();
    const splitBase = new Map<string, ClipRegion[]>();
    for (const id of dragIds) {
      const en = regionIndex.get(id);
      if (!en) continue;
      if (en.split) {
        if (!splitBase.has(en.streamId)) splitBase.set(en.streamId, docRegions[en.streamId] ?? []);
      } else {
        unsplitStarts.set(en.streamId, en.region.startSec);
      }
    }
    const move = (ev: PointerEvent) => {
      const dxSec = (ev.clientX - originX) / pxPerSec;
      if (Math.abs(ev.clientX - originX) < 4) return;
      if (unsplitStarts.size > 0) {
        setClipStartOverrides((prev) => {
          const next = { ...prev };
          for (const [streamId, start] of unsplitStarts) {
            next[streamId] = Math.max(0, start + dxSec);
          }
          return next;
        });
      }
      // Regions drag INDIVIDUALLY: only the grabbed/selected pieces move;
      // their siblings hold their spots (one whole-list write per stream).
      // Pieces MAY be stacked over each other — both sound (mixed), the
      // same behavior whole clips dragged onto each other have always had
      // (regions.ts regionsValid: source disjointness is the only rule).
      for (const [streamId, base] of splitBase) {
        writeStreamRegionsMap(
          streamId,
          base.map((r) =>
            dragged.has(r.id) ? { ...r, startSec: Math.max(0, r.startSec + dxSec) } : r,
          ),
        );
      }
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  /** Bare-surface press — THE timeline pointer contract (W4-C). What a
   * press means, in precedence order:
   *  - on a clip or any control (buttons, marker flags, comment ticks) →
   *    the control handles it (clip press = select, press-drag = move,
   *    double-click = explicit load);
   *  - on sticky chrome (ruler row, track headers) → not lane surface; the
   *    ruler runs its own click-seek through the same seekTimeline;
   *  - press-and-drag → marquee selection, startable from ANY bare spot
   *    including the empty space below the last lane. With shift (or
   *    cmd/ctrl) held the marquee ADDS its hits to the selection instead
   *    of replacing it, and a modifier'd click on bare lane preserves the
   *    selection (F17) — additive gestures only ever edit selection,
   *    never wipe it;
   *  - plain click (no drag) → transport seek: ANY x that doesn't hit a
   *    clip parks the playhead there (seekTimeline), gaps and empty space
   *    included. Seeking is modifier-agnostic. */
  function onLanePointerDown(e: React.PointerEvent) {
    if (e.button !== 0 || recording) return;
    const additive = e.shiftKey || e.metaKey || e.ctrlKey;
    const target = e.target as HTMLElement;
    if (target.closest("button")) return; // clips and controls handle themselves
    const container = timelineRef.current;
    const viewport = container?.parentElement;
    if (!container || !viewport) return;
    // Sticky chrome is not lane surface: the ruler row seeks itself and the
    // track headers are controls. Tested in VIEWPORT space — the content
    // coordinates below drift under the sticky elements once scrolled.
    const vp = viewport.getBoundingClientRect();
    if (e.clientX - vp.left < TRACK_HEADER_W || e.clientY - vp.top < RULER_H) return;
    const rect = container.getBoundingClientRect();
    // Split tool (W7-B): a bare-surface press IS the blade across all
    // lanes — the timeline is one time axis, so any y works, exactly like
    // click-to-seek. Marquee/seek stay Select-tool behaviors.
    if (tool === "split") {
      splitAllAt((e.clientX - rect.left - TRACK_HEADER_W) / pxPerSec);
      return;
    }
    const x0 = e.clientX - rect.left;
    const y0 = e.clientY - rect.top;
    let moved = false;
    const move = (ev: PointerEvent) => {
      const x1 = ev.clientX - rect.left;
      const y1 = ev.clientY - rect.top;
      if (Math.abs(x1 - x0) + Math.abs(y1 - y0) > 5) moved = true;
      if (moved) setMarquee({ x0, y0, x1, y1 });
    };
    const up = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      if (!moved) {
        if (!additive) setSelection([]);
        seekTimeline((x0 - TRACK_HEADER_W) / pxPerSec);
        setMarquee(null);
        return;
      }
      // Marquee select: every non-live clip whose rect intersects.
      // Selection only — the loaded take never switches as a side effect
      // (QA E3): double-click a clip to load its take.
      const x1 = ev.clientX - rect.left;
      const y1 = ev.clientY - rect.top;
      const [left, right] = [Math.min(x0, x1), Math.max(x0, x1)];
      const [top, bottom] = [Math.min(y0, y1), Math.max(y0, y1)];
      const hit: string[] = [];
      rowClips.forEach((clips, rowIndex) => {
        const rowTop = RULER_H + rowIndex * TRACK_ROW_H + 4;
        const rowBottom = RULER_H + (rowIndex + 1) * TRACK_ROW_H - 4;
        for (const clip of clips) {
          if (clip.live) continue;
          const clipLeft = TRACK_HEADER_W + clip.x;
          const clipRight = clipLeft + Math.max(clip.width, 26);
          if (clipLeft < right && clipRight > left && rowTop < bottom && rowBottom > top) {
            hit.push(clip.id);
          }
        }
      });
      setSelection((prev) =>
        additive ? [...prev, ...hit.filter((id) => !prev.includes(id))] : hit,
      );
      setMarquee(null);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  // Space bar: stop the ongoing recording, otherwise toggle playback.
  // Delete/Backspace: STAGE the selected takes' clips for deletion — the
  // confirm dialog (F2) owns the actual server-authoritative delete.
  // S/M with a lane selected (W4-E): solo/mute that lane — text inputs
  // are exempted up top, so typing never trips a shortcut.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable) {
        return;
      }
      // Open dialogs own the keyboard wholesale (the invite popover focuses
      // its Copy button — Space must stay the native button click there,
      // never transport). Deliberately scoped to [role="dialog"], NOT all
      // buttons: with a transport/mini button focused, Space = transport is
      // the DAW convention worth keeping. This yield covers EVERY shortcut
      // below — the W4-E S/M lane keys included.
      if (target.closest?.('[role="dialog"]')) return;
      // The confirm dialog owns the keyboard while open (Enter/Escape/trap),
      // as does the lane context menu (arrows/Enter/Escape) — W4-E. Both
      // gate by STATE, not focus, so they hold wherever focus sits.
      if (pendingDelete || (laneMenu && menuRow)) return;
      // The selected lane, verified against the CURRENT rows — a lane that
      // left the console (delete, session switch) is not a shortcut target.
      const laneKey =
        selectedLaneKey !== null && rows.some((row) => row.key === selectedLaneKey)
          ? selectedLaneKey
          : null;
      if (e.key === "Escape") {
        // Escape exits the Split tool first (W7-B) — the blade is the
        // most-modal thing on screen; a second Escape clears the lane.
        if (tool === "split") {
          setTool("select");
          return;
        }
        setSelectedLaneKey(null);
        return;
      }
      if (e.code === "Space") {
        e.preventDefault();
        if (recording) getDeskSession(sessionId).stopTake();
        // Space mirrors THE transport button exactly (W5-B): while a take
        // decodes, ▶ is disabled — so Space is a no-op too. Same predicate
        // as the button's disabled state (parity by construction), read on
        // the LIVE snapshot so a decode that began this frame already gates.
        else if (playActionReady(playerLoaded, getPlayer().snapshot())) getPlayer().toggle();
        return;
      }
      // S: solo the selected lane (W4-E).
      if (e.code === "KeyS" && !e.metaKey && !e.ctrlKey && !e.altKey) {
        if (laneKey) getPlayer().toggleChannelSolo(laneKey);
        return;
      }
      // M: mute the selected lane (W4-E); with none selected, the key
      // keeps its W2-B meaning — drop a song marker at the playhead.
      if (e.code === "KeyM" && !e.metaKey && !e.ctrlKey && !e.altKey) {
        if (laneKey) {
          getPlayer().toggleChannelMute(laneKey);
          return;
        }
        if (playerLoaded && !recording) takeMarkers.addAt(takeLocalPlayhead());
        return;
      }
      // C: activate the SPLIT tool (W7-B — the operator's ask owns this
      // key now; the comments composer moved to N). Inert while recording,
      // matching the toolbar button's honest disable.
      if (e.code === "KeyC" && !e.metaKey && !e.ctrlKey && !e.altKey) {
        if (!recording) setTool("split");
        return;
      }
      // V: back to the Select tool (W7-B).
      if (e.code === "KeyV" && !e.metaKey && !e.ctrlKey && !e.altKey) {
        setTool("select");
        return;
      }
      // N: open the comments composer focused at the playhead (W2-F;
      // moved from C when the Split tool claimed it — W7-B).
      if (e.code === "KeyN" && !e.metaKey && !e.ctrlKey && !e.altKey) {
        if (playerLoaded && !recording) {
          e.preventDefault();
          setTab("comments");
          setComposerFocus((n) => n + 1);
        }
        return;
      }
      if ((e.code === "Delete" || e.code === "Backspace") && selection.length > 0) {
        e.preventDefault();
        // Selection holds REGION ids (W7-B); deletion stays STREAM-level —
        // any selected piece stages its whole stream (the confirm dialog
        // says so when a split stream is among them). The same resolver
        // scopes selection-aware auto-align (W7-A × W7-B).
        const streamIds = new Set(selectionStreamIds(selection, docRegions));
        const refs = state.deskStatus
          .filter((s) => streamIds.has(s.streamId) && s.takeId !== state.activeTakeId)
          .map((s) => ({ takeId: s.takeId, streamId: s.streamId }));
        if (refs.length === 0) return;
        setPendingDelete(refs);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    recording,
    playerLoaded,
    sessionId,
    selection,
    selectedLaneKey,
    rows,
    pendingDelete,
    laneMenu,
    menuRow,
    tool,
    docRegions,
    state.deskStatus,
    state.activeTakeId,
    takeMarkers.addAt,
    takeLocalPlayhead,
  ]);

  /** Confirmed deletion (F2): the existing server-authoritative protocol
   * path, unchanged — local copies drop only on the streams-deleted
   * confirm fanout. */
  function confirmDelete() {
    if (!pendingDelete) return;
    getDeskSession(sessionId).deleteStreams(pendingDelete);
    setSelection([]);
    setClipStartOverrides((prev) => {
      const next = { ...prev };
      for (const ref of pendingDelete) delete next[ref.streamId];
      return next;
    });
    setPendingDelete(null);
  }

  /** Any staged stream is split into regions (W7-B): the dialog carries
   * the whole-lane honesty line — deletion is stream-level, a piece can't
   * be destroyed without its siblings. */
  const deleteSplitWhole = useMemo(
    () => (pendingDelete ?? []).some((ref) => (docRegions[ref.streamId]?.length ?? 0) > 1),
    [pendingDelete, docRegions],
  );

  /** What the staged deletion would destroy, spelled out for the dialog:
   * clip counts per take, in timeline take order. */
  const deleteSummary = useMemo((): DeleteSummaryTake[] => {
    if (!pendingDelete) return [];
    const order = [...takes.keys()];
    const counts = new Map<string, number>();
    for (const ref of pendingDelete) {
      counts.set(ref.takeId, (counts.get(ref.takeId) ?? 0) + 1);
    }
    return [...counts.entries()]
      .sort(([a], [b]) => order.indexOf(a) - order.indexOf(b))
      .map(([takeId, clipCount]) => ({
        name: `Take ${order.indexOf(takeId) + 1}`,
        clipCount,
      }));
  }, [pendingDelete, takes]);

  // ---- selection-aware auto-align (W7-A) -------------------------------------
  // The toolbar button forks on selection: none → force re-align the
  // loaded take, all lanes (the pre-W7-A behavior); selection → every take
  // owning selected clips gets (re)aligned, SELECTED streams only
  // (player.align scope), sequentially through the F5 queue
  // (load → align → next), then the operator's loaded take comes back and
  // the selection stays put. ANY forced run first RESETS the scoped
  // clips' manual arrange overrides — a manual move is exactly what
  // re-align exists to undo — and the chip note reports the reset
  // honestly. Cancel semantics (latest wins) live in align-flow.ts.
  const [alignFlow, setAlignFlow] = useState<{ done: number; total: number } | null>(null);
  const [alignNote, setAlignNote] = useState<string | null>(null);
  const alignNoteTimer = useRef<number | null>(null);
  /** Transient chip note — auto-expires, replaced by the next align run. */
  const noteAlign = useCallback((text: string | null) => {
    if (alignNoteTimer.current !== null) window.clearTimeout(alignNoteTimer.current);
    alignNoteTimer.current = null;
    setAlignNote(text);
    if (text !== null) {
      alignNoteTimer.current = window.setTimeout(() => setAlignNote(null), 10_000);
    }
  }, []);
  useEffect(
    () => () => {
      if (alignNoteTimer.current !== null) window.clearTimeout(alignNoteTimer.current);
    },
    [],
  );
  const recordingRef = useRef(recording);
  recordingRef.current = recording;
  // Session-identity guard for the async flow (the pinSession treatment):
  // a session switch or unmount cancels before the next step. An EPOCH,
  // not a boolean — a flag would flip back true for the new session while
  // the old flow's closure still watches the same ref; each flow captures
  // the epoch at start and cancels the moment it moves on.
  const flowEpoch = useRef(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: sessionId IS the trigger — its change (and unmount) must bump the epoch
  useEffect(() => {
    return () => {
      flowEpoch.current += 1;
    };
  }, [sessionId]);

  function autoAlign() {
    if (alignFlow !== null || playerSnap.aligning || recording || !selectedTakeId) return;
    // Selection holds REGION ids (W7-B); the align scope is per-STREAM —
    // head-trims are properties of the capture, shared by all its pieces —
    // so selecting ANY piece of a split stream puts that whole stream in
    // scope (selectionStreamIds dedupes; unsplit ids pass verbatim).
    const scopes =
      selection.length > 0
        ? planAlignScopes(
            selectionStreamIds(selection, docRegions),
            state.deskStatus.map((s) => ({
              streamId: s.streamId,
              takeId: s.takeId,
              complete: s.complete,
            })),
            {
              liveTakeId: state.activeTakeId,
              orphanedStreamIds: orphanedStreams,
              takeOrder: [...takes.keys()],
              loadedTakeId: playerSnap.loadedTakeId,
            },
          )
        : [{ takeId: selectedTakeId, streamIds: selectedStreamIds }];
    if (scopes.length === 0) {
      // Filter-not-fail left nothing: say so instead of silently no-opping.
      noteAlign("selection has no alignable clips");
      return;
    }
    // Reset manual moves UP FRONT, one doc transaction: the whole reset
    // fans out to other desks as one update (arrange is shared state —
    // intended). A mid-flow cancel can leave a scope reset-but-not-
    // remeasured, and that is SAFE: the persisted verdict still draws AND
    // plays those clips aligned (align-flow.ts header).
    //
    // SPLIT streams are exempt from the reset — PM decision (W7-A × W7-B):
    // a split is deliberate arrangement work, and its region layout is the
    // operator's edit, not a "manual move" re-align exists to undo. Their
    // region structure (source windows AND positions) is preserved; their
    // frozen legacy `arrange` key is preserved too (it is the OLD desks'
    // pre-split view — deleting it would move the clip on old desks only).
    // Realignment still fully applies to them: head-trims are schedule/
    // drawing compositions OVER the regions, never region mutations. Only
    // never-split streams get the override reset, and only those count in
    // the chip note.
    const scopedIds = scopes.flatMap((s) => s.streamIds);
    const resetIds = scopedIds.filter((id) => docRegions[id] === undefined);
    const resetCount = resetIds.filter((id) => clipStartOverrides[id] !== undefined).length;
    deleteArrangeKeys(collab.doc, resetIds, collab.origin);
    noteAlign(
      resetCount > 0
        ? `manual offsets reset · ${resetCount} clip${resetCount === 1 ? "" : "s"}`
        : null,
    );
    setAlignFlow({ done: 0, total: scopes.length });
    const flowSessionId = sessionId;
    const epoch = flowEpoch.current;
    const streamsOfTake = (takeId: string): string[] =>
      state.deskStatus.filter((s) => s.takeId === takeId && s.complete).map((s) => s.streamId);
    const channelOf = (streamId: string) => peerByStreamRef.current.get(streamId) ?? streamId;
    void runAlignFlow(scopes, {
      loadedTakeId: () => getPlayer().snapshot().loadedTakeId,
      cancelled: () => recordingRef.current || flowEpoch.current !== epoch,
      // Steps enqueue with NO busy pre-check, deliberately: a step's
      // settle signal fires inside the queue's drain loop (before
      // inFlight releases), so the very next enqueue lands in the pending
      // slot of our OWN drain — the queue's designed serialization, not a
      // race. Foreign requests keep winning through the queue's own
      // signals: one landing mid-step flips superseded() (the step
      // reports it, the flow aborts), and one REPLACING a still-pending
      // step surfaces through the dropped-pending signal — either way the
      // flow yields; it never silently stomps a fresher intent.
      runStep: (takeId, streamIds) =>
        new Promise((resolve) => {
          requestTakeLoad({
            sessionId: flowSessionId,
            takeId,
            streamIds: streamsOfTake(takeId), // the LOAD is whole-take…
            channelOf,
            align: false,
            forceAlignScope: streamIds, // …the MEASUREMENT is the selection
            onSettled: resolve,
          });
        }),
      restore: (takeId) => {
        requestTakeLoad({
          sessionId: flowSessionId,
          takeId,
          streamIds: streamsOfTake(takeId),
          channelOf,
          align: true, // restore persisted verdict; align() no-ops on it
        });
      },
      onProgress: (done, total) => setAlignFlow({ done, total }),
    }).finally(() => setAlignFlow(null));
  }

  /** Click-to-seek (W4-C): `sec` is an ARRANGEMENT-timeline position — any
   * x on the surface counts, loaded or not. The playhead parks at the
   * clicked spot immediately; when the spot lies inside another take's
   * clips the pick retargets onto that take, so play-from-here needs no
   * double-click focus dance first (the F5 latest-wins queue does the
   * actual loading; double-click on a clip stays the explicit load for
   * clip PRESSES, which remain selection-only — QA E3). The reconciliation
   * effects below feed the player once it holds the right take — a click
   * WHILE the transport rolls keeps its point through that load too (the
   * yield effect ignores the old take's motion until then), and the
   * retargeted take comes up PAUSED at the clicked spot: double-click load
   * parity, no auto-resume. */
  function seekTimeline(sec: number) {
    const target = takeAtSec(
      rowClips.flat().map((clip) => ({
        takeId: clip.takeId,
        startSec: clip.x / pxPerSec,
        durationSec: clip.durationSec,
        live: clip.live,
      })),
      sec,
      selectedTakeId,
    );
    if (target !== null && target !== selectedTakeId) setPickedTakeId(target);
    parkedAppliedSeek.current = null; // not reconciled with the player yet
    setParkedSeekSec(Math.max(0, sec));
  }

  // Parked-seek reconciliation — the composed W6-B × W6-C mapping (the
  // invariant lives above timelineBaseSec). The player's clock is the
  // arrangement timeline (W6-B), anchor-free; the click landed on DRAWN
  // geometry, which shifts by the anchor only inside the selected take.
  // Mapping a park X to its audio target:
  //   · X inside the selected take's DRAWN audio region
  //     [base+anchor, base+anchor+takeDur] → X − anchor: exactly
  //     expressible, the pin hands over;
  //   · X inside the trimmed-head strip [base, base+anchor): the drawn
  //     content there never plays (it is what alignment trims) — audio
  //     parks at room zero (base) while the pin honestly keeps the
  //     clicked spot;
  //   · anywhere else (gaps, beyond the end) → X verbatim: playable
  //     silence, expressible while inside the session; a park beyond the
  //     session end keeps the pin and Play from there follows the one end
  //     rule (F12, session-scoped). A click inside ANOTHER take's drawn
  //     boxes never reaches this mapping un-retargeted: seekTimeline
  //     re-picks that take (W4-C), so by the time the pin reconciles the
  //     take is the selected one and its own anchor rules apply — the
  //     W7-A per-take drawing (neighbors compose their persisted shifts)
  //     stays consistent with the click math by construction.
  //
  // W6-C QA F1: the align verdict lands AFTER the load (align() runs
  // post-load; a persisted verdict restores moments later), and an applied
  // verdict moves the drawn mapping right by the anchor. The seek re-runs
  // on every anchor/base change, but the pin only CLEARS once the verdict
  // settled — a cross-take click used to reconcile against the anchorless
  // mapping and hand over, then the anchor landed and the playhead visibly
  // jumped right by it. Settled = a non-null outcome with no run in flight
  // (aligned/declined/failed all settle; align() measures every loaded
  // track, so a completed run can never leave the outcome null — and a
  // look-ahead-mounted take PROMOTES with its persisted verdict already on
  // its tracks, then runs the same queue restore/align follow-ups, so a
  // promoted selection settles like a decoded one: no permanently-parked
  // pin).
  const alignSettled = !playerSnap.aligning && playerSnap.alignmentOutcome !== null;
  useEffect(() => {
    if (parkedSeekSec === null || !playerLoaded) return;
    const anchor = alignView.anchorSec;
    const drawnHeadSec = selectedBaseSec + anchor; // room zero, as drawn
    const drawnEndSec = drawnHeadSec + getPlayer().takeDuration();
    const inDrawnTake = parkedSeekSec >= drawnHeadSec && parkedSeekSec <= drawnEndSec;
    const inTrimStrip = parkedSeekSec >= selectedBaseSec && parkedSeekSec < drawnHeadSec;
    getPlayer().seek(
      inDrawnTake ? parkedSeekSec - anchor : inTrimStrip ? selectedBaseSec : parkedSeekSec,
    );
    parkedAppliedSeek.current = getPlayer().snapshot().seekCount;
    const expressible = inDrawnTake || (!inTrimStrip && parkedSeekSec <= getPlayer().duration());
    if (alignSettled && expressible) setParkedSeekSec(null);
  }, [parkedSeekSec, playerLoaded, selectedBaseSec, alignView.anchorSec, alignSettled]);
  // A parked pin is a promise about the NEXT play, not the current one: it
  // yields when the transport rolls, a take starts recording, or any
  // FOREIGN seek (marker flag, comment tick, songs panel, ⏮ — counted by
  // the player, since a foreign seek needn't move the position value)
  // lands — the pin must never mask where the audio truly is. But NOT
  // before the pin's take is the loaded one: until a pending retarget load
  // settles, playing/seeks belong to the PREVIOUS take and must not cost
  // the operator the clicked point (the reconciliation above still has to
  // run). playing/seekCount are the TRIGGERS; the body reads the live
  // counter, which the reconciliation may have bumped within this same
  // commit (snapshots lag one notify).
  // biome-ignore lint/correctness/useExhaustiveDependencies: playing/seekCount re-run the check; the body reads the live counter
  useEffect(() => {
    if (parkedSeekSec === null) return;
    if (recording) {
      setParkedSeekSec(null);
      return;
    }
    if (!playerLoaded) return;
    const applied = parkedAppliedSeek.current;
    if (playerSnap.playing || (applied !== null && getPlayer().snapshot().seekCount > applied)) {
      setParkedSeekSec(null);
    }
  }, [parkedSeekSec, playerLoaded, playerSnap.playing, playerSnap.seekCount, recording]);

  // Playhead position on the shared timeline: the live take's write head
  // while recording; else the parked click (W4-C — it exists even with
  // nothing loaded); else the player position — arrangement time (W6-B),
  // plus the anchor of WHATEVER take the audio comes from (the composition
  // invariant above, W7-A): the selected take's LIVE anchor while inside
  // its span, a neighbor take's PERSISTED anchor while inside that
  // neighbor's, zero over the gaps — the playhead always rides the drawn
  // waveforms it is playing.
  const positionInSelectedTake =
    playerSnap.positionSec >= selectedBaseSec &&
    playerSnap.positionSec <= selectedBaseSec + playerSnap.takeDurationSec;
  // Neighbor takes' AUDIO spans with their persisted anchors (anchorAtSec
  // input). Ends use declared stream lengths — the drawing domain's
  // yardstick; the aligned end lands fractionally earlier, so the anchor
  // holds a beat past the last audible sample. Cosmetic, and honest: the
  // drawn boxes extend exactly this far too.
  const neighborAnchorSpans = useMemo(() => {
    const spans: TakeAnchorSpan[] = [];
    for (const [takeId, slot] of takes) {
      if (takeId === selectedTakeId || slot.live) continue;
      const persisted = persistedShiftsByTake.get(takeId);
      if (!persisted || persisted.anchorSec === 0) continue;
      const streams = state.deskStatus.filter((s) => s.takeId === takeId);
      if (streams.length === 0) continue;
      // Split streams (W7-B) span their region layout — leftmost piece to
      // the last piece's end — through the same rule every other consumer
      // uses (streamStartSec); never-split streams keep the legacy
      // override/slot + declared-length yardstick.
      const starts = streams.map((s) => streamStartSec(s.streamId, takeId));
      const ends = streams.map((s, i) => {
        const regions = docRegions[s.streamId];
        if (regions && regions.length > 0) {
          return Math.max(...regions.map((r) => r.startSec + r.durationSec));
        }
        return (starts[i] as number) + s.totalSamples / SAMPLE_RATE;
      });
      spans.push({
        startSec: Math.min(...starts),
        endSec: Math.max(...ends),
        anchorSec: persisted.anchorSec,
      });
    }
    return spans;
  }, [takes, selectedTakeId, persistedShiftsByTake, state.deskStatus, streamStartSec, docRegions]);
  const playheadSec = recording
    ? state.activeTakeId && takes.has(state.activeTakeId)
      ? (takes.get(state.activeTakeId) as TakeSlot).offsetSec + elapsed
      : null
    : parkedSeekSec !== null
      ? parkedSeekSec
      : playerLoaded && selectedTakeId
        ? playerSnap.positionSec +
          (positionInSelectedTake
            ? alignView.anchorSec
            : anchorAtSec(neighborAnchorSpans, playerSnap.positionSec))
        : null;

  // ---- presence (W3-A) -------------------------------------------------------
  // Publish who we are and where our playhead sits; read the other desks.
  // Name = the operator's comment-author pref (already user-editable in the
  // comments panel); color keyed off the doc clientID into the track palette.
  useEffect(() => {
    collab.setPresence({
      name: commentAuthor,
      color: TRACK_COLORS[collab.doc.clientID % TRACK_COLORS.length] as string,
    });
  }, [collab, commentAuthor]);
  // Ghost cursor position, coarse on purpose (0.25 s — a cursor, not a
  // clock): setPresence no-ops on equal state, the client throttles the wire.
  useEffect(() => {
    collab.setPresence({
      playheadSec: playheadSec === null ? null : Math.round(playheadSec * 4) / 4,
      activeTakeId: selectedTakeId,
    });
  });
  const remoteDesks = collabSnap.peers;
  const ghostPlayheads = remoteDesks
    .filter((p) => p.playheadSec !== null)
    .map((p) => ({
      clientId: p.clientId,
      name: p.name,
      color: p.color,
      atSec: p.playheadSec as number,
    }));
  /** Mixer lanes another desk is touching right now → faint strip ring. */
  const remoteEditing = useMemo(() => {
    const map = new Map<string, { name: string; color: string }>();
    for (const p of remoteDesks) {
      if (p.editing?.startsWith("mix:")) {
        map.set(p.editing.slice(4), { name: p.name, color: p.color });
      }
    }
    return map;
  }, [remoteDesks]);

  /** Recording-time master bus estimate: the live track peaks summed (all
   * mics share one room, so amplitudes roughly add) and clamped. */
  const liveMasterLevel = recording
    ? Math.min(
        1,
        rows.reduce((sum, row) => sum + levelFor(row), 0),
      )
    : 0;

  // Mirror editing state for tests/diagnostics.
  useEffect(() => {
    publishUiMirror({
      selection,
      clipStarts: clipStartOverrides,
      regions: docRegions,
      tool,
      playheadSec,
      selectedTakeId,
      liveMasterLevel,
      waveformsCached: waveformCacheSize(),
      markers: displayMarkers,
      comments: takeComments.comments,
      currentSongId,
      lanes: rows.map((row) => ({ key: row.key, name: row.name })),
    });
  });

  const joinUrl = `${location.origin}/join/${sessionId}`;

  /** Real level for a row's meters: live METER telemetry while recording,
   * the player's analyser during playback, silence otherwise. */
  function levelFor(row: TrackRow): number {
    if (recording) {
      const activeStream = row.streams.find((s) => s.takeId === state.activeTakeId);
      const live = activeStream ? state.liveLevels[activeStream.streamId] : undefined;
      return live && Date.now() - live.at < 1_200 ? live.peak : 0;
    }
    if (playerSnap.playing) {
      // Per-lane peak across ALL mounted takes (W6-B): during a boundary
      // handoff the audible track may not belong to the selected take.
      return playerSnap.channelLevels[row.key] ?? 0;
    }
    return 0;
  }

  function exportFlacAll() {
    // Exports carry the lane name (nickname when set) for human filenames.
    const laneOf = new Map<string, string>();
    for (const row of rows) {
      for (const s of row.streams) laneOf.set(s.streamId, row.name);
    }
    for (const desk of state.deskStatus) {
      const server = serverStatus.get(desk.streamId);
      if (desk.complete && server?.complete && desk.digest === server.digest) {
        const a = document.createElement("a");
        const lane = laneOf.get(desk.streamId);
        a.href = `/api/streams/${desk.streamId}/flac`;
        a.download = `${lane ? `${fileSafe(lane)}-` : ""}${desk.streamId.slice(0, 8)}.flac`;
        a.click();
      }
    }
  }

  // ---- offline export (W2-A) ----------------------------------------------
  // Master/stems render exactly what playback would play (render.ts shares
  // the player's scheduling math), so they gate on playback readiness: the
  // selected take loaded, alignment settled, transport idle.
  const canRenderTake = playerLoaded && !recording && !playerSnap.loading && !playerSnap.aligning;
  const [exportBusy, setExportBusy] = useState<ExportJob | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  // Stem archive format (W5-C) — same mono 24-bit audio, WAV or FLAC.
  // Applies to the whole-take Stems export and the per-song stems alike;
  // deliberately page-lifetime state, not persisted (a format is a
  // per-delivery choice, not a desk setting).
  const [stemFormat, setStemFormat] = useState<StemFormat>("wav");

  const takeNumber = selectedTakeId ? [...takes.keys()].indexOf(selectedTakeId) + 1 : 0;
  const takeTag = `take-${String(Math.max(1, takeNumber)).padStart(2, "0")}`;

  async function runExport(kind: ExportJob, job: () => Promise<void>) {
    if (exportBusy) return;
    setExportBusy(kind);
    setExportError(null);
    try {
      await job();
    } catch (e) {
      setExportError(e instanceof Error ? e.message : String(e));
    } finally {
      setExportBusy(null);
    }
  }

  // THE master (W6-B, the operator's ask): the whole session at its room
  // offsets. The per-take mix stays available as its own row below.
  const exportSessionMaster = () =>
    runExport("master", () =>
      exportSessionMasterWav(`session-${sessionId.slice(0, 8)}-master.wav`),
    );

  const exportMaster = () => runExport("master", () => exportMasterWav(`${takeTag}-master.wav`));

  /** Stem entry name (sans extension — the format owns that): lane name
   * (nickname when set) + stream id, like the FLAC path. */
  const stemBaseName = (streamId: string, channelKey: string): string => {
    const lane = rows.find((row) => row.key === channelKey)?.name;
    return `${lane ? `${fileSafe(lane)}-` : ""}${streamId.slice(0, 8)}`;
  };

  const exportStems = () =>
    runExport("stems", () =>
      exportStemsZip(`${takeTag}-stems.zip`, stemBaseName, undefined, stemFormat),
    );

  /** A song's render span: a last-marker song runs to the true take end,
   * expressed by omitting endSec (resolveRange fills the duration in). */
  const songRange = (song: Song): RenderRange => ({
    startSec: song.startSec,
    ...(song.endSec !== null ? { endSec: song.endSec } : {}),
  });

  /** Per-song download names: `<take> — NN <name>` + what it is. The take
   * tag keeps two takes' "01 Kyrie" apart in the Downloads folder; inside
   * a ZIP the take tag is on the archive, so entries stay bare. */
  const songTag = (song: Song) => `${takeTag} — ${songSlug(song.index, song.name)}`;

  const exportSong = (song: Song) =>
    runExport("songs", () => exportMasterWav(`${songTag(song)}.wav`, songRange(song)));

  const exportSongStems = (song: Song) =>
    runExport("stems", () =>
      exportStemsZip(`${songTag(song)} — stems.zip`, stemBaseName, songRange(song), stemFormat),
    );

  const exportSongProject = (song: Song) =>
    runExport("project", () =>
      exportProjectPackage(`${songTag(song)} — project.zip`, projectCtx(), songRange(song)),
    );

  const exportAllSongs = () =>
    runExport("songs", () =>
      exportSongsZip(
        `${takeTag}-songs.zip`,
        songs.map((s) => ({ fileName: songFileName(s.index, s.name), range: songRange(s) })),
      ),
    );

  // ---- DAW project exports (W3-B): same gating/busy as the renders above.
  /** Lane names/peers + markers/comments the packages carry (use-desk). */
  const projectCtx = () => ({
    sessionId,
    lanes: rows.map((row) => ({ key: row.key, name: row.name, peerId: row.peerId })),
    // Display names (positional auto-numbering) — the package must match
    // what the operator sees in the songs panel and the per-song WAVs.
    markers: displayMarkers,
    comments: takeComments.comments,
  });

  const exportProject = () =>
    runExport("project", () => exportProjectPackage(`${takeTag}-project.zip`, projectCtx()));

  const exportAbleton = () =>
    runExport("ableton", () => exportAbletonProject(takeTag, projectCtx()));

  const exportLogic = () =>
    runExport("logic", () => exportLogicPackage(`${takeTag}-logic-stems.zip`, projectCtx()));

  const exportMenu: ExportMenuProps = {
    busy: exportBusy,
    canRender: canRenderTake,
    canFlac: convergedCount > 0,
    songs,
    takeDurationSec: playerSnap.takeDurationSec,
    midiEventCount: takeMidi.events.length,
    stemFormat,
    onStemFormat: setStemFormat,
    onMaster: () => void exportSessionMaster(),
    onTakeMaster: () => void exportMaster(),
    onStems: () => void exportStems(),
    onSong: (song) => void exportSong(song),
    onSongStems: (song) => void exportSongStems(song),
    onSongProject: (song) => void exportSongProject(song),
    onAllSongs: () => void exportAllSongs(),
    onFlac: exportFlacAll,
    onMidi: () => exportMidiFile(`${takeTag}.mid`, takeMidi.events),
    onProjectPackage: () => void exportProject(),
    onAbleton: () => void exportAbleton(),
    onLogic: () => void exportLogic(),
  };

  return (
    // min-w floor (W5-B): below 520px no shed tier can save the top bar or
    // toolbar from self-overlap, so the desk keeps its shape and the page
    // scrolls — a desktop tool degrading honestly, not exploding.
    <main className="grid h-dvh min-w-[520px] grid-cols-[minmax(0,1fr)] grid-rows-[48px_40px_1fr_264px] overflow-hidden bg-bg text-[12px]">
      <DeskTopBar
        sessionId={sessionId}
        joinUrl={joinUrl}
        phones={phones}
        remoteDesks={remoteDesks}
        deskInputLive={deskInput.phase === "live"}
        serverSync={state.serverSync}
        rebuiltChunks={state.rebuiltChunks}
        signalingConnected={state.signalingConnected}
        recording={recording}
        elapsed={elapsed}
        playerSnap={playerSnap}
        playerLoaded={playerLoaded}
        takeCount={takes.size}
        streamCount={state.deskStatus.length}
        exportMenu={exportMenu}
      />

      <DeskToolbar
        recording={recording}
        playerLoaded={playerLoaded}
        playerSnap={playerSnap}
        markersUsable={markersUsable}
        tool={tool}
        onTool={setTool}
        lastChirpAt={state.lastChirpAt}
        errors={state.errors}
        exportError={exportError}
        zoom={zoom}
        selectionCount={selection.length}
        alignFlow={alignFlow}
        alignNote={alignNote}
        laneNameOf={(channelKey) =>
          rows.find((row) => row.key === channelKey)?.name ?? channelKey.slice(0, 8)
        }
        onZoom={setZoom}
        onAutoAlign={autoAlign}
        onAddMarker={addMarkerAtPlayhead}
        onOpenComments={openCommentComposer}
        onDismissError={(index) => getDeskSession(sessionId).dismissError(index)}
      />

      {/* ================= MAIN ================= */}
      <div className="flex min-h-0">
        <TimelineSection
          sessionId={sessionId}
          timelineRef={timelineRef}
          onLanePointerDown={onLanePointerDown}
          laneWidth={laneWidth}
          pxPerSec={pxPerSec}
          rows={rows}
          rowClips={rowClips}
          levelFor={levelFor}
          channels={playerSnap.channels}
          disarmedPeers={state.disarmedPeers}
          recording={recording}
          markersUsable={markersUsable}
          tool={tool}
          onSplitAt={splitAllAt}
          activeSong={activeSong}
          durationSec={playerSnap.takeDurationSec}
          timelineBaseSec={timelineBaseSec}
          takeBaseSec={selectedBaseSec}
          markers={displayMarkers}
          comments={takeComments.comments}
          midiLane={midiLane}
          playheadSec={playheadSec}
          ghostPlayheads={ghostPlayheads}
          marquee={marquee}
          selectedLaneKey={selectedLaneKey}
          onSelectLane={setSelectedLaneKey}
          onLaneMenu={openLaneMenu}
          onSeekTimeline={seekTimeline}
          onAddMarkerAt={(atSec) => takeMarkers.addAt(atSec)}
          takeMicOf={takeMicOf}
        />

        {/* -------- right rail (272px) -------- */}
        <aside className="flex w-[272px] flex-none flex-col border-l border-divider bg-panel">
          <RailTabs
            tab={tab}
            onTab={setTab}
            songCount={songs.length}
            openCommentCount={takeComments.openCount}
            streamCount={state.deskStatus.length}
          />

          {tab === "performers" ? (
            <PerformersPanel
              sessionId={sessionId}
              recorders={phones}
              rows={rows}
              activeTakeId={state.activeTakeId}
              streams={state.streams}
              levelForRow={levelFor}
              deskInput={deskInput}
              deskMidi={deskMidi}
              midiColor={TRACK_COLORS[rows.length % TRACK_COLORS.length] as string}
            />
          ) : tab === "songs" ? (
            <SongsPanel
              songs={songs}
              takeDurationSec={playerSnap.takeDurationSec}
              currentSongId={currentSongId}
              usable={markersUsable}
              canRender={canRenderTake && exportBusy === null}
              fileNameOf={(song) => `${songTag(song)}.wav`}
              onAdd={addMarkerAtPlayhead}
              // Song starts are take-local; the transport clock is session
              // time (W6-B) — seeks add the take's base.
              onSeek={(song) => getPlayer().seek(selectedBaseSec + song.startSec)}
              onRename={takeMarkers.rename}
              onRemove={takeMarkers.remove}
              onRender={(song) => void exportSong(song)}
            />
          ) : tab === "comments" ? (
            <CommentsPanel
              comments={takeComments.comments}
              usable={markersUsable}
              lanes={commentLanes}
              // Comments live take-local (W2-F): hand the panel the
              // playhead in ITS domain, add the base back on seeks (W6-B).
              // Clamped into the take exactly like markers (QA M-1): a
              // session playhead rolling in a neighbor take must not mint
              // a comment beyond this take's span into the shared doc —
              // it lands at the nearest take edge instead.
              playheadSec={
                playerLoaded
                  ? Math.max(0, Math.min(takeLocalPositionSec, playerSnap.takeDurationSec))
                  : 0
              }
              author={commentAuthor}
              focusToken={composerFocus}
              onAuthorChange={changeCommentAuthor}
              onAdd={(input) => takeComments.add({ ...input, author: commentAuthor })}
              onSeek={(atSec) => getPlayer().seek(selectedBaseSec + atSec)}
              onEditText={takeComments.editText}
              onResolve={takeComments.resolve}
              onUnresolve={takeComments.unresolve}
              onRemove={takeComments.remove}
            />
          ) : (
            <SinksPanel
              deskStatus={state.deskStatus}
              serverStatus={serverStatus}
              driftByStream={driftByStream}
              orphanedStreams={orphanedStreams}
              laneNameOf={laneNameOf}
            />
          )}
        </aside>
      </div>

      <MixerDock
        sessionId={sessionId}
        rows={rows}
        playerSnap={playerSnap}
        recording={recording}
        liveMasterLevel={liveMasterLevel}
        levelFor={levelFor}
        remoteEditing={remoteEditing}
        selectedLaneKey={selectedLaneKey}
        onSelectLane={setSelectedLaneKey}
        onLaneMenu={openLaneMenu}
      />

      {/* Lane context menu (W4-E). Delete only STAGES the lane's recorded
          clips — the F2 confirm dialog below owns the durable destroy. */}
      {laneMenu && menuRow && (
        <LaneContextMenu
          laneName={menuRow.name}
          x={laneMenu.x}
          y={laneMenu.y}
          canMoveUp={rows.indexOf(menuRow) > 0}
          canMoveDown={rows.indexOf(menuRow) < rows.length - 1}
          soloed={playerSnap.channels.find((c) => c.key === menuRow.key)?.soloed ?? false}
          muted={playerSnap.channels.find((c) => c.key === menuRow.key)?.muted ?? false}
          deletableClipCount={menuRow.streams.filter((s) => s.takeId !== state.activeTakeId).length}
          onMoveUp={() => moveLane(menuRow.key, -1)}
          onMoveDown={() => moveLane(menuRow.key, 1)}
          onSolo={() => getPlayer().toggleChannelSolo(menuRow.key)}
          onMute={() => getPlayer().toggleChannelMute(menuRow.key)}
          onDelete={() => {
            const refs = menuRow.streams
              .filter((s) => s.takeId !== state.activeTakeId)
              .map((s) => ({ takeId: s.takeId, streamId: s.streamId }));
            if (refs.length > 0) setPendingDelete(refs);
          }}
          onClose={() => setLaneMenu(null)}
        />
      )}

      {pendingDelete && (
        <DeleteConfirm
          takes={deleteSummary}
          clipCount={pendingDelete.length}
          splitWhole={deleteSplitWhole}
          onConfirm={confirmDelete}
          onCancel={() => setPendingDelete(null)}
        />
      )}

      {/* Terminal control-plane halt (F3): signaling stopped for good —
          render the fact over everything; take-over is the only exit. */}
      {state.fatal && (
        <DeskFatalPanel
          fatal={state.fatal}
          onTakeOver={() => getDeskSession(sessionId).takeOver()}
        />
      )}
    </main>
  );
}

/** A region's slice of its stream's waveform array (W7-B): a proportional
 * index window over the full source, so a split's pieces visually CONTINUE
 * the original drawing — same peaks at the same source positions, each box
 * re-bucketed by ClipCard's own density rule over the same px-per-second
 * geometry the boxes share. */
function sliceEnergy(energy: number[], region: ClipRegion, streamDurationSec: number): number[] {
  if (energy.length === 0 || streamDurationSec <= 0) return energy;
  const from = Math.round((region.sourceOffsetSec / streamDurationSec) * energy.length);
  const to = Math.round(
    ((region.sourceOffsetSec + region.durationSec) / streamDurationSec) * energy.length,
  );
  return energy.slice(Math.max(0, from), Math.max(from + 1, Math.min(energy.length, to)));
}
