// Mixing desk — /session/:uuid. Layout, geometry, and visual language follow
// the prototype (docs/Antiphone DAW.dc.html) row for row: 48px top bar with
// a centered transport cluster, 40px toolbar, arrange timeline with 232px
// sticky track headers, a 272px right rail, and the mixer footer.
// Record/stop/chirp, playback with a moving playhead + click-to-seek,
// chirp auto-alignment, and the gain/mute/solo mixer are all live; only
// editing tools and pan (mono v1) remain visibly inert.

import type { PeerInfo } from "@antiphon/protocol";
import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import { useParams } from "react-router";
import type { DeskStreamStatus } from "../../audio/sink-worker-protocol";
import {
  Avatar,
  Badge,
  MonoReadout,
  SectionLabel,
  StatusPill,
  StyledQr,
  VUMeter,
  Wordmark,
} from "../../ui/kit";
import {
  AvatarStack,
  ClipCard,
  type ClipModel,
  InfoChip,
  LaneRuler,
  laneGridStyle,
  MixerStrip,
  RULER_H,
  SnapGrid,
  Timecode,
  ToolGroup,
  TRACK_HEADER_W,
  TRACK_ROW_H,
  TrackMiniButton,
  TransportButton,
  TransportGroup,
  ViewTabs,
  VUVertical,
  ZoomControl,
} from "./daw";
import { defaultEq } from "./eq";
import { type Marker, type Song, songFileName, songsOf } from "./markers";
import type { ChannelStrip, DriftResult, PlayerSnapshot } from "./player";
import type { RenderRange } from "./timeline-math";
import {
  ensureWaveform,
  exportMasterWav,
  exportSongsZip,
  exportStemsZip,
  getCachedWaveform,
  getDeskSession,
  getPlayer,
  loadTakeIntoPlayer,
  publishUiMirror,
  type ServerStreamStatus,
  useDeskState,
  usePlayer,
  useServerStatus,
  useTakeMarkers,
  waveformCacheSize,
} from "./use-desk";
import { type DeskInputState, getDeskInput, useDeskInput } from "./use-desk-input";

const TRACK_COLORS = [
  "#4fb8a8",
  "#d9a441",
  "#d96c7b",
  "#d97e4a",
  "#5b8dd9",
  "#9a7bd9",
  "#55aec8",
  "#7bb661",
];

const SAMPLE_RATE = 48_000;
const TAKE_GAP_SECONDS = 2;

export function DeskRoute() {
  const { uuid } = useParams();
  if (!uuid) return null;
  return <Desk sessionId={uuid} />;
}

// ---- timeline model ---------------------------------------------------------

interface TrackRow {
  key: string;
  index: number;
  /** Renameable lane ⇔ it maps to a known peer (peer-update target). */
  peerId: string | null;
  name: string;
  color: string;
  peerInitials: string;
  peerLabel: string | null;
  streams: DeskStreamStatus[];
  receiving: boolean;
  armed: boolean;
}

interface TakeSlot {
  takeId: string;
  offsetSec: number;
  durationSec: number;
  live: boolean;
}

function useReceiving(deskStatus: DeskStreamStatus[]): Set<string> {
  const heldRef = useRef(new Map<string, { count: number; at: number }>());
  const receiving = new Set<string>();
  const now = Date.now();
  for (const s of deskStatus) {
    const prev = heldRef.current.get(s.streamId);
    if (!prev || prev.count !== s.heldCount) {
      heldRef.current.set(s.streamId, { count: s.heldCount, at: now });
      if (prev) receiving.add(s.streamId);
    } else if (now - prev.at < 2_500) {
      receiving.add(s.streamId);
    }
  }
  return receiving;
}

function deviceName(userAgent: string): string {
  const m = /iPhone|iPad|Android|Macintosh|Windows/.exec(userAgent);
  return m ? m[0] : "Browser";
}

/** Avatar initials from a nickname: first letters of the first two words. */
function initialsOf(label: string | undefined): string | null {
  const words = label?.trim().split(/\s+/).filter(Boolean) ?? [];
  if (words.length === 0) return null;
  return words
    .slice(0, 2)
    .map((w) => (w[0] as string).toUpperCase())
    .join("");
}

/** Filesystem-safe lane name for export filenames. */
function fileSafe(name: string): string {
  return name.replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "") || "track";
}

/** Re-render at `ms` cadence while `active` (live timecode + growing clip). */
function useTick(active: boolean, ms: number): void {
  const [, force] = useState(0);
  useEffect(() => {
    if (!active) return;
    const t = window.setInterval(() => force((n) => n + 1), ms);
    return () => window.clearInterval(t);
  }, [active, ms]);
}

