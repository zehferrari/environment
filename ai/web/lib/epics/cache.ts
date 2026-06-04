import { revalidateTag } from "next/cache";
import type { RevalidateTagFn } from "@/lib/tasks/cache";

export const epicCacheTag = {
  shell: (epicId: string) => `epic:${epicId}:shell`,
  tasks: (epicId: string) => `epic:${epicId}:tasks`,
  comments: (epicId: string) => `epic:${epicId}:comments`,
  attachments: (epicId: string) => `epic:${epicId}:attachments`,
  activity: (epicId: string) => `epic:${epicId}:activity`,
  chat: (epicId: string) => `epic:${epicId}:chat`,
  chatArchives: (epicId: string) => `epic:${epicId}:chat-archives`,
  proposals: (epicId: string) => `epic:${epicId}:proposals`,
} as const;

export type EpicReplyCacheScope = "chat" | "comment";

export function tagsForEpicReplyScope(epicId: string, scope: EpicReplyCacheScope) {
  if (scope === "chat") {
    return [
      epicCacheTag.chat(epicId),
      epicCacheTag.chatArchives(epicId),
      epicCacheTag.proposals(epicId),
    ];
  }

  return [
    epicCacheTag.comments(epicId),
    epicCacheTag.activity(epicId),
  ];
}

export function revalidateEpicReplyScope(
  epicId: string,
  scope: EpicReplyCacheScope,
  revalidate: RevalidateTagFn = revalidateTag,
) {
  for (const tag of tagsForEpicReplyScope(epicId, scope)) {
    revalidate(tag);
  }
}
