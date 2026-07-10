// Top bar (48px): wordmark + session identity, the centered transport
// cluster, avatar stack (its "+" opens the invite popover), export menu —
// as in the prototype.

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

/** W8-A: Share (desk access by email) + UserButton — auth mode only, lazy
 * so keyless desks never load Clerk chrome. */
const AccountCluster = lazy(() => import("./account-cluster"));

/** THE transport button's ▶-face gate, shared with the global Space
 * shortcut (W5-B): Space must be a no-op exactly when ▶ is disabled.
 * QA hit the gap twice — while a take decodes (playerSnap.loading) the
 * button honestly refuses, but Space could still reach toggle() and play
 * the previous take. One predicate, both callers: parity by construction. */
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
  /** Other desks in the room (W3-A presence) — real people, real avatars. */
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
  // The "+" on the avatar stack is THE invite affordance (W4-D) — and its
  // popover holds the desk's ONLY join QR (W6-A retired the performers
  // tab's wall-poster copy, and with it the W5-B yield plumbing that had
  // this state living with the orchestrator). Nobody else cares: local.
  const [inviteOpen, setInviteOpen] = useState(false);
  const inviteAnchor = useRef<HTMLButtonElement>(null);
  // W8-A: the "+" stays the MIC invite (public link); desk-access sharing
  // and the operator's account render as their own cluster beside it,
  // auth mode only — keyless top bars are unchanged.
  const authMode = useAuthMode();
  // The operator's own face (A16): signed-in pfp over the DK disc.
  const me = useAuthUser();

  return (
    // Left and right groups are equal flex shares (flex-1 basis-0), so at
    // full width the transport cluster sits dead-center exactly like the
    // prototype's absolute centering — but when the viewport narrows the
    // cluster claims its space first (shrink-0) and the session-title block
    // truncates into its own share instead of running underneath (F15).
    //
    // Below that, the bar sheds tiers instead of self-overlapping (W5-B —
    // QA clamped to 430px and watched the right group run over the
    // transport): stat chips go first (<1200, F15), then the wordmark
    // lettering (<840 — the mark stays; the session title is the working
    // identity), then the timecode and the presence avatars (<640 — the
    // "+" invite affordance survives; the boundary sits where the title
    // still keeps a legible width WITH those pieces on screen — at the
    // old 560 the title crushed to ~2 chars right at the tier edge, QA
    // F5). The right group refuses to shrink below its content
    // (min-w-fit): overflow claims the flexible title, never the
    // neighbouring cluster. index.tsx floors the whole desk at 520px —
    // beyond every tier, the page scrolls rather than explodes.
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
              it); Play alone waits for a loaded, decoded take
              (playActionReady — the Space shortcut shares the gate). */}
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
              // like the Space guard (QA F4): disabled= should make this
              // unreachable, but both paths run the one predicate.
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
              // Other desks co-editing this session (W3-A presence).
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
