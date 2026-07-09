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

import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import { useParams } from "react-router";
import type { DeskStreamStatus } from "../../audio/sink-worker-protocol";
import { recordRecentSession } from "../home/recent-sessions";
import { orderTakeIds } from "./attribution";
import { loadAuthorPref, saveAuthorPref } from "./comments";
import { type CommentLane, CommentsPanel } from "./comments-panel";
import type { ClipModel } from "./daw";
import { RULER_H, TRACK_HEADER_W, TRACK_ROW_H } from "./daw";
import { DeleteConfirm, type DeleteSummaryTake } from "./delete-confirm";
import type { ExportJob, ExportMenuProps } from "./export-menu";
import { type Song, songFileName, songsOf } from "./markers";
import { noteSpansOf } from "./midi";
import type { MidiLaneModel } from "./midi-lane";
import { MixerDock } from "./mixer-dock";
import { PerformersPanel } from "./performers-panel";
import type { DriftResult } from "./player";
import { type RailTab, RailTabs } from "./right-rail";
import { SinksPanel } from "./sinks-panel";
import { SongsPanel } from "./songs-panel";
import { type Marquee, TimelineSection } from "./timeline";
import type { RenderRange } from "./timeline-math";
import { DeskFatalPanel, DeskToolbar } from "./toolbar";
import { DeskTopBar } from "./top-bar";
import {
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
  useOrphanedStreams,
  useReceiving,
  useTick,
  withPositionalSongNames,
} from "./track-model";
import { useCollabArrange, useCollabPresence } from "./use-collab";
import {
  ensureWaveform,
  exportAbletonProject,
  exportLogicPackage,
  exportMasterWav,
  exportMidiFile,
  exportProjectPackage,
  exportSongsZip,
  exportStemsZip,
  getCachedWaveform,
  getDeskCollab,
  getDeskSession,
  getPlayer,
  publishUiMirror,
  requestTakeLoad,
  useDeskState,
  usePlayer,
  useServerStatus,
  useSessionAttribution,
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
    return stableLaneOrder(laneRanks.current, candidates).map((key): TrackRow => {
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

  // Load (and, when a chirp was emitted this session, auto-align) the
  // selected take as soon as it is complete at the desk. Loads run through
  // the latest-wins queue (F5): a pick landing mid-decode is never dropped
  // — the player converges on the newest selection. Streams map to mixer
  // lanes by performer (read through a ref: mapping identity churns every
  // poll and must not re-fire this effect — see selectedStreamKey). Gated
  // on the attribution fetch settling so a cold desk's first load already
  // lands on performer lanes instead of streamId-keyed fallback strips.
  const chirped = state.lastChirpAt !== null;
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
      align: chirped,
    });
  }, [sessionId, selectedTakeId, selectedStreamIds, recording, chirped, attribution.ready]);

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
  const driftByStream = useMemo(() => {
    const map = new Map<string, DriftResult>();
    for (const t of playerSnap.tracks) {
      if (t.drift) map.set(t.streamId, t.drift);
    }
    return map;
  }, [playerSnap.tracks]);

  // ---- song markers (W2-B) -------------------------------------------------
  // Marker positions live in the TAKE's room-timeline domain — exactly
  // player.position()/seek() — so seeks and per-song render ranges need no
  // conversion; only drawing adds the arrangement offset (selectedBaseSec).
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
  // The song under the playhead (panel highlight); the ruler's accent
  // strip additionally requires the transport to be rolling.
  const currentSongId = markersUsable
    ? (songs.findLast((s) => playerSnap.positionSec >= s.startSec)?.id ?? null)
    : null;
  const activeSong = playerSnap.playing
    ? (songs.find((s) => s.id === currentSongId) ?? null)
    : null;

  function addMarkerAtPlayhead() {
    if (!markersUsable) return;
    takeMarkers.addAt(getPlayer().position());
  }

  // ---- comments (W2-F) -------------------------------------------------------
  // Same interim status and position domain as markers: atSec is take
  // room-timeline (player.position()/seek()); drawing adds selectedBaseSec.
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

  // ---- timeline editing: selection, marquee, clip drag ---------------------
  const [selection, setSelection] = useState<string[]>([]);
  // Deletion staged behind the confirm dialog (F2): Delete/Backspace only
  // STAGES refs here; the durable streams-delete fires from the dialog's
  // explicit confirm. Escape/cancel drops the stage, selection preserved.
  const [pendingDelete, setPendingDelete] = useState<Array<{
    takeId: string;
    streamId: string;
  }> | null>(null);
  // Clip arrangement lives in the shared doc (W3-A): local drags write
  // through, remote desks' drags land here live. Same updater shape as the
  // useState it replaced.
  const [clipStartOverrides, setClipStartOverrides] = useCollabArrange(collab);
  const [marquee, setMarquee] = useState<Marquee | null>(null);
  const timelineRef = useRef<HTMLDivElement | null>(null);

  /** Arrangement position of a clip: user override, else its take slot. */
  const clipStartSec = (streamId: string, takeId: string): number =>
    clipStartOverrides[streamId] ?? takes.get(takeId)?.offsetSec ?? 0;

  /** Per-row clip models with geometry + interaction handlers. */
  const rowClips: ClipModel[][] = rows.map((row) =>
    row.streams.flatMap((stream) => {
      const slot = takes.get(stream.takeId);
      if (!slot) return [];
      const server = serverStatus.get(stream.streamId);
      const converged =
        stream.complete && (server?.complete ?? false) && stream.digest === server?.digest;
      const aligned = alignmentByStream.get(stream.streamId) ?? false;
      const durationSec = Math.max(
        stream.totalSamples / SAMPLE_RATE,
        slot.live ? slot.durationSec : 1,
      );
      const takeNumber = [...takes.keys()].indexOf(stream.takeId) + 1;
      const startSec = clipStartSec(stream.streamId, stream.takeId);
      // Completed streams ALWAYS draw the true decoded waveform (background
      // cache); the encoded-complexity proxy only covers the live take
      // still growing under the record head.
      const waveform = getCachedWaveform(stream.streamId) ?? stream.energy;
      const recordedSec = stream.totalSamples / SAMPLE_RATE;
      return [
        {
          id: stream.streamId,
          takeId: stream.takeId,
          name: slot.live ? "Incoming take" : `Take ${takeNumber}`,
          color: row.color,
          x: startSec * pxPerSec,
          width: durationSec * pxPerSec - 3,
          durationSec,
          live: slot.live,
          // An orphaned stream (F9) can never align or converge — its
          // terminal "incomplete" outranks the transient "syncing".
          badge: slot.live
            ? ("rec" as const)
            : orphanedStreams.has(stream.streamId)
              ? ("incomplete" as const)
              : aligned
                ? ("aligned" as const)
                : converged
                  ? ("converged" as const)
                  : ("syncing" as const),
          energy: waveform,
          fillFraction: slot.live && durationSec > 0 ? Math.min(1, recordedSec / durationSec) : 1,
          selected: selection.includes(stream.streamId) && !slot.live,
          ...(slot.live
            ? {}
            : {
                onPointerDown: (e: React.PointerEvent) => onClipPointerDown(e, stream.streamId),
                // Loading a take is an EXPLICIT action (QA E3): selection
                // (click/marquee) must not switch what the player has
                // loaded — double-click does.
                onDoubleClick: () => setPickedTakeId(stream.takeId),
              }),
        },
      ];
    }),
  );

  /** The selected take's timeline base: leftmost of its clips. */
  const selectedBaseSec = useMemo(() => {
    if (!selectedTakeId) return 0;
    const starts = state.deskStatus
      .filter((s) => s.takeId === selectedTakeId)
      .map((s) => clipStartOverrides[s.streamId] ?? takes.get(selectedTakeId)?.offsetSec ?? 0);
    return starts.length > 0 ? Math.min(...starts) : 0;
    // eslint-style deps handled below in the delays effect
  }, [selectedTakeId, state.deskStatus, clipStartOverrides, takes]);

  // ---- captured MIDI (W3-C) --------------------------------------------------
  // The selected take's events, in the same room-timeline domain as markers
  // (drawing adds selectedBaseSec). `revision` bumps when a capture lands.
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
      baseSec: selectedBaseSec,
      durationSec: Math.max(playerSnap.durationSec, lastSec),
      // Next palette slot after the audio lanes — the lane reads as a
      // sibling track, not a duplicate of one.
      color: TRACK_COLORS[rows.length % TRACK_COLORS.length] as string,
      overflow: takeMidi.overflow,
    };
  }, [takeMidi, selectedBaseSec, playerSnap.durationSec, rows.length]);

  // Feed arrangement offsets into the playback engine.
  useEffect(() => {
    if (!selectedTakeId || !playerLoaded) return;
    const delays: Record<string, number> = {};
    for (const s of state.deskStatus) {
      if (s.takeId !== selectedTakeId) continue;
      delays[s.streamId] =
        (clipStartOverrides[s.streamId] ?? takes.get(selectedTakeId)?.offsetSec ?? 0) -
        selectedBaseSec;
    }
    getPlayer().setClipDelays(delays);
  }, [selectedTakeId, playerLoaded, clipStartOverrides, state.deskStatus, takes, selectedBaseSec]);

  /** Clip drag: pressing an unselected clip selects it; dragging moves every
   * selected clip together. A press without movement is just selection —
   * it deliberately does NOT switch the loaded take (QA E3); double-click
   * is the explicit load action.
   *
   * F17 — additive selection: shift/cmd/ctrl-press TOGGLES the clip in or
   * out of the current selection and never starts a drag (a toggle is a
   * selection edit, not a grab — dragging still works from a plain press). */
  function onClipPointerDown(e: React.PointerEvent, streamId: string) {
    if (e.button !== 0) return;
    e.stopPropagation();
    if (e.shiftKey || e.metaKey || e.ctrlKey) {
      setSelection((prev) =>
        prev.includes(streamId) ? prev.filter((id) => id !== streamId) : [...prev, streamId],
      );
      return;
    }
    const dragIds = selection.includes(streamId) ? selection : [streamId];
    if (!selection.includes(streamId)) setSelection([streamId]);
    const originX = e.clientX;
    const startPositions = new Map(
      dragIds.map((id) => {
        const stream = state.deskStatus.find((s) => s.streamId === id);
        return [id, stream ? clipStartSec(id, stream.takeId) : 0];
      }),
    );
    const move = (ev: PointerEvent) => {
      const dxSec = (ev.clientX - originX) / pxPerSec;
      if (Math.abs(ev.clientX - originX) < 4) return;
      setClipStartOverrides((prev) => {
        const next = { ...prev };
        for (const [id, start] of startPositions) {
          next[id] = Math.max(0, start + dxSec);
        }
        return next;
      });
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  /** Empty-lane press: click seeks the playhead, click-and-hold drags a
   * marquee that selects every clip it touches. With shift (or cmd/ctrl)
   * held the marquee ADDS its hits to the selection instead of replacing
   * it, and a modifier'd click on bare lane preserves the selection (F17)
   * — additive gestures only ever edit selection, never wipe it. Seeking
   * is modifier-agnostic. */
  function onLanePointerDown(e: React.PointerEvent) {
    if (e.button !== 0 || recording) return;
    const additive = e.shiftKey || e.metaKey || e.ctrlKey;
    const target = e.target as HTMLElement;
    if (target.closest("button")) return; // clips and controls handle themselves
    const container = timelineRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const x0 = e.clientX - rect.left;
    const y0 = e.clientY - rect.top;
    if (x0 < TRACK_HEADER_W || y0 < RULER_H) return; // headers/ruler
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
      // the DAW convention worth keeping.
      if (target.closest?.('[role="dialog"]')) return;
      // The confirm dialog owns the keyboard while open (Enter/Escape/trap).
      if (pendingDelete) return;
      if (e.code === "Space") {
        e.preventDefault();
        if (recording) getDeskSession(sessionId).stopTake();
        else if (playerLoaded) getPlayer().toggle();
        return;
      }
      // M: drop a song marker at the playhead (W2-B).
      if (e.code === "KeyM" && !e.metaKey && !e.ctrlKey && !e.altKey) {
        if (playerLoaded && !recording) takeMarkers.addAt(getPlayer().position());
        return;
      }
      // C: open the comments composer focused at the playhead (W2-F).
      if (e.code === "KeyC" && !e.metaKey && !e.ctrlKey && !e.altKey) {
        if (playerLoaded && !recording) {
          e.preventDefault();
          setTab("comments");
          setComposerFocus((n) => n + 1);
        }
        return;
      }
      if ((e.code === "Delete" || e.code === "Backspace") && selection.length > 0) {
        e.preventDefault();
        const refs = state.deskStatus
          .filter((s) => selection.includes(s.streamId) && s.takeId !== state.activeTakeId)
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
    pendingDelete,
    state.deskStatus,
    state.activeTakeId,
    takeMarkers.addAt,
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

  function seekTimeline(sec: number) {
    if (!playerLoaded) return;
    getPlayer().seek(Math.max(0, sec - selectedBaseSec));
  }

  // Playhead position on the shared timeline.
  const playheadSec = recording
    ? state.activeTakeId && takes.has(state.activeTakeId)
      ? (takes.get(state.activeTakeId) as TakeSlot).offsetSec + elapsed
      : null
    : playerLoaded && selectedTakeId
      ? selectedBaseSec + playerSnap.positionSec
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
      playheadSec,
      selectedTakeId,
      liveMasterLevel,
      waveformsCached: waveformCacheSize(),
      markers: displayMarkers,
      comments: takeComments.comments,
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
    if (playerLoaded && playerSnap.playing) {
      return playerSnap.tracks.find((t) => t.channelKey === row.key)?.level ?? 0;
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

  const exportMaster = () => runExport("master", () => exportMasterWav(`${takeTag}-master.wav`));

  const exportStems = () =>
    runExport("stems", () => {
      // Stems carry the lane name (nickname when set), like the FLAC path.
      const laneOf = new Map(rows.map((row) => [row.key, row.name]));
      return exportStemsZip(`${takeTag}-stems.zip`, (streamId, channelKey) => {
        const lane = laneOf.get(channelKey);
        return `${lane ? `${fileSafe(lane)}-` : ""}${streamId.slice(0, 8)}.wav`;
      });
    });

  /** A song's render span: a last-marker song runs to the true take end,
   * expressed by omitting endSec (resolveRange fills the duration in). */
  const songRange = (song: Song): RenderRange => ({
    startSec: song.startSec,
    ...(song.endSec !== null ? { endSec: song.endSec } : {}),
  });

  const exportSong = (song: Song) =>
    runExport("songs", () => exportMasterWav(songFileName(song.index, song.name), songRange(song)));

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
    takeDurationSec: playerSnap.durationSec,
    midiEventCount: takeMidi.events.length,
    onMaster: () => void exportMaster(),
    onStems: () => void exportStems(),
    onSong: (song) => void exportSong(song),
    onAllSongs: () => void exportAllSongs(),
    onFlac: exportFlacAll,
    onMidi: () => exportMidiFile(`${takeTag}.mid`, takeMidi.events),
    onProjectPackage: () => void exportProject(),
    onAbleton: () => void exportAbleton(),
    onLogic: () => void exportLogic(),
  };

  return (
    <main className="grid h-dvh grid-cols-[minmax(0,1fr)] grid-rows-[48px_40px_1fr_264px] overflow-hidden bg-bg text-[12px]">
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
        lastChirpAt={state.lastChirpAt}
        errors={state.errors}
        exportError={exportError}
        zoom={zoom}
        laneNameOf={(channelKey) =>
          rows.find((row) => row.key === channelKey)?.name ?? channelKey.slice(0, 8)
        }
        onZoom={setZoom}
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
          playerLoaded={playerLoaded}
          markersUsable={markersUsable}
          activeSong={activeSong}
          durationSec={playerSnap.durationSec}
          selectedBaseSec={selectedBaseSec}
          markers={displayMarkers}
          comments={takeComments.comments}
          midiLane={midiLane}
          playheadSec={playheadSec}
          ghostPlayheads={ghostPlayheads}
          marquee={marquee}
          onSeekTimeline={seekTimeline}
          onAddMarkerAt={(atSec) => takeMarkers.addAt(atSec)}
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
              joinUrl={joinUrl}
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
              takeDurationSec={playerSnap.durationSec}
              currentSongId={currentSongId}
              usable={markersUsable}
              canRender={canRenderTake && exportBusy === null}
              onAdd={addMarkerAtPlayhead}
              onSeek={(song) => getPlayer().seek(song.startSec)}
              onRename={takeMarkers.rename}
              onRemove={takeMarkers.remove}
              onRender={(song) => void exportSong(song)}
            />
          ) : tab === "comments" ? (
            <CommentsPanel
              comments={takeComments.comments}
              usable={markersUsable}
              lanes={commentLanes}
              playheadSec={playerLoaded ? playerSnap.positionSec : 0}
              author={commentAuthor}
              focusToken={composerFocus}
              onAuthorChange={changeCommentAuthor}
              onAdd={(input) => takeComments.add({ ...input, author: commentAuthor })}
              onSeek={(atSec) => getPlayer().seek(atSec)}
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
        rows={rows}
        playerSnap={playerSnap}
        recording={recording}
        liveMasterLevel={liveMasterLevel}
        levelFor={levelFor}
        remoteEditing={remoteEditing}
      />

      {pendingDelete && (
        <DeleteConfirm
          takes={deleteSummary}
          clipCount={pendingDelete.length}
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
