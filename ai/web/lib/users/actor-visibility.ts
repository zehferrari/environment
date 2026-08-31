import type { MessageActor } from "@/components/message-avatar";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import type { Viewer } from "@/lib/auth/permissions";

// Loose actor shape accepted by the projectors. Every Prisma `actorSelect`
// used across the app (task/epic reporter/assignee/actingManager, comment
// authors, activity `user`, …) is assignable to this, so the projectors can
// be shared without each call site converting first.
export type ActorLike = {
  id: string;
  username: string;
  kind: string;
  name?: string | null;
  avatarUpdatedAt?: Date | string | null;
  agent?: { slug?: string | null; name?: string | null; avatar?: string | null } | null;
};

export type ActorRow = {
  id: string;
  username: string;
  kind: string;
  name: string | null;
  avatarUpdatedAt: Date | string | null;
  agent: { slug?: string | null; name?: string | null; avatar?: string | null } | null;
};

export type VisibleMessageActor = Omit<MessageActor, "id"> & { id: string };

// Role a masked agent actor is playing at a given call site. Drives which
// synthetic identity a non-owner sees. `auto` is the context-free fallback
// (generic feeds): monitor agents → Monitor, every other agent → Owner.
export type ProjectionRole = "assignee" | "reviewer" | "monitor" | "auto";

// Stable synthetic sentinels. Non-owners see these instead of real agents
// acting as reviewer/acting-manager ("Feedback / Review") or the monitor
// agent ("Monitor"). They carry no agent slug/name/avatar, so nothing about a
// real agent can leak through them.
const REVIEW_ACTOR: VisibleMessageActor = {
  id: "synthetic:review",
  username: "feedback-review",
  kind: "synthetic",
  name: "Feedback / Review",
  avatarUpdatedAt: null,
  agent: null,
  synthetic: "review",
};

const MONITOR_ACTOR: VisibleMessageActor = {
  id: "synthetic:monitor",
  username: "monitor",
  kind: "synthetic",
  name: "Monitor",
  avatarUpdatedAt: null,
  agent: null,
  synthetic: "monitor",
};

const EMPTY_MONITOR_SLUGS: ReadonlySet<string> = new Set<string>();

// Real agent identity tokens (username + slug + display name) that must be
// redacted out of free text (comment bodies) shown to a non-owner member.
export type AgentIdentityToken = { username: string; slug: string | null; name: string | null };

export type ActorVisibility = {
  mode: Viewer["agentVisibility"];
  maskAgents: boolean;
  owner: ActorRow | null;
  // Slugs of agents whose registry role is "monitor" (e.g. karen). Any actor
  // whose agent.slug is in here projects to the Monitor identity regardless of
  // the requested role.
  monitorSlugs: ReadonlySet<string>;
  // Every agent's identity tokens, for body redaction (see redact-agents.ts).
  // Empty for the owner (no masking).
  agentIdentities: readonly AgentIdentityToken[];
  review: VisibleMessageActor;
  monitor: VisibleMessageActor;
};

export async function getActorVisibility(viewer: Viewer): Promise<ActorVisibility> {
  if (viewer.agentVisibility === "full") {
    return {
      mode: "full",
      maskAgents: false,
      owner: null,
      monitorSlugs: EMPTY_MONITOR_SLUGS,
      agentIdentities: [],
      review: REVIEW_ACTOR,
      monitor: MONITOR_ACTOR,
    };
  }

  const [owner, agents] = await Promise.all([
    db.user.findFirst({
      where: { kind: "human", status: "active", isOwner: true },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: {
        id: true,
        username: true,
        kind: true,
        name: true,
        avatarUpdatedAt: true,
        agent: { select: { slug: true, name: true, avatar: true } },
      },
    }),
    db.user.findMany({
      where: { kind: "agent" },
      select: { username: true, name: true, agent: { select: { slug: true, name: true, role: true } } },
    }),
  ]);
  const monitorSlugs = new Set<string>();
  const agentIdentities: AgentIdentityToken[] = [];
  for (const a of agents) {
    if (a.agent?.role === "monitor" && a.agent.slug) monitorSlugs.add(a.agent.slug);
    agentIdentities.push({
      username: a.username,
      slug: a.agent?.slug ?? null,
      name: a.agent?.name ?? a.name ?? null,
    });
  }
  return {
    mode: viewer.agentVisibility,
    maskAgents: true,
    owner,
    monitorSlugs,
    agentIdentities,
    review: REVIEW_ACTOR,
    monitor: MONITOR_ACTOR,
  };
}

function serializeActorRow(actor: ActorLike): VisibleMessageActor {
  return {
    id: actor.id,
    username: actor.username,
    kind: actor.kind,
    name: actor.name ?? null,
    avatarUpdatedAt:
      actor.avatarUpdatedAt instanceof Date
        ? actor.avatarUpdatedAt.toISOString()
        : actor.avatarUpdatedAt ?? null,
    agent: actor.kind === "agent" ? actor.agent ?? null : null,
    synthetic: null,
  };
}

