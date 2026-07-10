// Anchored-popover chrome shared by the desk's popovers/menus: click-away
// backdrop + window-level Escape (focus inside a card often parks on
// <body>, where a local onKeyDown never hears the key).

import { type ReactNode, useEffect } from "react";
import { cx } from "./cx";

/** Window Escape → onClose(true); the opener restores its own focus. */
export function useEscapeToClose(onClose: (restoreFocus: boolean) => void): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
}

/** Full-screen click-away layer; pointer dismissals don't restore focus. */
export function PopoverBackdrop({
  label,
  onClose,
  zIndex = "z-[19]",
}: {
  label: string;
  onClose: () => void;
  zIndex?: string;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      tabIndex={-1}
      onClick={onClose}
      className={cx("fixed inset-0 cursor-default", zIndex)}
    />
  );
}

/** Dialog card anchored under its opener (right-aligned). */
export function PopoverCard({
  label,
  className,
  children,
}: {
  label: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      role="dialog"
      aria-label={label}
      className={cx(
        "absolute top-[calc(100%+6px)] right-0 z-[20] rounded-lg border border-edge-card bg-card p-3 shadow-[0_10px_28px_rgba(0,0,0,.55)]",
        className,
      )}
    >
      {children}
    </div>
  );
}
