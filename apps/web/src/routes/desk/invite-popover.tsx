// Invite popover (W4-D): the avatar stack's "+" anchors this card — join
// QR + link + copy-link — folding the old top-bar Share button and the
// sidebar "Invite performer" toggle into the one affordance that was
// always going to survive. In auth mode it ALSO carries the desk-access
// section (add/list/revoke by email — the W8-A Share button folded in
// here too, operator ask): one popover, both capability classes, each
// stating its terms. Keyless renders exactly the mic half. Dismisses on
// click-away (the export menu's backdrop pattern) and on Esc, which hands
// focus back to the "+".

import { useEffect, useRef, useState } from "react";
import { useAuthMode } from "../../auth/auth-root";
import { SectionLabel, StyledQr } from "../../components";
import { DeskAccessSection } from "./desk-access-section";

export function InvitePopover({
  sessionId,
  joinUrl,
  onClose,
}: {
  sessionId: string;
  joinUrl: string;
  /** `restoreFocus` is true on Esc — pointer dismissals leave focus where
   * the pointer put it. */
  onClose: (restoreFocus: boolean) => void;
}) {
  const [copied, setCopied] = useState(false);
  const copyRef = useRef<HTMLButtonElement>(null);
  const authMode = useAuthMode();

  // Focus lands on the mic side's one action; the QR and link are passive
  // and the desk-access form (auth mode) is a Tab away — never stolen
  // into, even when its fetch resolves late.
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
        // Keyless carries exactly the mic invite (today's name, pinned by
        // the keyless suite); auth mode names both capabilities.
        aria-label={authMode === "clerk" ? "Invite & access" : "Invite performers"}
        className={`absolute top-[calc(100%+6px)] right-0 z-[20] rounded-lg border border-edge-card bg-card p-3 shadow-[0_10px_28px_rgba(0,0,0,.55)] ${
          authMode === "clerk" ? "w-[264px]" : "w-[236px]"
        }`}
      >
        <SectionLabel className="pb-1">Invite performers</SectionLabel>
        {/* Capability copy (W8-A): this section hands out the MIC side of
            the session — true in both auth modes: mic join is public by
            link (RFC §12). Desk access is the section below, auth only. */}
        <p className="pb-2 font-mono text-[9px] leading-relaxed text-text-faint">
          joins as a microphone — anyone with this link can sing, no account needed
        </p>
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
        {authMode === "clerk" && <DeskAccessSection sessionId={sessionId} />}
      </div>
    </>
  );
}
