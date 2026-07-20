import { Avatar } from "@/components/ui/primitives";
import AvatarStatus from "@/components/avatar-status";
import AgentAvatar from "@/components/agent-avatar";
import { SyntheticAvatar } from "@/components/synthetic-avatars";
export type MessageActor = {
  id?: string | null;
  username: string;
  // "human" | "agent" | "system" | "synthetic". A "synthetic" actor is a
  // masked non-owner identity (see `synthetic`) and never carries a real agent.
  kind: string;
  name?: string | null;
  avatarUpdatedAt?: Date | string | null;
  agent?: {
    slug?: string | null;
    name?: string | null;
    avatar?: string | null;
  } | null;
  // Marks a synthetic (non-owner) identity: "review" = Feedback / Review,
  // "monitor" = Monitor. Set only by the actor-visibility projectors.
  synthetic?: "review" | "monitor" | null;
};

// Subtle, theme-aware restyle metadata for a comment/message authored by a
// synthetic identity (member view). Returns null for owners and for
// human/agent/system actors, so callers apply no treatment there.
export function syntheticRoleMeta(
  actor: MessageActor,
): { label: string; accentClass: string; chipClass: string } | null {
  if (actor.kind !== "synthetic") return null;
  if (actor.synthetic === "monitor") {
    return {
      label: "Monitor",
      accentClass: "border-l-2 border-l-line-strong",
      chipClass: "border border-line-strong bg-bg-elev text-text-muted",
    };
  }
  return {
    label: "Feedback / Review",
    accentClass: "border-l-2 border-l-accent",
    chipClass: "border border-accent/30 bg-accent-soft text-accent",
  };
}

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
  if (actor.kind === "synthetic") return actor.name ?? actor.username;
  if (actor.kind === "agent") {
    return actor.agent?.name ?? actor.name ?? actor.username;
  }
  return actor.name ?? actor.username;
}

function actorAvatarSrc(actor: MessageActor) {
  if (actor.kind === "synthetic") return null;
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
  title,
}: {
  actor: MessageActor;
  size?: "sm" | "md";
  busy?: boolean;
  // Optional tooltip override (e.g. "Built by X"); defaults to the actor name.
  title?: string;
}) {
  if (actor.kind === "system") {
    return (
      <Avatar
        size={size}
        shape="square"
        className="border-accent bg-accent text-bg"
        title={title ?? actorDisplayName(actor)}
        aria-label={`${actorDisplayName(actor)} avatar`}
      >
        Z
      </Avatar>
    );
  }

  const src = actorAvatarSrc(actor);
  const label = actorDisplayName(actor);
  const tooltip = title ?? label;
  const sizeClass = size === "sm" ? "h-8 w-8" : "h-11 w-11 md:h-9 md:w-9";

  if (actor.kind === "synthetic") {
    // Masked non-owner identity: stylish inline glyph, no photo, no live
    // presence pulse (synthetics have no slug to subscribe).
    const glyphKind = actor.synthetic === "monitor" ? "monitor" : "review";
    const tone = glyphKind === "monitor" ? "text-text" : "text-accent";
    return (
      <AvatarStatus status="none" sizeClass={sizeClass} roundedClass="rounded-full" title={tooltip}>
        <span className={`grid h-full w-full place-items-center ${tone}`} aria-label={`${label} avatar`}>
          <SyntheticAvatar kind={glyphKind} className="h-[58%] w-[58%]" />
        </span>
      </AvatarStatus>
    );
  }
  const inner = (
    <Avatar
      size={size}
      title={tooltip}
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
  );
  if (actor.kind === "agent") {
    // Live presence: the slug subscribes this avatar to the presence stream;
    // the server-computed `busy` flag is only the SSR/first-paint hint.
    return (
      <AgentAvatar
        slug={actor.agent?.slug ?? null}
        name={label}
        sizeClass={sizeClass}
        roundedClass="rounded-full"
        title={tooltip}
        initialStatus={busy ? "busy" : undefined}
      >
        {inner}
      </AgentAvatar>
    );
  }
  return (
    <AvatarStatus status="none" sizeClass={sizeClass} roundedClass="rounded-full" title={tooltip}>
      {inner}
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
