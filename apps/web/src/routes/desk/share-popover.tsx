// W8-A desk-access sharing (auth mode only; reached via account-cluster).
// Deliberately a SEPARATE affordance from the avatar-stack "+" invite:
// that one hands out the MIC capability (public link + QR, no account) —
// this one grants DESK access (mix/edit/export) to specific emails,
// owner-only. Both popovers say which capability they carry.
//
// Same interaction grammar as invite-popover.tsx: click-away backdrop,
// Esc restores focus to the opener, dialog card anchored under the button.

import { useCallback, useEffect, useRef, useState } from "react";
import { authFetch } from "../../net/auth-token";
import { SectionLabel } from "../../ui/kit";

interface ShareEntry {
  email: string;
}

type ShareState =
  | { kind: "loading" }
  | { kind: "not-owner" }
  | { kind: "error" }
  | { kind: "owner"; shares: ShareEntry[] };

export function SharePopover({
  sessionId,
  onClose,
}: {
  sessionId: string;
  /** `restoreFocus` is true on Esc — pointer dismissals leave focus where
   * the pointer put it. */
  onClose: (restoreFocus: boolean) => void;
}) {
  const [state, setState] = useState<ShareState>({ kind: "loading" });
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await authFetch(`/api/sessions/${sessionId}/shares`);
      if (res.status === 403) {
        setState({ kind: "not-owner" });
        return;
      }
      if (!res.ok) {
        setState({ kind: "error" });
        return;
      }
      const body = (await res.json()) as { shares: Array<{ email: string }> };
      setState({ kind: "owner", shares: body.shares });
    } catch {
      setState({ kind: "error" });
    }
  }, [sessionId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Focus the email input once management is confirmed available.
  useEffect(() => {
    if (state.kind === "owner") inputRef.current?.focus();
  }, [state.kind]);

  // Esc at the window, exactly like the invite popover (see its comment on
  // why a local onKeyDown can't work here).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      onClose(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function addShare() {
    const email = draft.trim();
    if (!email || busy) return;
    setBusy(true);
    setAddError(null);
    try {
      const res = await authFetch(`/api/sessions/${sessionId}/shares`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email }),
      });
      if (res.ok) {
        setDraft("");
        await refresh();
      } else {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        setAddError(body?.error ?? "couldn't share — try again");
      }
    } catch {
      setAddError("couldn't share — server unreachable?");
    } finally {
      setBusy(false);
    }
  }

  async function revoke(email: string) {
    try {
      await authFetch(`/api/sessions/${sessionId}/shares/${encodeURIComponent(email)}`, {
        method: "DELETE",
      });
    } finally {
      await refresh();
    }
  }

  return (
    <>
      {/* Click-away backdrop */}
      <button
        type="button"
        aria-label="Close desk access popover"
        tabIndex={-1}
        onClick={() => onClose(false)}
        className="fixed inset-0 z-[19] cursor-default"
      />
      <div
        role="dialog"
        aria-label="Desk access"
        className="absolute top-[calc(100%+6px)] right-0 z-[20] w-[264px] rounded-lg border border-edge-card bg-card p-3 shadow-[0_10px_28px_rgba(0,0,0,.55)]"
      >
        <SectionLabel className="pb-1">Desk access</SectionLabel>
        <p className="pb-2 font-mono text-[9px] leading-relaxed text-text-faint">
          full console powers — mix, edit, export. mic invites live under the ＋ and never need an
          account.
        </p>

        {state.kind === "loading" && (
          <p className="font-mono text-[9px] text-text-faint">loading…</p>
        )}
        {state.kind === "error" && (
          <p className="font-mono text-[9px] text-warn">couldn't load shares — reopen to retry</p>
        )}
        {state.kind === "not-owner" && (
          <p className="font-mono text-[10px] leading-relaxed text-text-dim">
            Only the session owner can manage desk access. You're here as a shared editor.
          </p>
        )}

        {state.kind === "owner" && (
          <>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void addShare();
              }}
              className="flex items-stretch gap-1.5"
            >
              <input
                ref={inputRef}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder="singer@example.com"
                aria-label="Share desk access by email"
                type="email"
                className="min-w-0 flex-1 rounded-md border border-edge-inset bg-bg px-2 py-1.5 font-mono text-[10px] text-text outline-none placeholder:text-text-faint focus:border-accent"
              />
              <button
                type="submit"
                disabled={busy || draft.trim() === ""}
                className="rounded-md border border-edge-strong px-2.5 text-[11px] font-semibold text-text hover:bg-card-hi disabled:cursor-not-allowed disabled:opacity-40"
              >
                Share
              </button>
            </form>
            {addError && <p className="mt-1.5 font-mono text-[9px] text-warn">{addError}</p>}

            <div className="mt-2 flex flex-col gap-1">
              {state.shares.length === 0 && (
                <p className="font-mono text-[9px] text-text-faint">
                  nobody yet — add an email above; they sign in with it and this desk appears under
                  “shared with me”
                </p>
              )}
              {state.shares.map((s) => (
                <div
                  key={s.email}
                  className="flex items-center justify-between gap-2 rounded-md border border-edge-inset bg-bg px-2 py-1"
                >
                  <span className="truncate font-mono text-[10px] text-text" title={s.email}>
                    {s.email}
                  </span>
                  <button
                    type="button"
                    aria-label={`Revoke desk access for ${s.email}`}
                    title="Revoke desk access"
                    onClick={() => void revoke(s.email)}
                    className="shrink-0 rounded px-1 font-mono text-[11px] text-text-dim hover:text-rec"
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </>
  );
}
