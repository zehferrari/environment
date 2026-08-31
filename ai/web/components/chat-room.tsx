"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import ChatBubble from "@/components/chat-bubble";
import DeletedMessageDivider from "@/components/deleted-message-divider";
import LegacyChatRoom from "@/components/legacy-chat-room";
import DecomposedChatRoom from "@/components/chat-room-decomposed";

type ChatRoomProps = React.ComponentProps<typeof LegacyChatRoom> & {
  currentUsername?: string | null;
  readOnly?: boolean;
};

function ReadOnlyActionPlan({
  taskId,
  messages,
  archives = [],
  selectedArchiveId = null,
  selectedArchiveDeleted = false,
  viewingArchive = false,
  currentUserId = null,
}: Omit<ChatRoomProps, "readOnly">) {
  const pathname = usePathname();

  return (
    <div
      data-read-only-action-plan
      className="flex h-[calc(100dvh-14rem)] min-h-[620px] flex-col overflow-hidden rounded-panel border border-line bg-panel shadow-sm"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line bg-panel-soft px-card py-control-y.5">
        <span className="text-caption font-semibold uppercase tracking-wider text-text">
          {taskId ? "Task Action Plan" : "Epic Action Plan"}
        </span>
        <div className="flex items-center gap-2">
          <span className="text-nano font-semibold uppercase tracking-wider text-text-muted">
            Read-only
          </span>
          {viewingArchive ? (
            <Link
              href={`${pathname}?chatRoom=current`}
              className="rounded-lg border border-line bg-panel px-control-x py-control-y text-micro font-semibold text-text-muted transition hover:border-accent hover:text-accent"
            >
              Current discussion
            </Link>
          ) : null}
        </div>
      </div>

      {archives.length > 0 ? (
        <details className="border-b border-line bg-panel-soft/60 px-card py-2">
          <summary className="cursor-pointer text-caption font-semibold text-text-muted">
            Recent discussions ({archives.length})
          </summary>
          <div className="mt-2 flex flex-wrap gap-2">
            {archives.map((archive) => (
              <Link
                key={archive.id}
                href={`${pathname}?chatArchive=${archive.id}`}
                className={`rounded-lg border px-2 py-1 text-caption transition hover:border-accent hover:text-accent ${
                  selectedArchiveId === archive.id && !selectedArchiveDeleted
                    ? "border-accent bg-accent-soft text-accent"
                    : "border-line bg-panel text-text-muted"
                }`}
              >
                {archive.summary}
              </Link>
            ))}
          </div>
        </details>
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto p-card">
        {messages.length === 0 ? (
          <p className="rounded-card border border-dashed border-line bg-panel-soft/20 p-6 text-center text-caption text-text-muted">
            No action plan discussion yet.
          </p>
        ) : (
          <div className="space-y-3">
            {messages.map((message) => message.deletedAt ? (
              <DeletedMessageDivider
                key={message.id}
                deletedAt={message.deletedAt}
                deletedBy={message.deletedBy ?? null}
              >
                <span>{message.body}</span>
              </DeletedMessageDivider>
            ) : (
              <ChatBubble
                key={message.id}
                message={message}
                currentUserId={currentUserId}
                surface={taskId ? "task-chat" : "epic-chat"}
                preferShortAgentSections
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export default function ChatRoom({ readOnly = false, ...props }: ChatRoomProps) {
  if (readOnly) {
    return <ReadOnlyActionPlan {...props} />;
  }

  // The decomposed room is the feature-complete task/epic chat surface
  // (optimistic send, failed→resend, jump-to-unread, native notifications,
  // draft persistence). It is the default; set NEXT_PUBLIC_PM_DECOMPOSED_CHAT_ROOM=0
  // to fall back to the legacy room as an escape hatch.
  if (process.env.NEXT_PUBLIC_PM_DECOMPOSED_CHAT_ROOM === "0") {
    return <LegacyChatRoom {...props} />;
  }

  return <DecomposedChatRoom {...props} />;
}
