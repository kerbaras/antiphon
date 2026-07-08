// Per-worktree e2e port derivation.
//
// Several git worktrees of this repo run the suite concurrently. With the
// old fixed ports (4173/8787) plus `reuseExistingServer`, a run would adopt
// whichever worktree's servers happened to be listening — and silently test
// the OTHER worktree's build. Each worktree therefore gets a stable
// (web, server) port pair derived from its own path: deterministic per
// worktree (so reuseExistingServer still works WITHIN a worktree), disjoint
// across worktrees.
//
// Precedence: ANTIPHON_E2E_WEB_PORT / ANTIPHON_E2E_SERVER_PORT env overrides
// → fixed CI defaults (4173/8787, for cacheability + debuggability) →
// path-derived pair.

import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_WEB_PORT = 4173;
const DEFAULT_SERVER_PORT = 8787;

function envPort(name: string): number | null {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return null;
  const port = Number.parseInt(raw, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${name} must be a valid port, got ${JSON.stringify(raw)}`);
  }
  return port;
}

// Keyed on the worktree root (this file's location), NOT process.cwd(): the
// pair must come out identical no matter which directory playwright is
// launched from, or reuse-within-a-worktree breaks.
const worktreeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// sha256(worktree root) → an even web port in [20000, 29998]; the server
// rides on web+1. The 2xxxx range stays clear of the fixed CI defaults, of
// Postgres (5433), and of the OS ephemeral range (Linux 32768+, macOS
// 49152+) that helpers/dedicated-server.ts freePort() (listen on 0) draws
// from — a dedicated server can never collide with any worktree's pair.
function derivedWebPort(): number {
  const digest = createHash("sha256").update(worktreeRoot).digest();
  return 20000 + (digest.readUInt32BE(0) % 5000) * 2;
}

export const WEB_PORT: number =
  envPort("ANTIPHON_E2E_WEB_PORT") ?? (process.env.CI ? DEFAULT_WEB_PORT : derivedWebPort());

export const SERVER_PORT: number =
  envPort("ANTIPHON_E2E_SERVER_PORT") ??
  (process.env.CI ? DEFAULT_SERVER_PORT : derivedWebPort() + 1);
