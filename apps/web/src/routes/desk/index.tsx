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

import { useParams } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { useAuthUser } from "../../auth/use-auth-user";
import { recordRecentSession } from "../home/recent-sessions";
import { loadAuthorPref, saveAuthorPref } from "./comments";
import { type CommentLane, CommentsPanel } from "./comments-panel";
import type { ClipModel, DeskTool } from "./daw";
import { DeleteConfirm } from "./delete-confirm";
import { LaneContextMenu, type LaneMenuState } from "./lane-menu";
import { songsOf } from "./markers";
import { noteSpansOf } from "./midi";
import type { MidiLaneModel } from "./midi-lane";
import { MixerDock } from "./mixer-dock";
import { PerformersPanel } from "./performers-panel";
import { type RailTab, RailTabs } from "./right-rail";
import { buildRowClips } from "./row-clips";
import { SinksPanel } from "./sinks-panel";
import { SongsPanel } from "./songs-panel";
import { TimelineSection } from "./timeline";
import { anchorAtSec, type TakeAnchorSpan } from "./timeline-math";
import { DeskFatalPanel, DeskToolbar } from "./toolbar";
import { DeskTopBar } from "./top-bar";
import {
  SAMPLE_RATE,
  type TakeSlot,
  TRACK_COLORS,
  type TrackRow,
  takeAtSec,
  useOrphanedStreams,
  useReceiving,
  useTick,
  withPositionalSongNames,
} from "./track-model";
import { useArrangement } from "./use-arrangement";
import { useAutoAlign } from "./use-auto-align";
import { useCollabPresence } from "./use-collab";
import {
  ensureWaveform,
  getCachedWaveform,
  getDeskCollab,
  getDeskSession,
  getPlayer,
  publishUiMirror,
  requestTakeLoad,
  useDeskState,
  usePlayer,
  useServerStatus,
  useTakeComments,
  useTakeMarkers,
  waveformCacheSize,
} from "./use-desk";
import { useDeskInput } from "./use-desk-input";
import { getDeskMidi, useDeskMidi } from "./use-desk-midi";
import { useDeskRows } from "./use-desk-rows";
import { useExportActions } from "./use-export-actions";
import { useTimelineEditing } from "./use-timeline-editing";

export function DeskRoute() {
  const { uuid } = useParams({ strict: false });
  if (!uuid) return null;
  return <Desk sessionId={uuid} />;
}

