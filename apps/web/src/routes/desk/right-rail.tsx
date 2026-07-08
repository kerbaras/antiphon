// Right-rail tab strip: performers / songs / comments / sinks, with the
// panel badge counts. The panels themselves live in *-panel.tsx modules.

export type RailTab = "performers" | "songs" | "comments" | "sinks";

export function RailTabs({
  tab,
  onTab,
  songCount,
  openCommentCount,
  streamCount,
}: {
  tab: RailTab;
  onTab: (tab: RailTab) => void;
  songCount: number;
  /** Comments not yet marked done (amber while notes await resolution). */
  openCommentCount: number;
  streamCount: number;
}) {
  return (
    <div className="flex gap-0.5 border-b border-divider px-2.5 pt-2">
      {(["performers", "songs", "comments", "sinks"] as const).map((t) => (
        <button
          key={t}
          type="button"
          onClick={() => onTab(t)}
          className={`border-b-2 px-2 py-[7px] text-[11px] font-semibold capitalize ${
            tab === t
              ? "border-accent text-text-hi"
              : "border-transparent text-text-dim hover:text-text"
          }`}
        >
          {t}
          {t === "songs" && songCount > 0 && (
            <span className="ml-1.5 rounded-lg bg-edge px-1.5 py-px font-mono text-[9px] text-text-dim">
              {songCount}
            </span>
          )}
          {/* Open-count badge: amber while notes await resolution. */}
          {t === "comments" && openCommentCount > 0 && (
            <span className="ml-1.5 rounded-lg bg-edge px-1.5 py-px font-mono text-[9px] text-pin">
              {openCommentCount}
            </span>
          )}
          {t === "sinks" && streamCount > 0 && (
            <span className="ml-1.5 rounded-lg bg-edge px-1.5 py-px font-mono text-[9px] text-text-dim">
              {streamCount}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}
