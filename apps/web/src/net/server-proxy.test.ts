// Regression pin for the dev/preview WS proxy pattern (see server-proxy.ts
// for the room-mic postmortem): vite matches proxy regexes against the FULL
// req.url, and an unmatched upgrade HANGS — so every legitimate WS URL shape
// must match, query string included.

import { describe, expect, it } from "vitest";
import { SERVER_WS_PATTERN, serverProxy } from "./server-proxy";

const pattern = new RegExp(SERVER_WS_PATTERN);
const uuid = "3be5c0af-1a38-403d-94b6-02425b610e9c";

describe("SERVER_WS_PATTERN", () => {
  it("matches every WS URL the app opens", () => {
    expect(pattern.test(`/session/${uuid}/ws`)).toBe(true);
    expect(pattern.test(`/join/${uuid}/ws`)).toBe(true);
    expect(pattern.test(`/session/${uuid}/collab`)).toBe(true);
    // Auth mode: the collab token rides a query param (W8-A). The old
    // `$`-anchored pattern missed this — the hang that killed the
    // room-mic lane in auth-mode dev.
    expect(pattern.test(`/session/${uuid}/collab?auth_token=eyJx.y.z`)).toBe(true);
  });

  it("does not swallow app routes", () => {
    expect(pattern.test(`/session/${uuid}`)).toBe(false); // the desk SPA route
    expect(pattern.test(`/join/${uuid}`)).toBe(false); // the join SPA route
    expect(pattern.test(`/session/${uuid}/collaborate`)).toBe(false);
    expect(pattern.test(`/sessions/${uuid}/ws`)).toBe(false);
  });

  it("proxy map carries the pattern with ws enabled", () => {
    const map = serverProxy("http://localhost:8787");
    expect(map[SERVER_WS_PATTERN]).toMatchObject({ ws: true });
    expect(map["/api"]).toMatchObject({ changeOrigin: true });
  });
});
