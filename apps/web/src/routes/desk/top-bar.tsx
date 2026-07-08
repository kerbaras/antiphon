// Top bar (48px): wordmark + session identity, the centered transport
// cluster, avatar stack, share, export menu — as in the prototype.

import type { PeerInfo } from "@antiphon/protocol";
import { useState } from "react";
import type { DeskSessionState } from "../../net/desk-session";
import { Wordmark } from "../../ui/kit";
import { AvatarStack, InfoChip, Timecode, TransportButton, TransportGroup } from "./daw";
import { ExportMenu, type ExportMenuProps } from "./export-menu";
import type { PlayerSnapshot } from "./player";
import { deviceName, initialsOf, TRACK_COLORS } from "./track-model";
import { getDeskSession, getPlayer } from "./use-desk";

export function DeskTopBar({
  sessionId,
  joinUrl,
  phones,
  deskInputLive,
  serverSync,
  rebuiltChunks,
  signalingConnected,
  recording,
  elapsed,
  playerSnap,
  playerLoaded,
  takeCount,
  streamCount,
  onInvite,
  exportMenu,
}: {
  sessionId: string;
  joinUrl: string;
  phones: PeerInfo[];
  deskInputLive: boolean;
  serverSync: DeskSessionState["serverSync"];
  rebuiltChunks: number;
  signalingConnected: boolean;
  recording: boolean;
  elapsed: number;
  playerSnap: PlayerSnapshot;
  playerLoaded: boolean;
  takeCount: number;
  streamCount: number;
  onInvite: () => void;
  exportMenu: ExportMenuProps;
}) {
  const [shared, setShared] = useState(false);

  function share() {
    void navigator.clipboard.writeText(joinUrl).then(() => {
      setShared(true);
      window.setTimeout(() => setShared(false), 1_500);
    });
  }

  return (
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
            {deskInputLive ? " · desk input" : ""} · archive{" "}
            {serverSync === "connected" ? "linked" : serverSync}
            {rebuiltChunks > 0 ? ` · ${rebuiltChunks} chunks recovered` : ""}
          </span>
        </div>
      </div>

      {/* Centered transport cluster, as in the prototype */}
      <div className="absolute left-1/2 flex -translate-x-1/2 items-center gap-2.5">
        {/* Screen readers hear take/transport changes; visually the
            record button + timecode already carry this. */}
        <span aria-live="polite" className="sr-only">
          {recording ? "Recording take" : playerSnap.playing ? "Playing" : "Transport stopped"}
        </span>
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
            disabled={!signalingConnected || recording || playerSnap.playing}
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
          <InfoChip value={takeCount} unit={takeCount === 1 ? "take" : "takes"} />
          <InfoChip value={streamCount} unit="str" />
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
          onAdd={onInvite}
        />
        <button
          type="button"
          onClick={share}
          className="rounded-md border border-edge-strong px-3 py-1.5 text-[11px] font-semibold text-text hover:bg-card-hi"
        >
          {shared ? "Copied!" : "Share"}
        </button>
        <ExportMenu {...exportMenu} />
      </div>
    </header>
  );
}
