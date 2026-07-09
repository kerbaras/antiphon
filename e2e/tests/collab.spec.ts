// W3-A — multi-desk collaboration over the shared Yjs project doc.
//
// Two desks and one phone share a session. Desk A records a short take to
// convergence; desk B (no P2P leg — it converges through the server's
// HAVE-diff replication) sees the same take. A moves a fader, drags the
// clip, drops a marker and writes a comment → B reflects all of it live
// through /session/:uuid/collab. B renames the marker → A reflects.
// Presence: B's avatar and ghost playhead appear on A. Reloading A rebuilds
// every piece of shared state from the server-persisted doc.
//
// Transport authority is deliberately NOT arbitrated here (documented W3-A
// boundary): record/stop stay on the signaling protocol, last write wins,
// A14 unchanged — the room-epoch arbitration is the v2 follow-up.

import { expect, type Page, test } from "@playwright/test";
import {
  deskState,
  deskStatus,
  expectTakeConverged,
  joinAsRecorder,
  renamePeerFromDesk,
  startTake,
  stopTake,
} from "./helpers/session";

// ---- desk hook readers -------------------------------------------------------

interface UiMarker {
  id: string;
  name: string;
  atSec: number;
}

interface UiComment {
  id: string;
  text: string;
  author: string;
}

interface UiMirror {
  markers: UiMarker[];
  comments: UiComment[];
  clipStarts: Record<string, number>;
}

async function ui(desk: Page): Promise<UiMirror> {
  return await desk.evaluate(() => {
    const hook = (globalThis as unknown as { __antiphonDesk?: { ui(): UiMirror | null } })
      .__antiphonDesk;
    return hook?.ui() ?? { markers: [], comments: [], clipStarts: {} };
  });
}

async function channelGainDb(desk: Page, key: string): Promise<number | null> {
  return await desk.evaluate((channelKey) => {
    const hook = (
      globalThis as unknown as {
        __antiphonDesk?: {
          playerSnapshot(): { channels: Array<{ key: string; gainDb: number }> } | null;
        };
      }
    ).__antiphonDesk;
    const strip = hook?.playerSnapshot()?.channels.find((c) => c.key === channelKey);
    return strip ? strip.gainDb : null;
  }, key);
}

/** The loaded track for a stream: which mixer lane it plays through and
 * the gain that lane actually applies to it — the honest end of the
 * peerId-keyed mixer-sync wire (F1's previously-phantom path). */
async function trackLane(
  desk: Page,
  streamId: string,
): Promise<{ channelKey: string; gainDb: number } | null> {
  return await desk.evaluate((id) => {
    const hook = (
      globalThis as unknown as {
        __antiphonDesk?: {
          playerSnapshot(): {
            tracks: Array<{ streamId: string; channelKey: string; gainDb: number }>;
          } | null;
        };
      }
    ).__antiphonDesk;
    const track = hook?.playerSnapshot()?.tracks.find((t) => t.streamId === id);
    return track ? { channelKey: track.channelKey, gainDb: track.gainDb } : null;
  }, streamId);
}

/** Wait until the take is decoded into the player (shared-state UI unlocks). */
async function expectTakeLoaded(desk: Page, takeId: string, tracks: number): Promise<void> {
  await expect
    .poll(
      async () => {
        return await desk.evaluate(() => {
          const hook = (
            globalThis as unknown as {
              __antiphonDesk?: {
                playerSnapshot(): { loadedTakeId: string | null; tracks: unknown[] } | null;
              };
            }
          ).__antiphonDesk;
          const snap = hook?.playerSnapshot();
          return `take=${snap?.loadedTakeId ?? null} tracks=${snap?.tracks.length ?? 0}`;
        });
      },
      { timeout: 60_000 },
    )
    .toBe(`take=${takeId} tracks=${tracks}`);
}

const PX_PER_SEC = 24; // default zoom

