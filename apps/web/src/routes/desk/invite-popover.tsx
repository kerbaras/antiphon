// Invite popover, anchored to the avatar stack's "+": join QR + link +
// copy-link. Auth mode also carries the desk-access section — one popover,
// both capability classes. Keyless renders exactly the mic half.

import { useEffect, useRef, useState } from "react";
import { useAuthMode } from "../../auth/auth-root";
import {
  PopoverBackdrop,
  PopoverCard,
  SectionLabel,
  StyledQr,
  useEscapeToClose,
} from "../../components";
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
  // and the desk-access form (auth mode) is a Tab away — never stolen into.
  useEffect(() => copyRef.current?.focus(), []);
  useEscapeToClose(onClose);

  function copy() {
    void navigator.clipboard.writeText(joinUrl).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_500);
    });
  }

  return (
    <>
      <PopoverBackdrop label="Close invite popover" onClose={() => onClose(false)} />
      <PopoverCard
        // Keyless carries exactly the mic invite (today's name); auth mode
        // names both capabilities.
        label={authMode === "clerk" ? "Invite & access" : "Invite performers"}
        className={authMode === "clerk" ? "w-[264px]" : "w-[236px]"}
      >
        <SectionLabel className="pb-1">Invite performers</SectionLabel>
        {/* Capability copy: mic join is public by link — true in both auth
            modes. Desk access is the section below, auth only. */}
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
      </PopoverCard>
    </>
  );
}
