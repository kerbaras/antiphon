// Shared drivers/assertions for session-level e2e journeys, extracted from
// the M1 demo spec (house style: fake mics, poll-based convergence, sha256
// chunk-set digests compared across sinks — never fixed sleeps for state).

import { expect, type Page } from "@playwright/test";

// ---- status shapes (mirror apps/web sink-worker-protocol + server archive) --

export interface DeskStreamStatus {
  takeId: string;
  streamId: string;
  chwm: number | null;
  heldCount: number;
  holes: Array<[number, number]>;
  gaps: Array<[number, number]>;
  finalSeq: number | null;
  complete: boolean;
  settled: boolean;
  flagged: boolean;
  digest: string;
}

export interface ServerStreamStatus {
  streamId: string;
  takeId: string;
  peerId: string | null;
  chunkCount: number;
  chwm: number | null;
  holes: Array<[number, number]>;
  gaps: Array<[number, number]>;
  finalSeq: number | null;
  complete: boolean;
  settled: boolean;
  flagged: boolean;
  digest: string;
}

/** Subset of DeskSessionState the specs read through the page hook. */
export interface DeskStateSnapshot {
  signalingConnected: boolean;
  peerId: string | null;
  activeTakeId: string | null;
  serverSync: "connected" | "connecting" | "down";
  streams: Array<{ takeId: string; streamId: string; peerId: string | null }>;
  deskStatus: DeskStreamStatus[];
  rebuiltChunks: number;
  errors: string[];
  /** Terminal control-plane halt (F3): superseded / session-deleted / caps. */
  fatal: { code: string; message: string } | null;
  session: {
    peers: Array<{
      peerId: string;
      role: "desk" | "recorder";
      deviceInfo: { userAgent: string; label?: string };
    }>;
  } | null;
}

/** Subset of RecorderSessionState the specs read through the page hook. */
export interface RecorderStateSnapshot {
  signalingConnected: boolean;
  peerId: string | null;
  serverLink: "connected" | "connecting" | "down";
  deskLink: "connected" | "connecting" | "down" | "absent";
  activeTakeId: string | null;
  streamId: string | null;
  /** Terminal control-plane halt (F3): superseded / session-deleted / caps. */
  fatal: { code: string; message: string } | null;
}

// ---- page hook readers -------------------------------------------------------

export async function deskState(desk: Page): Promise<DeskStateSnapshot | null> {
  return await desk.evaluate(() => {
    const hook = (
      globalThis as unknown as {
        __antiphonDesk?: { snapshot(): DeskStateSnapshot | null };
      }
    ).__antiphonDesk;
    return hook?.snapshot() ?? null;
  });
}

export async function deskStatus(desk: Page): Promise<DeskStreamStatus[]> {
  return await desk.evaluate(() => {
    const hook = (
      globalThis as unknown as {
        __antiphonDesk?: { snapshot(): { deskStatus: DeskStreamStatus[] } | null };
      }
    ).__antiphonDesk;
    return hook?.snapshot()?.deskStatus ?? [];
  });
}

export async function recorderState(page: Page): Promise<RecorderStateSnapshot | null> {
  return await page.evaluate(() => {
    const hook = (
      globalThis as unknown as {
        __antiphon?: { sessionState(): RecorderStateSnapshot | null };
      }
    ).__antiphon;
    return hook?.sessionState() ?? null;
  });
}

export async function recorderSamples(page: Page): Promise<number> {
  return await page.evaluate(() => {
    const hook = (
      globalThis as unknown as {
        __antiphon?: { snapshot(): { stats: { samplesIn: number } | null } | null };
      }
    ).__antiphon;
    return hook?.snapshot()?.stats?.samplesIn ?? 0;
  });
}

// ---- journey drivers -----------------------------------------------------------

/** Enable the (fake) mic on an already-loaded /join page and wait for the
 * always-on server leg to come up. */
export async function enableMicAndWait(page: Page): Promise<void> {
  await page.getByRole("button", { name: /enable microphone/i }).click();
  await expect(page.getByText("server sink")).toBeVisible();
  await expect
    .poll(async () => (await recorderState(page))?.serverLink ?? "down", { timeout: 20_000 })
    .toBe("connected");
}

export async function joinAsRecorder(page: Page, sessionId: string, origin = ""): Promise<void> {
  await page.goto(`${origin}/join/${sessionId}`);
  await enableMicAndWait(page);
}

/** Start a take from the desk transport and return its takeId. */
export async function startTake(desk: Page): Promise<string> {
  await desk.getByRole("button", { name: "Record take" }).click();
  await expect
    .poll(async () => (await deskState(desk))?.activeTakeId ?? null, { timeout: 15_000 })
    .not.toBeNull();
  return (await deskState(desk))?.activeTakeId as string;
}

export async function stopTake(desk: Page): Promise<void> {
  await desk.getByRole("button", { name: "Stop take" }).click();
}

/** Rename a peer from the desk (A13: the desk is the session authority)
 * and wait for the roster echo to land back in the desk snapshot. */
export async function renamePeerFromDesk(desk: Page, peerId: string, label: string): Promise<void> {
  await desk.evaluate(
    (args) => {
      const hook = (
        globalThis as unknown as {
          __antiphonDesk?: { session: { renamePeer(peerId: string, label: string): void } };
        }
      ).__antiphonDesk;
      hook?.session.renamePeer(args.peerId, args.label);
    },
    { peerId, label },
  );
  await expect
    .poll(
      async () =>
        ((await deskState(desk))?.session?.peers ?? []).find((p) => p.peerId === peerId)?.deviceInfo
          .label ?? null,
      { timeout: 15_000 },
    )
    .toBe(label);
}

