// F3: fatal control errors are terminal. The client must stop the
// reconnect loop dead (no supersede ping-pong war) and only come back via
// an explicit reopen().

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SignalingClient } from "./signaling-client";

/** Minimal scripted WebSocket: records instances, lets tests fire events. */
class FakeWebSocket {
  static OPEN = 1;
  static instances: FakeWebSocket[] = [];
  readonly url: string;
  readyState = FakeWebSocket.OPEN;
  private readonly listeners = new Map<string, Set<(ev: unknown) => void>>();
  private closeFired = false;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type: string, listener: (ev: unknown) => void): void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(listener);
  }

  send(_data: string): void {}

  close(): void {
    // Like the real thing: close fires the close event exactly once.
    if (this.closeFired) return;
    this.closeFired = true;
    this.readyState = 3;
    this.emit("close", {});
  }

  emit(type: string, ev: unknown): void {
    for (const l of this.listeners.get(type) ?? []) l(ev);
  }

  serverMessage(msg: unknown): void {
    this.emit("message", { data: JSON.stringify(msg) });
  }
}

const FATAL = { v: 1, type: "error", code: "superseded", message: "device moved", fatal: true };
const NON_FATAL = { v: 1, type: "error", code: "bad-take", message: "nope" };

describe("SignalingClient fatal handling (F3)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeWebSocket.instances = [];
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.stubGlobal("location", { protocol: "http:", host: "test.local" });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const SESSION_ID = "11111111-2222-4333-8444-555555555555";

  function connected(): { client: SignalingClient; ws: FakeWebSocket } {
    const client = new SignalingClient("recorder", SESSION_ID);
    client.connect();
    const ws = FakeWebSocket.instances[0] as FakeWebSocket;
    ws.emit("open", {});
    return { client, ws };
  }

  it("fatal error → terminal state, socket closed, NO reconnect ever scheduled", () => {
    const { client, ws } = connected();
    ws.serverMessage(FATAL);
    expect(client.state.fatal).toEqual({ code: "superseded", message: "device moved" });
    expect(client.state.connected).toBe(false);

    // The server closes the socket after a fatal; either way our own
    // proactive close already fired. Exhaust every backoff window: the
    // halted client must never dial again.
    vi.advanceTimersByTime(60_000);
    expect(FakeWebSocket.instances).toHaveLength(1);

    // Even a direct connect() (e.g. a stray timer from before the fatal)
    // is refused while halted.
    client.connect();
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it("non-fatal error + close → reconnects with backoff (unchanged behavior)", () => {
    const { client, ws } = connected();
    ws.serverMessage(NON_FATAL);
    expect(client.state.fatal).toBeNull();
    ws.close();
    vi.advanceTimersByTime(1_000); // RECONNECT_BASE_MS
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it("reopen() is the only way back: clears fatal and dials deliberately", () => {
    const { client, ws } = connected();
    ws.serverMessage(FATAL);
    vi.advanceTimersByTime(60_000);
    expect(FakeWebSocket.instances).toHaveLength(1);

    client.reopen();
    expect(client.state.fatal).toBeNull();
    expect(FakeWebSocket.instances).toHaveLength(2);

    // A successful welcome restores the connected state.
    const next = FakeWebSocket.instances[1] as FakeWebSocket;
    next.emit("open", {});
    next.serverMessage({
      v: 1,
      type: "welcome",
      peerId: "22222222-2222-4333-8444-555555555555",
      protocolVersion: 1,
      session: { sessionId: SESSION_ID, peers: [], activeTake: null },
    });
    expect(client.state.connected).toBe(true);
  });

  it("reopen() is a no-op without a fatal halt (and after close())", () => {
    const { client } = connected();
    client.reopen();
    expect(FakeWebSocket.instances).toHaveLength(1);
    client.close();
    client.reopen();
    expect(FakeWebSocket.instances).toHaveLength(1);
  });
});
