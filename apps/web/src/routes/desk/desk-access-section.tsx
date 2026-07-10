// Desk-access section of the invite popover (auth mode only). Owner-only
// management: add/list/revoke emails against the owner-gated shares API;
// sharees see a read-only line. The mic capability (QR/link) lives above.

import { useCallback, useEffect, useState } from "react";
import { SectionLabel } from "../../components";
import { authFetch } from "../../net/auth-token";

interface ShareEntry {
  email: string;
}

type ShareState =
  | { kind: "loading" }
  | { kind: "not-owner" }
  | { kind: "error" }
  | { kind: "owner"; shares: ShareEntry[] };

export function DeskAccessSection({ sessionId }: { sessionId: string }) {
  const [state, setState] = useState<ShareState>({ kind: "loading" });
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

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
        return;
      }
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      setAddError(body?.error ?? "couldn't share — try again");
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
    <div className="mt-2.5 border-t border-divider pt-2.5">
      <SectionLabel className="pb-1">Desk access</SectionLabel>
      <p className="pb-2 font-mono text-[9px] leading-relaxed text-text-faint">
        full console powers — mix, edit, export. granted to signed-in accounts by email; the mic
        invite above needs none.
      </p>

      {state.kind === "loading" && <p className="font-mono text-[9px] text-text-faint">loading…</p>}
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
  );
}
