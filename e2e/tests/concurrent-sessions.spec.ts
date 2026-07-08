// Two independent sessions on one server, recording simultaneously.
//
// Sessions are isolation boundaries: rooms must not leak peers across
// session ids, archives must hold only their own takes/streams, and both
// takes must converge (complete, digest-equal at desk and server) exactly
// as if each session had the server to itself.

import { expect, type Page, test } from "@playwright/test";
import {
  deskState,
  expectTakeConverged,
  expectValidFlac,
  joinAsRecorder,
  recorderState,
  serverSessionTakeIds,
  startTake,
  stopTake,
} from "./helpers/session";

test.describe("concurrent sessions", () => {
  test.skip(({ browserName }) => browserName !== "chromium", "fake mic is Chromium-only");

  test("two sessions record simultaneously with zero cross-talk", async ({ browser }) => {
    test.setTimeout(150_000);
    const sessionA = crypto.randomUUID();
    const sessionB = crypto.randomUUID();

    const newPage = async (): Promise<Page> => await (await browser.newContext()).newPage();
    const deskA = await newPage();
    const deskB = await newPage();
    await deskA.goto(`/session/${sessionA}`);
    await deskB.goto(`/session/${sessionB}`);
    await expect(deskA.getByText("ANTIPHON", { exact: true })).toBeVisible();
    await expect(deskB.getByText("ANTIPHON", { exact: true })).toBeVisible();

    const phoneA = await newPage();
    const phoneB = await newPage();
    await joinAsRecorder(phoneA, sessionA);
    await joinAsRecorder(phoneB, sessionB);

    // Each desk sees exactly ITS phone — not the other session's.
    await expect(deskA.getByText("1 phone connected")).toBeVisible({ timeout: 15_000 });
    await expect(deskB.getByText("1 phone connected")).toBeVisible({ timeout: 15_000 });
    const phoneAPeer = (await recorderState(phoneA))?.peerId as string;
    const phoneBPeer = (await recorderState(phoneB))?.peerId as string;
    const peersOf = async (desk: Page): Promise<string[]> =>
      ((await deskState(desk))?.session?.peers ?? []).map((p) => p.peerId);
    const peersA = await peersOf(deskA);
    const peersB = await peersOf(deskB);
    expect(peersA).toContain(phoneAPeer);
    expect(peersA).not.toContain(phoneBPeer);
    expect(peersB).toContain(phoneBPeer);
    expect(peersB).not.toContain(phoneAPeer);
    expect(peersA.filter((p) => peersB.includes(p))).toEqual([]);

    // --- both sessions roll at the same time --------------------------------
    const takeA = await startTake(deskA);
    const takeB = await startTake(deskB);
    await expect(phoneA.getByText("recording", { exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(phoneB.getByText("recording", { exact: true })).toBeVisible({ timeout: 15_000 });
    await deskA.waitForTimeout(3_000);
    await stopTake(deskA);
    await stopTake(deskB);

    // Both takes converge independently (complete, digest-equal per sink).
    const convergedA = await expectTakeConverged(deskA, sessionA, takeA, 1);
    const convergedB = await expectTakeConverged(deskB, sessionB, takeB, 1);
    for (const stream of convergedA.serverStreams) {
      await expectValidFlac(deskA, stream.streamId);
    }
    for (const stream of convergedB.serverStreams) {
      await expectValidFlac(deskB, stream.streamId);
    }

    // --- zero cross-talk in the archive --------------------------------------
    // Each session's archive lists exactly its own take...
    expect(await serverSessionTakeIds(deskA, sessionA)).toEqual([takeA]);
    expect(await serverSessionTakeIds(deskB, sessionB)).toEqual([takeB]);
    // ...and the stream sets are disjoint.
    const streamsA = convergedA.serverStreams.map((s) => s.streamId);
    const streamsB = convergedB.serverStreams.map((s) => s.streamId);
    expect(streamsA.filter((id) => streamsB.includes(id))).toEqual([]);

    // Neither desk's sink store picked up the other session's streams.
    const deskAStreams = ((await deskState(deskA))?.deskStatus ?? []).map((s) => s.streamId);
    const deskBStreams = ((await deskState(deskB))?.deskStatus ?? []).map((s) => s.streamId);
    expect(deskAStreams).toEqual(streamsA);
    expect(deskBStreams).toEqual(streamsB);

    await phoneA.close();
    await phoneB.close();
    await deskA.close();
    await deskB.close();
  });
});
