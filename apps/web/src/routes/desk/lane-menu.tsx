// Lane context menu (right-click on a sidebar row header or mixer strip):
// Move up/down write the shared-doc lane order, Solo/Mute mirror the strip's
// S/M buttons, Delete only STAGES recorded clips behind the confirm dialog.

import { useLayoutEffect, useRef, useState } from "react";
import { cx, SectionLabel } from "../../components";

/** Where and for which lane the menu is open (index.tsx owns the state). */
export interface LaneMenuState {
  laneKey: string;
  x: number;
  y: number;
}

export function LaneContextMenu({
  laneName,
  x,
  y,
  canMoveUp,
  canMoveDown,
  soloed,
  muted,
  deletableClipCount,
  onMoveUp,
  onMoveDown,
  onSolo,
  onMute,
  onDelete,
  onClose,
}: {
  laneName: string;
  /** Cursor position (viewport px) — clamped so the menu never clips. */
  x: number;
  y: number;
  canMoveUp: boolean;
  canMoveDown: boolean;
  soloed: boolean;
  muted: boolean;
  /** Recorded (non-live) clips a delete would stage; 0 disables Delete. */
  deletableClipCount: number;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onSolo: () => void;
  onMute: () => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState({ x, y });

  // Clamp into the viewport and land focus on the first enabled item so
  // arrows/Enter work immediately.
  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setPos({
      x: Math.max(4, Math.min(x, window.innerWidth - rect.width - 4)),
      y: Math.max(4, Math.min(y, window.innerHeight - rect.height - 4)),
    });
    el.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  }, [x, y]);

  const enabledItems = (): HTMLButtonElement[] =>
    Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []);

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose();
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End", "Tab"].includes(e.key)) return;
    e.preventDefault();
    const items = enabledItems();
    if (items.length === 0) return;
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      e.key === "Home"
        ? 0
        : e.key === "End"
          ? items.length - 1
          : e.key === "ArrowDown" || (e.key === "Tab" && !e.shiftKey)
            ? (at + 1) % items.length
            : (at - 1 + items.length) % items.length;
    items[next]?.focus();
  }

  const pick = (action: () => void) => () => {
    onClose();
    action();
  };

  /** Right-click while open re-anchors in ONE gesture (native-menu
   * behavior): close, then forward the cursor position to whatever sits
   * underneath — backdrop and panel both carry data-lane-menu so the
   * hit-test skips the whole overlay. The forwarded event is synthetic,
   * so no browser menu can appear. */
  function reanchorContextMenu(e: React.MouseEvent) {
    e.preventDefault();
    onClose();
    const under = document
      .elementsFromPoint(e.clientX, e.clientY)
      .find((el) => !el.closest("[data-lane-menu]"));
    under?.dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        clientX: e.clientX,
        clientY: e.clientY,
      }),
    );
  }

  return (
    <>
      {/* Not the shared PopoverBackdrop: this one must carry data-lane-menu
          and the re-anchor contextmenu handler. */}
      <button
        type="button"
        aria-label="Close lane menu"
        data-lane-menu
        tabIndex={-1}
        onClick={onClose}
        onContextMenu={reanchorContextMenu}
        className="fixed inset-0 z-[30] cursor-default"
      />
      <div
        ref={menuRef}
        role="menu"
        aria-label={`${laneName} lane menu`}
        data-lane-menu
        onKeyDown={onKeyDown}
        onContextMenu={reanchorContextMenu}
        className="fixed z-[31] w-[172px] rounded-lg border border-edge-card bg-card p-1 shadow-[0_10px_28px_rgba(0,0,0,.55)]"
        style={{ left: pos.x, top: pos.y }}
      >
        {/* Strict menu ARIA: the label header is presentational chrome, the
            dividers are real <hr> separators — only menuitems are items. */}
        <div role="presentation" className="truncate px-2.5 pt-1 pb-0.5">
          <SectionLabel>{laneName}</SectionLabel>
        </div>
        <MenuItem
          label="Move up"
          disabled={!canMoveUp}
          disabledTitle="Already the first lane"
          onPick={pick(onMoveUp)}
        />
        <MenuItem
          label="Move down"
          disabled={!canMoveDown}
          disabledTitle="Already the last lane"
          onPick={pick(onMoveDown)}
        />
        <hr className="mx-1.5 my-1 h-px border-0 bg-divider" />
        <MenuItem label="Solo" hint="S" checked={soloed} tone="teal" onPick={pick(onSolo)} />
        <MenuItem label="Mute" hint="M" checked={muted} tone="gold" onPick={pick(onMute)} />
        <hr className="mx-1.5 my-1 h-px border-0 bg-divider" />
        <MenuItem
          label="Delete"
          hint={`${deletableClipCount} clip${deletableClipCount === 1 ? "" : "s"}`}
          danger
          disabled={deletableClipCount === 0}
          disabledTitle="No recorded clips on this lane"
          onPick={pick(onDelete)}
        />
      </div>
    </>
  );
}

function MenuItem({
  label,
  hint,
  checked,
  tone,
  danger,
  disabled,
  disabledTitle,
  onPick,
}: {
  label: string;
  /** Mono side note: the shortcut key (S/M) or what Delete would stage. */
  hint?: string;
  /** Present ⇒ menuitemcheckbox with a state dot (solo teal, mute gold). */
  checked?: boolean;
  tone?: "teal" | "gold";
  danger?: boolean;
  disabled?: boolean;
  /** Why the item can't apply right now — shown on hover, honestly. */
  disabledTitle?: string;
  onPick: () => void;
}) {
  return (
    <button
      type="button"
      role={checked !== undefined ? "menuitemcheckbox" : "menuitem"}
      {...(checked !== undefined ? { "aria-checked": checked } : {})}
      disabled={disabled ?? false}
      {...(disabled && disabledTitle ? { title: disabledTitle } : {})}
      onClick={onPick}
      className={cx(
        "flex w-full items-center justify-between gap-3 rounded-md px-2.5 py-1.5 text-left text-[11px] font-semibold",
        danger ? "text-rec hover:bg-rec/10" : "text-text-strong hover:bg-card-hi",
        "disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent",
      )}
    >
      <span className="flex items-center gap-1.5">
        {checked !== undefined && (
          <span
            className={cx(
              "size-[5px] flex-none rounded-full",
              checked
                ? tone === "teal"
                  ? "bg-track-teal"
                  : "bg-track-gold"
                : "border border-edge-strong",
            )}
          />
        )}
        {label}
      </span>
      {hint && <span className="font-mono text-[9px] text-text-faint">{hint}</span>}
    </button>
  );
}
