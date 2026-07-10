import type { ReactNode } from "react";
import { cx } from "./cx";

const VARIANTS = {
  accent: "bg-accent text-white hover:brightness-110",
  outline: "border border-edge-strong text-text hover:bg-card-hi",
  rec: "bg-rec text-white hover:brightness-110",
};

export function Button({
  variant = "outline",
  className,
  disabled,
  onClick,
  children,
}: {
  variant?: keyof typeof VARIANTS;
  className?: string;
  disabled?: boolean;
  onClick?: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cx(
        "rounded-md px-4 py-2 text-[12px] font-semibold transition-[filter,background-color]",
        "disabled:cursor-not-allowed disabled:opacity-40",
        VARIANTS[variant],
        className,
      )}
    >
      {children}
    </button>
  );
}