// ---- server archive readers ----------------------------------------------------

export async function serverTakeStreams(
  page: Page,
  sessionId: string,
  takeId: string,
  origin = "",
): Promise<ServerStreamStatus[]> {
  const res = await page.request.get(`${origin}/api/sessions/${sessionId}/takes/${takeId}`);
  if (res.status() === 404) return []; // unknown-or-foreign take (session-scoped route)
  expect(res.ok()).toBe(true);
  const body = (await res.json()) as { streams: ServerStreamStatus[] };
  return body.streams;
}

export async function serverSessionTakeIds(
  page: Page,
  sessionId: string,
  origin = "",
): Promise<string[]> {
  const res = await page.request.get(`${origin}/api/sessions/${sessionId}`);
  expect(res.ok()).toBe(true);
  const body = (await res.json()) as { takes: Array<{ id: string }> };
  return body.takes.map((t) => t.id);
}

// ---- convergence assertions ------------------------------------------------------

export interface ConvergedTake {
  deskStreams: DeskStreamStatus[];
  serverStreams: ServerStreamStatus[];
}

/** THE assertion (M1 house style): every sink holds an identical, complete
 * chunk set for every expected stream of the take — seq 0..=final, zero
 * holes, zero gaps, zero flags, byte-identical digests. Polls both sinks
 * with a generous deadline, then hard-asserts the invariants. */
export async function expectTakeConverged(
  desk: Page,
  sessionId: string,
  takeId: string,
  expectedStreams: number,
  opts: { onlyStreamIds?: string[]; timeoutMs?: number; origin?: string } = {},
): Promise<ConvergedTake> {
  const origin = opts.origin ?? "";
  const pick = <T extends { streamId: string; takeId: string }>(streams: T[]): T[] =>
    streams.filter(
      (s) =>
        s.takeId === takeId &&
        (opts.onlyStreamIds === undefined || opts.onlyStreamIds.includes(s.streamId)),
    );

  await expect
    .poll(
      async () => {
        const ds = pick(await deskStatus(desk));
        if (ds.length !== expectedStreams) return `desk streams=${ds.length}`;
        const deskIncomplete = ds.filter((s) => !s.complete || s.finalSeq === null);
        if (deskIncomplete.length > 0) {
          return `desk incomplete: ${deskIncomplete
            .map((s) => `${s.streamId.slice(0, 8)} chwm=${s.chwm} final=${s.finalSeq}`)
            .join(" | ")}`;
        }
        const ss = pick(await serverTakeStreams(desk, sessionId, takeId, origin));
        if (ss.length !== expectedStreams) return `server streams=${ss.length}`;
        const serverIncomplete = ss.filter((s) => !s.complete);
        if (serverIncomplete.length > 0) {
          return `server incomplete: ${serverIncomplete
            .map((s) => `${s.streamId.slice(0, 8)} held=${s.chunkCount} final=${s.finalSeq}`)
            .join(" | ")}`;
        }
        for (const d of ds) {
          const s = ss.find((x) => x.streamId === d.streamId);
          if (!s) return `server missing ${d.streamId.slice(0, 8)}`;
          if (s.digest !== d.digest) return `digest mismatch ${d.streamId.slice(0, 8)}`;
        }
        return "converged";
      },
      { timeout: opts.timeoutMs ?? 60_000, intervals: [1_000] },
    )
    .toBe("converged");

  const deskStreams = pick(await deskStatus(desk));
  const serverStreams = pick(await serverTakeStreams(desk, sessionId, takeId, origin));
  for (const d of deskStreams) {
    const s = serverStreams.find((x) => x.streamId === d.streamId);
    expect(s, `server holds stream ${d.streamId}`).toBeDefined();
    if (!s) continue;
    expect(d.complete).toBe(true);
    expect(s.complete).toBe(true);
    expect(d.holes).toEqual([]);
    expect(s.holes).toEqual([]);
    expect(d.gaps).toEqual([]);
    expect(s.gaps).toEqual([]);
    expect(d.flagged).toBe(false);
    expect(s.flagged).toBe(false);
    expect(d.heldCount).toBe((d.finalSeq as number) + 1);
    expect(s.chunkCount).toBe((s.finalSeq as number) + 1);
    expect(d.digest, `digest for ${d.streamId}`).toBe(s.digest);
  }
  return { deskStreams, serverStreams };
}

/** The archive serves complete, structurally valid FLAC for a stream:
 * fLaC magic, frame sync right after the 42-byte bootstrap, plausible size. */
export async function expectValidFlac(
  page: Page,
  streamId: string,
  opts: { partial?: boolean; minBytes?: number; origin?: string } = {},
): Promise<void> {
  const res = await page.request.get(
    `${opts.origin ?? ""}/api/streams/${streamId}/flac${opts.partial ? "?partial=1" : ""}`,
  );
  expect(res.status()).toBe(200);
  const bytes = await res.body();
  expect(bytes.subarray(0, 4).toString("latin1")).toBe("fLaC");
  expect(bytes[42]).toBe(0xff);
  expect(bytes.length).toBeGreaterThan(opts.minBytes ?? 1_000);
}
