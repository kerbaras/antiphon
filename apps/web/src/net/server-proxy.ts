// Dev/preview proxy contract between the web origin and the app server
// (vite.config.ts imports this; production is same-origin, no proxy).

/** Signaling (ws) + doc sync (collab); query string admitted (auth token).
 * Must match the FULL req.url: vite leaves an unmatched upgrade unanswered
 * (hung in CONNECTING), and the browser's one-CONNECTING-handshake-per-host
 * rule (RFC 6455 §4.1) then blocks every later WebSocket to the origin. */
export const SERVER_WS_PATTERN = "^/(session|join)/[^/]+/(ws|collab)(\\?|$)";

/** The vite `server.proxy` / `preview.proxy` map for a given server origin. */
export function serverProxy(serverOrigin: string): Record<string, object> {
  return {
    "/api": { target: serverOrigin, changeOrigin: true },
    [SERVER_WS_PATTERN]: { target: serverOrigin, ws: true, changeOrigin: true },
  };
}