function Desk({ sessionId }: { sessionId: string }) {
  const state = useDeskState(sessionId);
  const takeIds = useMemo(() => [...new Set(state.streams.map((s) => s.takeId))], [state.streams]);
  const serverStatus = useServerStatus(sessionId, takeIds);
  const receiving = useReceiving(state.deskStatus);
  const [zoom, setZoom] = useState(1);
  const [tab, setTab] = useState<"performers" | "songs" | "sinks">("performers");
  const [shared, setShared] = useState(false);
  const pxPerSec = 24 * zoom;

  const recording = state.activeTakeId !== null;
  useTick(recording, 100);
  const recorders = (state.session?.peers ?? []).filter((p) => p.role === "recorder");
  // The desk's own input joins as a recorder peer (W2-D); it gets a lane
  // like everyone else but is not a "phone" anywhere the copy says so.
  const deskInput = useDeskInput(sessionId);
  const phones = recorders.filter((p) => p.peerId !== deskInput.peerId);
  const peerByStream = useMemo(() => {
    const map = new Map<string, string>();
    for (const s of state.streams) if (s.peerId) map.set(s.streamId, s.peerId);
    return map;
  }, [state.streams]);

  // Rows: one per performer (falling back to per-stream for rebuilt takes
  // whose announce we never saw).
  const rows = useMemo(() => {
    const byKey = new Map<string, TrackRow>();
    const order: string[] = [];
    for (const stream of state.deskStatus) {
      const peerId = peerByStream.get(stream.streamId) ?? null;
      const key = peerId ?? stream.streamId;
      let row = byKey.get(key);
      if (!row) {
        const index = order.length;
        const peer = recorders.find((p) => p.peerId === peerId);
        // Nickname first (A13); fall back to the device-derived name.
        const nickname = peer?.deviceInfo.label?.trim();
        row = {
          key,
          index,
          peerId: peer?.peerId ?? null,
          name:
            nickname ||
            (peer
              ? `${deviceName(peer.deviceInfo.userAgent)} ${index + 1}`
              : `Stream ${index + 1}`),
          color: TRACK_COLORS[index % TRACK_COLORS.length] as string,
          peerInitials:
            initialsOf(nickname) ?? (peerId ?? stream.streamId).slice(0, 2).toUpperCase(),
          // The chip keeps the device provenance even when a nickname rules
          // the lane title ("Maria" · chip "iPhone"; the desk input · "Desk").
          peerLabel: peer
            ? peer.peerId === deskInput.peerId
              ? "Desk"
              : deviceName(peer.deviceInfo.userAgent)
            : null,
          streams: [],
          receiving: false,
          armed: false,
        };
        byKey.set(key, row);
        order.push(key);
      }
      row.streams.push(stream);
      if (receiving.has(stream.streamId)) row.receiving = true;
      if (stream.takeId === state.activeTakeId) row.armed = true;
    }
    return order.map((k) => byKey.get(k) as TrackRow);
  }, [state.deskStatus, peerByStream, recorders, receiving, state.activeTakeId, deskInput.peerId]);

  // Takes in CHRONOLOGICAL order with sequential timeline offsets. Stream
  // announces arrive live (in take order); deskStatus alone is sorted by
  // take-id bytes, which would shuffle take numbers/placement per session.
  // Rebuilt-after-reload takes (no announce seen) append in status order.
  const takes = useMemo(() => {
    const seen: string[] = [];
    for (const s of state.streams) {
      if (!seen.includes(s.takeId)) seen.push(s.takeId);
    }
    for (const s of state.deskStatus) {
      if (!seen.includes(s.takeId)) seen.push(s.takeId);
    }
    const present = new Set(state.deskStatus.map((s) => s.takeId));
    for (let i = seen.length - 1; i >= 0; i--) {
      if (!present.has(seen[i] as string)) seen.splice(i, 1);
    }
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
  }, [state.streams, state.deskStatus, state.activeTakeId, state.takeStartedAt]);

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
  // selected take as soon as it is complete at the desk. Streams map to
  // mixer lanes by performer (read through a ref: mapping identity churns
  // every poll and must not re-fire this effect — see selectedStreamKey).
  const chirped = state.lastChirpAt !== null;
  const peerByStreamRef = useRef(peerByStream);
  peerByStreamRef.current = peerByStream;
  useEffect(() => {
    if (!selectedTakeId || selectedStreamIds.length === 0 || recording) return;
    const channelOf = (streamId: string) => peerByStreamRef.current.get(streamId) ?? streamId;
    void loadTakeIntoPlayer(sessionId, selectedTakeId, selectedStreamIds, channelOf).then((ok) => {
      if (ok && chirped) void getPlayer().align();
    });
  }, [sessionId, selectedTakeId, selectedStreamIds, recording, chirped]);

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
  const songs = useMemo(() => songsOf(takeMarkers.markers), [takeMarkers.markers]);
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

  // ---- timeline editing: selection, marquee, clip drag ---------------------
  const [selection, setSelection] = useState<string[]>([]);
  const [clipStartOverrides, setClipStartOverrides] = useState<Record<string, number>>({});
  const [marquee, setMarquee] = useState<{
    x0: number;
    y0: number;
    x1: number;
    y1: number;
  } | null>(null);
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
          badge: slot.live
            ? ("rec" as const)
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
                onPointerDown: (e: React.PointerEvent) =>
                  onClipPointerDown(e, stream.streamId, stream.takeId),
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
   * selected clip together. A press without movement is just selection. */
  function onClipPointerDown(e: React.PointerEvent, streamId: string, takeId: string) {
    if (e.button !== 0) return;
    e.stopPropagation();
    const dragIds = selection.includes(streamId) ? selection : [streamId];
    if (!selection.includes(streamId)) setSelection([streamId]);
    setPickedTakeId(takeId);
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
   * marquee that selects every clip it touches. */
  function onLanePointerDown(e: React.PointerEvent) {
    if (e.button !== 0 || recording) return;
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
        setSelection([]);
        seekTimeline((x0 - TRACK_HEADER_W) / pxPerSec);
        setMarquee(null);
        return;
      }
      // Marquee select: every non-live clip whose rect intersects.
      const x1 = ev.clientX - rect.left;
      const y1 = ev.clientY - rect.top;
      const [left, right] = [Math.min(x0, x1), Math.max(x0, x1)];
      const [top, bottom] = [Math.min(y0, y1), Math.max(y0, y1)];
      const hit: string[] = [];
      let hitTake: string | null = null;
      rowClips.forEach((clips, rowIndex) => {
        const rowTop = RULER_H + rowIndex * TRACK_ROW_H + 4;
        const rowBottom = RULER_H + (rowIndex + 1) * TRACK_ROW_H - 4;
        for (const clip of clips) {
          if (clip.live) continue;
          const clipLeft = TRACK_HEADER_W + clip.x;
          const clipRight = clipLeft + Math.max(clip.width, 26);
          if (clipLeft < right && clipRight > left && rowTop < bottom && rowBottom > top) {
            hit.push(clip.id);
            hitTake ??= clip.takeId;
          }
        }
      });
      setSelection(hit);
      if (hitTake) setPickedTakeId(hitTake);
      setMarquee(null);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  // Space bar: stop the ongoing recording, otherwise toggle playback.
  // Delete/Backspace: remove the selected takes' clips (server-authoritative;
  // every sink drops its copy on the confirm).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable) {
        return;
      }
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
      if ((e.code === "Delete" || e.code === "Backspace") && selection.length > 0) {
        e.preventDefault();
        const refs = state.deskStatus
          .filter((s) => selection.includes(s.streamId) && s.takeId !== state.activeTakeId)
          .map((s) => ({ takeId: s.takeId, streamId: s.streamId }));
        if (refs.length === 0) return;
        getDeskSession(sessionId).deleteStreams(refs);
        setSelection([]);
        setClipStartOverrides((prev) => {
          const next = { ...prev };
          for (const ref of refs) delete next[ref.streamId];
          return next;
        });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    recording,
    playerLoaded,
    sessionId,
    selection,
    state.deskStatus,
    state.activeTakeId,
    takeMarkers.addAt,
  ]);

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
      markers: takeMarkers.markers,
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

  function share() {
    void navigator.clipboard.writeText(joinUrl).then(() => {
      setShared(true);
      window.setTimeout(() => setShared(false), 1_500);
    });
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
  const [exportBusy, setExportBusy] = useState<"master" | "stems" | "songs" | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);

  const takeNumber = selectedTakeId ? [...takes.keys()].indexOf(selectedTakeId) + 1 : 0;
  const takeTag = `take-${String(Math.max(1, takeNumber)).padStart(2, "0")}`;

  async function runExport(kind: "master" | "stems" | "songs", job: () => Promise<void>) {
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

  return (
    <main className="grid h-dvh grid-cols-[minmax(0,1fr)] grid-rows-[48px_40px_1fr_264px] overflow-hidden bg-bg text-[12px]">
      {/* ================= TOP BAR (48px) ================= */}
      <header className="relative flex items-center justify-between gap-4 border-b border-divider bg-panel px-3.5">
        <div className="flex min-w-0 items-center gap-3.5">
          <Wordmark />
          <div className="h-5 w-px bg-edge-btn" />
          <div className="flex min-w-0 flex-col leading-[1.25]">
            <span className="truncate text-[12px] font-semibold text-text-strong">
              Session {sessionId.slice(0, 8)}
            </span>
            <span className="truncate text-[10px] text-text-dim">
              {phones.length} phone{phones.length === 1 ? "" : "s"} connected
              {deskInput.phase === "live" ? " · desk input" : ""} · archive{" "}
              {state.serverSync === "connected" ? "linked" : state.serverSync}
              {state.rebuiltChunks > 0 ? ` · ${state.rebuiltChunks} chunks recovered` : ""}
            </span>
          </div>
        </div>

        {/* Centered transport cluster, as in the prototype */}
        <div className="absolute left-1/2 flex -translate-x-1/2 items-center gap-2.5">
          <TransportGroup>
            <TransportButton
              label="Return to start"
              disabled={!playerLoaded || recording}
              onClick={() => getPlayer().seek(0)}
            >
              ⏮
            </TransportButton>
            <TransportButton
              label={playerSnap.playing ? "Pause" : "Play"}
              tone="accent"
              active={playerSnap.playing}
              disabled={!playerLoaded || recording || playerSnap.loading}
              onClick={() => getPlayer().toggle()}
            >
              {playerSnap.playing ? "⏸" : "▶"}
            </TransportButton>
            <TransportButton
              label="Record take"
              tone="rec"
              active={recording}
              disabled={!state.signalingConnected || recording || playerSnap.playing}
              onClick={() => getDeskSession(sessionId).startTake()}
            >
              ●
            </TransportButton>
            <TransportButton
              label="Stop take"
              disabled={!recording}
              onClick={() => getDeskSession(sessionId).stopTake()}
            >
              ■
            </TransportButton>
            <TransportButton
              label="Chirp"
              tone="accent"
              disabled={!recording}
              onClick={() => void getDeskSession(sessionId).playChirp()}
            >
              ♫
            </TransportButton>
          </TransportGroup>
          <Timecode seconds={recording ? elapsed : playerLoaded ? playerSnap.positionSec : 0} />
          <div className="flex gap-1.5">
            <InfoChip value="48.0" unit="kHz" />
            <InfoChip value={takes.size} unit={takes.size === 1 ? "take" : "takes"} />
            <InfoChip value={state.deskStatus.length} unit="str" />
          </div>
        </div>

        <div className="flex items-center gap-3">
          <AvatarStack
            people={[
              { initials: "DK", color: "#c8c9cb", title: "You (Desk)" },
              ...phones.slice(0, 3).map((p, i) => ({
                initials: initialsOf(p.deviceInfo.label) ?? p.peerId.slice(0, 2).toUpperCase(),
                color: TRACK_COLORS[i % TRACK_COLORS.length] as string,
                title: p.deviceInfo.label?.trim() || deviceName(p.deviceInfo.userAgent),
              })),
            ]}
            onAdd={() => setTab("performers")}
          />
          <button
            type="button"
            onClick={share}
            className="rounded-md border border-edge-strong px-3 py-1.5 text-[11px] font-semibold text-text hover:bg-card-hi"
          >
            {shared ? "Copied!" : "Share"}
          </button>
          <ExportMenu
            busy={exportBusy}
            canRender={canRenderTake}
            canFlac={convergedCount > 0}
            songs={songs}
            takeDurationSec={playerSnap.durationSec}
            onMaster={() => void exportMaster()}
            onStems={() => void exportStems()}
            onSong={(song) => void exportSong(song)}
            onAllSongs={() => void exportAllSongs()}
            onFlac={exportFlacAll}
          />
        </div>
      </header>

      {/* ================= TOOLBAR (40px) ================= */}
      <div className="flex items-center justify-between border-b border-divider bg-raised px-3.5">
        <div className="flex items-center gap-3.5">
          <ToolGroup />
          <div className="h-[18px] w-px bg-edge" />
          <SnapGrid />
          <button
            type="button"
            aria-label="Auto-align"
            disabled={!playerLoaded || playerSnap.aligning || recording}
            onClick={() => void getPlayer().align(true)}
            className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10.5px] font-semibold transition-colors disabled:cursor-not-allowed ${
              playerSnap.tracks.some((t) => t.alignment?.applied)
                ? "border-accent text-accent"
                : state.lastChirpAt
                  ? "border-accent/50 text-accent/80 hover:text-accent"
                  : "border-edge-strong text-text-faint"
            }`}
          >
            <span className="text-[8px]">●</span>
            {playerSnap.aligning
              ? "aligning…"
              : playerSnap.tracks.some((t) => t.alignment?.applied)
                ? "auto-align on"
                : "auto-align"}
          </button>
          <button
            type="button"
            aria-label="Add marker at playhead"
            title="Add song marker at playhead (M) — or double-click the ruler"
            disabled={!markersUsable}
            onClick={addMarkerAtPlayhead}
            className="flex items-center gap-1.5 rounded-full border border-edge-strong px-2.5 py-1 text-[10.5px] font-semibold text-text-mute transition-colors hover:text-text-hi disabled:cursor-not-allowed disabled:opacity-50"
          >
            <span className="text-[8px] text-accent/80">◆</span>
            marker
          </button>
          {state.lastChirpAt && (
            <span className="font-mono text-[9px] text-text-faint">
              chirp emitted {new Date(state.lastChirpAt).toLocaleTimeString()}
            </span>
          )}
          {playerSnap.error && (
            <span className="font-mono text-[9px] text-warn">{playerSnap.error}</span>
          )}
          {exportError && (
            <span className="font-mono text-[9px] text-warn">export: {exportError}</span>
          )}
          {state.errors.length > 0 && (
            <span className="font-mono text-[9px] text-rec">
              {state.errors[state.errors.length - 1]}
            </span>
          )}
        </div>
        <div className="flex items-center gap-3.5">
          <ViewTabs />
          <ZoomControl zoom={zoom} onZoom={setZoom} />
        </div>
      </div>

      {/* ================= MAIN ================= */}
      <div className="flex min-h-0">
        {/* -------- arrange timeline -------- */}
        <section className="relative min-w-0 flex-1 overflow-auto bg-bg">
          {/* Pointer editing surface (seek/marquee/drag); the transport
              buttons + space bar are the keyboard path. */}
          <div
            ref={timelineRef}
            className="relative min-w-full"
            style={{ width: laneWidth + TRACK_HEADER_W }}
            onPointerDown={onLanePointerDown}
            role="presentation"
          >
            {/* ruler row */}
            <div className="sticky top-0 z-[6] flex">
              <div
                className="sticky left-0 z-[7] flex flex-none items-center border-r border-b border-divider bg-panel px-2.5"
                style={{ width: TRACK_HEADER_W, height: RULER_H }}
              >
                <SectionLabel>Tracks</SectionLabel>
              </div>
              {/* Ruler + marker layer. Double-click bookmarks a song at
                  that spot (single clicks still seek via LaneRuler). */}
              {/* biome-ignore lint/a11y/noStaticElementInteractions: dblclick shortcut; the toolbar button + M key are the accessible path */}
              <div
                data-ruler
                role="presentation"
                className="relative"
                onDoubleClick={(e) => {
                  if (!markersUsable) return;
                  const rect = e.currentTarget.getBoundingClientRect();
                  const atSec = (e.clientX - rect.left) / pxPerSec - selectedBaseSec;
                  if (atSec < 0 || atSec > playerSnap.durationSec) return;
                  takeMarkers.addAt(atSec);
                }}
              >
                <LaneRuler
                  pxPerSec={pxPerSec}
                  widthPx={laneWidth}
                  {...(playerLoaded && !recording ? { onSeek: seekTimeline } : {})}
                />
                {/* Active-song accent strip (the prototype's ruler range bar) */}
                {markersUsable && activeSong && (
                  <div
                    className="pointer-events-none absolute top-0 z-[1] h-1 rounded-b-[2px] bg-accent opacity-70"
                    style={{
                      left: (selectedBaseSec + activeSong.startSec) * pxPerSec,
                      width: Math.max(
                        0,
                        ((activeSong.endSec ?? playerSnap.durationSec) - activeSong.startSec) *
                          pxPerSec,
                      ),
                    }}
                  />
                )}
                {markersUsable &&
                  takeMarkers.markers.map((marker) => (
                    <MarkerFlag
                      key={marker.id}
                      marker={marker}
                      x={(selectedBaseSec + marker.atSec) * pxPerSec}
                      onSeek={() => getPlayer().seek(marker.atSec)}
                    />
                  ))}
              </div>
            </div>

            {/* track rows */}
            {rows.length === 0 && (
              <div className="flex" style={{ height: TRACK_ROW_H }}>
                <div
                  className="sticky left-0 z-[5] flex flex-none items-center border-r border-b border-[#0e0f10] bg-card px-3"
                  style={{ width: TRACK_HEADER_W }}
                >
                  <span className="text-[11px] text-text-faint">Waiting for phones…</span>
                </div>
                <div
                  className="flex-1 border-b border-[#0e0f10] bg-lane"
                  style={laneGridStyle(pxPerSec)}
                >
                  <p className="p-3 text-[11px] text-text-faint">
                    Performers join via the QR invite; ● starts everyone at once.
                  </p>
                </div>
              </div>
            )}
            {rows.map((row, rowIndex) => (
              <TimelineRow
                key={row.key}
                row={row}
                clips={rowClips[rowIndex] ?? []}
                pxPerSec={pxPerSec}
                laneWidth={laneWidth}
                level={levelFor(row)}
                strip={playerSnap.channels.find((c) => c.key === row.key)}
                armed={recording ? row.armed : !state.disarmedPeers.includes(row.key)}
                onToggleArm={() => getDeskSession(sessionId).toggleArm(row.key)}
                {...(row.peerId
                  ? {
                      onRename: (label: string) =>
                        getDeskSession(sessionId).renamePeer(row.peerId as string, label),
                    }
                  : {})}
              />
            ))}

            {/* Marquee selection rectangle */}
            {marquee && (
              <div
                className="pointer-events-none absolute z-[5] border border-accent bg-accent/10"
                style={{
                  left: Math.min(marquee.x0, marquee.x1),
                  top: Math.min(marquee.y0, marquee.y1),
                  width: Math.abs(marquee.x1 - marquee.x0),
                  height: Math.abs(marquee.y1 - marquee.y0),
                }}
              />
            )}

            {/* Marker guides: a whisper of each song boundary down the
                lanes (the ruler flags carry the names). */}
            {markersUsable &&
              takeMarkers.markers.map((marker) => (
                <div
                  key={marker.id}
                  className="pointer-events-none absolute bottom-0 z-[3] w-px bg-accent/15"
                  style={{
                    left: TRACK_HEADER_W + (selectedBaseSec + marker.atSec) * pxPerSec,
                    top: RULER_H,
                  }}
                />
              ))}

            {/* Playhead: rides the live take's write head while recording,
                the player position during playback. */}
            {playheadSec !== null && (
              <div
                className="pointer-events-none absolute top-0 bottom-0 z-[4] w-px bg-accent"
                style={{ left: TRACK_HEADER_W + playheadSec * pxPerSec }}
              >
                <div
                  className="absolute top-0 -left-[5px] size-[11px] bg-accent"
                  style={{ clipPath: "polygon(0 0, 100% 0, 50% 100%)" }}
                />
              </div>
            )}
          </div>
        </section>

        {/* -------- right rail (272px) -------- */}
        <aside className="flex w-[272px] flex-none flex-col border-l border-divider bg-panel">
          <div className="flex gap-0.5 border-b border-divider px-2.5 pt-2">
            {(["performers", "songs", "sinks"] as const).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setTab(t)}
                className={`border-b-2 px-3 py-[7px] text-[11px] font-semibold capitalize ${
                  tab === t
                    ? "border-accent text-text-hi"
                    : "border-transparent text-text-dim hover:text-text"
                }`}
              >
                {t}
                {t === "songs" && songs.length > 0 && (
                  <span className="ml-1.5 rounded-lg bg-edge px-1.5 py-px font-mono text-[9px] text-text-dim">
                    {songs.length}
                  </span>
                )}
                {t === "sinks" && state.deskStatus.length > 0 && (
                  <span className="ml-1.5 rounded-lg bg-edge px-1.5 py-px font-mono text-[9px] text-text-dim">
                    {state.deskStatus.length}
                  </span>
                )}
              </button>
            ))}
          </div>

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
          ) : (
            <SinksPanel
              deskStatus={state.deskStatus}
              serverStatus={serverStatus}
              driftByStream={driftByStream}
            />
          )}
        </aside>
      </div>

      {/* ============ MIXER (264px: prototype's 218 + the EQ block) ============ */}
      <div className="flex min-w-0 border-t border-divider bg-raised">
        <div className="flex min-w-0 flex-1 overflow-x-auto">
          {rows.map((row) => (
            <RowMixerStrip
              key={row.key}
              row={row}
              playerSnap={playerSnap}
              recording={recording}
              liveLevel={levelFor(row)}
            />
          ))}
        </div>
        <MixerStrip
          name="MASTER"
          color="var(--color-accent)"
          active={rows.some((r) => r.receiving)}
          master
          level={recording ? liveMasterLevel : playerSnap.playing ? playerSnap.masterLevel : 0}
          gainDb={playerSnap.masterDb}
          onGainDb={(db: number) => getPlayer().setMasterDb(db)}
          pan={playerSnap.masterPan}
          onPan={(p: number) => getPlayer().setMasterPan(p)}
          eq={playerSnap.masterEq}
          onEq={(patch) => getPlayer().setMasterEq(patch)}
          onEqBypass={() => getPlayer().toggleMasterEqBypass()}
          {...(recording ? { dbText: formatDbfs(liveMasterLevel) } : {})}
        />
      </div>
    </main>
  );
}

/** Top-bar "Export ▾" dropdown (the prototype's decorative button, live):
 * offline renders of the loaded take — master WAV, stems ZIP, and (when
 * markers exist) each song's span as "NN <name>.wav" or all of them in one
 * ZIP — plus the raw per-stream FLAC downloads. Render items gate on
 * playback readiness; the button shows an indeterminate busy label while
 * an OfflineAudioContext render runs (one-shot: no progress to report). */
function ExportMenu({
  busy,
  canRender,
  canFlac,
  songs,
  takeDurationSec,
  onMaster,
  onStems,
  onSong,
  onAllSongs,
  onFlac,
}: {
  busy: "master" | "stems" | "songs" | null;
  canRender: boolean;
  canFlac: boolean;
  songs: Song[];
  takeDurationSec: number;
  onMaster: () => void;
  onStems: () => void;
  onSong: (song: Song) => void;
  onAllSongs: () => void;
  onFlac: () => void;
}) {
  const [open, setOpen] = useState(false);
  const pick = (action: () => void) => () => {
    setOpen(false);
    action();
  };
  return (
    <div className="relative">
      <button
        type="button"
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => setOpen((o) => !o)}
        disabled={busy !== null || (!canRender && !canFlac)}
        className={`rounded-md bg-accent px-3.5 py-1.5 text-[11px] font-semibold text-white hover:brightness-110 ${
          busy !== null
            ? "animate-pulse cursor-wait"
            : "disabled:cursor-not-allowed disabled:opacity-40"
        }`}
      >
        {busy === "master"
          ? "Rendering mix…"
          : busy === "stems"
            ? "Rendering stems…"
            : busy === "songs"
              ? "Rendering songs…"
              : "Export ▾"}
      </button>
      {open && (
        <>
          {/* Click-away backdrop */}
          <button
            type="button"
            aria-label="Close export menu"
            tabIndex={-1}
            onClick={() => setOpen(false)}
            className="fixed inset-0 z-[19] cursor-default"
          />
          <div
            role="menu"
            className="absolute top-[calc(100%+6px)] right-0 z-[20] w-[236px] rounded-lg border border-edge-card bg-card p-1 shadow-[0_10px_28px_rgba(0,0,0,.55)]"
          >
            <ExportItem
              title="Master mix"
              hint="WAV · 24-bit · 48 kHz"
              disabled={!canRender}
              onClick={pick(onMaster)}
            />
            <ExportItem
              title="Stems"
              hint="ZIP · aligned mono WAVs"
              disabled={!canRender}
              onClick={pick(onStems)}
            />
            {songs.length > 0 && (
              <>
                <div className="mx-1.5 my-1 h-px bg-divider" />
                <div className="px-2.5 pt-1 pb-0.5">
                  <SectionLabel>Songs</SectionLabel>
                </div>
                <div className="max-h-[204px] overflow-y-auto">
                  {songs.map((song) => (
                    <ExportItem
                      key={song.id}
                      title={`${String(song.index).padStart(2, "0")} ${song.name}`}
                      hint={`WAV · ${formatSpan((song.endSec ?? takeDurationSec) - song.startSec)}`}
                      disabled={!canRender}
                      onClick={pick(() => onSong(song))}
                    />
                  ))}
                </div>
                <ExportItem
                  title="All songs"
                  hint={`ZIP · ${songs.length} WAVs`}
                  disabled={!canRender}
                  onClick={pick(onAllSongs)}
                />
              </>
            )}
            <div className="mx-1.5 my-1 h-px bg-divider" />
            <ExportItem
              title="Source streams"
              hint="FLAC · raw per stream"
              disabled={!canFlac}
              onClick={pick(onFlac)}
            />
          </div>
        </>
      )}
    </div>
  );
}

function ExportItem({
  title,
  hint,
  disabled,
  onClick,
}: {
  title: string;
  hint: string;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={onClick}
      className="flex w-full items-baseline justify-between gap-3 rounded-md px-2.5 py-2 text-left hover:bg-card-hi disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
    >
      <span className="text-[11px] font-semibold text-text-strong">{title}</span>
      <span className="font-mono text-[9px] text-text-faint">{hint}</span>
    </button>
  );
}

// ---- song markers (W2-B) ------------------------------------------------------

/** m:ss span readout (song lengths). */
function formatSpan(sec: number): string {
  const total = Math.max(0, Math.round(sec));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/** mm:ss.d position readout (marker timecodes). */
function formatAt(sec: number): string {
  const minutes = Math.floor(sec / 60);
  const seconds = sec - minutes * 60;
  return `${String(minutes).padStart(2, "0")}:${seconds.toFixed(1).padStart(4, "0")}`;
}

/** Ruler flag for one marker: a hairline with the song name tagged at the
 * ruler's foot. Accent at low alpha so the solid-accent playhead stays the
 * loudest line; click seeks to the song start. */
function MarkerFlag({ marker, x, onSeek }: { marker: Marker; x: number; onSeek: () => void }) {
  return (
    <button
      type="button"
      data-marker={marker.id}
      aria-label={`Marker ${marker.name}`}
      title={`${marker.name} — click to seek`}
      onClick={(e) => {
        e.stopPropagation();
        onSeek();
      }}
      onDoubleClick={(e) => e.stopPropagation()}
      className="group/marker absolute inset-y-0 z-[2] flex items-end pb-[3px]"
      style={{ left: x }}
    >
      <span className="absolute inset-y-0 left-0 w-px bg-accent/50 group-hover/marker:bg-accent" />
      <span className="ml-[3px] max-w-[96px] truncate rounded-[3px] border border-edge-btn bg-raised/95 px-[5px] py-px font-mono text-[8px] font-semibold tracking-[0.4px] text-text-mute group-hover/marker:border-accent/60 group-hover/marker:text-accent">
        {marker.name}
      </span>
    </button>
  );
}

/** Right-rail song list: one row per marker-started song — name (inline
 * rename), start timecode, span. Click seeks; hover reveals rename /
 * render-WAV / delete. */
function SongsPanel({
  songs,
  takeDurationSec,
  currentSongId,
  usable,
  canRender,
  onAdd,
  onSeek,
  onRename,
  onRemove,
  onRender,
}: {
  songs: Song[];
  takeDurationSec: number;
  currentSongId: string | null;
  /** A take is loaded and idle — markers can be added and seeked. */
  usable: boolean;
  canRender: boolean;
  onAdd: () => void;
  onSeek: (song: Song) => void;
  onRename: (id: string, name: string) => void;
  onRemove: (id: string) => void;
  onRender: (song: Song) => void;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto p-2.5">
      {songs.length === 0 && (
        <p className="px-1 py-1 text-[11px] leading-relaxed text-text-dim">
          No songs bookmarked yet. Each marker starts a song that runs to the next marker (or the
          take end). Press <span className="font-mono text-text-mute">M</span> to drop one at the
          playhead, or double-click the ruler.
        </p>
      )}
      {songs.map((song) => (
        <SongRow
          key={song.id}
          song={song}
          durationSec={(song.endSec ?? takeDurationSec) - song.startSec}
          active={song.id === currentSongId}
          usable={usable}
          canRender={canRender}
          onSeek={() => onSeek(song)}
          onRename={(name) => onRename(song.id, name)}
          onRemove={() => onRemove(song.id)}
          onRender={() => onRender(song)}
        />
      ))}
      <button
        type="button"
        disabled={!usable}
        onClick={onAdd}
        className="mt-0.5 flex items-center justify-center gap-2 rounded-lg border border-dashed border-edge-strong p-2 text-[11px] font-semibold text-text-dim hover:text-text disabled:cursor-not-allowed disabled:opacity-50"
      >
        ◆ Add marker at playhead
        <span className="rounded border border-edge-strong px-1.5 py-px font-mono text-[9px]">
          M
        </span>
      </button>
    </div>
  );
}

function SongRow({
  song,
  durationSec,
  active,
  usable,
  canRender,
  onSeek,
  onRename,
  onRemove,
  onRender,
}: {
  song: Song;
  durationSec: number;
  active: boolean;
  usable: boolean;
  canRender: boolean;
  onSeek: () => void;
  onRename: (name: string) => void;
  onRemove: () => void;
  onRender: () => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const cancelled = useRef(false);
  const commit = (value: string) => {
    setDraft(null);
    if (value.trim() && value.trim() !== song.name) onRename(value);
  };
  return (
    <div
      className={`group/song flex flex-col gap-[3px] rounded-md border px-2 py-[7px] ${
        active ? "border-accent/60 bg-card-hi" : "border-edge-card bg-card hover:bg-card-hi"
      }`}
    >
      <div className="flex items-center gap-1.5">
        <span className="flex-none font-mono text-[9px] font-semibold text-text-faint">
          {String(song.index).padStart(2, "0")}
        </span>
        {draft !== null ? (
          <input
            // biome-ignore lint/a11y/noAutofocus: user explicitly opened the editor
            autoFocus
            value={draft}
            maxLength={64}
            aria-label="Rename song"
            onChange={(e) => setDraft(e.target.value)}
            onFocus={(e) => e.target.select()}
            onBlur={(e) => {
              if (cancelled.current) {
                cancelled.current = false;
                setDraft(null);
              } else {
                commit(e.target.value);
              }
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
              if (e.key === "Escape") {
                cancelled.current = true;
                e.currentTarget.blur();
              }
            }}
            className="w-full min-w-0 rounded-[3px] border border-accent bg-bg px-1 py-px text-[11.5px] font-semibold text-text-hi outline-none"
          />
        ) : (
          <>
            <button
              type="button"
              disabled={!usable}
              onClick={onSeek}
              onDoubleClick={() => setDraft(song.name)}
              title="Click to seek · double-click to rename"
              className="min-w-0 flex-1 truncate text-left text-[11.5px] font-semibold text-text-strong hover:text-text-hi disabled:cursor-default"
            >
              {song.name}
            </button>
            <button
              type="button"
              aria-label={`Rename ${song.name}`}
              onClick={() => setDraft(song.name)}
              className="hidden flex-none font-mono text-[10px] leading-none text-text-faint hover:text-accent group-hover/song:inline"
            >
              ✎
            </button>
            <button
              type="button"
              aria-label={`Export ${song.name}`}
              title={`Render ${songFileName(song.index, song.name)}`}
              disabled={!canRender}
              onClick={onRender}
              className="hidden flex-none font-mono text-[10px] leading-none text-text-faint hover:text-accent disabled:cursor-not-allowed disabled:opacity-40 group-hover/song:inline"
            >
              ↓
            </button>
            <button
              type="button"
              aria-label={`Delete marker ${song.name}`}
              onClick={onRemove}
              className="hidden flex-none font-mono text-[10px] leading-none text-text-faint hover:text-rec group-hover/song:inline"
            >
              ×
            </button>
          </>
        )}
      </div>
      <button
        type="button"
        disabled={!usable}
        onClick={onSeek}
        title="Seek to song start"
        className="flex items-baseline gap-1.5 pl-[22px] text-left font-mono text-[9.5px] text-text-dim hover:text-text disabled:cursor-default"
      >
        <span className={active ? "text-accent" : ""}>▶ {formatAt(song.startSec)}</span>
        <span className="text-text-faint">·</span>
        <span>{formatSpan(durationSec)}</span>
      </button>
    </div>
  );
}

/** Mixer strip bound to a track row (performer lane). Gain/mute/solo edit
 * the lane's persistent channel strip — independent of which take is
 * selected, loaded, or whether anything is loaded at all. Meters show the
 * phone's LIVE capture level while recording (METER telemetry) and the
 * playback analyser otherwise. */
function RowMixerStrip({
  row,
  playerSnap,
  recording,
  liveLevel,
}: {
  row: TrackRow;
  playerSnap: PlayerSnapshot;
  recording: boolean;
  liveLevel: number;
}) {
  const strip = playerSnap.channels.find((c) => c.key === row.key);
  return (
    <MixerStrip
      name={row.name}
      color={row.color}
      active={row.receiving}
      level={liveLevel}
      gainDb={strip?.gainDb ?? 0}
      onGainDb={(db) => getPlayer().setChannelDb(row.key, db)}
      pan={strip?.pan ?? 0}
      onPan={(p) => getPlayer().setChannelPan(row.key, p)}
      eq={strip?.eq ?? defaultEq()}
      onEq={(patch) => getPlayer().setChannelEq(row.key, patch)}
      onEqBypass={() => getPlayer().toggleChannelEqBypass(row.key)}
      muted={strip?.muted ?? false}
      onMute={() => getPlayer().toggleChannelMute(row.key)}
      soloed={strip?.soloed ?? false}
      onSolo={() => getPlayer().toggleChannelSolo(row.key)}
      {...(recording ? { dbText: formatDbfs(liveLevel) } : {})}
    />
  );
}

/** Instantaneous dBFS readout for a 0..1 peak. */
function formatDbfs(peak: number): string {
  if (peak <= 0.001) return "−∞ dB";
  return `${(20 * Math.log10(peak)).toFixed(1)} dB`;
}

// ---- timeline row -----------------------------------------------------------

function TimelineRow({
  row,
  clips,
  pxPerSec,
  laneWidth,
  level,
  strip,
  armed,
  onToggleArm,
  onRename,
}: {
  row: TrackRow;
  clips: ClipModel[];
  pxPerSec: number;
  laneWidth: number;
  level: number;
  strip: ChannelStrip | undefined;
  armed: boolean;
  onToggleArm: () => void;
  onRename?: (label: string) => void;
}) {
  return (
    <div className="flex border-b border-[#0e0f10]" style={{ height: TRACK_ROW_H }}>
      {/* header (232px, sticky) */}
      <div
        className="sticky left-0 z-[5] flex flex-none items-stretch border-r border-divider bg-card"
        style={{ width: TRACK_HEADER_W }}
      >
        <div className="w-1 flex-none" style={{ background: row.color }} />
        <div className="flex min-w-0 flex-1 flex-col justify-between px-2 py-[7px]">
          <div className="group/lane flex min-w-0 items-center gap-1.5">
            <LaneName name={row.name} {...(onRename ? { onRename } : {})} />
            <Badge className="flex-none">audio</Badge>
          </div>
          <div className="flex items-center gap-[5px]">
            <TrackMiniButton
              label="M"
              ariaLabel={`Mute ${row.name} (header)`}
              active={strip?.muted ?? false}
              tone="gold"
              onClick={() => getPlayer().toggleChannelMute(row.key)}
            />
            <TrackMiniButton
              label="S"
              ariaLabel={`Solo ${row.name} (header)`}
              active={strip?.soloed ?? false}
              tone="teal"
              onClick={() => getPlayer().toggleChannelSolo(row.key)}
            />
            <TrackMiniButton
              label="●"
              ariaLabel={`Arm ${row.name}`}
              armed={armed}
              onClick={onToggleArm}
            />
            {row.peerLabel && (
              <span className="ml-[3px] flex min-w-0 items-center gap-1 rounded-[10px] border border-edge bg-[#17181a] py-px pr-[7px] pl-[2px]">
                <span
                  className="relative grid size-[14px] flex-none place-items-center rounded-full text-[7px] font-bold text-void"
                  style={{ background: row.color }}
                >
                  {row.peerInitials}
                  <span
                    className="absolute -right-px -bottom-px size-[5px] rounded-full border border-[#17181a]"
                    style={{
                      background: row.receiving ? "var(--color-rec)" : "var(--color-ok)",
                    }}
                  />
                </span>
                <span className="truncate text-[9px] text-text-dim">{row.peerLabel}</span>
              </span>
            )}
          </div>
        </div>
        <div className="flex w-[14px] flex-none items-end bg-[#191a1b] px-1 py-1.5">
          <VUVertical active={row.receiving} level={level} className="h-[52px]" />
        </div>
      </div>

      {/* lane */}
      <div className="relative bg-lane" style={{ width: laneWidth, ...laneGridStyle(pxPerSec) }}>
        {clips.map((clip) => (
          <ClipCard key={clip.id} clip={clip} />
        ))}
      </div>
    </div>
  );
}

/** Lane title with inline rename: double-click the name, or the pencil
 * that appears on header hover. Renames go through peer-update (A13) —
 * the server persists and fans out; the title updates on the echo. Only
 * lanes that map to a known peer get the affordance. */
function LaneName({ name, onRename }: { name: string; onRename?: (label: string) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const cancelled = useRef(false);

  if (draft !== null && onRename) {
    const commit = (value: string) => {
      setDraft(null);
      const next = value.trim();
      if (next !== name) onRename(next);
    };
    return (
      <input
        // biome-ignore lint/a11y/noAutofocus: user explicitly opened the editor
        autoFocus
        value={draft}
        maxLength={48}
        aria-label="Rename lane"
        onChange={(e) => setDraft(e.target.value)}
        onFocus={(e) => e.target.select()}
        onBlur={(e) => {
          if (cancelled.current) {
            cancelled.current = false;
            setDraft(null);
          } else {
            commit(e.target.value);
          }
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          if (e.key === "Escape") {
            cancelled.current = true;
            e.currentTarget.blur();
          }
        }}
        className="w-full min-w-0 rounded-[3px] border border-accent bg-bg px-1 py-px text-[11.5px] font-semibold text-text-hi outline-none"
      />
    );
  }
  if (!onRename) {
    return <span className="truncate text-[11.5px] font-semibold text-text-strong">{name}</span>;
  }
  return (
    <>
      <button
        type="button"
        onDoubleClick={() => setDraft(name)}
        title="Double-click to rename"
        className="min-w-0 cursor-text truncate text-left text-[11.5px] font-semibold text-text-strong"
      >
        {name}
      </button>
      <button
        type="button"
        aria-label={`Rename ${name}`}
        onClick={() => setDraft(name)}
        className="hidden flex-none font-mono text-[10px] leading-none text-text-faint group-hover/lane:inline hover:text-accent"
      >
        ✎
      </button>
    </>
  );
}

// ---- right rail panels --------------------------------------------------------

function PerformersPanel({
  sessionId,
  recorders,
  rows,
  joinUrl,
  activeTakeId,
  streams,
  levelForRow,
  deskInput,
}: {
  sessionId: string;
  recorders: PeerInfo[];
  rows: TrackRow[];
  joinUrl: string;
  activeTakeId: string | null;
  streams: Array<{ streamId: string; takeId: string; peerId: string | null }>;
  levelForRow: (row: TrackRow) => number;
  deskInput: DeskInputState;
}) {
  const [showQr, setShowQr] = useState<boolean | null>(null);
  // Auto-open while the room is empty, tuck away once performers arrive;
  // manual toggling wins after the first click.
  const qrVisible = showQr ?? recorders.length === 0;
  const session = getDeskSession(sessionId);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-2.5">
      {recorders.length === 0 && (
        <p className="px-1 py-1 text-[11px] text-text-dim">Waiting for phones…</p>
      )}
      {recorders.map((peer, i) => {
        const row = rows.find((r) => r.key === peer.peerId);
        const isRecording = streams.some(
          (s) => s.peerId === peer.peerId && s.takeId === activeTakeId && activeTakeId,
        );
        const color = row?.color ?? (TRACK_COLORS[i % TRACK_COLORS.length] as string);
        return (
          <div
            key={peer.peerId}
            className="flex flex-col gap-[7px] rounded-lg border border-edge-card bg-card-hi px-2.5 py-[9px]"
          >
            <div className="flex items-center gap-2">
              <Avatar
                initials={
                  initialsOf(peer.deviceInfo.label) ?? peer.peerId.slice(0, 2).toUpperCase()
                }
                color={color}
                dot={isRecording ? "var(--color-rec)" : "var(--color-ok)"}
              />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[11.5px] font-semibold text-text-strong">
                  {peer.deviceInfo.label?.trim() || deviceName(peer.deviceInfo.userAgent)}
                </div>
                <div className="truncate font-mono text-[9.5px] text-text-dim">
                  {deviceName(peer.deviceInfo.userAgent)} · {peer.peerId.slice(0, 8)}
                </div>
              </div>
              <StatusPill tone={isRecording ? "rec" : "ok"}>
                {isRecording ? "recording" : "ready"}
              </StatusPill>
            </div>
            <div className="flex items-center gap-2">
              <span className="w-14 flex-none truncate text-[9px] text-text-faint">
                → {row?.name ?? "unassigned"}
              </span>
              <VUMeter level={row ? levelForRow(row) : 0} className="flex-1" />
            </div>
          </div>
        );
      })}

      <DeskInputBlock
        sessionId={sessionId}
        input={deskInput}
        takeRolling={activeTakeId !== null}
        color={rows.find((r) => r.peerId === deskInput.peerId)?.color ?? null}
      />

      <button
        type="button"
        onClick={() => setShowQr(!qrVisible)}
        className="mt-0.5 flex items-center justify-center gap-2 rounded-lg border border-dashed border-edge-strong p-2.5 text-[11px] font-semibold text-text-dim hover:text-text"
      >
        + Invite performer
        <span className="rounded border border-edge-strong px-1.5 py-px font-mono text-[9px]">
          QR
        </span>
      </button>
      {qrVisible && (
        <div className="rounded-lg border border-edge-card bg-card p-3">
          <StyledQr value={joinUrl} className="w-full" />
          <p className="mt-2 break-all font-mono text-[9px] leading-relaxed text-text-dim">
            {joinUrl}
          </p>
        </div>
      )}
      <p className="mt-auto px-1 pt-1 font-mono text-[9px] text-text-faint">
        sync {session.snapshot().serverSync}
      </p>
    </div>
  );
}

/** The desk's own hardware input (W2-D): pick an interface/mic and run it
 * as an embedded recorder lane — the ARCHITECTURE §2.2 room reference mic.
 * Device labels are blank until permission grants, so the picker opens
 * through a one-off probe; the live card shows the real capture level and
 * the same EC/NS/AGC honesty as the phone page. Enable/disable sit out
 * rolling takes: a lane must never appear or vanish mid-take. */
function DeskInputBlock({
  sessionId,
  input,
  takeRolling,
  color,
}: {
  sessionId: string;
  input: DeskInputState;
  takeRolling: boolean;
  color: string | null;
}) {
  const [pickedId, setPickedId] = useState<string | null>(null);
  const mgr = getDeskInput(sessionId);

  if (input.phase === "off") {
    return (
      <div className="flex flex-col gap-1">
        <button
          type="button"
          disabled={takeRolling}
          onClick={() => void (input.resumeLabel ? mgr.resume() : mgr.openPicker())}
          className="flex items-center justify-center gap-2 rounded-lg border border-dashed border-edge-strong p-2.5 text-[11px] font-semibold text-text-dim hover:text-text disabled:cursor-not-allowed disabled:opacity-50"
        >
          {input.resumeLabel ? "⏻ Resume desk input" : "+ Add desk input"}
          <span className="rounded border border-edge-strong px-1.5 py-px font-mono text-[9px]">
            MIC
          </span>
        </button>
        {input.resumeLabel && (
          <div className="flex items-baseline justify-between gap-2 px-1">
            <span className="truncate font-mono text-[9px] text-text-faint">
              {input.resumeLabel}
            </span>
            <button
              type="button"
              onClick={() => void mgr.openPicker()}
              className="flex-none font-mono text-[9px] text-text-dim hover:text-accent"
            >
              change
            </button>
          </div>
        )}
        {input.error && <p className="px-1 font-mono text-[9px] text-rec">{input.error}</p>}
      </div>
    );
  }

  if (input.phase === "picking" || input.phase === "starting") {
    const picked = input.devices.find((d) => d.id === pickedId) ?? input.devices[0];
    return (
      <div className="flex flex-col gap-2 rounded-lg border border-edge-card bg-card p-2.5">
        <SectionLabel>Desk input</SectionLabel>
        <select
          aria-label="Desk input device"
          value={picked?.id ?? ""}
          onChange={(e) => setPickedId(e.target.value)}
          disabled={input.phase === "starting"}
          className="w-full rounded-md border border-edge-inset bg-bg px-2 py-1.5 text-[11px] text-text outline-none focus:border-accent"
        >
          {input.devices.length === 0 && <option value="">no inputs found</option>}
          {input.devices.map((d) => (
            <option key={d.id} value={d.id}>
              {d.label}
            </option>
          ))}
        </select>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            disabled={!picked || takeRolling || input.phase === "starting"}
            onClick={() => {
              if (picked) void mgr.enable(picked);
            }}
            className="rounded-md bg-accent px-3 py-1.5 text-[11px] font-semibold text-white hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {input.phase === "starting" ? "Starting…" : "Use input"}
          </button>
          <button
            type="button"
            onClick={() => mgr.closePicker()}
            disabled={input.phase === "starting"}
            className="rounded-md border border-edge-strong px-3 py-1.5 text-[11px] font-semibold text-text hover:bg-card-hi disabled:opacity-40"
          >
            Cancel
          </button>
        </div>
        {takeRolling && (
          <p className="font-mono text-[9px] text-text-faint">available between takes</p>
        )}
        {input.error && <p className="font-mono text-[9px] text-rec">{input.error}</p>}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-[7px] rounded-lg border border-edge-card bg-card-hi px-2.5 py-[9px]">
      <div className="flex items-center gap-2">
        <Avatar
          initials={initialsOf(input.laneLabel ?? undefined) ?? "RM"}
          color={color ?? "var(--color-accent)"}
          dot={input.recording ? "var(--color-rec)" : "var(--color-ok)"}
        />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[11.5px] font-semibold text-text-strong">
            {input.laneLabel ?? "Desk input"}
          </div>
          <div className="truncate font-mono text-[9.5px] text-text-dim">
            {input.input?.label}
            {input.sampleRate ? ` · ${(input.sampleRate / 1000).toFixed(1)} kHz` : ""}
          </div>
        </div>
        <StatusPill tone={input.recording ? "rec" : "ok"}>
          {input.recording ? "recording" : "ready"}
        </StatusPill>
      </div>
      <VUMeter level={input.peak} />
      <div className="flex items-center justify-between gap-2">
        <div className="flex gap-1">
          <CaptureFlagChip label="EC" value={input.flags?.echoCancellation} />
          <CaptureFlagChip label="NS" value={input.flags?.noiseSuppression} />
          <CaptureFlagChip label="AGC" value={input.flags?.autoGainControl} />
        </div>
        <button
          type="button"
          disabled={takeRolling}
          onClick={() => void mgr.disable()}
          title={takeRolling ? "Available between takes" : "Release this input"}
          className="flex-none font-mono text-[9px] font-semibold tracking-[0.5px] text-text-dim uppercase hover:text-rec disabled:cursor-not-allowed disabled:opacity-40"
        >
          disable
        </button>
      </div>
      {input.unplugged && (
        <p className="font-mono text-[9px] leading-relaxed text-warn">
          input unplugged — the lane records silence; swap or disable between takes
        </p>
      )}
      {input.error && <p className="font-mono text-[9px] text-rec">{input.error}</p>}
    </div>
  );
}

/** EC/NS/AGC honesty chip (desk-compact twin of the phone page badges):
 * all three must be OFF for a truthful recording. */
function CaptureFlagChip({ label, value }: { label: string; value: boolean | string | undefined }) {
  const off = value === false || value === "none";
  return (
    <span
      className={`rounded-[3px] border border-edge bg-bg px-1.5 py-px font-mono text-[8px] font-bold tracking-[0.5px] ${
        off ? "text-ok" : value === undefined ? "text-warn" : "text-rec"
      }`}
    >
      {label} {off ? "OFF" : value === undefined ? "—" : "ON"}
    </span>
  );
}

/** Drift readout: clock-rate error vs the reference stream in ppm, with
 * the fit confidence — "off" marks a measurement the guard rails bypassed
 * (played uncorrected rather than wrongly corrected). */
function driftReadout(drift: DriftResult) {
  if (drift.isReference) return "reference";
  const ppm = `${drift.ppm >= 0 ? "+" : ""}${drift.ppm.toFixed(1)} ppm`;
  const conf = `c ${drift.confidence.toFixed(2)}`;
  return (
    <span className={drift.applied ? undefined : "text-warn"}>
      {drift.applied ? `${ppm} · ${conf}` : `${ppm} · ${conf} · off`}
    </span>
  );
}

function SinksPanel({
  deskStatus,
  serverStatus,
  driftByStream,
}: {
  deskStatus: DeskStreamStatus[];
  serverStatus: Map<string, ServerStreamStatus>;
  driftByStream: Map<string, DriftResult>;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-2.5">
      {deskStatus.length === 0 && (
        <p className="px-1 py-1 text-[11px] text-text-dim">No streams yet.</p>
      )}
      {deskStatus.map((desk) => {
        const server = serverStatus.get(desk.streamId);
        const drift = driftByStream.get(desk.streamId);
        const converged =
          desk.complete && (server?.complete ?? false) && desk.digest === server?.digest;
        return (
          <div
            key={desk.streamId}
            className="flex flex-col gap-1.5 rounded-lg border border-edge-card bg-card-hi px-2.5 py-[9px]"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="truncate font-mono text-[9.5px] text-text-dim">
                {desk.streamId.slice(0, 16)}…
              </span>
              {desk.flagged || server?.flagged ? (
                <StatusPill tone="rec">flagged</StatusPill>
              ) : converged ? (
                <StatusPill tone="ok">⇥ converged</StatusPill>
              ) : (
                <StatusPill tone="warn">reconciling</StatusPill>
              )}
            </div>
            <MonoReadout
              label="desk chwm / held"
              value={`${desk.chwm ?? "—"} / ${desk.heldCount}`}
            />
            <MonoReadout
              label="server chwm / held"
              value={`${server?.chwm ?? "—"} / ${server?.chunkCount ?? 0}`}
            />
            <MonoReadout
              label="holes d·s"
              value={
                <span className={desk.holes.length || server?.holes.length ? "text-warn" : ""}>
                  {desk.holes.length} · {server?.holes.length ?? 0}
                </span>
              }
            />
            {desk.finalSeq !== null && <MonoReadout label="final seq" value={desk.finalSeq} />}
            {drift && <MonoReadout label="drift" value={driftReadout(drift)} />}
            {converged && (
              <a
                href={`/api/streams/${desk.streamId}/flac`}
                download
                className="self-start font-mono text-[10px] text-accent hover:underline"
              >
                ↓ download .flac
              </a>
            )}
          </div>
        );
      })}
    </div>
  );
}
