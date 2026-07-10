import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { serverProxy } from "./src/net/server-proxy";

// COOP/COEP from day one: SharedArrayBuffer requires cross-origin isolation,
// and retrofitting it breaks lazily-loaded third-party scripts.
// (docs/ARCHITECTURE.md §2.2)
const crossOriginIsolation = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
};

// Control plane + archive REST live on the app server; one origin for the
// browser (and for a single cloudflared tunnel) via proxy in dev/preview.
// The e2e suite runs one preview+server pair per git worktree on derived
// ports (e2e/ports.ts) and threads the server origin in here; dev and CI
// keep the fixed :8787 default. Proxy map + the unit-pinned WS pattern
// live in src/net/server-proxy.ts (the room-mic postmortem is there).
const serverOrigin = process.env.ANTIPHON_SERVER_ORIGIN ?? "http://localhost:8787";
const proxy = serverProxy(serverOrigin);

export default defineConfig({
  plugins: [
    react({
      babel: {
        plugins: ["babel-plugin-react-compiler"],
      },
    }),
    tailwindcss(),
  ],
  server: { headers: crossOriginIsolation, proxy },
  preview: { headers: crossOriginIsolation, proxy },
  worker: { format: "es" },
});
