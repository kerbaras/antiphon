// Mixer footer (264px: prototype's 218 + the EQ block): one strip per
// performer lane plus the master bus.

import { MixerStrip } from "./daw";
import { defaultEq } from "./eq";
import type { PlayerSnapshot } from "./player";
import type { TrackRow } from "./track-model";
import { getDeskSession, getPlayer } from "./use-desk";

export function MixerDock({
  sessionId,
  rows,
  playerSnap,
  recording,
  liveMasterLevel,
  levelFor,
  remoteEditing,
  selectedLaneKey,
  onSelectLane,
  onLaneMenu,
}: {
  sessionId: string;
  rows: TrackRow[];
  playerSnap: PlayerSnapshot;
  recording: boolean;
  /** Recording-time master bus estimate (sum of live track peaks). */
  liveMasterLevel: number;
  levelFor: (row: TrackRow) => number;
  /** Lanes another desk is touching right now (W3-A presence), by
   * channel key — the strip gets a faint ring in that desk's color. */
  remoteEditing: Map<string, { name: string; color: string }>;
  /** Selected lane (W4-E): desk-local UI state shared with the sidebar —
   * highlighted here, target of the S/M keyboard shortcuts. */
  selectedLaneKey: string | null;
  onSelectLane: (key: string) => void;
  /** Right-click a strip: the lane context menu at the cursor (W4-E). */
  onLaneMenu: (key: string, x: number, y: number) => void;
}) {
  return (
    <div className="flex min-w-0 border-t border-divider bg-raised">
      <div className="flex min-w-0 flex-1 overflow-x-auto">
        {rows.map((row) => (
          <RowMixerStrip
            key={row.key}
            sessionId={sessionId}
            row={row}
            playerSnap={playerSnap}
            recording={recording}
            liveLevel={levelFor(row)}
            remoteEditor={remoteEditing.get(row.key) ?? null}
            selected={row.key === selectedLaneKey}
            onSelect={() => onSelectLane(row.key)}
            onLaneMenu={(x, y) => onLaneMenu(row.key, x, y)}
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
        remoteEditor={remoteEditing.get("master") ?? null}
        {...(recording ? { dbText: formatDbfs(liveMasterLevel) } : {})}
      />
    </div>
  );
}

/** Mixer strip bound to a track row (performer lane). Gain/mute/solo edit
 * the lane's persistent channel strip — independent of which take is
 * selected, loaded, or whether anything is loaded at all. Meters show the
 * phone's LIVE capture level while recording (METER telemetry) and the
 * playback analyser otherwise. Renames (W4-E) ride the SAME peer-update
 * path as the sidebar title — server-persisted, fanned out, echoed back. */
function RowMixerStrip({
  sessionId,
  row,
  playerSnap,
  recording,
  liveLevel,
  remoteEditor,
  selected,
  onSelect,
  onLaneMenu,
}: {
  sessionId: string;
  row: TrackRow;
  playerSnap: PlayerSnapshot;
  recording: boolean;
  liveLevel: number;
  remoteEditor: { name: string; color: string } | null;
  selected: boolean;
  onSelect: () => void;
  onLaneMenu: (x: number, y: number) => void;
}) {
  const strip = playerSnap.channels.find((c) => c.key === row.key);
  return (
    <MixerStrip
      name={row.name}
      color={row.color}
      active={row.receiving}
      level={liveLevel}
      remoteEditor={remoteEditor}
      selected={selected}
      onSelect={onSelect}
      onLaneMenu={onLaneMenu}
      {...(row.peerId
        ? {
            onRename: (label: string) =>
              getDeskSession(sessionId).renamePeer(row.peerId as string, label),
          }
        : {})}
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
