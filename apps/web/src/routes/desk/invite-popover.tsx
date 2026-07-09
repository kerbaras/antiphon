// Invite popover (W4-D): the avatar stack's "+" anchors this card — join
// QR + link + copy-link — folding the old top-bar Share button and the
// sidebar "Invite performer" toggle into the one affordance that was
// always going to survive. Dismisses on click-away (the export menu's
// backdrop pattern) and on Esc, which hands focus back to the "+".

import { useEffect, useRef, useState } from "react";
import { SectionLabel, StyledQr } from "../../ui/kit";

export function InvitePopover({
  joinUrl,
  onClose,
}: {
  joinUrl: string;
  /** `restoreFocus` is true on Esc — pointer dismissals leave focus where
   * the pointer put it. */
  onClose: (restoreFocus: boolean) => void;
}) {
  const [copied, setCopied] = useState(false);
  const copyRef = useRef<HTMLButtonElement>(null);

  // Focus lands on the one action in here; the QR and link are passive.
  useEffect(() => copyRef.current?.focus(), []);

  // Esc listens at the window: a click inside the card parks focus on
  // <body> (nothing but the copy button is focusable), where a local
  // onKeyDown would never hear the key. No stopPropagation — it can't
  // shield sibling window listeners anyway; the desk's global shortcut
  // handler protects itself by exempting open [role="dialog"]s.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      onClose(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  function copy() {
    void navigator.clipboard.writeText(joinUrl).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_500);
    });
  }

  return (
    <>
      {/* Click-away backdrop */}
      <button
        type="button"
        aria-label="Close invite popover"
        tabIndex={-1}
        onClick={() => onClose(false)}
        className="fixed inset-0 z-[19] cursor-default"
      />
      <div
        role="dialog"
        aria-label="Invite performers"
        className="absolute top-[calc(100%+6px)] right-0 z-[20] w-[236px] rounded-lg border border-edge-card bg-card p-3 shadow-[0_10px_28px_rgba(0,0,0,.55)]"
      >
        <SectionLabel className="pb-2">Invite performers</SectionLabel>
        <StyledQr value={joinUrl} className="w-full" />
        <p className="mt-2 break-all font-mono text-[9px] leading-relaxed text-text-dim">
          {joinUrl}
        </p>
        <button
          ref={copyRef}
          type="button"
          onClick={copy}
          className="mt-2 w-full rounded-md border border-edge-strong px-3 py-1.5 text-[11px] font-semibold text-text hover:bg-card-hi"
        >
          {copied ? "Copied!" : "Copy link"}
        </button>
      </div>
    </>
  );
}
