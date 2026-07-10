// Public surface of the desk's non-visual state layer. Implementation
// lives in the sibling modules; this path re-exports every name the
// panels/toolbars (and diagnostics) import.

export {
  type DeskUiMirror,
  ensureWaveform,
  getCachedWaveform,
  getDeskCollab,
  getDeskSession,
  getPlayer,
  publishUiMirror,
  useDeskState,
  usePlayer,
  waveformCacheSize,
} from "./desk-state";
export {
  exportMasterWav,
  exportMidiFile,
  exportSessionMasterWav,
  exportSongsZip,
  exportStemsZip,
  SESSION_RENDER_CONFIRM_BYTES,
  type StemFormat,
} from "./export-audio";
export {
  exportAbletonProject,
  exportLogicPackage,
  exportProjectPackage,
  type ProjectExportContext,
  type ProjectLane,
} from "./export-project";
export {
  loadTakeIntoPlayer,
  requestTakeLoad,
  type TakeLoadRequest,
  useTakeAlignShifts,
} from "./take-load";
export { type AttributionState, useSessionAttribution } from "./use-attribution";
export { type ServerStreamStatus, useServerStatus } from "./use-server-status";
export {
  type TakeCommentsApi,
  type TakeMarkersApi,
  useTakeComments,
  useTakeMarkers,
} from "./use-take-lists";
