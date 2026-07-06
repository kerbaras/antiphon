// Milestone 1 — the killer demo, automated (architecture §11).
//
// Two recorders stream FLAC chunks to two sinks (desk over P2P, server over
// its always-on leg) through real WebRTC. The desk chirps. One recorder's
// network dies mid-take for 5 seconds — capture never stops — then
// reconnects and backfills. When the take ends, every sink must hold an
// IDENTICAL, COMPLETE chunk set for every stream, verified by comparing the
// desk's OPFS digest with the server archive's digest, chunk for chunk.
//
// If this test passes, the DAW is the easy 80%.

import { expect, type Page, test } from "@playwright/test";

interface DeskStreamStatus {
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

interface ServerStreamStatus {
  streamId: string;
  chunkCount: number;
  holes: Array<[number, number]>;
  gaps: Array<[number, number]>;
  finalSeq: number | null;
  complete: boolean;
  flagged: boolean;
  digest: string;
}

async function deskStatus(desk: Page): Promise<DeskStreamStatus[]> {
  return await desk.evaluate(() => {
    const hook = (
      globalThis as unknown as {
        __antiphonDesk?: { snapshot(): { deskStatus: DeskStreamStatus[] } | null };
      }
    ).__antiphonDesk;
    return hook?.snapshot()?.deskStatus ?? [];
  });
}

async function recorderSamples(page: Page): Promise<number> {
  return await page.evaluate(() => {
    const hook = (
      globalThis as unknown as {
        __antiphon?: { snapshot(): { stats: { samplesIn: number } | null } | null };
      }
    ).__antiphon;
    return hook?.snapshot()?.stats?.samplesIn ?? 0;
  });
}

async function joinAsRecorder(page: Page, sessionId: string): Promise<void> {
  await page.goto(`/join/${sessionId}`);
  await page.getByRole("button", { name: /enable microphone/i }).click();
  await expect(page.getByText("server sink")).toBeVisible();
  await expect
    .poll(
      async () =>
        await page.evaluate(() => {
          const hook = (
            globalThis as unknown as {
              __antiphon?: { sessionState(): { serverLink: string } | null };
            }
          ).__antiphon;
          return hook?.sessionState()?.serverLink ?? "down";
        }),
      { timeout: 20_000 },
    )
    .toBe("connected");
}

test.describe("Milestone 1", () => {
  test.skip(({ browserName }) => browserName !== "chromium", "fake mic is Chromium-only");

  test("two recorders, chirp, mid-take network kill, backfill, convergence", async ({
    browser,
  }) => {
    test.setTimeout(180_000);
    const sessionId = crypto.randomUUID();

    // --- the desk and two phones come up -------------------------------
    const deskCtx = await browser.newContext();
    const desk = await deskCtx.newPage();
    await desk.goto(`/session/${sessionId}`);
    await expect(desk.getByText("ANTIPHON", { exact: true })).toBeVisible();

    const phoneA = await (await browser.newContext()).newPage();
    const phoneB = await (await browser.newContext()).newPage();
    await joinAsRecorder(phoneA, sessionId);
    await joinAsRecorder(phoneB, sessionId);
    await expect(desk.getByText("2 phones connected")).toBeVisible({ timeout: 15_000 });

    // --- take starts; both phones arm and stream -------------------------
    await desk.getByRole("button", { name: "Record take" }).click();
    await expect(phoneA.getByText("recording", { exact: true })).toBeVisible({
      timeout: 15_000,
    });
    await expect(phoneB.getByText("recording", { exact: true })).toBeVisible({
      timeout: 15_000,
    });

    // --- chirp calibration (§10: only while streams are armed) -----------
    await desk.getByRole("button", { name: "Chirp" }).click();
    await expect(desk.getByText(/chirp emitted/i)).toBeVisible();
    await desk.waitForTimeout(3_000);

    // --- kill phone B's network mid-take ---------------------------------
    const samplesBefore = await recorderSamples(phoneB);
    await phoneB.getByRole("button", { name: /simulate 5s dropout/i }).click();
    await expect(phoneB.getByText(/network outage simulated/i)).toBeVisible();
    await phoneB.waitForTimeout(3_000);
    // Capture NEVER gates on the network (§7.1): samples keep flowing
    // while the transport is dead.
    const samplesDuring = await recorderSamples(phoneB);
    expect(samplesDuring).toBeGreaterThan(samplesBefore + 48_000);

    // Let the outage end, reconnect, and stream a while longer.
    await phoneB.waitForTimeout(4_000);
    await desk.waitForTimeout(4_000);

    // --- stop the take -----------------------------------------------------
    await desk.getByRole("button", { name: "Stop take" }).click();

    // --- convergence: every sink, identical, complete ---------------------
    await expect
      .poll(
        async () => {
          const streams = await deskStatus(desk);
          if (streams.length !== 2) return `streams=${streams.length}`;
          if (!streams.every((s) => s.complete && s.finalSeq !== null)) {
            return `desk incomplete: ${streams
              .map((s) => `${s.streamId.slice(0, 8)} chwm=${s.chwm} final=${s.finalSeq}`)
              .join(" | ")}`;
          }
          return "complete";
        },
        { timeout: 60_000, intervals: [1_000] },
      )
      .toBe("complete");

    const streams = await deskStatus(desk);
    const takeId = streams[0]?.takeId as string;
    const res = await desk.request.get(`/api/sessions/${sessionId}/takes/${takeId}`);
    expect(res.ok()).toBe(true);
    const server = (await res.json()) as { streams: ServerStreamStatus[] };
    expect(server.streams).toHaveLength(2);

    for (const deskStream of streams) {
      const serverStream = server.streams.find((s) => s.streamId === deskStream.streamId);
      expect(serverStream, `server holds stream ${deskStream.streamId}`).toBeDefined();
      if (!serverStream) continue;
      // Complete at both sinks: seq 0..=final, no holes, no gaps, no flags.
      expect(deskStream.complete).toBe(true);
      expect(serverStream.complete).toBe(true);
      expect(deskStream.holes).toEqual([]);
      expect(serverStream.holes).toEqual([]);
      expect(deskStream.gaps).toEqual([]);
      expect(serverStream.gaps).toEqual([]);
      expect(deskStream.flagged).toBe(false);
      expect(serverStream.flagged).toBe(false);
      expect(deskStream.heldCount).toBe((deskStream.finalSeq as number) + 1);
      expect(serverStream.chunkCount).toBe((serverStream.finalSeq as number) + 1);
      // THE assertion: byte-identical chunk sets at both sinks.
      expect(deskStream.digest, `digest for ${deskStream.streamId}`).toBe(serverStream.digest);
    }

    // The archive serves complete, structurally valid FLAC for both streams.
    for (const stream of streams) {
      const flacRes = await desk.request.get(`/api/streams/${stream.streamId}/flac`);
      expect(flacRes.status()).toBe(200);
      const bytes = await flacRes.body();
      expect(bytes.subarray(0, 4).toString("latin1")).toBe("fLaC");
      expect(bytes[42]).toBe(0xff);
      expect(bytes.length).toBeGreaterThan(10_000);
    }

    // The desk UI reports convergence to the operator (clips upgrade to
    // "⇥ aligned" when chirp correlation succeeds — fake mics won't have
    // heard the speaker chirp, real rooms will).
    await expect(desk.getByText(/⇥ (converged|aligned)/).first()).toBeVisible({
      timeout: 15_000,
    });

    await phoneA.close();
    await phoneB.close();
    await desk.close();
  });
});
