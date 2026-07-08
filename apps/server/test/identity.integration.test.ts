// Peer identity + nicknames over REAL WS signaling (A12/A13): deviceId
// resume, zombie replacement, rename authority, and peers-table
// persistence. Same harness as ingest.integration.test.ts; requires
// Postgres (docker compose up -d postgres); skipped when unreachable.

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeDesk, FakeRecorder, pollUntil, startTestServer, type TestServer } from "./helpers.ts";

const ADMIN_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://antiphon:antiphon@localhost:5433/antiphon";

let available = true;
try {
  const probe = postgres(ADMIN_URL, { max: 1, connect_timeout: 3 });
  await probe`select 1`;
  await probe.end();
} catch {
  available = false;
}

const suite = available ? describe : describe.skip;

async function freshDatabase(name: string): Promise<string> {
  const admin = postgres(ADMIN_URL, { max: 1 });
  await admin.unsafe(`drop database if exists ${name} with (force)`);
  await admin.unsafe(`create database ${name}`);
  await admin.end();
  return ADMIN_URL.replace(/\/[^/]+$/, `/${name}`);
}

interface PeerRow {
  id: string;
  role: string;
  label: string | null;
  device_id: string | null;
}

suite("peer identity + nicknames (A12/A13)", () => {
  let server: TestServer;
  let dbUrl: string;
  let sql: postgres.Sql;

  beforeAll(async () => {
    dbUrl = await freshDatabase("antiphon_identity_it");
    server = await startTestServer(dbUrl, `${process.env.TMPDIR ?? "/tmp"}/antiphon-identity-it`);
    sql = postgres(dbUrl, { max: 1 });
  }, 30_000);

  afterAll(async () => {
    await sql?.end();
    await server?.stop();
  });

  async function newSession(): Promise<string> {
    const { sessionId } = (await (
      await fetch(`${server.baseUrl}/api/sessions`, { method: "POST" })
    ).json()) as { sessionId: string };
    return sessionId;
  }

  function peerRows(sessionId: string): Promise<PeerRow[]> {
    return sql<
      PeerRow[]
    >`select id, role, label, device_id from peers where session_id = ${sessionId}`;
  }

  it("same deviceId + role resumes the peerId; label persists across a silent reconnect", async () => {
    const sessionId = await newSession();
    const desk = new FakeDesk(server.baseUrl, sessionId);
    await desk.join();
    const deviceId = crypto.randomUUID();

    const first = new FakeRecorder(server.baseUrl, sessionId, { deviceId, label: "Maria" });
    await first.join();
    const peerId = first.peerId as string;
    expect(desk.session?.peers.find((p) => p.peerId === peerId)?.deviceInfo.label).toBe("Maria");

    // Disconnect entirely, rejoin WITHOUT a label: same lane, name kept.
    await first.close();
    await pollUntil(
      async () => desk.session?.peers.filter((p) => p.role === "recorder") ?? [],
      (peers) => peers.length === 0,
      "recorder left the room",
    );
    const second = new FakeRecorder(server.baseUrl, sessionId, { deviceId });
    await second.join();
    expect(second.peerId).toBe(peerId);
    expect(desk.session?.peers.find((p) => p.peerId === peerId)?.deviceInfo.label).toBe("Maria");

    // A hello carrying a NEW label wins over the stored one.
    await second.close();
    const third = new FakeRecorder(server.baseUrl, sessionId, { deviceId, label: "Maria S." });
    await third.join();
    expect(third.peerId).toBe(peerId);
    expect(desk.session?.peers.find((p) => p.peerId === peerId)?.deviceInfo.label).toBe("Maria S.");

    // Same deviceId but a DIFFERENT role never resumes the recorder's peer.
    const desk2 = new FakeDesk(server.baseUrl, sessionId, { deviceId });
    await desk2.join();
    expect(desk2.peerId).not.toBe(peerId);

    // One durable row per identity, upserted in place.
    const rows = await peerRows(sessionId);
    const recorders = rows.filter((r) => r.role === "recorder");
    expect(recorders).toHaveLength(1);
    expect(recorders[0]).toMatchObject({ id: peerId, label: "Maria S.", device_id: deviceId });

    await third.close();
    desk.close();
    desk2.close();
  }, 30_000);

  it("zombie connection: still-open old socket is superseded, not duplicated", async () => {
    const sessionId = await newSession();
    const desk = new FakeDesk(server.baseUrl, sessionId);
    await desk.join();
    const deviceId = crypto.randomUUID();

    const zombie = new FakeRecorder(server.baseUrl, sessionId, { deviceId, label: "Tenor" });
    await zombie.join();
    const successor = new FakeRecorder(server.baseUrl, sessionId, { deviceId });
    await successor.join();

    expect(successor.peerId).toBe(zombie.peerId);
    const err = await zombie.waitForMessage("error");
    expect(err.code).toBe("superseded");
    expect(err.fatal).toBe(true);
    await pollUntil(
      async () => zombie.wsClosed,
      (closed) => closed,
      "zombie socket closed by server",
    );

    // The zombie's close must NOT evict the successor (epoch guard):
    // the room still holds exactly one recorder, the resumed one.
    await new Promise((r) => setTimeout(r, 200));
    const recorders = desk.session?.peers.filter((p) => p.role === "recorder") ?? [];
    expect(recorders.map((p) => p.peerId)).toEqual([successor.peerId]);
    expect(recorders[0]?.deviceInfo.label).toBe("Tenor");

    await successor.close();
    desk.close();
  }, 30_000);

  it("peer-update authority: desk renames anyone, a recorder only itself", async () => {
    const sessionId = await newSession();
    const desk = new FakeDesk(server.baseUrl, sessionId);
    await desk.join();
    const alice = new FakeRecorder(server.baseUrl, sessionId, { deviceId: crypto.randomUUID() });
    await alice.join();
    const bob = new FakeRecorder(server.baseUrl, sessionId, { deviceId: crypto.randomUUID() });
    await bob.join();
    const alicePeer = alice.peerId as string;
    const bobPeer = bob.peerId as string;

    // Desk renames Alice: fans out to everyone, persists.
    desk.renamePeer(alicePeer, "Alto — Alice");
    const update = await alice.waitForMessage("peer-update");
    expect(update).toEqual({ v: 1, type: "peer-update", peerId: alicePeer, label: "Alto — Alice" });
    await pollUntil(
      async () => desk.session?.peers.find((p) => p.peerId === alicePeer)?.deviceInfo.label,
      (label) => label === "Alto — Alice",
      "desk snapshot renamed",
    );
    await pollUntil(
      async () => (await peerRows(sessionId)).find((r) => r.id === alicePeer)?.label ?? null,
      (label) => label === "Alto — Alice",
      "label persisted",
    );

    // Bob renames himself: allowed.
    bob.rename(bobPeer, "Bass — Bob");
    await pollUntil(
      async () => desk.session?.peers.find((p) => p.peerId === bobPeer)?.deviceInfo.label,
      (label) => label === "Bass — Bob",
      "self-rename fanned out",
    );

    // Bob renaming Alice: refused, nothing changes.
    bob.rename(alicePeer, "Hijacked");
    const refusal = await bob.waitForMessage("error");
    expect(refusal.code).toBe("not-authorized");
    await new Promise((r) => setTimeout(r, 200));
    expect(desk.session?.peers.find((p) => p.peerId === alicePeer)?.deviceInfo.label).toBe(
      "Alto — Alice",
    );

    // Renaming an unknown peer: refused.
    desk.renamePeer(crypto.randomUUID(), "Ghost");
    const unknown = await pollUntil(
      async () => desk.received.filter((m) => m.type === "error"),
      (errors) => errors.length > 0,
      "unknown-peer refusal",
    );
    expect(unknown[0]).toMatchObject({ code: "unknown-peer" });

    // Empty label clears back to the device-derived fallback.
    desk.renamePeer(alicePeer, "   ");
    await pollUntil(
      async () => desk.session?.peers.find((p) => p.peerId === alicePeer)?.deviceInfo,
      (info) => info !== undefined && info.label === undefined,
      "label cleared in snapshot",
    );
    expect((await peerRows(sessionId)).find((r) => r.id === alicePeer)?.label).toBeNull();

    await alice.close();
    await bob.close();
    desk.close();
  }, 30_000);

  it("identity resume survives a server restart (device index rebuilt from the peers table)", async () => {
    const sessionId = await newSession();
    const deviceId = crypto.randomUUID();
    const before = new FakeRecorder(server.baseUrl, sessionId, { deviceId, label: "Soprano" });
    await before.join();
    const peerId = before.peerId as string;
    await before.close();

    await server.stop();
    server = await startTestServer(dbUrl, `${process.env.TMPDIR ?? "/tmp"}/antiphon-identity-it`);

    const after = new FakeRecorder(server.baseUrl, sessionId, { deviceId });
    await after.join();
    expect(after.peerId).toBe(peerId);
    expect(after.session?.peers.find((p) => p.peerId === peerId)?.deviceInfo.label).toBe("Soprano");
    await after.close();
  }, 30_000);
});
