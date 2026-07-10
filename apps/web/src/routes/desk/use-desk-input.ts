// Desk hardware input: the desk embeds a recorder built from the SAME
// CaptureController + RecorderSession machinery the phone uses — on the
// wire it is just another recorder peer; no sink special-casing anywhere.
// One manager per page, bridged into React via useSyncExternalStore, with
// the __antiphonDeskInput e2e hook.

import { useCallback, useSyncExternalStore } from "react";
import {
  CaptureController,
  type CaptureFlags,
  type CaptureSnapshot,
} from "../../audio/capture-controller";
import {
  type DeskInputPrefs,
  defaultDeskInputLabel,
  deriveDeskInputDeviceId,
  loadDeskInputPrefs,
  saveDeskInputPrefs,
} from "../../net/desk-input-identity";
import { getDeviceId } from "../../net/device-identity";
import { RecorderSession, type RecorderSessionState } from "../../net/recorder-session";

export interface DeskInputDeviceOption {
  id: string;
  label: string;
}

export interface DeskInputState {
  phase: "off" | "picking" | "starting" | "live";
  /** Enumerated audio inputs (labels require a granted permission). */
  devices: DeskInputDeviceOption[];
  /** The live input, when phase = live. */
  input: DeskInputDeviceOption | null;
  /** Lane nickname (desk renames land here via peer-update). */
  laneLabel: string | null;
  peerId: string | null;
  streamId: string | null;
  /** This lane is armed in the rolling take. */
  recording: boolean;
  /** Live capture peak (0..1), flowing whenever the pipeline is up. */
  peak: number;
  /** EC/NS/AGC honesty — same truth the phone page surfaces. */
  flags: CaptureFlags | null;
  sampleRate: number | null;
  /** The selected device vanished; the lane records silence until swapped
   * or disabled between takes (sample-domain continuity over dead air). */
  unplugged: boolean;
  /** Persisted input from a previous visit — one-click resume. */
  resumeLabel: string | null;
  error: string | null;
}

type Listener = (state: DeskInputState) => void;

const OFF_STATE: DeskInputState = {
  phase: "off",
  devices: [],
  input: null,
  laneLabel: null,
  peerId: null,
  streamId: null,
  recording: false,
  peak: 0,
  flags: null,
  sampleRate: null,
  unplugged: false,
  resumeLabel: null,
  error: null,
};

export class DeskInput {
  private controller: CaptureController | null = null;
  private session: RecorderSession | null = null;
  private sessionState: RecorderSessionState | null = null;
  private prefs: DeskInputPrefs | null = loadDeskInputPrefs();
  private state: DeskInputState = { ...OFF_STATE, resumeLabel: this.prefs?.inputLabel ?? null };
  private readonly listeners = new Set<Listener>();
  /** Final-seq dedupe, per (takeId, streamId, finalSeq). */
  private lastReportedFinal: string | null = null;