export function visibleActor<T extends ActorRow>(
  actor: T | null | undefined,
  visibility: ActorVisibility,
): ActorRow | T | null {
  if (!actor) return null;
  if (!visibility.maskAgents || actor.kind !== "agent") return actor;
  if (visibility.mode === "hidden") return null;
  return visibility.owner;
}

// Role-aware projector. For the owner (or any human/system actor) the actor is
// returned as-is. For a non-owner viewing an agent actor it is masked to one of
// the three identities by role:
//   monitor agent (registry role) ....... Monitor
//   role === "monitor" .................. Monitor
//   role === "reviewer" ................. Feedback / Review
//   role === "assignee" | "auto" ........ Owner
export function serializeVisibleActorAs(
  actor: ActorLike | null | undefined,
  role: ProjectionRole,
  visibility: ActorVisibility,
): VisibleMessageActor | null {
  if (!actor) return null;
  if (!visibility.maskAgents || actor.kind !== "agent") {
    return serializeActorRow(actor);
  }
  if (visibility.mode === "hidden") return null;
  const slug = actor.agent?.slug ?? null;
  if ((slug && visibility.monitorSlugs.has(slug)) || role === "monitor") {
    return visibility.monitor;
  }
  if (role === "reviewer") {
    return visibility.review;
  }
  return visibility.owner ? serializeActorRow(visibility.owner) : null;
}

// Context-free projector kept for the many call sites that have only the actor
// (no task/role context). Agents fall back to monitor→Monitor, else Owner.
export function serializeVisibleActor(
  actor: ActorLike | null | undefined,
  visibility: ActorVisibility,
): VisibleMessageActor | null {
  return serializeVisibleActorAs(actor, "auto", visibility);
}

const AGENT_SESSION_ACTIVITY = /(^agent\.|^pm\.|\.action_plan(?:\.|$)|\.chat(?:\.|$)|\.comment(?:\.|$)|\.dispatch(?:_|\.|$)|\.stream(?:_|\.|$)|\.workflow(?:\.|$)|\.wake(?:\.|$))/;

/**
 * SQL counterpart of the activity-feed guard in visibleActivityRows. This is
 * NOT the agent-identity mask (that now lives in the actor projectors) — it is
 * the leak/pagination guard for describeActivity-driven feeds: the excluded
 * kinds render raw agent slugs inside their human-readable labels
 * (e.g. "messaged @coding-agent-a", "dispatched a turn to @…"), which non-owners
 * must never see. Applying it before pagination also stops those hidden rows
 * from consuming a member's activity-feed limit. Member content is un-hidden on
 * the surfaces that render bodies + projected avatars (comments) rather than
 * through describeActivity.
 */
export function visibleActivityWhere(viewer: Viewer): Prisma.ActivityLogWhereInput {
  if (viewer.agentVisibility === "full") return {};
  return {
    AND: [
      { targetAgent: null },
      {
        NOT: [
          { kind: { startsWith: "agent." } },
          { kind: { startsWith: "pm." } },
          { kind: { contains: ".action_plan" } },
          { kind: { contains: ".chat" } },
          { kind: { contains: ".comment" } },
          { kind: { contains: ".dispatch" } },
          { kind: { contains: ".stream" } },
          { kind: { contains: ".workflow" } },
          { kind: { contains: ".wake" } },
        ],
      },
    ],
  };
}

type ActivityRowWithActor = {
  kind: string;
  payload: string | null;
  targetAgent?: string | null;
  user: ActorLike | null;
};

export type VisibleActivityRow<T extends ActivityRowWithActor> = Omit<T, "user"> & {
  user: VisibleMessageActor | null;
};

export function visibleActivityRows<T extends ActivityRowWithActor>(
  rows: readonly T[],
  visibility: ActorVisibility,
): VisibleActivityRow<T>[] {
  // Member feed guard: drop the agent-session/plumbing rows whose labels embed
  // raw agent slugs (see visibleActivityWhere) and null their payloads, then
  // project the actor identity of every surviving row. The owner path keeps
  // every row and payload untouched; only the actor is serialized (identity is
  // unchanged for the owner because maskAgents is false).
  const source = visibility.maskAgents
    ? rows.filter((row) => !row.targetAgent && !AGENT_SESSION_ACTIVITY.test(row.kind))
    : rows;
  return source.map((row) => ({
    ...row,
    payload: visibility.maskAgents ? null : row.payload,
    targetAgent: visibility.maskAgents ? null : row.targetAgent,
    user: serializeVisibleActor(row.user, visibility),
  })) as VisibleActivityRow<T>[];
}
