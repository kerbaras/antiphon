// Top bar (48px): wordmark + session identity, the centered transport
// cluster, avatar stack (its "+" opens the invite popover), export menu.

import type { PeerInfo } from "@antiphon/protocol";
import { lazy, Suspense, useRef, useState } from "react";
import { useAuthMode } from "../../auth/auth-root";
import { useAuthUser } from "../../auth/use-auth-user";
import { Wordmark } from "../../components";
import type { DeskSessionState } from "../../net/desk-session";
import { AvatarStack, InfoChip, Timecode, TransportButton, TransportGroup } from "./daw";
import { ExportMenu, type ExportMenuProps } from "./export-menu";
import { InvitePopover } from "./invite-popover";
import type { PlayerSnapshot } from "./player";
import { deviceName, initialsOf, TRACK_COLORS } from "./track-model";
import { getDeskSession, getPlayer } from "./use-desk";

/** Account button — auth mode only, lazy so keyless desks never load
 * Clerk chrome. */
const AccountCluster = lazy(() => import("./account-cluster"));

/** THE transport button's ▶-face gate, shared with the global Space
 * shortcut: Space must be a no-op exactly when ▶ is disabled (e.g. while a
 * take decodes). One predicate, both callers: parity by construction. */
export function playActionReady(playerLoaded: boolean, playerSnap: PlayerSnapshot): boolean {
  return playerLoaded && !playerSnap.loading;
}

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
  /** Other desks in the room — real people, real avatars. */
  remoteDesks: Array<{ clientId: number; name: string; color: string; avatarUrl: string | null }>;
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
  // The "+" on the avatar stack is THE invite affordance; its popover
  // holds the desk's only join QR. Nobody else cares: local state.
  const [inviteOpen, setInviteOpen] = useState(false);
  const inviteAnchor = useRef<HTMLButtonElement>(null);
  const authMode = useAuthMode();
  const me = useAuthUser();

  return (
    // Equal flex shares center the transport at full width; narrower, the
    // sweep-pinned tiers shed (stat chips <1200, wordmark lettering <840,
    // timecode + presence avatars <640) and the flexible title truncates.
    <header className="flex items-center gap-4 border-b border-divider bg-panel px-3.5">
      <div className="flex min-w-0 flex-1 items-center gap-3.5">
        <Wordmark textClassName="hidden min-[840px]:block" />
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

      {/* Centered transport cluster */}
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
          {/* Face IS the transport state: ■ Stop while a take rolls
              (recording wins), ⏸ while playing, ▶ idle. Stop never gates on
              player/signaling; Play alone waits for playActionReady. */}
          <TransportButton
            label={recording ? "Stop take" : playerSnap.playing ? "Pause" : "Play"}
            tone="accent"
            active={!recording && playerSnap.playing}
            disabled={!recording && !playActionReady(playerLoaded, playerSnap)}
            onClick={() => {
              if (recording) {
                getDeskSession(sessionId).stopTake();
                return;
              }
              // Re-validated at event time on the live snapshot, exactly
              // like the Space guard: both paths run the one predicate.
              if (playActionReady(playerLoaded, getPlayer().snapshot())) getPlayer().toggle();
            }}
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
        <Timecode
          className="hidden min-[640px]:block"
          seconds={recording ? elapsed : playerLoaded ? playerSnap.positionSec : 0}
        />
        {/* Stat chips are the lowest-priority tier: they collapse first so
            the session title keeps a legible width at narrow widths. */}
        <div className="hidden gap-1.5 min-[1200px]:flex">
          <InfoChip value="48.0" unit="kHz" />
          <InfoChip value={takeCount} unit={takeCount === 1 ? "take" : "takes"} />
          <InfoChip value={streamCount} unit="str" />
        </div>
      </div>

      <div className="flex min-w-fit flex-1 items-center justify-end gap-3">
        <div className="relative">
          <AvatarStack
            people={[
              {
                id: "you",
                initials: "DK",
                color: "#c8c9cb",
                title: "You (Desk)",
                avatarUrl: me?.imageUrl ?? null,
              },
              ...remoteDesks.slice(0, 3).map((d) => ({
                id: `desk-${d.clientId}`,
                initials: initialsOf(d.name) ?? "D",
                color: d.color,
                title: `${d.name} (Desk)`,
                avatarUrl: d.avatarUrl,
              })),
              ...phones.slice(0, 3).map((p, i) => ({
                id: `phone-${p.peerId}`,
                initials: initialsOf(p.deviceInfo.label) ?? p.peerId.slice(0, 2).toUpperCase(),
                color: TRACK_COLORS[i % TRACK_COLORS.length] as string,
                title: p.deviceInfo.label?.trim() || deviceName(p.deviceInfo.userAgent),
                avatarUrl: p.deviceInfo.avatarUrl ?? null,
              })),
            ]}
            onAdd={() => setInviteOpen(!inviteOpen)}
            addRef={inviteAnchor}
            addExpanded={inviteOpen}
          />
          {inviteOpen && (
            <InvitePopover
              sessionId={sessionId}
              joinUrl={joinUrl}
              onClose={(restoreFocus) => {
                setInviteOpen(false);
                if (restoreFocus) inviteAnchor.current?.focus();
              }}
            />
          )}
        </div>
        {authMode === "clerk" && (
          <Suspense fallback={null}>
            <AccountCluster />
          </Suspense>
        )}
        <ExportMenu {...exportMenu} />
      </div>
    </header>
  );
}
