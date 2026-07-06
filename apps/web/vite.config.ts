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
const serverProxy = {
  "/api": { target: "http://localhost:8787", changeOrigin: true },
  "^/(session|join)/[^/]+/ws$": {
    target: "http://localhost:8787",
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
