// Control-plane WS client with hello/welcome handshake and reconnect.
// Same-origin: Vite proxies /session/:id/ws and /join/:id/ws to the server
// in dev/preview; production serves them from the same host.

import {
  type PeerRole,
  parseSignalingMessage,
  type SessionState,
  type SignalingMessage,
} from "@antiphon/protocol";
import { getDeviceId } from "./device-identity";

type MessageListener = (msg: SignalingMessage) => void;
type StateListener = (state: SignalingClientState) => void;

export interface SignalingClientState {
  connected: boolean;
  peerId: string | null;
  session: SessionState | null;
}

const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 8_000;

export class SignalingClient {
  readonly role: PeerRole;
  readonly sessionId: string;
  /** Nickname sent as `deviceInfo.label` on (re)hello (A13). Mutable so a
   * rename survives the next reconnect handshake. */
  label: string | null;
  /** A12 identity override (the desk's embedded recorder derives its own);
   * null = this browser's persisted deviceId. */
  private readonly deviceId: string | null;
  private ws: WebSocket | null = null;
  private closed = false;
  private attempts = 0;
  private readonly messageListeners = new Set<MessageListener>();
  private readonly stateListeners = new Set<StateListener>();
  state: SignalingClientState = { connected: false, peerId: null, session: null };

  constructor(
    role: PeerRole,
    sessionId: string,
    label: string | null = null,
    deviceId: string | null = null,
  ) {
    this.role = role;
    this.sessionId = sessionId;
    this.label = label;
    this.deviceId = deviceId;
  }

  connect(): void {
    if (this.closed) return;
    const path = this.role === "desk" ? "session" : "join";
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/${path}/${this.sessionId}/ws`);
    this.ws = ws;
    ws.addEventListener("open", () => {
      this.attempts = 0;
      const label = this.label?.trim();
      this.sendRaw({
        v: 1,
        type: "hello",
        role: this.role,
        deviceInfo: {
          userAgent: navigator.userAgent.slice(0, 500),
          // Stable per-browser id (A12): the server resumes our peerId.
          deviceId: this.deviceId ?? getDeviceId(),
          ...(label ? { label } : {}),
        },
        protocolVersions: [1],
      });
    });
    ws.addEventListener("message", (ev) => {
      let msg: SignalingMessage | null = null;
      try {
        msg = parseSignalingMessage(String(ev.data));
      } catch {
        return;
      }
      if (!msg) return;
      if (msg.type === "welcome") {
        this.setState({ connected: true, peerId: msg.peerId, session: msg.session });
      } else if (msg.type === "peer-status") {
        this.setState({ ...this.state, session: msg.session });
      } else if (msg.type === "peer-update" && this.state.session) {
        // Live rename (A13): patch the snapshot so every consumer sees the
        // new label without waiting for the next peer-status.
        const update = msg;
        const peers = this.state.session.peers.map((p) => {
          if (p.peerId !== update.peerId) return p;
          const { label: _drop, ...rest } = p.deviceInfo;
          return {
            ...p,
            deviceInfo: { ...rest, ...(update.label ? { label: update.label } : {}) },
          };
        });
        this.setState({ ...this.state, session: { ...this.state.session, peers } });
      }
      for (const l of this.messageListeners) l(msg);
    });
    ws.addEventListener("close", () => {
      this.setState({ ...this.state, connected: false, peerId: null });
      if (!this.closed) {
        const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** this.attempts++);
        setTimeout(() => this.connect(), delay);
      }
    });
    ws.addEventListener("error", () => ws.close());
  }

  send(msg: SignalingMessage): void {
    this.sendRaw(msg);
  }

  private sendRaw(msg: SignalingMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  onMessage(listener: MessageListener): () => void {
    this.messageListeners.add(listener);
    return () => this.messageListeners.delete(listener);
  }

  onState(listener: StateListener): () => void {
    this.stateListeners.add(listener);
    listener(this.state);
    return () => this.stateListeners.delete(listener);
  }

  private setState(state: SignalingClientState): void {
    this.state = state;
    for (const l of this.stateListeners) l(state);
  }

  close(): void {
    this.closed = true;
    this.ws?.close();
  }
}
