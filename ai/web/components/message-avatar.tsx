import { Avatar } from "@/components/ui/primitives";
import AvatarStatus from "@/components/avatar-status";
export type MessageActor = {
  id?: string | null;
  username: string;
  kind: string;
  name?: string | null;
  avatarUpdatedAt?: Date | string | null;
  agent?: {
    slug?: string | null;
    name?: string | null;
    avatar?: string | null;
  } | null;
};

function avatarStamp(value: Date | string | null | undefined): number | null {
  if (!value) return null;
  if (value instanceof Date) return value.getTime();
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function agentAvatarUrl(name: string) {
  let first = name.split(" ")[0] || name;
  if (first.startsWith("@")) {
    first = first.slice(1);
  }
  if (first.length > 0) {
    first = first.charAt(0).toUpperCase() + first.slice(1);
  }
  return `/agents/avatars/${encodeURIComponent(first)}?v=agent-image-v2`;
}

export function actorDisplayName(actor: MessageActor) {
  if (actor.kind === "system") return actor.name ?? "System";
  if (actor.kind === "agent") {
    return actor.agent?.name ?? actor.name ?? actor.username;
  }
  return actor.name ?? actor.username;
}

function actorAvatarSrc(actor: MessageActor) {
  if (actor.kind === "agent") {
    const agentName = actor.agent?.name ?? actor.name;
    if (actor.agent?.avatar && agentName) return agentAvatarUrl(agentName);
    return null;
  }

  const stamp = avatarStamp(actor.avatarUpdatedAt);
  if (actor.id && stamp) return `/api/users/${actor.id}/avatar?v=${stamp}`;
  return null;
}

function initialFor(actor: MessageActor) {
  const label = actorDisplayName(actor).trim() || actor.username;
  return label.slice(0, 1).toUpperCase();
}

export function MessageAvatar({
  actor,
  size = "md",
  busy = false,
}: {
  actor: MessageActor;
  size?: "sm" | "md";
  busy?: boolean;
}) {
  if (actor.kind === "system") {
    return (
      <Avatar
        size={size}
        shape="square"
        className="border-accent bg-accent text-white"
        title={actorDisplayName(actor)}
        aria-label={`${actorDisplayName(actor)} avatar`}
      >
        Z
      </Avatar>
    );
  }

  const src = actorAvatarSrc(actor);
  const label = actorDisplayName(actor);
  const sizeClass = size === "sm" ? "h-8 w-8" : "h-11 w-11 md:h-9 md:w-9";
  return (
    <AvatarStatus status={busy && actor.kind === "agent" ? "busy" : "none"} sizeClass={sizeClass} roundedClass="rounded-full" title={label}>
      <Avatar
        size={size}
        title={label}
        aria-label={`${label} avatar`}
        className="border-0"
      >
        {src ? (
          <img
            src={src}
            alt=""
            loading="lazy"
            decoding="async"
            className="h-full w-full object-cover"
          />
        ) : (
          <span>{initialFor(actor)}</span>
        )}
      </Avatar>
    </AvatarStatus>
  );
}

function coerceDate(value: Date | string) {
  return value instanceof Date ? value : new Date(value);
}

function relativeTime(date: Date) {
  const diff = Math.max(0, (Date.now() - date.getTime()) / 1000);
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 86400 * 30) return `${Math.floor(diff / 86400)}d ago`;
  return date.toLocaleDateString("en-AU", { day: "2-digit", month: "short" });
}

function absoluteTime(date: Date) {
  return date.toLocaleString("en-AU", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function shortClock(date: Date) {
  return date.toLocaleString("en-AU", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function MessageTimestamp({ value }: { value: Date | string }) {
  const date = coerceDate(value);
  const iso = Number.isFinite(date.getTime()) ? date.toISOString() : "";

  return (
    <time
      dateTime={iso}
      title={Number.isFinite(date.getTime()) ? absoluteTime(date) : undefined}
      className="inline-flex items-center gap-1 rounded-full border border-line bg-bg/80 px-2 py-0.5 text-nano font-medium normal-case tracking-normal text-text-muted tabular-nums"
    >
      <span>{Number.isFinite(date.getTime()) ? relativeTime(date) : "unknown"}</span>
      {Number.isFinite(date.getTime()) ? (
        <>
          <span className="hidden text-line sm:inline" aria-hidden="true">
            /
          </span>
          <span className="hidden sm:inline">{shortClock(date)}</span>
        </>
      ) : null}
    </time>
  );
}
