// F7 — alignment UX honesty + reload persistence.
//
// (a) Outcome states: alignment on a chirpless take must NOT end silent —
//     it now AUTO-runs on take load (W4-B) and lands in a visible
//     "declined" state carrying the measured confidence (fake mics emit a
//     periodic tone: chirp correlation legitimately declines, and the
//     content fallback honestly declines too — a periodic signal matches
//     at every period, so no unique lag exists). The near-identical-clips
//     scenario that DOES content-align lives in content-align.spec.ts.
// (b) Persistence: the alignment verdict is take-derived state — it must
//     survive a desk reload (doc + localStorage shadow) and reapply at
//     schedule time WITHOUT re-decoding or re-correlating. Applied deltas
//     are asserted non-null post-reload through the page hook.

import { expect, type Page, test } from "@playwright/test";
import { expectTakeConverged, joinAsRecorder, startTake, stopTake } from "./helpers/session";

interface TrackAlignmentView {
  streamId: string;
  alignment: { lagSamples: number; confidence: number; applied: boolean } | null;
}

async function playerTracks(desk: Page): Promise<TrackAlignmentView[]> {
  return await desk.evaluate(() => {
    const hook = (
      globalThis as unknown as {
        __antiphonDesk?: {
          playerSnapshot(): { loadedTakeId: string | null; tracks: TrackAlignmentView[] } | null;
        };
      }
    ).__antiphonDesk;
    return hook?.playerSnapshot()?.tracks ?? [];
  });
}

async function loadedTakeId(desk: Page): Promise<string | null> {
  return await desk.evaluate(() => {
    const hook = (
      globalThis as unknown as {
        __antiphonDesk?: { playerSnapshot(): { loadedTakeId: string | null } | null };
      }
    ).__antiphonDesk;
    return hook?.playerSnapshot()?.loadedTakeId ?? null;
  });
}

/** The player's applied head-trim deltas (streamId → samples), via hook. */
async function alignDeltas(desk: Page): Promise<Array<[string, number]>> {
  return await desk.evaluate(() => {
    const hook = (
      globalThis as unknown as {
        __antiphonDesk?: { player: { alignDeltas(): Map<string, number> } };
      }
    ).__antiphonDesk;
    if (!hook) return [];
    return [...hook.player.alignDeltas().entries()];
  });
}

test.describe("alignment UX (F7)", () => {
  test.skip(({ browserName }) => browserName !== "chromium", "fake mic is Chromium-only");

  test("declined state is visible, survives reload; applied deltas restore", async ({
    browser,
  }) => {
    test.setTimeout(240_000);
    const sessionId = crypto.randomUUID();

    const deskContext = await browser.newContext();
    const desk = await deskContext.newPage();
    await desk.goto(`/session/${sessionId}`);
    await expect(desk.getByText("ANTIPHON", { exact: true })).toBeVisible();

    const phoneA = await (await browser.newContext()).newPage();
    const phoneB = await (await browser.newContext()).newPage();
    await joinAsRecorder(phoneA, sessionId);
    await joinAsRecorder(phoneB, sessionId);
    await expect(desk.getByText("2 phones connected")).toBeVisible({ timeout: 15_000 });

    // --- a chirpless take AUTO-aligns on load (W4-B): the periodic fake
    //     tone defeats chirp AND content correlation → honest DECLINED,
    //     with the measured confidence, no click required.
    const takeId = await startTake(desk);
    await desk.waitForTimeout(3_000);
    await stopTake(desk);
    await expectTakeConverged(desk, sessionId, takeId, 2);
    await expect.poll(() => loadedTakeId(desk), { timeout: 30_000 }).toBe(takeId);

    const alignButton = desk.getByRole("button", { name: "Auto-align" });
    await expect(alignButton).toHaveAttribute("data-align-state", "declined", {
      timeout: 60_000,
    });
    const outcome = desk.getByTestId("align-outcome");
    await expect(outcome).toBeVisible();
    // The readout carries the measured confidence and the accept bar it
    // failed: the chirp bar (2.5) or the stricter content bar (2.75),
    // whichever matches the best measurement's method.
    await expect(outcome).toContainText(/declined/i);
    await expect(outcome).toContainText(/confidence \d+(\.\d+)? < 2\.(5|75)/);
    // Every loaded track carries a measured (non-null, unapplied) verdict.
    const measured = await playerTracks(desk);
    expect(measured).toHaveLength(2);
    for (const t of measured) {
      expect(t.alignment).not.toBeNull();
      expect(t.alignment?.applied).toBe(false);
    }

    // --- reload: the DECLINED verdict must survive without re-running ----
    await desk.reload();
    await expect(desk.getByText("ANTIPHON", { exact: true })).toBeVisible();
    await expect.poll(() => loadedTakeId(desk), { timeout: 40_000 }).toBe(takeId);
    await expect(desk.getByRole("button", { name: "Auto-align" })).toHaveAttribute(
      "data-align-state",
      "declined",
      { timeout: 20_000 },
    );
    await expect(desk.getByTestId("align-outcome")).toContainText(/declined/i);

    // --- applied alignment persists and restores with non-null deltas ----
    // Fake mics can never yield a confident chirp hit, so a confident
    // verdict is applied through the diagnostics hook — the same restore
    // path a second desk's doc update takes — then must survive a reload.
    const streamIds = measured.map((t) => t.streamId).sort();
    await desk.evaluate(
      ([tid, s1, s2]) => {
        const hook = (
          globalThis as unknown as {
            __antiphonDesk?: {
              applyAlignment(
                takeId: string,
                entries: Record<
                  string,
                  {
                    alignment: { lagSamples: number; confidence: number; applied: boolean };
                    drift: null;
                  }
                >,
              ): void;
            };
          }
        ).__antiphonDesk;
        hook?.applyAlignment(tid as string, {
          [s1 as string]: {
            alignment: { lagSamples: 0, confidence: 5, applied: true },
            drift: null,
          },
          [s2 as string]: {
            alignment: { lagSamples: 4_800, confidence: 5, applied: true },
            drift: null,
          },
        });
      },
      [takeId, streamIds[0] as string, streamIds[1] as string],
    );
    await expect(desk.getByRole("button", { name: "Auto-align" })).toHaveAttribute(
      "data-align-state",
      "aligned",
      { timeout: 15_000 },
    );
    await expect(desk.getByTestId("align-outcome")).toContainText(/2 tracks aligned/i);

    await desk.reload();
    await expect(desk.getByText("ANTIPHON", { exact: true })).toBeVisible();
    await expect.poll(() => loadedTakeId(desk), { timeout: 40_000 }).toBe(takeId);
    await expect(desk.getByRole("button", { name: "Auto-align" })).toHaveAttribute(
      "data-align-state",
      "aligned",
      { timeout: 20_000 },
    );
    // THE assertion: reapplied alignment is live in the schedule math —
    // non-null head-trim deltas, exactly the persisted 4800-sample spread.
    await expect
      .poll(async () => {
        const deltas = await alignDeltas(desk);
        if (deltas.length !== 2) return `deltas=${deltas.length}`;
        const spread = Math.max(...deltas.map(([, d]) => d));
        return `deltas=2 spread=${spread}`;
      })
      .toBe("deltas=2 spread=4800");

    await phoneA.close();
    await phoneB.close();
    await desk.close();
    await deskContext.close();
  });
});