function Desk({ sessionId }: { sessionId: string }) {
  const state = useDeskState(sessionId);
  // Shared project doc: mix/markers/comments/arrange sync + presence.
  const collab = getDeskCollab(sessionId);
  const collabSnap = useCollabPresence(collab);
  // Leave a trail for the home page's "recent sessions" list.
  useEffect(() => {
    recordRecentSession(sessionId);
  }, [sessionId]);
  const receiving = useReceiving(state.deskStatus);
  const [zoom, setZoom] = useState(1);
  const [tab, setTab] = useState<RailTab>("performers");
  const pxPerSec = 24 * zoom;

  const recording = state.activeTakeId !== null;
  useTick(recording, 100);
  // Editing tool: desk-local UI state (a tool is a cursor, not project
  // state). A take starting auto-reverts to Select — editing tools have
  // no meaning over a rolling take.
  const [tool, setTool] = useState<DeskTool>("select");
  useEffect(() => {
    if (recording && tool !== "select") setTool("select");
  }, [recording, tool]);
  const recorders = (state.session?.peers ?? []).filter((p) => p.role === "recorder");
  // The desk's own input joins as a recorder peer; it gets a lane like
  // everyone else but is never called a "phone".
  const deskInput = useDeskInput(sessionId);
  const deskMidi = useDeskMidi(sessionId);
  const phones = recorders.filter((p) => p.peerId !== deskInput.peerId);

  const { observedTakeIds, attribution, peerByStream, rows, takes, writeLaneOrderMap } =
    useDeskRows({
      sessionId,
      state,
      collab,
      recorders,
      deskInputPeerId: deskInput.peerId,
      receiving,
    });
  const serverStatus = useServerStatus(sessionId, observedTakeIds);
  // A mid-take phone reload leaves the original stream without an end
  // marker at either sink — terminally incomplete, presented as such.
  const orphanedStreams = useOrphanedStreams(state.deskStatus, serverStatus, state.activeTakeId);

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

  // Load AND auto-align the selected take once it is complete (chirp
  // first, content fallback; a restored persisted verdict makes align a
  // no-op). Loads ride the latest-wins queue. peerByStream is read via a
  // ref: mapping identity churns every poll and must not re-fire this.
  // Gated on attribution settling so a cold desk's first load lands on
  // performer lanes, not streamId fallback strips.
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

  // Late attribution: a stream→peer mapping landing AFTER a take loaded
  // re-keys its tracks onto performer lanes — parameter-only, playback
  // never cuts.
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
  const {
    alignmentByStream,
    alignView,
    persistedShiftsByTake,
    clipShiftSec,
    driftByStream,
    clipStartOverrides,
    setClipStartOverrides,
    docRegions,
    writeStreamRegionsMap,
    clipStartSec,
    streamStartSec,
    selectedBaseSec,
    timelineBaseSec,
    streamRegionsOf,
    regionIndex,
  } = useArrangement({
    sessionId,
    collab,
    state,
    takes,
    selectedTakeId,
    playerLoaded,
    playerSnap,
    orphanedStreams,
  });

  // Markers/comments/songs live in the TAKE's room-timeline domain (0 =
  // take head). The transport clock is session-absolute and anchor-free:
  // seeks ADD selectedBaseSec, playhead reads SUBTRACT it; only drawing
  // adds the anchored timelineBaseSec.
  const takeMarkers = useTakeMarkers(sessionId, selectedTakeId);
  // Display-level positional renumbering for auto-named songs; every
  // consumer (panel, flags, exports, mirror) reads THESE markers.
  const displayMarkers = useMemo(
    () => withPositionalSongNames(takeMarkers.markers),
    [takeMarkers.markers],
  );
  const songs = useMemo(() => songsOf(displayMarkers), [displayMarkers]);
  const markersUsable = playerLoaded && !recording;
  // Clamped into the take: the session playhead can honestly sit outside
  // it, and a marker dropped then belongs to the nearest take edge.
  const takeLocalPlayhead = useCallback(
    () =>
      Math.max(0, Math.min(getPlayer().position() - selectedBaseSec, getPlayer().takeDuration())),
    [selectedBaseSec],
  );
  // The song under the playhead. A session position OUTSIDE the selected
  // take is under NO song — without the upper bound the last song would
  // stay "current" forever.
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

  const takeComments = useTakeComments(sessionId, selectedTakeId);
  const [commentAuthor, setCommentAuthor] = useState(() => loadAuthorPref());
  // Bumped by the N key / toolbar pill: the composer focuses its input.
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

  /** Stream → lane name, for the sinks cards' human labels. */
  const laneNameOf = useMemo(() => {
    const names = new Map<string, string>();
    for (const row of rows) {
      for (const s of row.streams) names.set(s.streamId, row.name);
    }
    return (streamId: string): string | undefined => names.get(streamId);
  }, [rows]);

  /** Lane → archived mic(s) behind its AUDIBLE clips in the loaded take.
   * Audible = the take's complete streams, sorted (deterministic; an
   * unplayable orphan can never lend the chip its mic). undefined = no
   * claim; null = the archive holds no device description. */
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

  // ONE selected lane, shared by the tracks sidebar and mixer strips.
  // Desk-local by design — never in the shared doc: which lane an
  // operator is about to solo is their cursor, not project state.
  const [selectedLaneKey, setSelectedLaneKey] = useState<string | null>(null);

  // Right-click opens the cursor-anchored lane menu (and selects the
  // lane). The row re-resolves from CURRENT rows each render — a lane
  // vanishing mid-menu takes its menu with it.
  const [laneMenu, setLaneMenu] = useState<LaneMenuState | null>(null);
  const menuRow = laneMenu ? (rows.find((row) => row.key === laneMenu.laneKey) ?? null) : null;

  // A lane leaving the console takes its selection/menu STATE with it —
  // a stale selection would silently flip M back to marker-drop, and a
  // lingering menu would resurrect at stale coordinates on lane rejoin.
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

  /** Move a lane one slot: swap within the CURRENT display order, then
   * write the complete laneKey → ordinal map to the shared doc — every
   * on-screen lane gets its position pinned, later joiners append. */
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

  // Click-to-seek: the operator's parked playhead, in ARRANGEMENT seconds.
  // Any bare-surface/ruler click parks it — even with nothing loaded — and
  // it renders as THE playhead until the player can express the position
  // itself (reconciliation effects below).
  const [parkedSeekSec, setParkedSeekSec] = useState<number | null>(null);
  /** The player's seek counter as of OUR last pin reconciliation. The
   * yield effect tells a FOREIGN seek from the pin's own clamped seek by
   * this counter — the position value can't carry that signal (⏮ with
   * the transport already parked at 0 moves nothing). */
  const parkedAppliedSeek = useRef<number | null>(null);
  // The pick and the pin are per-session interaction state: a stale pick
  // would load the previous session's take.
  const pinSession = useRef(sessionId);
  if (pinSession.current !== sessionId) {
    pinSession.current = sessionId;
    setPickedTakeId(null);
    setParkedSeekSec(null);
    parkedAppliedSeek.current = null;
  }
  const timelineRef = useRef<HTMLDivElement | null>(null);

  const rowClipsRef = useRef<ClipModel[][]>([]);
  const {
    selection,
    marquee,
    pendingDelete,
    setPendingDelete,
    confirmDelete,
    deleteSplitWhole,
    deleteSummary,
    onClipPointerDown,
    onLanePointerDown,
    splitAllAt,
  } = useTimelineEditing({
    sessionId,
    collab,
    state,
    takes,
    rows,
    recording,
    playerLoaded,
    tool,
    setTool,
    pxPerSec,
    timelineRef,
    regionIndex,
    docRegions,
    writeStreamRegionsMap,
    setClipStartOverrides,
    clipStartSec,
    clipShiftSec,
    selectedLaneKey,
    setSelectedLaneKey,
    laneMenuOpen: laneMenu !== null && menuRow !== null,
    orphanedStreams,
    seekTimeline,
    getRowClips: () => rowClipsRef.current,
    onAddMarker: addMarkerAtPlayhead,
    onOpenComments: openCommentComposer,
  });

  const rowClips = buildRowClips({
    rows,
    takes,
    pxPerSec,
    tool,
    selection,
    serverDigestOf: (streamId) => serverStatus.get(streamId),
    alignedOf: (streamId) => alignmentByStream.get(streamId) ?? false,
    orphanedStreams,
    clipStartSec,
    clipShiftSec,
    streamRegionsOf,
    onClipPointerDown,
    onPickTake: setPickedTakeId,
  });
  rowClipsRef.current = rowClips;

  // The selected take's captured MIDI, in the markers' room-timeline
  // domain. `revision` bumps when a capture lands.
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
      // Drawing base is the ANCHORED one, like markers.
      baseSec: timelineBaseSec,
      durationSec: Math.max(playerSnap.takeDurationSec, lastSec),
      // Next palette slot after the audio lanes: a sibling track.
      color: TRACK_COLORS[rows.length % TRACK_COLORS.length] as string,
      overflow: takeMidi.overflow,
    };
  }, [takeMidi, timelineBaseSec, playerSnap.takeDurationSec, rows.length]);

  // Feed the SESSION PLAN into the engine: every non-live take's complete
  // streams with their arrangement starts and declared lengths — the
  // transport's whole-session map (duration, look-ahead, session render).
  // The engine diffs internally, so per-second poll rebuilds cost nothing.
  useEffect(() => {
    const plan = [...takes.keys()]
      .filter((takeId) => takeId !== state.activeTakeId)
      .map((takeId) => ({
        takeId,
        streams: state.deskStatus
          .filter((s) => s.takeId === takeId && s.complete)
          .map((s) => {
            // Split streams hand the engine their region list; never-split
            // streams keep the plan shape without a `regions` key.
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

  const { alignFlow, alignNote, autoAlign } = useAutoAlign({
    sessionId,
    collab,
    state,
    takes,
    recording,
    playerSnap,
    selectedTakeId,
    selectedStreamIds,
    selection,
    docRegions,
    writeStreamRegionsMap,
    clipStartOverrides,
    orphanedStreams,
    channelOf: (streamId) => peerByStreamRef.current.get(streamId) ?? streamId,
  });

  /** Click-to-seek: the playhead parks at the clicked ARRANGEMENT second
   * immediately; a spot inside another take's clips retargets the pick
   * onto that take (play-from-here needs no double-click first), and the
   * retargeted take comes up PAUSED at the clicked spot. */
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

  // Parked-seek reconciliation: the click landed on DRAWN geometry (which
  // shifts by the anchor inside the selected take); the player's clock is
  // anchor-free. X inside the drawn take → X − anchor; X inside the
  // trimmed-head strip [base, base+anchor) → audio parks at room zero
  // while the pin keeps the clicked spot; anywhere else → X verbatim
  // (playable silence). The pin only CLEARS once the align verdict has
  // SETTLED — it lands after the load, and clearing against the anchorless
  // mapping made the playhead visibly jump when the anchor arrived.
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
  // A parked pin is a promise about the NEXT play: it yields when the
  // transport rolls, a take starts recording, or any FOREIGN seek lands —
  // but not before the pin's take is the loaded one (until a retarget
  // load settles, seeks belong to the previous take and must not cost the
  // clicked point). The body reads the LIVE counter: the reconciliation
  // above may have bumped it within this same commit.
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

  // Playhead: the live take's write head while recording; else the parked
  // click; else the player position plus the anchor of WHATEVER take the
  // audio comes from (live for the selected take, persisted for
  // neighbors, zero over gaps) — it always rides the drawn waveforms.
  const positionInSelectedTake =
    playerSnap.positionSec >= selectedBaseSec &&
    playerSnap.positionSec <= selectedBaseSec + playerSnap.takeDurationSec;
  // Neighbor takes' audio spans with their persisted anchors. Ends use
  // declared stream lengths — the drawing domain's yardstick.
  const neighborAnchorSpans = useMemo(() => {
    const spans: TakeAnchorSpan[] = [];
    for (const [takeId, slot] of takes) {
      if (takeId === selectedTakeId || slot.live) continue;
      const persisted = persistedShiftsByTake.get(takeId);
      if (!persisted || persisted.anchorSec === 0) continue;
      const streams = state.deskStatus.filter((s) => s.takeId === takeId);
      if (streams.length === 0) continue;
      // Split streams span their region layout; never-split streams keep
      // the override/slot + declared-length yardstick. Zero-clip streams
      // (streamStartSec = +Infinity) span nothing and drop out.
      const starts = streams
        .map((s) => streamStartSec(s.streamId, takeId))
        .filter((s) => Number.isFinite(s));
      if (starts.length === 0) continue;
      const ends = streams.flatMap((s) => {
        const regions = docRegions[s.streamId];
        if (regions) return regions.map((r) => r.startSec + r.durationSec);
        return [streamStartSec(s.streamId, takeId) + s.totalSamples / SAMPLE_RATE];
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

  // Presence: publish who we are and where our playhead sits. Name = the
  // comment-author pref; color keyed off the doc clientID; face = the
  // signed-in account's picture (null keyless/signed out).
  const authUserIdentity = useAuthUser();
  useEffect(() => {
    collab.setPresence({
      name: commentAuthor,
      color: TRACK_COLORS[collab.doc.clientID % TRACK_COLORS.length] as string,
      avatarUrl: authUserIdentity?.imageUrl ?? null,
    });
  }, [collab, commentAuthor, authUserIdentity]);
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
      // Per-lane peak across ALL mounted takes: during a boundary handoff
      // the audible track may not belong to the selected take.
      return playerSnap.channelLevels[row.key] ?? 0;
    }
    return 0;
  }

  const { exportMenu, exportError, songExports } = useExportActions({
    sessionId,
    state,
    rows,
    takes,
    serverStatus,
    selectedTakeId,
    songs,
    displayMarkers,
    comments: takeComments.comments,
    midiEvents: takeMidi.events,
    playerSnap,
    playerLoaded,
    recording,
    convergedCount,
  });

  return (
    // min-w floor: below 520px no shed tier can save the top bar or
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
              canRender={songExports.canRender}
              fileNameOf={songExports.fileNameOf}
              onAdd={addMarkerAtPlayhead}
              // Song starts are take-local; the transport clock is session
              // time — seeks add the take's base.
              onSeek={(song) => getPlayer().seek(selectedBaseSec + song.startSec)}
              onRename={takeMarkers.rename}
              onRemove={takeMarkers.remove}
              onRender={songExports.render}
            />
          ) : tab === "comments" ? (
            <CommentsPanel
              comments={takeComments.comments}
              usable={markersUsable}
              lanes={commentLanes}
              // Comments live take-local: playhead handed in THAT domain,
              // clamped into the take (a session playhead rolling in a
              // neighbor must not mint a comment beyond this take's span).
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

      {/* Lane context menu. Delete only STAGES the lane's recordings —
          the confirm dialog below owns the durable destroy. */}
      {laneMenu && menuRow && (
        <LaneContextMenu
          laneName={menuRow.name}
          x={laneMenu.x}
          y={laneMenu.y}
          canMoveUp={rows.indexOf(menuRow) > 0}
          canMoveDown={rows.indexOf(menuRow) < rows.length - 1}
          soloed={playerSnap.channels.find((c) => c.key === menuRow.key)?.soloed ?? false}
          muted={playerSnap.channels.find((c) => c.key === menuRow.key)?.muted ?? false}
          deletableClipCount={menuRow.streams
            .filter((s) => s.takeId !== state.activeTakeId)
            // A recording stays durably deletable even with zero visible
            // clips (projection-deleted): count at least 1 each.
            .reduce((n, s) => n + Math.max(docRegions[s.streamId]?.length ?? 1, 1), 0)}
          onMoveUp={() => moveLane(menuRow.key, -1)}
          onMoveDown={() => moveLane(menuRow.key, 1)}
          onSolo={() => getPlayer().toggleChannelSolo(menuRow.key)}
          onMute={() => getPlayer().toggleChannelMute(menuRow.key)}
          onDelete={() => {
            // Whole-lane durable destroy (rows + blobs), behind the confirm.
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
          clipCount={deleteSummary.reduce((n, t) => n + t.clipCount, 0)}
          splitWhole={deleteSplitWhole}
          onConfirm={confirmDelete}
          onCancel={() => setPendingDelete(null)}
        />
      )}

      {/* Terminal control-plane halt: signaling stopped for good — render
          the fact over everything; take-over is the only exit. */}
      {state.fatal && (
        <DeskFatalPanel
          fatal={state.fatal}
          onTakeOver={() => getDeskSession(sessionId).takeOver()}
        />
      )}
    </main>
  );
}
