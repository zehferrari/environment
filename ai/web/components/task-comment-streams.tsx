"use client";

import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import StreamingAgentReply from "@/components/streaming-agent-reply";
import { ChatStreamManager } from "@/lib/agents/chat/chat-stream-manager";

type PendingCommentMessage = {
  id: string;
  agentSlug: string;
};

export default function TaskCommentStreams({
  taskId,
  messages,
}: {
  taskId: string;
  messages: PendingCommentMessage[];
}) {
  const router = useRouter();
  const [settledKeys, setSettledKeys] = useState<Set<string>>(() => new Set());

  const settle = useCallback((messageId: string, agentSlug: string, refresh: boolean) => {
    setSettledKeys((current) => {
      const next = new Set(current);
      next.add(`${messageId}:${agentSlug}`);
      return next;
    });
    if (refresh) router.refresh();
  }, [router]);

  const activeMessages = messages.filter((message) => !settledKeys.has(`${message.id}:${message.agentSlug}`));
  if (activeMessages.length === 0) return null;

  return (
    <div className="mt-3 space-y-2">
      {activeMessages.map((message) => (
        <StreamingAgentReply
          key={`${message.id}:${message.agentSlug}`}
          targetKind="task-comment"
          agentSlug={message.agentSlug}
          taskId={taskId}
          messageId={message.id}
          roomId={ChatStreamManager.roomId({
            targetKind: "task-comment",
            agentSlug: message.agentSlug,
            taskId,
          })}
          label={`@${message.agentSlug}`}
          anonymizeTyping
          onFinal={({ status }) => {
            settle(message.id, message.agentSlug, status === "done" || status === "error");
          }}
          onCanceled={({ agentSlug }) => {
            settle(message.id, agentSlug, false);
          }}
        />
      ))}
    </div>
  );
}
