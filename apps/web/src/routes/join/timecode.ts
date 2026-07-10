// Phone timecode: "mm:ss.cc" — centiseconds behind a decimal point (three
// colon-separated pairs reads as HH:MM:SS), minutes widening past 99.

export function formatClock(seconds: number): string {
  const safe = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
  const mm = Math.floor(safe / 60);
  const ss = Math.floor(safe % 60);
  const cs = Math.floor((safe % 1) * 100);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(mm)}:${pad(ss)}.${pad(cs)}`;
}
