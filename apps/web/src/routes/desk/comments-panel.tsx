// Right-rail Comments panel: timestamped notes with a resolve flow.

import { useEffect, useMemo, useRef, useState } from "react";
import { SectionLabel } from "../../components";
import { type CommentLane, CommentRow } from "./comment-row";
import { MAX_COMMENT_AUTHOR, MAX_COMMENT_TEXT, type TakeComment } from "./comments";
import { formatAt } from "./format";

export type { CommentLane } from "./comment-row";

/** Comments list + composer. The composer at the foot anchors a note at
 * the playhead the moment typing starts — not at Enter: playback keeps
 * rolling while the operator types. */
export function CommentsPanel({
  comments,
  usable,
  lanes,
  playheadSec,
  author,
  focusToken,
  onAuthorChange,
  onAdd,
  onSeek,
  onEditText,
  onResolve,
  onUnresolve,
  onRemove,
}: {
  comments: TakeComment[];
  /** A take is loaded and idle — comments can be added and seeked. */
  usable: boolean;
  lanes: CommentLane[];
  /** Live playhead in take time — the composer's default anchor. */
  playheadSec: number;
  author: string;
  /** Bumped by the C key / toolbar pill: focus the composer input. */
  focusToken: number;
  onAuthorChange: (author: string) => void;
  onAdd: (input: { atSec: number; text: string; streamId: string | null }) => void;
  onSeek: (atSec: number) => void;
  onEditText: (id: string, text: string) => void;
  onResolve: (id: string) => void;
  onUnresolve: (id: string) => void;
  onRemove: (id: string) => void;
}) {
  const [filter, setFilter] = useState<"all" | "open">("all");
  const [text, setText] = useState("");
  const [anchorSec, setAnchorSec] = useState<number | null>(null);
  const [laneId, setLaneId] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);
  const laneByStream = useMemo(() => new Map(lanes.map((l) => [l.streamId, l])), [lanes]);

  useEffect(() => {
    if (focusToken > 0) inputRef.current?.focus();
  }, [focusToken]);

  const visible = filter === "open" ? comments.filter((c) => c.resolvedAtMs === null) : comments;
  const atSec = anchorSec ?? playheadSec;

  function submit() {
    if (!usable || !text.trim()) return;
    // A stale lane pick (take changed under the composer) degrades to take-wide.
    onAdd({ atSec, text, streamId: laneByStream.has(laneId) ? laneId : null });
    setText("");
    setAnchorSec(null);
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between px-2.5 pt-2 pb-1.5">
        <SectionLabel>Comments</SectionLabel>
        <div className="flex overflow-hidden rounded-[5px] border border-edge-btn">
          {(["all", "open"] as const).map((f) => (
            <button
              key={f}
              type="button"
              aria-pressed={filter === f}
              onClick={() => setFilter(f)}
              className={`px-2 py-[3px] font-mono text-[8.5px] font-semibold tracking-[0.5px] uppercase ${
                filter === f ? "bg-card-hi text-text-hi" : "text-text-dim hover:text-text"
              }`}
            >
              {f}
            </button>
          ))}
        </div>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto px-2.5 pb-2.5">
        {visible.length === 0 && (
          <p className="px-1 py-1 text-[11px] leading-relaxed text-text-dim">
            {comments.length > 0 ? (
              "No open comments — everything is resolved."
            ) : (
              <>
                No comments yet. Press <span className="font-mono text-text-mute">C</span> to note
                something at the playhead — “alto flat at 2:31” — and mark it done once fixed.
              </>
            )}
          </p>
        )}
        {visible.map((comment) => (
          <CommentRow
            key={comment.id}
            comment={comment}
            lane={comment.streamId ? (laneByStream.get(comment.streamId) ?? null) : null}
            usable={usable}
            onSeek={() => onSeek(comment.atSec)}
            onEditText={(next) => onEditText(comment.id, next)}
            onToggleResolved={() =>
              comment.resolvedAtMs === null ? onResolve(comment.id) : onUnresolve(comment.id)
            }
            onRemove={() => onRemove(comment.id)}
          />
        ))}
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        className="flex flex-col gap-1.5 border-t border-divider p-2.5"
      >
        <input
          ref={inputRef}
          value={text}
          disabled={!usable}
          maxLength={MAX_COMMENT_TEXT}
          placeholder={usable ? "Comment at playhead…" : "Load a take to comment"}
          aria-label="Comment text"
          onChange={(e) => {
            const next = e.target.value;
            // Anchor on the FIRST keystroke: the moment the operator heard
            // it, not wherever the playhead sits when Enter lands.
            setAnchorSec((prev) => (next ? (prev ?? playheadSec) : null));
            setText(next);
          }}
          onKeyDown={(e) => {
            // Explicit: implicit form submission needs a submit button.
            if (e.key === "Enter") {
              e.preventDefault();
              submit();
            }
            if (e.key === "Escape") {
              setText("");
              setAnchorSec(null);
              e.currentTarget.blur();
            }
          }}
          className="w-full rounded-[7px] border border-edge-card bg-bg px-2.5 py-2 text-[10.5px] text-text outline-none placeholder:text-text-faint focus:border-pin/60 disabled:opacity-50"
        />
        <div className="flex items-center gap-1.5">
          <input
            value={author}
            disabled={!usable}
            maxLength={MAX_COMMENT_AUTHOR}
            aria-label="Comment author"
            title="Author label — persisted for future sessions"
            onChange={(e) => onAuthorChange(e.target.value)}
            className="w-[68px] flex-none rounded-[5px] border border-edge bg-bg px-1.5 py-1 text-[9.5px] text-text-mute outline-none focus:border-accent disabled:opacity-50"
          />
          <select
            value={laneByStream.has(laneId) ? laneId : ""}
            disabled={!usable}
            aria-label="Pin comment to lane"
            onChange={(e) => setLaneId(e.target.value)}
            className="min-w-0 flex-1 rounded-[5px] border border-edge bg-bg px-1 py-1 text-[9.5px] text-text-mute outline-none focus:border-accent disabled:opacity-50"
          >
            <option value="">take-wide</option>
            {lanes.map((lane) => (
              <option key={lane.streamId} value={lane.streamId}>
                {lane.name}
              </option>
            ))}
          </select>
          <span className="flex-none font-mono text-[9px] text-text-faint" title="Anchor time">
            @ <span className={anchorSec !== null ? "text-pin" : ""}>{formatAt(atSec)}</span>
          </span>
        </div>
      </form>
    </div>
  );
}
