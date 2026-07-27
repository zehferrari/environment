import type { ReactNode } from "react";

export type AvatarStatusTone = "busy" | "live" | "idle" | "stale" | "offline" | "registered" | "none";

export function avatarStatusTone(status: string | null | undefined): { grayscale: boolean; pulse: boolean } {
  return {
    grayscale: status === "stale" || status === "offline",
    pulse: status === "busy",
  };
}

export default function AvatarStatus({
  status = "none",
  sizeClass = "h-8 w-8",
  roundedClass = "rounded-lg",
  className = "",
  title,
  unread = false,
  pulse,
  children,
}: {
  status?: AvatarStatusTone | string | null;
  sizeClass?: string;
  roundedClass?: string;
  className?: string;
  title?: string;
  unread?: boolean;
  /** Explicit pulse override. When omitted the pulse follows `status === "busy"`;
   *  callers that scope the pulse to a context (e.g. a board card pulsing only on
   *  the task an agent is actively working) pass it directly. */
  pulse?: boolean;
  children: ReactNode;
}) {
  const tone = avatarStatusTone(status);
  const showPulse = pulse ?? tone.pulse;
  return (
    <span className={`relative inline-grid shrink-0 ${sizeClass}`} title={title}>
      {showPulse ? (
        <span
          className={`pointer-events-none absolute -inset-1 animate-ping ${roundedClass} bg-accent opacity-30`}
          aria-hidden="true"
        />
      ) : null}
      <span
        className={`relative grid h-full w-full place-items-center overflow-hidden border border-line bg-panel-soft text-caption font-semibold text-text ${roundedClass} ${className}`}
      >
        {typeof children === "string" ? children : children}
      </span>
      {unread ? (
        <span
          className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full border border-panel bg-red-500"
          title="Unread messages"
          aria-label="Unread messages"
        />
      ) : null}
    </span>
  );
}
