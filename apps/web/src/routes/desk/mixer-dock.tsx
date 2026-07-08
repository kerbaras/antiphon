// Mixer footer (264px: prototype's 218 + the EQ block): one strip per
// performer lane plus the master bus.

import { MixerStrip } from "./daw";
import { defaultEq } from "./eq";
import type { PlayerSnapshot } from "./player";
import type { TrackRow } from "./track-model";
import { getPlayer } from "./use-desk";

export function MixerDock({
  rows,
  playerSnap,
  recording,
  liveMasterLevel,
  levelFor,
}: {
  rows: TrackRow[];
  playerSnap: PlayerSnapshot;
  recording: boolean;
  /** Recording-time master bus estimate (sum of live track peaks). */
  liveMasterLevel: number;
  levelFor: (row: TrackRow) => number;
}) {
  return (
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
