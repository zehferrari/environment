// Shared Prisma `select` + serializer for a chat message sender, used by both
// the server-rendered chat page and the incremental reconcile-poll API route so
// the two always return the same sender shape. Keeping them in lockstep matters:
// the client swaps server-rendered messages for polled ones, so a drift here
// would flicker avatars/names after the first poll.

export const messageSenderSelect = {
  id: true,
  username: true,
  kind: true,
  name: true,
  avatarUpdatedAt: true,
  agent: { select: { slug: true, name: true, avatar: true } },
} as const;

export function serializeSender(sender: {
  id: string;
  username: string;
  kind: string;
  name: string | null;
  avatarUpdatedAt: Date | null;
  agent: { slug: string; name: string; avatar: string | null } | null;
}) {
  return {
    id: sender.id,
    username: sender.username,
    kind: sender.kind,
    name: sender.name,
    avatarUpdatedAt: sender.avatarUpdatedAt?.toISOString() ?? null,
    agent: sender.agent,
  };
}
