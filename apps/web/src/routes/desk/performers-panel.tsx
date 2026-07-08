// Right-rail Performers panel: connected phones, the desk input, QR invite.

import type { PeerInfo } from "@antiphon/protocol";
import { useState } from "react";
import { Avatar, StatusPill, StyledQr, VUMeter } from "../../ui/kit";
import { DeskInputBlock } from "./desk-input-block";
import { deviceName, initialsOf, TRACK_COLORS, type TrackRow } from "./track-model";
import { getDeskSession } from "./use-desk";
import type { DeskInputState } from "./use-desk-input";

export function PerformersPanel({
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
        const nickname = peer.deviceInfo.label?.trim();
        const model = deviceName(peer.deviceInfo.userAgent);
        // Unnamed performers title as their lane ("iPhone 2") — the device
        // is already in the title, so the subtitle keeps just the id. Named
        // ones keep the device provenance ("Maria" / "iPhone · a1b2c3d4").
        const title = nickname || row?.name || model;
        const subtitle = nickname
          ? `${model} · ${peer.peerId.slice(0, 8)}`
          : peer.peerId.slice(0, 8);
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
                <div className="truncate text-[11.5px] font-semibold text-text-strong">{title}</div>
                <div className="truncate font-mono text-[9.5px] text-text-dim">{subtitle}</div>
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
