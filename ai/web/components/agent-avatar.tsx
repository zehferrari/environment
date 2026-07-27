"use client";

// The one live agent avatar. Renders through AvatarStatus (which owns the
// pulse/unread markup) but sources its status from the live presence store via
// useAgentStatus, so a busy flip pulses everywhere without a page refresh.
// First paint uses `initialStatus` (the server-render value); the store takes
// over after hydration. Humans (no slug) just render initialStatus/none.

import type { ReactNode } from "react";
import AvatarStatus, { avatarStatusTone } from "@/components/avatar-status";
import { useAgentStatus } from "@/components/agent-presence-provider";

export default function AgentAvatar({
  slug,
  name,
  src,
  sizeClass = "h-8 w-8",
  roundedClass = "rounded-lg",
  className = "",
  initialStatus,
  unread = false,
  title,
  fallback,
  pulse,
  children,
}: {
  slug?: string | null;
  name: string;
  src?: string | null;
  sizeClass?: string;
  roundedClass?: string;
  className?: string;
  initialStatus?: string | null;
  unread?: boolean;
  title?: string;
  /** Shown when there is no image; defaults to the name's first character. */
  fallback?: ReactNode;
  /** Scope the pulse to a context (e.g. a board card pulsing only on the task an
   *  agent is actively working). When omitted the pulse follows live busy. */
  pulse?: boolean;
  /** Full custom inner content (e.g. an Avatar primitive); wins over src/fallback. */
  children?: ReactNode;
}) {
  const status = useAgentStatus(slug, initialStatus);
  const tone = avatarStatusTone(status);
  return (
    <AvatarStatus
      status={status}
      sizeClass={sizeClass}
      roundedClass={roundedClass}
      className={className}
      title={title}
      unread={unread}
      pulse={pulse}
    >
      {children ??
        (src ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={src}
            alt={`${name} avatar`}
            decoding="async"
            className={`h-full w-full object-cover ${tone.grayscale ? "grayscale" : ""}`}
          />
        ) : (
          fallback ?? name.slice(0, 1)
        ))}
    </AvatarStatus>
  );
}
