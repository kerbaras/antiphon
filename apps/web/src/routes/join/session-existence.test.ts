import { describe, expect, it } from "vitest";
import { interpretSummary } from "./session-existence";

// F19: GET /api/sessions/:id answers 200 with an empty summary for ANY id
// (verified against the live server — no 404; flagged for the server wave).
// Existence is therefore read from the body: a session is real once a desk
// has ever opened it (invite links come from a desk) or it holds takes.
describe("interpretSummary (F19 existence probe)", () => {
  it("an empty summary — nobody ever opened this id — is absent", () => {
    expect(interpretSummary({ sessionId: "x", takes: [], peers: [] })).toBe("absent");
  });

  it("a desk peer (present or historical) proves existence", () => {
    expect(interpretSummary({ takes: [], peers: [{ peerId: "p", role: "desk" }] })).toBe("present");
  });

  it("recorded takes prove existence even with an empty roster", () => {
    expect(interpretSummary({ takes: [{ id: "t" }], peers: [] })).toBe("present");
  });

  it("a lone recorder in a void is still absent — no desk ever came", () => {
    expect(interpretSummary({ takes: [], peers: [{ peerId: "p", role: "recorder" }] })).toBe(
      "absent",
    );
  });

  it("malformed bodies are unknown, never a false warning", () => {
    expect(interpretSummary(null)).toBe("unknown");
    expect(interpretSummary("nope")).toBe("unknown");
    expect(interpretSummary({})).toBe("unknown");
    expect(interpretSummary({ takes: "x", peers: [] })).toBe("unknown");
    expect(interpretSummary({ takes: [], peers: [null] })).toBe("absent");
  });
});
