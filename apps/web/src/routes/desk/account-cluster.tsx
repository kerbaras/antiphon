// W8-A top-bar account cluster (auth mode only; lazy — the only desk
// chrome that imports @clerk/react). Two affordances, deliberately
// adjacent to the avatar-stack "+" so the capability split reads at a
// glance: "+" invites MICS (public link, no account); "Share" grants DESK
// access (accounts, owner-managed); the UserButton is the operator's own
// account.

import { UserButton } from "@clerk/react";
import { useRef, useState } from "react";
import { SharePopover } from "./share-popover";

export default function AccountCluster({ sessionId }: { sessionId: string }) {
  const [shareOpen, setShareOpen] = useState(false);
  const shareAnchor = useRef<HTMLButtonElement>(null);

  return (
    <div className="flex items-center gap-3">
      <div className="relative">
        <button
          ref={shareAnchor}
          type="button"
          aria-haspopup="dialog"
          aria-expanded={shareOpen}
          onClick={() => setShareOpen(!shareOpen)}
          title="Desk access — share the console by email"
          className="rounded-md border border-edge-strong px-2.5 py-1 text-[11px] font-semibold text-text hover:bg-card-hi"
        >
          Share
        </button>
        {shareOpen && (
          <SharePopover
            sessionId={sessionId}
            onClose={(restoreFocus) => {
              setShareOpen(false);
              if (restoreFocus) shareAnchor.current?.focus();
            }}
          />
        )}
      </div>
      <UserButton />
    </div>
  );
}
