import { describe, expect, it } from "vitest";
import { interpretProbeStatus } from "./session-existence";

describe("interpretProbeStatus", () => {
  it("200 — the session row exists — is present", () => {
    expect(interpretProbeStatus(200)).toBe("present");
  });

  it("404 — no session row anywhere — is absent", () => {
    expect(interpretProbeStatus(404)).toBe("absent");
  });

  it("server trouble or proxy noise is unknown, never a false warning", () => {
    expect(interpretProbeStatus(500)).toBe("unknown");
    expect(interpretProbeStatus(502)).toBe("unknown");
    expect(interpretProbeStatus(503)).toBe("unknown");
    expect(interpretProbeStatus(429)).toBe("unknown");
    expect(interpretProbeStatus(302)).toBe("unknown");
  });
});
