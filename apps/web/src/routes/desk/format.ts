// Shared time readouts for the desk panels.

/** m:ss span readout (song lengths). */
export function formatSpan(sec: number): string {
  const total = Math.max(0, Math.round(sec));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/** mm:ss.d position readout (marker timecodes). */
export function formatAt(sec: number): string {
  const minutes = Math.floor(sec / 60);
  const seconds = sec - minutes * 60;
  return `${String(minutes).padStart(2, "0")}:${seconds.toFixed(1).padStart(4, "0")}`;
}
