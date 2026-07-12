import type { MessageActor } from "@/components/message-avatar";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import type { Viewer } from "@/lib/auth/permissions";

export type ActorRow = {
  id: string;
  username: string;
  kind: string;
  name: string | null;
  avatarUpdatedAt: Date | string | null;
  agent: { slug?: string | null; name?: string | null; avatar?: string | null } | null;
};

export type ActorVisibility = {
  maskAgents: boolean;
  owner: ActorRow | null;
};

export type VisibleMessageActor = Omit<MessageActor, "id"> & { id: string };

export async function getActorVisibility(viewer: Viewer): Promise<ActorVisibility> {
  if (viewer.isOwner) {
    return { maskAgents: false, owner: null };
  }

  const owner = await db.user.findFirst({
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
  });
  return { maskAgents: true, owner };
}

export function visibleActor<T extends ActorRow>(
  actor: T | null | undefined,
  visibility: ActorVisibility,
): ActorRow | T | null {
  if (!actor) return null;
  if (!visibility.maskAgents || actor.kind !== "agent") return actor;
  return visibility.owner;
}

export function serializeVisibleActor(
  actor: ActorRow | null | undefined,
  visibility: ActorVisibility,
): VisibleMessageActor | null {
  const projected = visibleActor(actor, visibility);
  if (!projected) return null;
  return {
    id: projected.id,
    username: projected.username,
    kind: projected.kind,
    name: projected.name,
    avatarUpdatedAt: projected.avatarUpdatedAt instanceof Date
      ? projected.avatarUpdatedAt.toISOString()
      : projected.avatarUpdatedAt ?? null,
    agent: projected.kind === "agent" ? projected.agent : null,
  };
}

const AGENT_SESSION_ACTIVITY = /(^agent\.|^pm\.|\.action_plan(?:\.|$)|\.chat(?:\.|$)|\.comment(?:\.|$)|\.dispatch(?:_|\.|$)|\.stream(?:_|\.|$)|\.workflow(?:\.|$)|\.wake(?:\.|$))/;

/**
 * SQL counterpart of visibleActivityRows. Apply it before pagination so
 * hidden agent/session rows cannot consume a member's activity-feed limit.
 */
export function visibleActivityWhere(viewer: Viewer): Prisma.ActivityLogWhereInput {
  if (viewer.isOwner) return {};
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
  user: { kind: string } | null;
};

export function visibleActivityRows<T extends ActivityRowWithActor>(
  rows: readonly T[],
  visibility: ActorVisibility,
): T[] {
  if (!visibility.maskAgents) return [...rows];

  return rows
    .filter((row) => !row.targetAgent && !AGENT_SESSION_ACTIVITY.test(row.kind))
    .map((row) => ({
      ...row,
      payload: null,
      targetAgent: null,
      user: row.user?.kind === "agent" ? visibility.owner : row.user,
    })) as T[];
}
