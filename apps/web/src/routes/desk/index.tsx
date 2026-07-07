// Mixing desk — /session/:uuid. Layout, geometry, and visual language follow
// the prototype (docs/Antiphone DAW.dc.html) row for row: 48px top bar with
// a centered transport cluster, 40px toolbar, arrange timeline with 232px
// sticky track headers, a 272px right rail, and the mixer footer.
// Record/stop/chirp, playback with a moving playhead + click-to-seek,
// chirp auto-alignment, and the gain/mute/solo mixer are all live; only
// editing tools and pan (mono v1) remain visibly inert.

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
import type { ChannelStrip, PlayerSnapshot } from "./player";
import {
  ensureWaveform,
  getCachedWaveform,
  getDeskSession,
  getPlayer,
  loadTakeIntoPlayer,
  publishUiMirror,
  type ServerStreamStatus,
  useDeskState,
  usePlayer,
  useServerStatus,
  waveformCacheSize,
} from "./use-desk";

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
  const [tab, setTab] = useState<"performers" | "sinks">("performers");
  const [shared, setShared] = useState(false);
  const pxPerSec = 24 * zoom;

  const recording = state.activeTakeId !== null;
  useTick(recording, 100);
  const recorders = (state.session?.peers ?? []).filter((p) => p.role === "recorder");
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
        row = {
          key,
          index,
          name: peer
            ? `${deviceName(peer.deviceInfo.userAgent)} ${index + 1}`
            : `Stream ${index + 1}`,
          color: TRACK_COLORS[index % TRACK_COLORS.length] as string,
          peerInitials: (peerId ?? stream.streamId).slice(0, 2).toUpperCase(),
          peerLabel: peer ? deviceName(peer.deviceInfo.userAgent) : null,
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
  }, [state.deskStatus, peerByStream, recorders, receiving, state.activeTakeId]);

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
  }, [recording, playerLoaded, sessionId, selection, state.deskStatus, state.activeTakeId]);

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

  function exportAll() {
    for (const desk of state.deskStatus) {
      const server = serverStatus.get(desk.streamId);
      if (desk.complete && server?.complete && desk.digest === server.digest) {
        const a = document.createElement("a");
        a.href = `/api/streams/${desk.streamId}/flac`;
        a.download = `${desk.streamId}.flac`;
        a.click();
      }
    }
  }

  return (
    <main className="grid h-dvh grid-cols-[minmax(0,1fr)] grid-rows-[48px_40px_1fr_218px] overflow-hidden bg-bg text-[12px]">
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
              {recorders.length} phone{recorders.length === 1 ? "" : "s"} connected · archive{" "}
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
              ...recorders.slice(0, 3).map((p, i) => ({
                initials: p.peerId.slice(0, 2).toUpperCase(),
                color: TRACK_COLORS[i % TRACK_COLORS.length] as string,
                title: deviceName(p.deviceInfo.userAgent),
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
          <button
            type="button"
            onClick={exportAll}
            disabled={convergedCount === 0}
            className="rounded-md bg-accent px-3.5 py-1.5 text-[11px] font-semibold text-white hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Export ▾
          </button>
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
          {state.lastChirpAt && (
            <span className="font-mono text-[9px] text-text-faint">
              chirp emitted {new Date(state.lastChirpAt).toLocaleTimeString()}
            </span>
          )}
          {playerSnap.error && (
            <span className="font-mono text-[9px] text-warn">{playerSnap.error}</span>
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
              <LaneRuler
                pxPerSec={pxPerSec}
                widthPx={laneWidth}
                {...(playerLoaded && !recording ? { onSeek: seekTimeline } : {})}
              />
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
            {(["performers", "sinks"] as const).map((t) => (
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
              recorders={recorders}
              rows={rows}
              joinUrl={joinUrl}
              activeTakeId={state.activeTakeId}
              streams={state.streams}
              levelForRow={levelFor}
            />
          ) : (
            <SinksPanel deskStatus={state.deskStatus} serverStatus={serverStatus} />
          )}
        </aside>
      </div>

      {/* ================= MIXER (218px) ================= */}
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
          {...(recording ? { dbText: formatDbfs(liveMasterLevel) } : {})}
        />
      </div>
    </main>
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
}: {
  row: TrackRow;
  clips: ClipModel[];
  pxPerSec: number;
  laneWidth: number;
  level: number;
  strip: ChannelStrip | undefined;
  armed: boolean;
  onToggleArm: () => void;
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
          <div className="flex min-w-0 items-center gap-1.5">
            <span className="truncate text-[11.5px] font-semibold text-text-strong">
              {row.name}
            </span>
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

// ---- right rail panels --------------------------------------------------------

function PerformersPanel({
  sessionId,
  recorders,
  rows,
  joinUrl,
  activeTakeId,
  streams,
  levelForRow,
}: {
  sessionId: string;
  recorders: Array<{ peerId: string; deviceInfo: { userAgent: string } }>;
  rows: TrackRow[];
  joinUrl: string;
  activeTakeId: string | null;
  streams: Array<{ streamId: string; takeId: string; peerId: string | null }>;
  levelForRow: (row: TrackRow) => number;
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
                initials={peer.peerId.slice(0, 2).toUpperCase()}
                color={color}
                dot={isRecording ? "var(--color-rec)" : "var(--color-ok)"}
              />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[11.5px] font-semibold text-text-strong">
                  {deviceName(peer.deviceInfo.userAgent)}
                </div>
                <div className="truncate font-mono text-[9.5px] text-text-dim">
                  {peer.peerId.slice(0, 13)}
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

function SinksPanel({
  deskStatus,
  serverStatus,
}: {
  deskStatus: DeskStreamStatus[];
  serverStatus: Map<string, ServerStreamStatus>;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-2.5">
      {deskStatus.length === 0 && (
        <p className="px-1 py-1 text-[11px] text-text-dim">No streams yet.</p>
      )}
      {deskStatus.map((desk) => {
        const server = serverStatus.get(desk.streamId);
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
