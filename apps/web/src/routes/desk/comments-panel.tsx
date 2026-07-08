// Right-rail Comments panel (W2-F): timestamped notes with a resolve flow.

import { useEffect, useMemo, useRef, useState } from "react";
import { SectionLabel } from "../../ui/kit";
import { MAX_COMMENT_AUTHOR, MAX_COMMENT_TEXT, type TakeComment } from "./comments";
import { formatAt } from "./format";

export interface CommentLane {
  streamId: string;
  name: string;
  color: string;
}

/** Right-rail comments list + composer. Rows: amber dot (dimmed once
 * resolved), author, seekable timecode, lane chip when stream-pinned, the
 * note, a resolve/reopen check, delete on hover. The composer at the foot
 * anchors a note at the playhead the moment typing starts — not at Enter:
 * playback keeps rolling while the operator types. */
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

function CommentRow({
  comment,
  lane,
  usable,
  onSeek,
  onEditText,
  onToggleResolved,
  onRemove,
}: {
  comment: TakeComment;
  lane: CommentLane | null;
  usable: boolean;
  onSeek: () => void;
  onEditText: (text: string) => void;
  onToggleResolved: () => void;
  onRemove: () => void;
}) {
  const resolved = comment.resolvedAtMs !== null;
  const [draft, setDraft] = useState<string | null>(null);
  const cancelled = useRef(false);
  const commit = (value: string) => {
    setDraft(null);
    if (value.trim() && value.trim() !== comment.text) onEditText(value);
  };
  return (
    <div
      data-comment={comment.id}
      data-resolved={resolved}
      className={`group/comment flex flex-col gap-[3px] rounded-md border border-edge-card px-2 py-[7px] ${
        resolved ? "bg-card/50" : "bg-card hover:bg-card-hi"
      }`}
    >
      <div className="flex items-center gap-1.5">
        <span
          aria-hidden
          className={`size-[7px] flex-none rounded-full ${resolved ? "bg-pin/25" : "bg-pin"}`}
        />
        <span
          className={`min-w-0 truncate text-[10.5px] font-semibold ${
            resolved ? "text-text-dim" : "text-text-strong"
          }`}
        >
          {comment.author}
        </span>
        <button
          type="button"
          disabled={!usable}
          onClick={onSeek}
          title="Seek to comment"
          className={`flex-none font-mono text-[9px] ${
            resolved ? "text-text-faint" : "text-pin"
          } hover:text-text-hi disabled:cursor-default`}
        >
          @ {formatAt(comment.atSec)}
        </button>
        {lane && (
          <span
            data-lane={lane.streamId}
            className="flex min-w-0 items-center gap-1 rounded-[8px] border border-edge bg-bg px-1.5 py-px"
          >
            <span
              className="size-[5px] flex-none rounded-full"
              style={{ background: lane.color }}
            />
            <span className="truncate text-[8.5px] text-text-dim">{lane.name}</span>
          </span>
        )}
        <span className="ml-auto flex flex-none items-center gap-1">
          <button
            type="button"
            aria-label={`${resolved ? "Reopen" : "Resolve"} comment: ${comment.text}`}
            title={resolved ? "Reopen" : "Mark as done"}
            onClick={onToggleResolved}
            className={`grid size-4 place-items-center rounded-[4px] border text-[9px] leading-none ${
              resolved
                ? "border-ok/60 text-ok"
                : "border-edge-strong text-text-faint hover:border-ok hover:text-ok"
            }`}
          >
            ✓
          </button>
          <button
            type="button"
            aria-label={`Delete comment: ${comment.text}`}
            onClick={onRemove}
            className="hidden font-mono text-[10px] leading-none text-text-faint hover:text-rec group-hover/comment:inline"
          >
            ×
          </button>
        </span>
      </div>
      {draft !== null ? (
        <input
          // biome-ignore lint/a11y/noAutofocus: user explicitly opened the editor
          autoFocus
          value={draft}
          maxLength={MAX_COMMENT_TEXT}
          aria-label="Edit comment"
          onChange={(e) => setDraft(e.target.value)}
          onFocus={(e) => e.target.select()}
          onBlur={(e) => {
            if (cancelled.current) {
              cancelled.current = false;
              setDraft(null);
            } else {
              commit(e.target.value);
            }
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
            if (e.key === "Escape") {
              cancelled.current = true;
              e.currentTarget.blur();
            }
          }}
          className="ml-[13px] rounded-[3px] border border-accent bg-bg px-1 py-px text-[11px] text-text-hi outline-none"
        />
      ) : (
        <button
          type="button"
          onDoubleClick={() => setDraft(comment.text)}
          title="Double-click to edit"
          className={`cursor-text pl-[13px] text-left text-[11px] leading-relaxed ${
            resolved ? "text-text-faint" : "text-text-body"
          }`}
        >
          {comment.text}
        </button>
      )}
    </div>
  );
}
