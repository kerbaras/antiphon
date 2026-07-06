// Mixing desk — /session/:uuid. The session's control authority and a full
// sink. Built from the reference top bar (wordmark, session title, transport
// + timecode cluster) and Performers panel; the arrange timeline and mixer
// arrive with the DAW milestone.

import QRCode from "qrcode";
import { useEffect, useMemo, useState } from "react";
import { useParams } from "react-router";
import type { DeskStreamStatus } from "../../audio/sink-worker-protocol";
import type { StreamMeta } from "../../net/desk-session";
import {
  Avatar,
  Badge,
  Button,
  InsetDisplay,
  MonoReadout,
  Panel,
  RecDot,
  SectionLabel,
  StatusPill,
  Wordmark,
} from "../../ui/kit";
import { getDeskSession, type ServerStreamStatus, useDeskState, useServerStatus } from "./use-desk";

const TRACK_COLORS = [
  "var(--color-track-teal)",
  "var(--color-track-gold)",
  "var(--color-track-rose)",
  "var(--color-track-orange)",
  "var(--color-track-blue)",
  "var(--color-track-violet)",
  "var(--color-track-cyan)",
  "var(--color-track-green)",
];

export function DeskRoute() {
  const { uuid } = useParams();
  if (!uuid) return null;
  return <Desk sessionId={uuid} />;
}

