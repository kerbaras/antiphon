// F2 — destructive-action confirm. Stream deletion is durable and fans out
// to every sink (rows AND blobs gone), so the Delete key must never fire
// it straight from keydown. This kit-styled alertdialog spells out exactly
// what is about to be destroyed (clip count per take, mono readouts),
// traps focus, and maps Enter=confirm / Escape=cancel. It only ADDS a
// confirmation ahead of the existing server-authoritative delete protocol
// — the never-lose-audio path itself is untouched.

import { useEffect, useRef } from "react";
import { Button, MonoReadout, Panel, SectionLabel } from "../../ui/kit";

export interface DeleteSummaryTake {
  /** Timeline name of the take ("Take 3"). */
  name: string;
  /** How many of ITS clips are selected for deletion. */
  clipCount: number;
}

export function DeleteConfirm({
  takes,
  clipCount,
  onConfirm,
  onCancel,
}: {
  takes: DeleteSummaryTake[];
  clipCount: number;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const boxRef = useRef<HTMLDivElement | null>(null);

  const trapButtons = (): HTMLButtonElement[] =>
    Array.from(boxRef.current?.querySelectorAll<HTMLButtonElement>("button") ?? []);

  // Focus lands on the confirm button: Enter confirms (native button
  // activation — so Enter on a Tab-focused Cancel still cancels, no
  // surprise destruction), Escape always cancels.
  useEffect(() => {
    const buttons = boxRef.current?.querySelectorAll<HTMLButtonElement>("button");
    buttons?.[buttons.length - 1]?.focus();
  }, []);

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onCancel();
      return;
    }
    // Focus trap: Tab cycles inside the dialog.
    if (e.key === "Tab") {
      const buttons = trapButtons();
      const first = buttons[0];
      const last = buttons[buttons.length - 1];
      if (!first || !last) return;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  }

  const clipsLabel = `${clipCount} clip${clipCount === 1 ? "" : "s"}`;

  return (
    <div className="fixed inset-0 z-[40] grid place-items-center bg-void/60">
      {/* Click-away backdrop = cancel (selection preserved). */}
      <button
        type="button"
        aria-label="Cancel deletion"
        tabIndex={-1}
        onClick={onCancel}
        className="absolute inset-0 cursor-default"
      />
      <div
        ref={boxRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="delete-confirm-title"
        aria-describedby="delete-confirm-details"
        onKeyDown={onKeyDown}
        className="relative"
      >
        <Panel className="w-[400px] p-4 shadow-[0_14px_36px_rgba(0,0,0,.6)]">
          <SectionLabel>Delete recordings</SectionLabel>
          <h2 id="delete-confirm-title" className="mt-2 text-[13px] font-bold text-text-hi">
            Delete {clipsLabel}?
          </h2>
          <div id="delete-confirm-details" className="mt-3 space-y-1.5">
            {takes.map((take) => (
              <MonoReadout
                key={take.name}
                label={take.name}
                value={`${take.clipCount} clip${take.clipCount === 1 ? "" : "s"}`}
              />
            ))}
            <p className="pt-1.5 font-mono text-[9.5px] leading-relaxed text-warn">
              Removes the recordings from every sink — server rows and blobs are deleted durably.
              There is no undo.
            </p>
          </div>
          <div className="mt-4 flex items-center justify-between gap-2">
            <span className="font-mono text-[9px] text-text-faint">enter confirm · esc cancel</span>
            <div className="flex gap-2">
              <Button variant="outline" onClick={onCancel}>
                Cancel
              </Button>
              <Button variant="rec" onClick={onConfirm}>
                Delete {clipsLabel}
              </Button>
            </div>
          </div>
        </Panel>
      </div>
    </div>
  );
}
