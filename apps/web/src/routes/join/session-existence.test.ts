import { describe, expect, it } from "vitest";
import { interpretProbeStatus } from "./session-existence";

// F19 (tightened by the nano-batch server fix): GET /api/sessions/:id now
// 404s for unknown session rows, so existence is read straight from the
// HTTP status — exact, no body heuristics. Anything that is neither a
// definite hit nor a definite miss stays "unknown" (never a false warning).
describe("interpretProbeStatus (F19 existence probe)", () => {
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
