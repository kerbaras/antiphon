// Test-owned Antiphon server + same-origin proxy, for journeys that must
// kill/restart the server process mid-take. The suite's shared server is
// owned by the playwright webServer config and cannot be restarted without
// breaking parallel tests, so these specs spawn their own instance (own
// PORT + BLOB_FS_ROOT, same Postgres) and put a tiny reverse proxy in
// front: the web app is strictly same-origin (vite preview proxies /api
// and the WS endpoints to the suite's server port), so pages get a
// dedicated origin whose /api + signaling routes hit the dedicated server
// while everything else is served by the shared vite preview.

import { type ChildProcess, spawn } from "node:child_process";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

export const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://antiphon:antiphon@localhost:5433/antiphon";

/** Paths the vite preview proxies to the server (vite.config.ts), plus
 * /health for liveness probes. Everything else is the web app. */
const SERVER_PATHS = /^\/(?:api(?:\/|$)|health$)|^\/(?:session|join)\/[^/]+\/ws$/;

/** OS-assigned ephemeral port (listen on 0). Ephemeral ranges start at
 * 32768 (Linux) / 49152 (macOS), so these can never collide with the
 * worktree-derived 20000-29999 pairs in e2e/ports.ts or the fixed CI
 * defaults. */
export async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const address = srv.address();
      if (address === null || typeof address === "string") {
        reject(new Error("no port assigned"));
        return;
      }
      srv.close(() => resolve(address.port));
    });
  });
}

export interface ServerProcess {
  child: ChildProcess;
  /** SIGKILL — a crash, not a shutdown — and wait for process exit. */
  kill(): Promise<void>;
}

/** Spawn `node src/index.ts` in apps/server (the same entrypoint the
 * playwright webServer uses) and wait until /health answers. */
export async function startDedicatedServer(opts: {
  port: number;
  blobRoot: string;
}): Promise<ServerProcess> {
  const child = spawn(process.execPath, ["src/index.ts"], {
    cwd: path.join(repoRoot, "apps", "server"),
    env: {
      ...process.env,
      DATABASE_URL,
      PORT: String(opts.port),
      BLOB_DRIVER: "fs",
      BLOB_FS_ROOT: opts.blobRoot,
      // Single-IP test traffic + post-kill reconnect storms: production
      // per-IP join limits would starve the clients (see playwright.config).
      JOIN_RATE_PER_MIN: "6000",
      JOIN_RATE_BURST: "1000",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const logs: string[] = [];
  child.stdout?.on("data", (d: Buffer) => logs.push(d.toString()));
  child.stderr?.on("data", (d: Buffer) => logs.push(d.toString()));

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`dedicated server exited early (${child.exitCode}): ${logs.join("")}`);
    }
    try {
      const res = await fetch(`http://127.0.0.1:${opts.port}/health`);
      if (res.ok) break;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  if (Date.now() >= deadline) {
    child.kill("SIGKILL");
    throw new Error(`dedicated server never became healthy: ${logs.join("")}`);
  }

  return {
    child,
    kill: () =>
      new Promise<void>((resolve) => {
        if (child.exitCode !== null) {
          resolve();
          return;
        }
        child.once("exit", () => resolve());
        child.kill("SIGKILL");
      }),
  };
}

export interface SameOriginProxy {
  origin: string;
  close(): Promise<void>;
}

/** vite preview may bind ::1 only while the api server binds IPv4; probe
 * which loopback family actually answers on a port. */
async function detectLoopbackHost(port: number): Promise<string> {
  for (const host of ["127.0.0.1", "::1"]) {
    const reachable = await new Promise<boolean>((resolve) => {
      const probe = net.connect({ host, port });
      probe.once("connect", () => {
        probe.destroy();
        resolve(true);
      });
      probe.once("error", () => resolve(false));
    });
    if (reachable) return host;
  }
  return "127.0.0.1";
}

/** HTTP + WebSocket reverse proxy: server paths → apiPort, everything else
 * → the shared vite preview (webPort). While the dedicated server is dead,
 * server-path requests fail fast (502 / socket close) exactly like a
 * crashed backend, and the clients' reconnect machinery takes over. */
export async function startSameOriginProxy(
  webPort: number,
  apiPort: number,
): Promise<SameOriginProxy> {
  const webHost = await detectLoopbackHost(webPort);
  const apiHost = await detectLoopbackHost(apiPort);
  const targetFor = (url: string): { host: string; port: number } =>
    SERVER_PATHS.test(url) ? { host: apiHost, port: apiPort } : { host: webHost, port: webPort };

  const server = http.createServer((req, res) => {
    const upstream = http.request(
      {
        ...targetFor(req.url ?? "/"),
        path: req.url,
        method: req.method,
        headers: req.headers,
      },
      (ures) => {
        res.writeHead(ures.statusCode ?? 502, ures.headers);
        ures.pipe(res);
      },
    );
    upstream.on("error", () => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    req.pipe(upstream);
  });

  server.on("upgrade", (req, socket, head) => {
    const upstream = net.connect(targetFor(req.url ?? "/"), () => {
      const headerLines = Object.entries(req.headers).flatMap(([name, value]) =>
        Array.isArray(value)
          ? value.map((v) => `${name}: ${v}`)
          : value === undefined
            ? []
            : [`${name}: ${value}`],
      );
      upstream.write(`${req.method} ${req.url} HTTP/1.1\r\n${headerLines.join("\r\n")}\r\n\r\n`);
      if (head.length > 0) upstream.write(head);
      socket.pipe(upstream);
      upstream.pipe(socket);
    });
    const teardown = () => {
      socket.destroy();
      upstream.destroy();
    };
    upstream.on("error", teardown);
    socket.on("error", teardown);
    upstream.on("close", () => socket.destroy());
    socket.on("close", () => upstream.destroy());
  });

  const port = await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("no proxy port assigned"));
        return;
      }
      resolve(address.port);
    });
  });

  return {
    origin: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
