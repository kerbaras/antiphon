import { Wordmark } from "../../components";

export function JoinHeader({ uuid, label }: { uuid: string | undefined; label: string }) {
  return (
    <header className="flex items-center justify-between border-b border-divider pb-3">
      <Wordmark />
      <div className="flex flex-col items-end leading-tight">
        <span className="text-[10px] text-text-dim">{label}</span>
        <span className="font-mono text-[10px] text-text-mute">
          {uuid ? `${uuid.slice(0, 8)}…` : "no session"}
        </span>
      </div>
    </header>
  );
}