  constructor(readonly sessionId: string) {
    navigator.mediaDevices?.addEventListener?.("devicechange", this.onDeviceChange);
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  snapshot(): DeskInputState {
    return this.state;
  }

  /** The embedded recorder's session view (e2e/diagnostics). */
  sessionSnapshot(): RecorderSessionState | null {
    return this.sessionState;
  }

  private patch(next: Partial<DeskInputState>): void {
    this.state = { ...this.state, ...next };
    for (const l of this.listeners) l(this.state);
  }

  /** Labels are blank until getUserMedia grants, so a throwaway probe
   * stream runs first (stopped immediately). False = permission denied. */
  private async probeMicPermission(): Promise<boolean> {
    this.patch({ phase: "picking", error: null });
    try {
      const probe = await navigator.mediaDevices.getUserMedia({ audio: true });
      for (const track of probe.getTracks()) track.stop();
      return true;
    } catch (e) {
      this.patch({ phase: "off", error: `microphone permission: ${String(e)}` });
      return false;
    }
  }

  /** Open the device picker. */
  async openPicker(): Promise<void> {
    if (this.state.phase === "live") return;
    if (!(await this.probeMicPermission())) return;
    await this.refreshDevices();
  }

  closePicker(): void {
    if (this.state.phase === "picking") this.patch({ phase: "off" });
  }

  /** Start the lane on a picked input. Between takes only (UI-gated). */
  async enable(device: DeskInputDeviceOption): Promise<void> {
    if (this.controller) return;
    this.patch({ phase: "starting", error: null });
    const controller = new CaptureController();
    this.controller = controller;
    controller.subscribe((snap) => this.onCapture(snap));
    try {
      // No wake lock: the desk is the active tab by definition.
      await controller.start({ deviceId: device.id, wakeLock: false });
    } catch (e) {
      this.controller = null;
      void controller.teardown();
      // The card shows the friendly line; keep the raw cause for devtools.
      console.warn("[desk-input] capture failed to start", e);
      this.patch({ phase: "picking", error: "input failed to start — is it still connected?" });
      return;
    }
    controller.audioTrack?.addEventListener("ended", () => this.patch({ unplugged: true }));
    const laneLabel = this.prefs?.label ?? defaultDeskInputLabel(device.label);
    const session = new RecorderSession(this.sessionId, controller, {
      // Stable derived deviceId so a reload resumes the lane.
      deviceId: deriveDeskInputDeviceId(getDeviceId()),
      label: laneLabel,
      persistLabel: (label) => this.persistLabel(label),
    });
    this.session = session;
    session.subscribe((s) => this.onSession(s));
    session.start();
    this.prefs = { inputId: device.id, inputLabel: device.label, label: this.prefs?.label ?? null };
    saveDeskInputPrefs(this.prefs);
    this.patch({
      phase: "live",
      input: device,
      laneLabel,
      resumeLabel: device.label,
      unplugged: false,
    });
  }

  /** One click after a reload: re-enable the persisted input. Permission is
   * already granted and the derived deviceId is stable, so the server hands
   * back the same peerId — the lane resumes instead of forking. */
  async resume(): Promise<void> {
    const prefs = this.prefs;
    if (!prefs) {
      await this.openPicker();
      return;
    }
    if (!(await this.probeMicPermission())) return;
    const devices = await this.refreshDevices();
    // Device ids persist per origin; fall back to the label if the browser
    // re-minted them (cleared site data).
    const match =
      devices.find((d) => d.id === prefs.inputId) ??
      devices.find((d) => d.label === prefs.inputLabel);
    if (!match) {
      this.patch({ error: `saved input "${prefs.inputLabel}" not found — pick another` });
      return;
    }
    await this.enable(match);
  }

  /** Tear the lane down. Between takes only (UI-gated): a mid-take teardown
   * would orphan the stream's DRAINING obligations. */
  async disable(): Promise<void> {
    this.session?.close();
    this.session = null;
    this.sessionState = null;
    const controller = this.controller;
    this.controller = null;
    await controller?.teardown();
    this.lastReportedFinal = null;
    this.patch({ ...OFF_STATE, resumeLabel: this.prefs?.inputLabel ?? null });
  }

  private async refreshDevices(): Promise<DeskInputDeviceOption[]> {
    const all = await navigator.mediaDevices.enumerateDevices();
    const devices = all
      .filter((d) => d.kind === "audioinput")
      .map((d, i) => ({ id: d.deviceId, label: d.label || `Input ${i + 1}` }));
    this.patch({ devices });
    return devices;
  }

  private onCapture(snap: CaptureSnapshot): void {
    // The worker reported a final seq: tell the sinks via control plane.
    if (snap.finalSeq !== null && this.session) {
      const key = snap.stats
        ? `${snap.stats.takeId}:${snap.stats.streamId}:${snap.finalSeq}`
        : null;
      if (key === null || key !== this.lastReportedFinal) {
        this.lastReportedFinal = key;
        this.session.notifyFinal(snap.finalSeq);
      }
    }
    this.patch({
      peak: snap.peak,
      flags: snap.flags,
      sampleRate: snap.contextSampleRate,
      ...(snap.error !== null ? { error: snap.error } : {}),
    });
  }

  private onSession(s: RecorderSessionState): void {
    this.sessionState = s;
    this.patch({
      peerId: s.peerId,
      streamId: s.streamId,
      recording: s.activeTakeId !== null,
      laneLabel: s.label ?? this.state.laneLabel,
    });
  }

  private persistLabel(label: string): void {
    if (!this.prefs) return; // only reachable while live
    this.prefs = { ...this.prefs, label: label.trim() || null };
    saveDeskInputPrefs(this.prefs);
  }

  private onDeviceChange = (): void => {
    void (async () => {
      if (this.state.phase === "picking") {
        await this.refreshDevices();
        return;
      }
      const input = this.state.input;
      if (this.state.phase !== "live" || !input) return;
      const all = await navigator.mediaDevices.enumerateDevices();
      const present = all.some((d) => d.kind === "audioinput" && d.deviceId === input.id);
      // Keep the pipeline running either way: an unplugged input feeds
      // silence, preserving sample-domain continuity for the rolling take.
      // A dead track never recovers, even if the device re-enumerates.
      const trackDead = this.controller?.audioTrack?.readyState === "ended";
      this.patch({ unplugged: trackDead || !present });
    })();
  };
}

let manager: DeskInput | null = null;
let latest: DeskInputState | null = null;

export function getDeskInput(sessionId: string): DeskInput {
  if (!manager || manager.sessionId !== sessionId) {
    manager = new DeskInput(sessionId);
    manager.subscribe((s) => {
      latest = s;
    });
    (globalThis as Record<string, unknown>).__antiphonDeskInput = {
      input: manager,
      snapshot: () => latest,
      sessionState: () => manager?.sessionSnapshot() ?? null,
    };
  }
  return manager;
}

export function useDeskInput(sessionId: string): DeskInputState {
  const subscribe = useCallback(
    (onChange: () => void) => getDeskInput(sessionId).subscribe(() => onChange()),
    [sessionId],
  );
  return useSyncExternalStore(subscribe, () => latest ?? getDeskInput(sessionId).snapshot());
}
