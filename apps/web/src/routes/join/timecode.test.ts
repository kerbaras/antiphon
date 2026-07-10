import { describe, expect, it } from "vitest";
import { formatClock } from "./timecode";

describe("formatClock", () => {
  it("renders mm:ss.cc unambiguously", () => {
    expect(formatClock(0)).toBe("00:00.00");
    expect(formatClock(1.5)).toBe("00:01.50");
    expect(formatClock(83.5)).toBe("01:23.50");
    expect(formatClock(599.25)).toBe("09:59.25");
  });

  it("minutes widen naturally past 99 instead of wrapping", () => {
    expect(formatClock(3_600)).toBe("60:00.00");
    expect(formatClock(6_000)).toBe("100:00.00");
    expect(formatClock(6_061.75)).toBe("101:01.75");
  });

  it("degrades safely on garbage input", () => {
    expect(formatClock(Number.NaN)).toBe("00:00.00");
    expect(formatClock(-5)).toBe("00:00.00");
    expect(formatClock(Number.POSITIVE_INFINITY)).toBe("00:00.00");
  });
});