test.describe("multi-desk collaboration (W3-A)", () => {
  test.skip(({ browserName }) => browserName !== "chromium", "fake mic is Chromium-only");

  test("two desks co-edit mix, markers, comments, arrangement; presence + doc persistence", async ({
    browser,
  }) => {
    test.setTimeout(180_000);
    const sessionId = crypto.randomUUID();

    const deskA = await (await browser.newContext()).newPage();
    await deskA.goto(`/session/${sessionId}`);
    await expect(deskA.getByText("ANTIPHON", { exact: true })).toBeVisible();

    // Desk B is a second operator with a name (presence carries it).
    const contextB = await browser.newContext();
    await contextB.addInitScript(() => {
      localStorage.setItem("antiphon:comment-author", "Bea");
    });
    const deskB = await contextB.newPage();
    await deskB.goto(`/session/${sessionId}`);
    await expect(deskB.getByText("ANTIPHON", { exact: true })).toBeVisible();

    const phone = await (await browser.newContext()).newPage();
    await joinAsRecorder(phone, sessionId);
    await expect(deskA.getByText("1 phone connected")).toBeVisible({ timeout: 15_000 });

    // --- desk A records a short take to convergence -------------------------
    const takeId = await startTake(deskA);
    await deskA.waitForTimeout(3_500);
    await stopTake(deskA);
    await expectTakeConverged(deskA, sessionId, takeId, 1);
    await expectTakeLoaded(deskA, takeId, 1);
    const streamId = (await deskStatus(deskA)).find((s) => s.takeId === takeId)?.streamId as string;
    const laneKey = (await deskState(deskA))?.streams.find((s) => s.streamId === streamId)
      ?.peerId as string;

    // --- desk B sees the take (server HAVE-diff replication, no P2P leg) ----
    await expect
      .poll(
        async () =>
          (await deskStatus(deskB)).find((s) => s.streamId === streamId)?.complete ?? false,
        { timeout: 60_000, intervals: [1_000] },
      )
      .toBe(true);
    await expectTakeLoaded(deskB, takeId, 1);

    // --- A edits: fader, clip drag, marker, comment --------------------------
    // Fader through the player (the audio authority); collab diffs it into
    // the shared doc.
    await deskA.evaluate((key) => {
      (
        globalThis as unknown as {
          __antiphonDesk: { player: { setChannelDb(k: string, db: number): void } };
        }
      ).__antiphonDesk.player.setChannelDb(key, -6);
    }, laneKey);

    // Clip drag: +4 s on the arrangement (96 px at default zoom).
    const clip = deskA.locator(`[data-clip="${streamId}"]`);
    const box = (await clip.boundingBox()) as {
      x: number;
      y: number;
      width: number;
      height: number;
    };
    await deskA.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await deskA.mouse.down();
    await deskA.mouse.move(box.x + box.width / 2 + 4 * PX_PER_SEC, box.y + box.height / 2, {
      steps: 8,
    });
    await deskA.mouse.up();
    const draggedTo = (await ui(deskA)).clipStarts[streamId] as number;
    expect(draggedTo).toBeGreaterThan(4);

    // Marker at the playhead.
    const addMarker = deskA.getByRole("button", { name: "Add marker at playhead" });
    await expect(addMarker).toBeEnabled({ timeout: 15_000 });
    await addMarker.click();
    await expect(deskA.getByRole("button", { name: "Marker Song 1", exact: true })).toBeVisible();

    // A comment through the composer (N — the Split tool owns C, W7-B).
    await deskA.keyboard.press("n");
    const composer = deskA.getByLabel("Comment text");
    await expect(composer).toBeFocused();
    await composer.fill("alto flat in the second phrase");
    await composer.press("Enter");
    await expect(deskA.locator("[data-comment]")).toHaveCount(1);

    // --- B reflects all four (live doc sync) ---------------------------------
    await expect
      .poll(async () => (await ui(deskB)).markers.map((m) => m.name).join(","), {
        timeout: 15_000,
      })
      .toBe("Song 1");
    await expect
      .poll(async () => (await ui(deskB)).comments.map((c) => c.text).join(","), {
        timeout: 15_000,
      })
      .toBe("alto flat in the second phrase");
    await expect.poll(async () => channelGainDb(deskB, laneKey), { timeout: 15_000 }).toBe(-6);
    await expect
      .poll(async () => Math.abs(((await ui(deskB)).clipStarts[streamId] ?? 0) - draggedTo), {
        timeout: 15_000,
      })
      .toBeLessThan(0.01);
    // B's timeline actually drew the moved clip where A put it.
    await expect(deskB.locator(`[data-clip="${streamId}"]`)).toBeVisible();

    // --- B renames the marker → A reflects -----------------------------------
    await deskB.getByRole("button", { name: /^songs/i }).click();
    await deskB.getByRole("button", { name: "Song 1", exact: true }).dblclick();
    await deskB.getByRole("textbox", { name: "Rename song" }).fill("Kyrie");
    await deskB.keyboard.press("Enter");
    await expect
      .poll(async () => (await ui(deskA)).markers.map((m) => m.name).join(","), {
        timeout: 15_000,
      })
      .toBe("Kyrie");

    // --- presence: B is visible on A ------------------------------------------
    await expect(deskA.locator('[title="Bea (Desk)"]')).toBeVisible({ timeout: 15_000 });
    // B has the take loaded → its ghost playhead hairline rides A's timeline.
    await expect(deskA.locator("[data-ghost-playhead]").first()).toBeVisible({
      timeout: 15_000,
    });
    await expect(deskA.getByText("Bea", { exact: true })).toBeVisible();

    // --- reload A: every piece of shared state comes back from the doc -------
    await deskA.reload();
    await expect(deskA.getByText("ANTIPHON", { exact: true })).toBeVisible();
    await expectTakeLoaded(deskA, takeId, 1);
    await expect(deskA.getByRole("button", { name: "Marker Kyrie", exact: true })).toBeVisible({
      timeout: 15_000,
    });
    await expect.poll(async () => channelGainDb(deskA, laneKey), { timeout: 15_000 }).toBe(-6);
    await expect
      .poll(async () => (await ui(deskA)).comments.map((c) => c.text).join(","), {
        timeout: 15_000,
      })
      .toBe("alto flat in the second phrase");
    await expect
      .poll(async () => Math.abs(((await ui(deskA)).clipStarts[streamId] ?? 0) - draggedTo), {
        timeout: 15_000,
      })
      .toBeLessThan(0.01);
    // Presence survives the reload too.
    await expect(deskA.locator('[title="Bea (Desk)"]')).toBeVisible({ timeout: 15_000 });

    // --- a COLD desk C joins after the fact (F1, the W3-A promise) -----------
    // C never saw a stream-announce: everything must rebuild from the
    // archive attribution — named lane, stream attached to the performer's
    // peerId-keyed mixer lane (not a phantom streamId strip), and per-lane
    // mixer sync live in both directions.
    await renamePeerFromDesk(deskA, laneKey, "Maria");
    const deskC = await (await browser.newContext()).newPage();
    await deskC.goto(`/session/${sessionId}`);
    await expect(deskC.getByText("ANTIPHON", { exact: true })).toBeVisible();
    await expect
      .poll(
        async () =>
          (await deskStatus(deskC)).find((s) => s.streamId === streamId)?.complete ?? false,
        { timeout: 60_000, intervals: [1_000] },
      )
      .toBe(true);
    await expectTakeLoaded(deskC, takeId, 1);

    // The historical stream lands on the performer lane, which already
    // carries the doc's mixer state (A's -6 dB fader) — not a fresh
    // phantom strip at 0 dB.
    await expect
      .poll(async () => (await trackLane(deskC, streamId))?.channelKey ?? "none", {
        timeout: 15_000,
      })
      .toBe(laneKey);
    await expect
      .poll(async () => (await trackLane(deskC, streamId))?.gainDb ?? null, { timeout: 15_000 })
      .toBe(-6);
    // ...and the lane is NAMED from the persisted peer, not "Stream N".
    await expect(deskC.getByText("Maria").first()).toBeVisible({ timeout: 15_000 });
    await expect(deskC.getByText(/^Stream \d+$/)).toHaveCount(0);

    // Fader move on A lands on C's matching lane (the previously-inert
    // per-lane path); C's move lands back on A.
    await deskA.evaluate((key) => {
      (
        globalThis as unknown as {
          __antiphonDesk: { player: { setChannelDb(k: string, db: number): void } };
        }
      ).__antiphonDesk.player.setChannelDb(key, -9);
    }, laneKey);
    await expect
      .poll(async () => (await trackLane(deskC, streamId))?.gainDb ?? null, { timeout: 15_000 })
      .toBe(-9);
    await deskC.evaluate((key) => {
      (
        globalThis as unknown as {
          __antiphonDesk: { player: { setChannelDb(k: string, db: number): void } };
        }
      ).__antiphonDesk.player.setChannelDb(key, -3);
    }, laneKey);
    await expect.poll(async () => channelGainDb(deskA, laneKey), { timeout: 15_000 }).toBe(-3);

    await phone.close();
    await deskC.close();
    await deskB.close();
    await deskA.close();
  });
});
