// Description drafts — requester-bound, heartbeat-reaped.
//
// HOMELAB-41 / item 4: replaces the prior filesystem-based draft store at
// .data/drafts/<scope>-<id>.txt. That store had three problems:
//   1) the draft was visible to every viewer of the task/epic, not just
//      the person who clicked "Ask AI to update description";
//   2) it persisted indefinitely until rolled back or applied;
//   3) it survived the requester closing the page before the agent
//      finished, leaving a stale "draft" the requester never saw.
//
// Now drafts live in the DescriptionDraft table, keyed by
// (scope, targetId, requesterUserId). The page heartbeats every 15s while
// open (via /api/system/description-draft/heartbeat) bumping lastSeenAt,
// and any read opportunistically purges rows whose lastSeenAt is older
// than the freshness window — so if the requester closes the page before
// the agent answers, the eventual draft write is reaped within ~1 minute
// before any other reader can see it.
//
// expiresAt provides a backstop in case heartbeats fail silently.

import { db } from "@/lib/db";

export const DESCRIPTION_DRAFT_TTL_MS = 30 * 60 * 1000;     // 30 minutes
export const DESCRIPTION_DRAFT_STALE_MS = 60 * 1000;        // 60 seconds without a heartbeat = closed page

export type DraftScope = "task" | "epic";

// Lazy reaper — runs at most every 5s within a process. Drops rows that
// either expired by clock or went stale by heartbeat. SQLite + low row
// volume makes this cheap.
let lastPurgeAt = 0;
async function purgeStaleDescriptionDrafts() {
  const now = Date.now();
  if (now - lastPurgeAt < 5_000) return;
  lastPurgeAt = now;
  try {
    await db.descriptionDraft.deleteMany({
      where: {
        OR: [
          { expiresAt: { lt: new Date(now) } },
          { lastSeenAt: { lt: new Date(now - DESCRIPTION_DRAFT_STALE_MS) } },
        ],
      },
    });
  } catch (err) {
    console.warn("[description-drafts] purge failed", err);
  }
}

export async function saveDescriptionDraft(args: {
  scope: DraftScope;
  targetId: string;
  requesterUserId: string;
  agentSlug: string;
  body: string;
}) {
  await purgeStaleDescriptionDrafts();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + DESCRIPTION_DRAFT_TTL_MS);
  await db.descriptionDraft.upsert({
    where: {
      scope_targetId_requesterUserId: {
        scope: args.scope,
        targetId: args.targetId,
        requesterUserId: args.requesterUserId,
      },
    },
    create: {
      scope: args.scope,
      targetId: args.targetId,
      requesterUserId: args.requesterUserId,
      agentSlug: args.agentSlug,
      body: args.body,
      createdAt: now,
      lastSeenAt: now,
      expiresAt,
    },
    update: {
      agentSlug: args.agentSlug,
      body: args.body,
      lastSeenAt: now,
      expiresAt,
    },
  });
}

// Returns the requester's own draft if one exists and is still alive (not
// expired, not stale). Anyone other than the requester always sees null.
export async function getDescriptionDraft(args: {
  scope: DraftScope;
  targetId: string;
  requesterUserId: string;
}): Promise<string | null> {
  await purgeStaleDescriptionDrafts();
  const now = new Date();
  const row = await db.descriptionDraft.findUnique({
    where: {
      scope_targetId_requesterUserId: {
        scope: args.scope,
        targetId: args.targetId,
        requesterUserId: args.requesterUserId,
      },
    },
    select: { body: true, expiresAt: true, lastSeenAt: true },
  });
  if (!row) return null;
  if (row.expiresAt < now) return null;
  if (row.lastSeenAt < new Date(now.getTime() - DESCRIPTION_DRAFT_STALE_MS)) {
    return null;
  }
  return row.body;
}

// Bump lastSeenAt for the requester's own draft (idempotent no-op if no
// draft exists). Called by the heartbeat endpoint while the page is open.
export async function touchDescriptionDraft(args: {
  scope: DraftScope;
  targetId: string;
  requesterUserId: string;
}) {
  try {
    await db.descriptionDraft.updateMany({
      where: {
        scope: args.scope,
        targetId: args.targetId,
        requesterUserId: args.requesterUserId,
      },
      data: { lastSeenAt: new Date() },
    });
  } catch (err) {
    console.warn("[description-drafts] heartbeat failed", err);
  }
}

// Removes the requester's draft for this item (e.g. rollback button or a
// successful Save apply). If requesterUserId is omitted, clears every
// draft on the item — used when the underlying entity is deleted.
export async function deleteDescriptionDraft(args: {
  scope: DraftScope;
  targetId: string;
  requesterUserId?: string;
}) {
  if (args.requesterUserId) {
    await db.descriptionDraft.deleteMany({
      where: {
        scope: args.scope,
        targetId: args.targetId,
        requesterUserId: args.requesterUserId,
      },
    });
    return;
  }
  await db.descriptionDraft.deleteMany({
    where: { scope: args.scope, targetId: args.targetId },
  });
}
