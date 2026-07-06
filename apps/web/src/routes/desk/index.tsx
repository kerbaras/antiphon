// Mixing desk — /session/:uuid. Layout, geometry, and visual language follow
// the prototype (docs/Antiphone DAW.dc.html) row for row: 48px top bar with
// a centered transport cluster, 40px toolbar, arrange timeline with 232px
// sticky track headers, a 272px right rail, and the mixer footer.
// Record/stop/chirp, playback with a moving playhead + click-to-seek,
// chirp auto-alignment, and the gain/mute/solo mixer are all live; only
// editing tools and pan (mono v1) remain visibly inert.

import QRCode from "qrcode";
import { useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router";
import type { DeskStreamStatus } from "../../audio/sink-worker-protocol";
import {
  Avatar,
  Badge,
  MonoReadout,
  SectionLabel,
  StatusPill,
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
import type { PlayerSnapshot } from "./player";
import {
  getDeskSession,
  getPlayer,
  loadTakeIntoPlayer,
  type ServerStreamStatus,
  useDeskState,
  usePlayer,
  useServerStatus,
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

  // Takes in encounter order with sequential timeline offsets.
  const takes = useMemo(() => {
    const seen: string[] = [];
    for (const s of state.deskStatus) {
      if (!seen.includes(s.takeId)) seen.push(s.takeId);
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
  }, [state.deskStatus, state.activeTakeId, state.takeStartedAt]);

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
  const selectedStreamIds = useMemo(
    () =>
      state.deskStatus
        .filter((s) => s.takeId === selectedTakeId && s.complete)
        .map((s) => s.streamId),
    [state.deskStatus, selectedTakeId],
  );

  // Load (and, when a chirp was emitted this session, auto-align) the
  // selected take as soon as it is complete at the desk.
  const chirped = state.lastChirpAt !== null;
  useEffect(() => {
    if (!selectedTakeId || selectedStreamIds.length === 0 || recording) return;
    void loadTakeIntoPlayer(sessionId, selectedTakeId, selectedStreamIds).then((ok) => {
      if (ok && chirped) void getPlayer().align();
    });
  }, [sessionId, selectedTakeId, selectedStreamIds, recording, chirped]);

  const selectedSlot = selectedTakeId ? (takes.get(selectedTakeId) ?? null) : null;
  const playerLoaded = playerSnap.loadedTakeId === selectedTakeId && playerSnap.tracks.length > 0;
  const alignmentByStream = useMemo(() => {
    const map = new Map<string, boolean>();
    for (const t of playerSnap.tracks) map.set(t.streamId, t.alignment?.applied ?? false);
    return map;
  }, [playerSnap.tracks]);

  function seekTimeline(sec: number) {
    if (!selectedSlot || !playerLoaded) return;
    getPlayer().seek(Math.max(0, sec - selectedSlot.offsetSec));
  }

  // Playhead position on the shared timeline.
  const playheadSec = recording
    ? state.activeTakeId && takes.has(state.activeTakeId)
      ? (takes.get(state.activeTakeId) as TakeSlot).offsetSec + elapsed
      : null
    : selectedSlot && playerLoaded
      ? selectedSlot.offsetSec + playerSnap.positionSec
      : null;

  const joinUrl = `${location.origin}/join/${sessionId}`;

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
            onClick={() => void getPlayer().align()}
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
          <div className="relative min-w-full" style={{ width: laneWidth + TRACK_HEADER_W }}>
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
            {rows.map((row) => (
              <TimelineRow
                key={row.key}
                row={row}
                takes={takes}
                pxPerSec={pxPerSec}
                laneWidth={laneWidth}
                serverStatus={serverStatus}
                selectedTakeId={selectedTakeId}
                alignmentByStream={alignmentByStream}
                onSelectTake={setPickedTakeId}
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
              selectedTakeId={selectedTakeId}
              playerSnap={playerSnap}
              playerLoaded={playerLoaded}
            />
          ))}
        </div>
        <MixerStrip
          name="MASTER"
          color="var(--color-accent)"
          active={rows.some((r) => r.receiving)}
          master
          {...(playerLoaded
            ? {
                level: playerSnap.playing ? playerSnap.masterLevel : 0,
                gainDb: playerSnap.masterDb,
                onGainDb: (db: number) => getPlayer().setMasterDb(db),
              }
            : { dbText: "—" })}
        />
      </div>
    </main>
  );
}

/** Mixer strip bound to a track row: controls the selected take's stream
 * for that performer; falls back to activity display while recording. */
function RowMixerStrip({
  row,
  selectedTakeId,
  playerSnap,
  playerLoaded,
}: {
  row: TrackRow;
  selectedTakeId: string | null;
  playerSnap: PlayerSnapshot;
  playerLoaded: boolean;
}) {
  const streamId = row.streams.find((s) => s.takeId === selectedTakeId)?.streamId;
  const track = playerLoaded ? playerSnap.tracks.find((t) => t.streamId === streamId) : undefined;
  if (!track) {
    return (
      <MixerStrip
        name={row.name}
        color={row.color}
        active={row.receiving}
        dbText={row.receiving ? "rx" : "—"}
      />
    );
  }
  return (
    <MixerStrip
      name={row.name}
      color={row.color}
      active={row.receiving}
      level={playerSnap.playing ? track.level : 0}
      gainDb={track.gainDb}
      onGainDb={(db) => getPlayer().setTrackDb(track.streamId, db)}
      muted={track.muted}
      onMute={() => getPlayer().toggleMute(track.streamId)}
      soloed={track.soloed}
      onSolo={() => getPlayer().toggleSolo(track.streamId)}
    />
  );
}

// ---- timeline row -----------------------------------------------------------

function TimelineRow({
  row,
  takes,
  pxPerSec,
  laneWidth,
  serverStatus,
  selectedTakeId,
  alignmentByStream,
  onSelectTake,
}: {
  row: TrackRow;
  takes: Map<string, TakeSlot>;
  pxPerSec: number;
  laneWidth: number;
  serverStatus: Map<string, ServerStreamStatus>;
  selectedTakeId: string | null;
  alignmentByStream: Map<string, boolean>;
  onSelectTake: (takeId: string) => void;
}) {
  const clips: ClipModel[] = [];
  for (const stream of row.streams) {
    const slot = takes.get(stream.takeId);
    if (!slot) continue;
    const server = serverStatus.get(stream.streamId);
    const converged =
      stream.complete && (server?.complete ?? false) && stream.digest === server?.digest;
    const aligned = alignmentByStream.get(stream.streamId) ?? false;
    const durationSec = Math.max(
      stream.totalSamples / SAMPLE_RATE,
      slot.live ? slot.durationSec : 1,
    );
    const takeNumber = [...takes.keys()].indexOf(stream.takeId) + 1;
    clips.push({
      id: stream.streamId,
      name: slot.live ? "Incoming take" : `Take ${takeNumber}`,
      color: row.color,
      x: slot.offsetSec * pxPerSec,
      width: durationSec * pxPerSec - 3,
      live: slot.live,
      badge: slot.live ? "rec" : aligned ? "aligned" : converged ? "converged" : "syncing",
      energy: stream.energy,
      selected: stream.takeId === selectedTakeId && !slot.live,
      ...(slot.live ? {} : { onSelect: () => onSelectTake(stream.takeId) }),
    });
  }

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
            <TrackMiniButton label="M" inert />
            <TrackMiniButton label="S" inert />
            <TrackMiniButton label="●" armed={row.armed} inert={!row.armed} />
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
          <VUVertical active={row.receiving} className="h-[52px]" />
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
}: {
  sessionId: string;
  recorders: Array<{ peerId: string; deviceInfo: { userAgent: string } }>;
  rows: TrackRow[];
  joinUrl: string;
  activeTakeId: string | null;
  streams: Array<{ streamId: string; takeId: string; peerId: string | null }>;
}) {
  const [showQr, setShowQr] = useState<boolean | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  useEffect(() => {
    void QRCode.toDataURL(joinUrl, {
      margin: 1,
      width: 224,
      color: { dark: "#f0f1f2", light: "#141516" },
    }).then(setQr);
  }, [joinUrl]);
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
              <VUMeter level={row?.receiving ? 0.72 : 0.03} className="flex-1" />
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
        <div className="rounded-lg border border-edge-card bg-card p-2.5">
          {qr && <img src={qr} alt="Join QR code" className="w-full rounded" />}
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
