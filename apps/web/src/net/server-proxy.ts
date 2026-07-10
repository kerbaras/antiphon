// The dev/preview proxy contract between the web origin and the app server
// (vite.config.ts imports this; production serves everything same-origin so
// no proxy exists there). Extracted so the WS pattern is unit-pinned: vite
// tests proxy regexes against the FULL req.url, and a pattern that misses a
// legitimate WS URL does not 404 — vite leaves the unmatched upgrade
// UNANSWERED, the socket hangs in CONNECTING, and the browser's
// one-CONNECTING-handshake-per-host rule (RFC 6455 §4.1) then blocks every
// later WebSocket to the origin. That exact failure shipped once: W8-A put
// `?auth_token=…` on the collab URL, the old `$`-anchored pattern stopped
// matching it, and the hung collab handshake took the desk-input recorder's
// /join WS (the room-mic lane) down with it in auth-mode dev.

/** Signaling (ws) + the W3-A shared-project-doc sync (collab), query
 * string admitted (the collab token rides one in auth mode). */
export const SERVER_WS_PATTERN = "^/(session|join)/[^/]+/(ws|collab)(\\?|$)";

/** The vite `server.proxy` / `preview.proxy` map for a given server origin. */
export function serverProxy(serverOrigin: string): Record<string, object> {
  return {
    "/api": { target: serverOrigin, changeOrigin: true },
    [SERVER_WS_PATTERN]: { target: serverOrigin, ws: true, changeOrigin: true },
  };
}
