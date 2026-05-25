import { db } from "@/lib/db";
import { getAgentChatUploadDir } from "@/lib/agents/direct-chat-actions";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { resolveBinTtlMs } from "@/lib/settings/system";

const DEFAULT_TTL_DAYS = 7;

export interface ChatPurgeResult {
  purgedArchives: number;
  purgedMessages: number;
  removedFolders: number;
  errors: string[];
}

export async function purgeDirectAgentChatBin(): Promise<ChatPurgeResult> {
  const cutoff = new Date(Date.now() - (await resolveBinTtlMs("PM_BIN_TTL_DAYS", DEFAULT_TTL_DAYS)));
  const result: ChatPurgeResult = {
    purgedArchives: 0,
    purgedMessages: 0,
    removedFolders: 0,
    errors: [],
  };

  try {
    const expiring = await db.directAgentChatArchive.findMany({
      where: { deletedAt: { lt: cutoff, not: null } },
      select: { id: true, agentSlug: true },
    });

    if (expiring.length === 0) {
      return result;
    }

    const archiveIds = expiring.map((a) => a.id);

    // Delete messages linked to these archives first, to avoid onDelete: SetNull trigger restoring them to active chat
    const msgDel = await db.directAgentChatMessage.deleteMany({
      where: { archiveId: { in: archiveIds } },
    });
    result.purgedMessages = msgDel.count;

    // Delete the archives
    const arcDel = await db.directAgentChatArchive.deleteMany({
      where: { id: { in: archiveIds } },
    });
    result.purgedArchives = arcDel.count;

    // Remove folders from disk
    for (const item of expiring) {
      const uploadDir = await getAgentChatUploadDir(item.agentSlug, item.id);
      if (existsSync(uploadDir)) {
        try {
          await rm(uploadDir, { recursive: true, force: true });
          result.removedFolders += 1;
        } catch (err) {
          result.errors.push(`folder delete ${uploadDir}: ${(err as Error).message}`);
        }
      }
    }

    // Log the purge activity
    await db.activityLog.create({
      data: {
        kind: "agent.direct_chat.bin_purge",
        payload: JSON.stringify(result),
      },
    });

  } catch (err) {
    result.errors.push(`general purge error: ${(err as Error).message}`);
    console.error("[pm] direct chat purge error:", err);
  }

  return result;
}
