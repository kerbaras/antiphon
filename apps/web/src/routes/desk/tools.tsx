// Toolbar tool group + inert prototype chrome (visibly disabled, never fake).
// Width tiers are pinned by the topbar width sweep: the verdict chip is the
// row's one flexible child and must keep its longest string whole ≥700px —
// key hints shed <900, marker/comment labels <1024 (toolbar), view tabs
// <860, snap/grid <1200, inert tools <1380. Change tiers only with the sweep.

import { cx } from "../../components";

export type DeskTool = "select" | "split" | "trim";

function SoonChip() {
  return (
    <span className="rounded-[3px] bg-edge px-1 py-px font-mono text-[7.5px] font-semibold tracking-[0.5px] text-text-faint uppercase">
      soon
    </span>
  );
}

const INERT_TOOLS = [
  { name: "Stretch", key: "R" },
  { name: "Fade", key: "F" },
  { name: "Align", key: "A" },
];

export function ToolGroup({
  tool,
  onTool,
  splitDisabled,
}: {
  tool: DeskTool;
  onTool: (tool: DeskTool) => void;
  /** Recording disables the editing tools (shortcuts too). */
  splitDisabled?: boolean;
}) {
  const LIVE_TOOLS: Array<{ id: DeskTool; name: string; key: string; title: string }> = [
    { id: "select", name: "Select", key: "V", title: "Select tool (V) — click, marquee, drag" },
    {
      id: "split",
      name: "Split",
      key: "C",
      title: splitDisabled
        ? "Split is unavailable while recording"
        : "Split tool (C) — click a clip to cut it there; click the ruler or bare timeline to cut every lane. V or Escape returns to Select.",
    },
    {
      id: "trim",
      name: "Trim",
      key: "T",
      title: splitDisabled
        ? "Trim is unavailable while recording"
        : "Trim tool (T) — drag a clip's nearest edge to shorten it or re-extend hidden audio. V or Escape returns to Select.",
    },
  ];
  return (
    <div className="flex items-center gap-0.5 rounded-md border border-edge bg-bg p-[2px]">
      {LIVE_TOOLS.map((t) => {
        const active = tool === t.id;
        return (
          <button
            key={t.id}
            type="button"
            data-tool={t.id}
            aria-pressed={active}
            title={t.title}
            disabled={t.id !== "select" && (splitDisabled ?? false)}
            onClick={() => onTool(t.id)}
            className={cx(
              "flex items-center gap-1.5 rounded px-2.5 py-1 text-[11px] font-semibold transition-colors",
              active ? "bg-accent text-white" : "bg-transparent text-text-mute hover:text-text",
              "disabled:cursor-not-allowed disabled:opacity-40",
            )}
          >
            {t.name}
            <span
              className={cx(
                "hidden font-mono text-[9px] min-[900px]:inline",
                active ? "text-white/80" : "opacity-70",
              )}
            >
              {t.key}
            </span>
          </button>
        );
      })}
      <span
        aria-disabled="true"
        title="Coming soon — editing tools arrive with the timeline milestone"
        className="hidden cursor-not-allowed items-center gap-0.5 opacity-40 min-[1380px]:flex"
      >
        {INERT_TOOLS.map((tool) => (
          <span
            key={tool.name}
            className="flex items-center gap-1.5 rounded px-2.5 py-1 text-[11px] font-semibold text-text-faint"
          >
            {tool.name}
            <span className="font-mono text-[9px] opacity-70">{tool.key}</span>
          </span>
        ))}
      </span>
      <span className="hidden pr-1 pl-0.5 min-[1380px]:inline">
        <SoonChip />
      </span>
    </div>
  );
}

export function SnapGrid() {
  return (
    <div
      aria-disabled="true"
      title="Coming soon — snap and grid land with the editing tools"
      className="hidden cursor-not-allowed items-center gap-2 text-[11px] text-text-faint min-[1200px]:flex"
    >
      <span className="flex items-center gap-2 opacity-40">
        <span>Snap</span>
        <span className="rounded-[5px] border border-edge bg-bg px-2 py-[3px] font-semibold text-text-dim">
          Bar ▾
        </span>
        <span>Grid</span>
        <span className="rounded-[5px] border border-edge bg-bg px-2 py-[3px] font-mono font-semibold text-text-dim">
          1/16
        </span>
      </span>
      <SoonChip />
    </div>
  );
}

export function ViewTabs() {
  return (
    <div className="hidden rounded-md border border-edge bg-bg p-[2px] text-[11px] font-semibold min-[860px]:flex">
      <span className="rounded bg-accent px-3.5 py-1 text-white">Arrange</span>
      <span
        aria-disabled="true"
        title="Coming soon — Session view arrives with the DAW milestone"
        className="cursor-not-allowed px-3.5 py-1 text-text-faint opacity-40"
      >
        Session
      </span>
    </div>
  );
}

export function ZoomControl({ zoom, onZoom }: { zoom: number; onZoom: (z: number) => void }) {
  return (
    <div className="flex items-center gap-1.5 font-mono text-[12px] text-text-dim">
      <button
        type="button"
        aria-label="Zoom out"
        className="rounded border border-edge px-[7px] py-px hover:text-text"
        onClick={() => onZoom(Math.max(0.5, zoom - 0.25))}
      >
        −
      </button>
      <span className="text-[10px]">{Math.round(zoom * 100)}%</span>
      <button
        type="button"
        aria-label="Zoom in"
        className="rounded border border-edge px-[6px] py-px hover:text-text"
        onClick={() => onZoom(Math.min(2, zoom + 0.25))}
      >
        +
      </button>
    </div>
  );
}