function Desk({ sessionId }: { sessionId: string }) {
  const state = useDeskState(sessionId);
  const takeIds = useMemo(() => [...new Set(state.streams.map((s) => s.takeId))], [state.streams]);
  const serverStatus = useServerStatus(sessionId, takeIds);
  const recording = state.activeTakeId !== null;

  const recorders = (state.session?.peers ?? []).filter((p) => p.role === "recorder");

  return (
    <main className="flex min-h-dvh flex-col bg-bg">
      {/* ===== Top bar (reference: wordmark · session · transport) ===== */}
      <header className="flex h-12 items-center justify-between gap-4 border-b border-divider bg-panel px-3.5">
        <div className="flex min-w-0 items-center gap-3.5">
          <Wordmark />
          <div className="h-5 w-px bg-edge-btn" />
          <div className="flex min-w-0 flex-col leading-tight">
            <span className="truncate text-[12px] font-semibold text-text-strong">
              Session {sessionId.slice(0, 8)}
            </span>
            <span className="text-[10px] text-text-dim">
              {recorders.length} phone{recorders.length === 1 ? "" : "s"} connected ·{" "}
              {state.rebuiltChunks > 0 ? `${state.rebuiltChunks} chunks recovered · ` : ""}
              sync {state.serverSync}
            </span>
          </div>
        </div>

        <div className="flex items-center gap-2.5">
          <InsetDisplay className="px-3 py-1">
            <TakeClock startedAt={recording ? state.takeStartedAt : null} />
          </InsetDisplay>
          {recording ? (
            <Button variant="outline" onClick={() => getDeskSession(sessionId).stopTake()}>
              ■ Stop take
            </Button>
          ) : (
            <Button
              variant="rec"
              disabled={!state.signalingConnected}
              onClick={() => getDeskSession(sessionId).startTake()}
            >
              ● Record take
            </Button>
          )}
          <Button
            variant="outline"
            disabled={recording && state.lastChirpAt !== null}
            onClick={() => void getDeskSession(sessionId).playChirp()}
          >
            ♫ Chirp
          </Button>
        </div>

        <div className="flex items-center gap-2">
          <StatusPill tone={state.signalingConnected ? "ok" : "idle"}>
            {state.signalingConnected ? "online" : "offline"}
          </StatusPill>
          <StatusPill tone={state.serverSync === "connected" ? "accent" : "warn"}>
            archive {state.serverSync === "connected" ? "linked" : state.serverSync}
          </StatusPill>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* ===== Main: streams / convergence ===== */}
        <section className="min-w-0 flex-1 overflow-auto p-4">
          {state.errors.length > 0 && (
            <Panel className="mb-3 border-rec/40 p-3">
              <SectionLabel className="text-rec">Protocol errors</SectionLabel>
              {state.errors.map((e) => (
                <p key={e} className="mt-1 font-mono text-[10px] text-rec">
                  {e}
                </p>
              ))}
            </Panel>
          )}

          <Panel className="p-4">
            <div className="flex items-center justify-between">
              <SectionLabel>Streams — sink convergence</SectionLabel>
              {recording && (
                <StatusPill tone="rec">
                  <RecDot /> recording
                </StatusPill>
              )}
            </div>
            {state.streams.length === 0 ? (
              <p className="mt-4 text-[12px] text-text-dim">
                No streams yet. Phones join via the QR code; Record starts everyone at once.
              </p>
            ) : (
              <div className="mt-3 flex flex-col gap-2">
                {state.streams.map((stream, i) => (
                  <StreamRow
                    key={stream.streamId}
                    stream={stream}
                    color={TRACK_COLORS[i % TRACK_COLORS.length] as string}
                    desk={state.deskStatus.find((d) => d.streamId === stream.streamId)}
                    server={serverStatus.get(stream.streamId)}
                  />
                ))}
              </div>
            )}
          </Panel>
        </section>

        {/* ===== Right rail: performers + invite (reference panel) ===== */}
        <aside className="flex w-[272px] flex-none flex-col gap-3 border-l border-divider bg-panel p-3">
          <div>
            <SectionLabel className="px-1 pb-2">Performers</SectionLabel>
            <div className="flex flex-col gap-2">
              {recorders.length === 0 && (
                <p className="px-1 text-[11px] text-text-dim">Waiting for phones…</p>
              )}
              {recorders.map((peer, i) => {
                const stream = state.streams.find(
                  (s) => s.peerId === peer.peerId && s.takeId === state.activeTakeId,
                );
                return (
                  <div
                    key={peer.peerId}
                    className="flex flex-col gap-2 rounded-lg border border-edge-card bg-card-hi p-2.5"
                  >
                    <div className="flex items-center gap-2">
                      <Avatar
                        initials={peer.peerId.slice(0, 2).toUpperCase()}
                        color={TRACK_COLORS[i % TRACK_COLORS.length] as string}
                        dot={stream ? "var(--color-rec)" : "var(--color-ok)"}
                      />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-[11.5px] font-semibold text-text-strong">
                          {deviceName(peer.deviceInfo.userAgent)}
                        </div>
                        <div className="truncate font-mono text-[9px] text-text-dim">
                          {peer.peerId.slice(0, 13)}
                        </div>
                      </div>
                      <StatusPill tone={stream ? "rec" : "ok"}>
                        {stream ? "recording" : "ready"}
                      </StatusPill>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
          <InvitePanel sessionId={sessionId} />
          {state.lastChirpAt && (
            <p className="px-1 font-mono text-[9px] text-text-faint">
              chirp emitted {new Date(state.lastChirpAt).toLocaleTimeString()}
            </p>
          )}
        </aside>
      </div>
    </main>
  );
}

function StreamRow({
  stream,
  color,
  desk,
  server,
}: {
  stream: StreamMeta;
  color: string;
  desk: DeskStreamStatus | undefined;
  server: ServerStreamStatus | undefined;
}) {
  const converged =
    desk !== undefined &&
    server !== undefined &&
    desk.digest !== "" &&
    desk.digest === server.digest &&
    desk.complete &&
    server.complete;
  return (
    <div className="flex items-stretch overflow-hidden rounded-md border border-edge bg-lane">
      <div className="w-1 flex-none" style={{ background: color }} />
      <div className="flex flex-1 flex-col gap-1.5 p-2.5">
        <div className="flex items-center justify-between gap-2">
          <span className="font-mono text-[10px] text-text-mute">
            {stream.streamId.slice(0, 18)}…
          </span>
          <div className="flex items-center gap-1.5">
            {stream.finalSeq !== null && <Badge>final {stream.finalSeq}</Badge>}
            {desk?.flagged || server?.flagged ? (
              <StatusPill tone="rec">flagged</StatusPill>
            ) : converged ? (
              <StatusPill tone="ok">⇥ converged</StatusPill>
            ) : (
              <StatusPill tone="warn">reconciling</StatusPill>
            )}
          </div>
        </div>
        <div className="grid grid-cols-2 gap-x-6 gap-y-0.5">
          <MonoReadout label="desk chwm" value={fmtChwm(desk?.chwm)} />
          <MonoReadout label="server chwm" value={fmtChwm(server?.chwm ?? null)} />
          <MonoReadout label="desk held" value={desk?.heldCount ?? 0} />
          <MonoReadout label="server held" value={server?.chunkCount ?? 0} />
          <MonoReadout
            label="desk holes"
            value={
              <span className={desk?.holes.length ? "text-warn" : undefined}>
                {desk?.holes.length ?? 0}
              </span>
            }
          />
          <MonoReadout
            label="server holes"
            value={
              <span className={server?.holes.length ? "text-warn" : undefined}>
                {server?.holes.length ?? 0}
              </span>
            }
          />
        </div>
        {converged && (
          <a
            href={`/api/streams/${stream.streamId}/flac`}
            className="self-start font-mono text-[10px] text-accent hover:underline"
            download
          >
            ↓ download .flac
          </a>
        )}
      </div>
    </div>
  );
}

function InvitePanel({ sessionId }: { sessionId: string }) {
  const [qr, setQr] = useState<string | null>(null);
  const joinUrl = `${location.origin}/join/${sessionId}`;
  useEffect(() => {
    void QRCode.toDataURL(joinUrl, {
      margin: 1,
      width: 232,
      color: { dark: "#f0f1f2", light: "#141516" },
    }).then(setQr);
  }, [joinUrl]);
  return (
    <div className="rounded-lg border border-dashed border-edge-strong p-3">
      <SectionLabel>Invite performer</SectionLabel>
      {qr && <img src={qr} alt="Join QR code" className="mt-2 w-full rounded-md" />}
      <p className="mt-2 break-all font-mono text-[9px] leading-relaxed text-text-dim">{joinUrl}</p>
    </div>
  );
}

function TakeClock({ startedAt }: { startedAt: number | null }) {
  const [, force] = useState(0);
  useEffect(() => {
    if (startedAt === null) return;
    const t = window.setInterval(() => force((n) => n + 1), 100);
    return () => window.clearInterval(t);
  }, [startedAt]);
  const seconds = startedAt === null ? 0 : (Date.now() - startedAt) / 1_000;
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    <span className="font-mono text-[15px] font-semibold tracking-[1px] text-text-hi">
      {pad(Math.floor(seconds / 60))}:{pad(Math.floor(seconds % 60))}
      <span className="text-text-faint">:{pad(Math.floor((seconds % 1) * 100))}</span>
    </span>
  );
}

function fmtChwm(chwm: number | null | undefined): string {
  return chwm === null || chwm === undefined ? "—" : String(chwm);
}

function deviceName(userAgent: string): string {
  const m = /iPhone|iPad|Android|Macintosh|Windows/.exec(userAgent);
  return m ? `${m[0]} · Safari/Chrome` : "Browser";
}
