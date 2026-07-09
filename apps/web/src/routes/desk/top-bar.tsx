// Top bar (48px): wordmark + session identity, the centered transport
// cluster, avatar stack (its "+" opens the invite popover), export menu —
// as in the prototype.

import type { PeerInfo } from "@antiphon/protocol";
import { useRef, useState } from "react";
import type { DeskSessionState } from "../../net/desk-session";
import { Wordmark } from "../../ui/kit";
import { AvatarStack, InfoChip, Timecode, TransportButton, TransportGroup } from "./daw";
import { ExportMenu, type ExportMenuProps } from "./export-menu";
import { InvitePopover } from "./invite-popover";
import type { PlayerSnapshot } from "./player";
import { deviceName, initialsOf, TRACK_COLORS } from "./track-model";
import { getDeskSession, getPlayer } from "./use-desk";

export function DeskTopBar({
  sessionId,
  joinUrl,
  phones,
  remoteDesks,
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
  exportMenu,
}: {
  sessionId: string;
  joinUrl: string;
  phones: PeerInfo[];
  /** Other desks in the room (W3-A presence) — real people, real avatars. */
  remoteDesks: Array<{ clientId: number; name: string; color: string }>;
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
  exportMenu: ExportMenuProps;
}) {
  // The "+" on the avatar stack is THE invite affordance (W4-D): it took
  // over the old Share button's clipboard job and the sidebar QR toggle.
  const [inviteOpen, setInviteOpen] = useState(false);
  const inviteAnchor = useRef<HTMLButtonElement>(null);

  return (
    // Left and right groups are equal flex shares (flex-1 basis-0), so at
    // full width the transport cluster sits dead-center exactly like the
    // prototype's absolute centering — but when the viewport narrows the
    // cluster claims its space first (shrink-0) and the session-title block
    // truncates into its own share instead of running underneath (F15).
    <header className="flex items-center gap-4 border-b border-divider bg-panel px-3.5">
      <div className="flex min-w-0 flex-1 items-center gap-3.5">
        <Wordmark />
        <div className="h-5 w-px shrink-0 bg-edge-btn" />
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
      <div className="flex shrink-0 items-center gap-2.5">
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
          {/* THE transport button (W4-D): one context-aware control whose
              face IS the transport state — ■ Stop while a take rolls
              (stopping is the only sane transport action then; record and
              playback stay mutually exclusive), ⏸ Pause while playing,
              ▶ Play when idle. Recording wins the precedence, exactly like
              the Space shortcut in index.tsx always has. Stop never gates
              on the player or on signaling: a rolling take must stay
              stoppable even mid-server-restart (the recovery e2e relies on
              it); Play alone waits for a loaded, decoded take. */}
          <TransportButton
            label={recording ? "Stop take" : playerSnap.playing ? "Pause" : "Play"}
            tone="accent"
            active={!recording && playerSnap.playing}
            disabled={!recording && (!playerLoaded || playerSnap.loading)}
            onClick={() =>
              recording ? getDeskSession(sessionId).stopTake() : getPlayer().toggle()
            }
          >
            {recording ? "■" : playerSnap.playing ? "⏸" : "▶"}
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
            label="Chirp"
            tone="accent"
            disabled={!recording}
            onClick={() => void getDeskSession(sessionId).playChirp()}
          >
            ♫
          </TransportButton>
        </TransportGroup>
        <Timecode seconds={recording ? elapsed : playerLoaded ? playerSnap.positionSec : 0} />
        {/* Stat chips are the lowest-priority tier: they collapse first so
            the session title keeps a legible width at narrow widths. */}
        <div className="hidden gap-1.5 min-[1200px]:flex">
          <InfoChip value="48.0" unit="kHz" />
          <InfoChip value={takeCount} unit={takeCount === 1 ? "take" : "takes"} />
          <InfoChip value={streamCount} unit="str" />
        </div>
      </div>

      <div className="flex flex-1 items-center justify-end gap-3">
        <div className="relative">
          <AvatarStack
            people={[
              { id: "you", initials: "DK", color: "#c8c9cb", title: "You (Desk)" },
              // Other desks co-editing this session (W3-A presence).
              ...remoteDesks.slice(0, 3).map((d) => ({
                id: `desk-${d.clientId}`,
                initials: initialsOf(d.name) ?? "D",
                color: d.color,
                title: `${d.name} (Desk)`,
              })),
              ...phones.slice(0, 3).map((p, i) => ({
                id: `phone-${p.peerId}`,
                initials: initialsOf(p.deviceInfo.label) ?? p.peerId.slice(0, 2).toUpperCase(),
                color: TRACK_COLORS[i % TRACK_COLORS.length] as string,
                title: p.deviceInfo.label?.trim() || deviceName(p.deviceInfo.userAgent),
              })),
            ]}
            onAdd={() => setInviteOpen((open) => !open)}
            addRef={inviteAnchor}
            addExpanded={inviteOpen}
          />
          {inviteOpen && (
            <InvitePopover
              joinUrl={joinUrl}
              onClose={(restoreFocus) => {
                setInviteOpen(false);
                if (restoreFocus) inviteAnchor.current?.focus();
              }}
            />
          )}
        </div>
        <ExportMenu {...exportMenu} />
      </div>
    </header>
  );
}
