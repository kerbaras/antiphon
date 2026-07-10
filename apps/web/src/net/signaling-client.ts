// Control-plane WS client with hello/welcome handshake and reconnect.
// Same-origin: Vite proxies /session/:id/ws and /join/:id/ws to the server
// in dev/preview; production serves them from the same host.

import {
  type PeerRole,
  parseSignalingMessage,
  type SessionState,
  type SignalingMessage,
} from "@antiphon/protocol";
import { authToken } from "./auth-token";
import { authUser } from "./auth-user";
import { getDeviceId } from "./device-identity";

type MessageListener = (msg: SignalingMessage) => void;
type StateListener = (state: SignalingClientState) => void;

/** A terminal control-plane error (§11 `fatal:true`), e.g. this device
 * identity reconnected elsewhere and superseded us. The client halts — no
 * reconnect — until an explicit reopen(). */
export interface FatalSignalingError {
  code: string;
  message: string;
}

export interface SignalingClientState {
  connected: boolean;
  peerId: string | null;
  session: SessionState | null;
  /** Non-null = this client is terminally halted. */
  fatal: FatalSignalingError | null;
}

const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 8_000;
/** Upgrade answered within this or the attempt is aborted: a handshake a
 * broken proxy never answers would otherwise sit in CONNECTING forever —
 * and the browser serializes ws handshakes per host (RFC 6455 §4.1), so
 * one hung socket dams every later WebSocket to the origin. */
const HANDSHAKE_TIMEOUT_MS = 10_000;

export class SignalingClient {
  readonly role: PeerRole;
  readonly sessionId: string;
  /** Nickname sent as `deviceInfo.label` on (re)hello. Mutable so a rename
   * survives the next reconnect handshake. */
  label: string | null;
  /** Identity override (the desk's embedded recorder derives its own);
   * null = this browser's persisted deviceId. */
  private readonly deviceId: string | null;
  /** This endpoint speaks for the signed-in account: hellos carry the
   * profile picture, and an unnamed recorder defaults to the account email.
   * False for the desk's room-mic recorder — hardware, not a person. */
  private readonly accountIdentity: boolean;
  private ws: WebSocket | null = null;
  private closed = false;
  private attempts = 0;
  private readonly messageListeners = new Set<MessageListener>();
  private readonly stateListeners = new Set<StateListener>();
  state: SignalingClientState = { connected: false, peerId: null, session: null, fatal: null };

  constructor(
    role: PeerRole,
    sessionId: string,
    label: string | null = null,
    deviceId: string | null = null,
    accountIdentity = true,
  ) {
    this.role = role;
    this.sessionId = sessionId;
    this.label = label;
    this.deviceId = deviceId;
    this.accountIdentity = accountIdentity;
  }

  connect(): void {
    // A fatal halt gates reconnection too: a timer armed before the fatal
    // landed must not resurrect the socket (that's the supersede ping-pong
    // war). Only reopen() clears the halt.
    if (this.closed || this.state.fatal) return;
    const path = this.role === "desk" ? "session" : "join";
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/${path}/${this.sessionId}/ws`);
    this.ws = ws;
    const deadline = setTimeout(() => {
      if (ws.readyState === WebSocket.CONNECTING) ws.close();
    }, HANDSHAKE_TIMEOUT_MS);
    ws.addEventListener("open", () => {
      clearTimeout(deadline);
      this.attempts = 0;
      // Account identity is read at hello time so a sign-in that landed
      // after construction still counts. An unnamed recorder defaults its
      // label to the account email (never persisted; a nickname wins).
      const account = this.accountIdentity ? authUser() : null;
      const label =
        this.label?.trim() ||
        (this.role === "recorder" ? (account?.email ?? undefined) : undefined);
      // Desk hellos carry the session token (the browser can't set WS
      // headers), fetched per (re)connect for a fresh JWT. Recorders never
      // send one: mic join stays accountless (RFC §12).
      const tokenPromise = this.role === "desk" ? authToken() : Promise.resolve(null);
      void tokenPromise.then((token) => {
        if (this.ws !== ws || ws.readyState !== WebSocket.OPEN) return;
        this.sendRaw({
          v: 1,
          type: "hello",
          role: this.role,
          deviceInfo: {
            userAgent: navigator.userAgent.slice(0, 500),
            // Stable per-browser id so the server resumes our peerId.
            deviceId: this.deviceId ?? getDeviceId(),
            ...(label ? { label } : {}),
            ...(account?.imageUrl ? { avatarUrl: account.imageUrl } : {}),
          },
          protocolVersions: [1],
          ...(token ? { authToken: token } : {}),
        });
      });
    });
    ws.addEventListener("message", (ev) => {
      let msg: SignalingMessage | null = null;
      try {
        msg = parseSignalingMessage(String(ev.data));
      } catch (e) {
        // A frame we can't parse means a protocol mismatch — worth a
        // trace, never worth killing the socket handler.
        console.warn("[signaling] unparseable message", e);
        return;
      }
      if (!msg) return;
      if (msg.type === "error" && msg.fatal) {
        // Terminal by contract: superseded devices, deleted sessions, caps.
        // Halt the reconnect loop; recovery is a deliberate reopen(), never
        // an automatic retry.
        this.setState({
          ...this.state,
          connected: false,
          fatal: { code: msg.code, message: msg.message },
        });
        ws.close(); // the server is closing it anyway; don't linger half-open
      } else if (msg.type === "welcome") {
        this.setState({ connected: true, peerId: msg.peerId, session: msg.session, fatal: null });
      } else if (msg.type === "peer-status") {
        this.setState({ ...this.state, session: msg.session });
      } else if (msg.type === "peer-update" && this.state.session) {
        // Live rename: patch the snapshot so every consumer sees the new
        // label without waiting for the next peer-status.
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
      clearTimeout(deadline);
      this.setState({ ...this.state, connected: false, peerId: null });
      if (!this.closed && !this.state.fatal) {
        const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** this.attempts++);
        setTimeout(() => this.connect(), delay);
      }
    });
    ws.addEventListener("error", () => ws.close());
  }

  /** Deliberate rejoin after a fatal halt (the "take over in this tab"
   * affordance): clears the terminal state and reconnects — knowingly
   * superseding whichever connection owns this device identity now. */
  reopen(): void {
    if (this.closed || !this.state.fatal) return;
    this.attempts = 0;
    this.setState({ ...this.state, fatal: null });
    this.connect();
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
