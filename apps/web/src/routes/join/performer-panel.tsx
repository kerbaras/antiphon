// Nickname display + edit: persisted on the phone, prefilled on return
// visits, sent on hello, live-renameable while connected. A desk rename
// lands here too (`deskLabel` mirrors the session's view of us).

import { useEffect, useState } from "react";
import { useAuthUser } from "../../auth/use-auth-user";
import { Avatar, Button, InsetDisplay, Panel, SectionLabel } from "../../components";
import { getNickname, NICKNAME_MAX_LENGTH, normalizeNickname } from "../../net/device-identity";
import { renameSelf } from "./use-capture";

export function PerformerPanel({ deskLabel }: { deskLabel: string | null }) {
  const me = useAuthUser();
  const [name, setName] = useState(() => getNickname() ?? "");
  const [draft, setDraft] = useState<string | null>(null); // null = not editing
  const editing = draft !== null;
  // The name the desk actually sees: explicit nickname, else the signed-in
  // email (the hello's default), else unnamed.
  const effectiveName = name || me?.email || "";

  // Adopt desk-initiated renames unless the user is mid-edit.
  useEffect(() => {
    if (deskLabel !== null && !editing) setName(deskLabel);
  }, [deskLabel, editing]);

  function commit() {
    if (draft === null) return;
    // The input's maxLength is decorative for paste/programmatic writes —
    // normalize (trim + cap) at commit time.
    const trimmed = normalizeNickname(draft);
    renameSelf(trimmed);
    setName(trimmed);
    setDraft(null);
  }

  return (
    <Panel className="p-4">
      <div className="flex items-center justify-between">
        <SectionLabel>Performer</SectionLabel>
        {!editing && (
          <button
            type="button"
            onClick={() => setDraft(name)}
            className="font-mono text-[10px] font-semibold tracking-[0.5px] text-accent uppercase hover:brightness-110"
          >
            ✎ edit
          </button>
        )}
      </div>
      {editing ? (
        <div className="mt-2.5 flex items-stretch gap-2">
          <input
            // biome-ignore lint/a11y/noAutofocus: user explicitly opened the editor
            autoFocus
            value={draft}
            maxLength={NICKNAME_MAX_LENGTH}
            placeholder={me?.email ?? "Your name"}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") commit();
              if (e.key === "Escape") setDraft(null);
            }}
            className="min-w-0 flex-1 rounded-md border border-edge-inset bg-bg px-3 py-1.5 font-mono text-[14px] font-semibold text-text-hi outline-none focus:border-accent"
          />
          <Button variant="accent" className="px-3 py-1.5" onClick={commit}>
            Save
          </Button>
        </div>
      ) : (
        <button type="button" onClick={() => setDraft(name)} className="mt-2.5 block w-full">
          <div className="flex items-center gap-2">
            {me?.imageUrl && (
              <Avatar initials="" color="var(--color-card-hi)" imageUrl={me.imageUrl} />
            )}
            <InsetDisplay className="flex min-w-0 flex-1 items-baseline justify-between px-3 py-1.5">
              <span
                className={`truncate font-mono text-[15px] font-semibold tracking-[0.5px] ${
                  effectiveName ? "text-text-hi" : "text-text-faint"
                }`}
              >
                {effectiveName || "unnamed performer"}
              </span>
              <span className="ml-3 flex-none font-mono text-[9px] text-text-faint">
                {name ? "tap to edit" : "tap to set"}
              </span>
            </InsetDisplay>
          </div>
        </button>
      )}
      <p className="mt-2 text-[10px] leading-relaxed text-text-faint">
        {!name && me?.email
          ? "Your account email names this phone's track on the desk — tap to use a stage name instead."
          : "Names this phone's track on the desk. Saved for next time."}
      </p>
    </Panel>
  );
}
