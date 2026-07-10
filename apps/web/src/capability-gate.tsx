// Boot-time capability gate for the audio-bearing routes: they need
// cross-origin isolation (COOP/COEP → SharedArrayBuffer for the capture
// ring) and AudioWorklet. State exactly what is missing; no polyfills.

import type { ReactNode } from "react";
import { MonoReadout, Panel, SectionLabel, Wordmark } from "./components";

interface Capability {
  name: string;
  ok: boolean;
  why: string;
}

function probe(): Capability[] {
  return [
    {
      name: "cross-origin isolated",
      ok: globalThis.crossOriginIsolated === true,
      why: "host must send COOP: same-origin + COEP: require-corp headers",
    },
    {
      name: "SharedArrayBuffer",
      ok: typeof SharedArrayBuffer === "function",
      why: "capture ring shares memory between worklet and encoder worker",
    },
    {
      name: "AudioWorklet",
      ok: typeof AudioWorkletNode === "function",
      why: "capture runs on the audio rendering thread",
    },
  ];
}

/** Wraps a route that records or plays audio: renders it when the browser
 * context can actually run it, a clear explanation when it can't. */
export function CapabilityGate({ children }: { children: ReactNode }) {
  const capabilities = probe();
  if (capabilities.every((c) => c.ok)) return children;
  return (
    <main className="grid min-h-dvh place-items-center bg-void p-6">
      <div className="flex w-full max-w-sm flex-col items-center gap-5">
        <Wordmark />
        <Panel className="w-full p-4">
          <SectionLabel>Can’t run here</SectionLabel>
          <p className="mt-2 text-[12px] leading-relaxed text-text-body">
            Antiphon records lossless audio in the browser, which needs capabilities this page
            didn’t get. Most often the app was served without the{" "}
            <span className="font-mono text-[11px] text-text-mute">Cross-Origin-Opener-Policy</span>{" "}
            /{" "}
            <span className="font-mono text-[11px] text-text-mute">
              Cross-Origin-Embedder-Policy
            </span>{" "}
            headers that unlock SharedArrayBuffer.
          </p>
          <div className="mt-3 flex flex-col gap-1.5 border-t border-divider pt-3">
            {capabilities.map((c) => (
              <div key={c.name} className="flex flex-col gap-0.5">
                <MonoReadout
                  label={c.name}
                  value={
                    <span className={c.ok ? "text-ok" : "text-rec"}>{c.ok ? "ok" : "missing"}</span>
                  }
                />
                {!c.ok && (
                  <p className="pl-1 font-mono text-[9px] leading-relaxed text-text-faint">
                    {c.why}
                  </p>
                )}
              </div>
            ))}
          </div>
        </Panel>
        <p className="text-center text-[10px] leading-relaxed text-text-faint">
          Operators: serve the app with COOP/COEP response headers (the dev/preview servers and the
          deployment <span className="font-mono">_headers</span> config already do), then reload.
        </p>
      </div>
    </main>
  );
}
