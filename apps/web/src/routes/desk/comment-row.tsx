// One comment row for the comments panel: amber dot (dimmed once
// resolved), author, seekable timecode, lane chip when stream-pinned, the
// note (double-click edits), resolve/reopen check, delete on hover.

import { useRef, useState } from "react";
import { MAX_COMMENT_TEXT, type TakeComment } from "./comments";
import { formatAt } from "./format";

export interface CommentLane {
  streamId: string;
  name: string;
  color: string;
}

export function CommentRow({
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
