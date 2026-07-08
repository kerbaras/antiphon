// Phone timecode formatting (QA #16). The old `MM:SS:CC` read as
// `HH:MM:SS` — three colon-separated pairs is universally hours. Centi-
// seconds ride behind a decimal point instead ("01:23.81"), and minutes
// widen naturally past 99 rather than wrapping or padding into nonsense.

export function formatClock(seconds: number): string {
  const safe = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
  const mm = Math.floor(safe / 60);
  const ss = Math.floor(safe % 60);
  const cs = Math.floor((safe % 1) * 100);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(mm)}:${pad(ss)}.${pad(cs)}`;
}
