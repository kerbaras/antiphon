import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

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
// keep the fixed :8787 default.
const serverOrigin = process.env.ANTIPHON_SERVER_ORIGIN ?? "http://localhost:8787";
const serverProxy = {
  "/api": { target: serverOrigin, changeOrigin: true },
  // Signaling (ws) + the W3-A shared-project-doc sync (collab).
  "^/(session|join)/[^/]+/(ws|collab)$": {
    target: serverOrigin,
    ws: true,
    changeOrigin: true,
  },
};

export default defineConfig({
  plugins: [
    react({
      babel: {
        plugins: ["babel-plugin-react-compiler"],
      },
    }),
    tailwindcss(),
  ],
  server: { headers: crossOriginIsolation, proxy: serverProxy },
  preview: { headers: crossOriginIsolation, proxy: serverProxy },
  worker: { format: "es" },
});
