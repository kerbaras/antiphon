// Barrel for the desk's DAW chrome, lifted from the prototype reference
// (docs/Antiphone DAW.dc.html). Anything not yet functional renders
// visibly inert (aria-disabled), never fake.

export { AvatarStack } from "./avatar-stack";
export { ClipCard, type ClipModel } from "./clip-card";
export { hexA } from "./color";
export { Fader } from "./fader";
export { PanKnob } from "./knobs";
export {
  LaneRuler,
  laneGridStyle,
  RenameInput,
  RULER_H,
  TRACK_HEADER_W,
  TRACK_ROW_H,
  TrackMiniButton,
  VUVertical,
} from "./lane-chrome";
export { MixerStrip } from "./mixer-strip";
export { type DeskTool, SnapGrid, ToolGroup, ViewTabs, ZoomControl } from "./tools";
export { InfoChip, Timecode, TransportButton, TransportGroup } from "./transport";
