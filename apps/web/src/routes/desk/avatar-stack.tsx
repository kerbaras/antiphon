import type { Ref } from "react";
import { AvatarImg, cx } from "../../components";

/** Overlapping presence avatars + the "+" invite button. Avatars shed
 * below 640px (the performers rail carries the roster); the "+" stays. */
export function AvatarStack({
  people,
  onAdd,
  addRef,
  addExpanded,
}: {
  /** `id` is the stable identity — titles may repeat. */
  people: Array<{
    id: string;
    initials: string;
    color: string;
    title: string;
    avatarUrl?: string | null;
  }>;
  onAdd?: () => void;
  /** The "+" anchors the invite popover; the opener owns aria-expanded
   * and gets the element so Escape can hand focus back. */
  addRef?: Ref<HTMLButtonElement>;
  addExpanded?: boolean;
}) {
  return (
    <div className="flex items-center">
      {people.map((p, i) => (
        <div
          key={p.id}
          title={p.title}
          className={cx(
            "relative hidden size-[26px] place-items-center rounded-full border-2 border-panel min-[640px]:grid",
            "text-[9.5px] font-bold text-void",
            i > 0 && "-ml-[7px]",
          )}
          style={{ background: p.color }}
        >
          {p.initials}
          {p.avatarUrl && <AvatarImg src={p.avatarUrl} />}
        </div>
      ))}
      <button
        ref={addRef}
        type="button"
        aria-label="Invite performer"
        aria-haspopup="dialog"
        aria-expanded={addExpanded ?? false}
        onClick={onAdd}
        className="grid size-[26px] place-items-center rounded-full border-2 border-panel bg-card-hi text-[11px] text-text-dim hover:text-text min-[640px]:-ml-[7px]"
      >
        +
      </button>
    </div>
  );
}
