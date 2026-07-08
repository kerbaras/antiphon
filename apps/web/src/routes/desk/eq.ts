// 3-band channel EQ (W2-C): one pure parameter model plus one biquad-chain
// builder, shared by live playback (player.ts) and the offline render
// (render.ts). Like timeline-math, export parity is by construction — both
// paths build their filter chains HERE, so the master render can only ever
// hear what monitoring hears.
//
// Chain: low shelf (120 Hz) → mid peak (sweepable 200 Hz–8 kHz, Q 1) →
// high shelf (8 kHz), all ±12 dB. At 0 dB gain the RBJ coefficients of all
// three types collapse to b0=a0, b1=a1, b2=a2 — an exact IEEE identity
// (verified coefficient-for-coefficient in eq.test.ts, and byte-for-byte
// against real renders in e2e/tests/eq.spec.ts) — so an engaged EQ at
// defaults is bit-transparent, not merely inaudible.

export const EQ_LOW_HZ = 120;
export const EQ_HIGH_HZ = 8_000;
export const EQ_MID_Q = 1;
export const EQ_MID_HZ_MIN = 200;
export const EQ_MID_HZ_MAX = 8_000;
export const EQ_MID_HZ_DEFAULT = 1_000;
export const EQ_DB_RANGE = 12;
/** setTargetAtTime time constant for live band moves: ~5τ = 100 ms to
 * settle — click-free but still feels immediate under a dragging finger. */
export const EQ_SMOOTH_SEC = 0.02;

export interface EqState {
  lowDb: number;
  midDb: number;
  /** Mid peak center frequency, EQ_MID_HZ_MIN..EQ_MID_HZ_MAX. */
  midHz: number;
  highDb: number;
  /** True bypass: the strip's signal path reconnects AROUND the biquads. */
  bypassed: boolean;
}

export type EqBandPatch = Partial<Pick<EqState, "lowDb" | "midDb" | "midHz" | "highDb">>;

export function defaultEq(): EqState {
  return { lowDb: 0, midDb: 0, midHz: EQ_MID_HZ_DEFAULT, highDb: 0, bypassed: false };
}

function clampDb(db: number): number {
  return Math.max(-EQ_DB_RANGE, Math.min(EQ_DB_RANGE, db));
}

function clampHz(hz: number): number {
  return Math.max(EQ_MID_HZ_MIN, Math.min(EQ_MID_HZ_MAX, hz));
}

/** Clamped merge — the single write path for EQ band parameters. */
export function applyEqPatch(eq: EqState, patch: EqBandPatch): EqState {
  return {
    ...eq,
    lowDb: clampDb(patch.lowDb ?? eq.lowDb),
    midDb: clampDb(patch.midDb ?? eq.midDb),
    midHz: clampHz(patch.midHz ?? eq.midHz),
    highDb: clampDb(patch.highDb ?? eq.highDb),
  };
}

// Mid-frequency sweeps feel right on a log scale: the UI drags a normalized
// 0..1 position, the model keeps Hz.

export function midHzToNorm(hz: number): number {
  return Math.log(clampHz(hz) / EQ_MID_HZ_MIN) / Math.log(EQ_MID_HZ_MAX / EQ_MID_HZ_MIN);
}

export function normToMidHz(norm: number): number {
  const n = Math.max(0, Math.min(1, norm));
  return clampHz(EQ_MID_HZ_MIN * (EQ_MID_HZ_MAX / EQ_MID_HZ_MIN) ** n);
}

/** "+4.5" / "0.0" / "−12.0" — signed dB knob readout (typographic minus). */
export function formatEqDb(db: number): string {
  const magnitude = Math.abs(db).toFixed(1);
  return db > 0 ? `+${magnitude}` : db < 0 ? `−${magnitude}` : magnitude;
}

/** "397" below 1 kHz, "1.0k" above — dense mid-frequency readout. */
export function formatEqHz(hz: number): string {
  return hz >= 1_000 ? `${(hz / 1_000).toFixed(1)}k` : `${Math.round(hz)}`;
}

export interface EqChain {
  low: BiquadFilterNode;
  mid: BiquadFilterNode;
  high: BiquadFilterNode;
}

/** Build the band chain (signal enters `low`, exits `high`). Parameters are
 * set directly — correct for offline renders and for freshly created live
 * chains; live re-targeting goes through updateEqChain for smoothing. */
export function createEqChain(ctx: BaseAudioContext, eq: EqState): EqChain {
  const low = ctx.createBiquadFilter();
  low.type = "lowshelf";
  low.frequency.value = EQ_LOW_HZ;
  low.gain.value = clampDb(eq.lowDb);
  const mid = ctx.createBiquadFilter();
  mid.type = "peaking";
  mid.Q.value = EQ_MID_Q;
  mid.frequency.value = clampHz(eq.midHz);
  mid.gain.value = clampDb(eq.midDb);
  const high = ctx.createBiquadFilter();
  high.type = "highshelf";
  high.frequency.value = EQ_HIGH_HZ;
  high.gain.value = clampDb(eq.highDb);
  low.connect(mid);
  mid.connect(high);
  return { low, mid, high };
}

/** Re-target a live chain's parameters click-free (setTargetAtTime; the
 * strip gains historically snap via `.value` — biquad coefficient jumps are
 * far more click-prone than gain jumps, hence the explicit smoothing). */
export function updateEqChain(chain: EqChain, eq: EqState, atSec: number): void {
  chain.low.gain.setTargetAtTime(clampDb(eq.lowDb), atSec, EQ_SMOOTH_SEC);
  chain.mid.gain.setTargetAtTime(clampDb(eq.midDb), atSec, EQ_SMOOTH_SEC);
  chain.mid.frequency.setTargetAtTime(clampHz(eq.midHz), atSec, EQ_SMOOTH_SEC);
  chain.high.gain.setTargetAtTime(clampDb(eq.highDb), atSec, EQ_SMOOTH_SEC);
}

export function disconnectEqChain(chain: EqChain): void {
  chain.low.disconnect();
  chain.mid.disconnect();
  chain.high.disconnect();
}
