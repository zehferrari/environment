import Link from "next/link";
import { db } from "@/lib/db";
import { auth } from "@/lib/auth";
import { listChatTargets } from "@/lib/agents/chat-targets";
import {
  deleteChatMessage,
} from "@/lib/agents/chat-actions";
import { renderFullMarkdown } from "@/lib/markdown";
import StreamingAgentReply from "@/components/streaming-agent-reply";
import AgentChatInput from "./agent-chat-input";
import {
  actorDisplayName,
  MessageAvatar,
  MessageTimestamp,
  type MessageActor,
} from "@/components/message-avatar";

interface CommonProps {
  projectSlug: string;
  selectedAgentSlug: string | null;
  parentPath: string;
}

type TargetProps =
  | (CommonProps & { taskId: string; epicId?: undefined })
  | (CommonProps & { epicId: string; taskId?: undefined });

function dispatchIsDisabled(): boolean {
  return !process.env.PM_DISPATCH_SOCKET && !process.env.PM_DISPATCH_DROP_DIR;
}

export default async function AgentChatSidebar(props: TargetProps) {
  const targets = await listChatTargets();
  const selected = props.selectedAgentSlug
    ? targets.find((t) => t.agentSlug === props.selectedAgentSlug) ?? null
    : null;
  const isTaskChat = "taskId" in props && props.taskId !== undefined;
  const session = await auth();
  const currentUserId = session?.user?.id ?? null;

  const rows = selected
    ? await db.agentChatMessage.findMany({
        where: {
          agentSlug: selected.agentSlug,
          ...(props.taskId ? { taskId: props.taskId } : { epicId: props.epicId }),
        },
        orderBy: { createdAt: "desc" },
        take: 50,
        include: {
          sender: {
            select: {
              id: true,
              username: true,
              kind: true,
              name: true,
              avatarUpdatedAt: true,
              agent: { select: { slug: true, name: true, avatar: true } },
            },
          },
        },
      })
    : [];
  const messages = rows.reverse();
  const latest = messages.at(-1) ?? null;
  const pendingChatReply = isTaskChat
    && latest
    && latest.sender.kind !== "agent"
    && latest.originChannel === "chat"
    ? latest
    : null;

  return (
    <section className="space-y-3 rounded-2xl border border-[var(--color-line)] bg-[var(--color-panel)] p-4 shadow-sm">
      <div className="flex items-center justify-between gap-2">
        <div className="text-[11px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
          Agent chat
        </div>
        {dispatchIsDisabled() ? (
          <span className="rounded-full border border-[var(--color-line)] px-2 py-0.5 text-[10px] uppercase tracking-wider text-[var(--color-text-muted)]">
            Stored
          </span>
        ) : null}
      </div>

      {targets.length === 0 ? (
        <p className="text-xs text-[var(--color-text-muted)]">No active agents.</p>
      ) : (
        <nav className="flex flex-wrap gap-1.5">
          {targets.map((t) => {
            const isSelected = t.agentSlug === props.selectedAgentSlug;
            return (
              <Link
                key={t.agentSlug}
                href={`${props.parentPath}?chat=${t.agentSlug}`}
                className={
                  isSelected
                    ? "rounded-full bg-[var(--color-accent)] px-2.5 py-1 text-[11px] font-medium text-[var(--color-bg)]"
                    : "rounded-full border border-[var(--color-line)] bg-[var(--color-panel-soft)] px-2.5 py-1 text-[11px] text-[var(--color-text-muted)] hover:border-[var(--color-accent)] hover:text-[var(--color-text)]"
                }
              >
                {t.username}
              </Link>
            );
          })}
        </nav>
      )}

      {selected ? (
        <>
          <div className="max-h-[420px] space-y-2 overflow-y-auto pr-1">
            {messages.length === 0 ? (
              <p className="text-xs text-[var(--color-text-muted)]">
                No messages for @{selected.username}.
              </p>
            ) : (
              messages.map((m) => {
                const fromAgent = m.sender.kind === "agent";
                const fromCurrentUser = Boolean(currentUserId && m.sender.id === currentUserId);
                const bubbleTone = fromCurrentUser
                  ? "border-[var(--color-accent)]/35 bg-[var(--color-accent)]/[0.09]"
                  : fromAgent
                    ? "border-[var(--color-accent)]/25 bg-[var(--color-panel-soft)]"
                    : "border-[var(--color-line)] bg-[var(--color-panel-soft)]";
                return (
                  <div
                    key={m.id}
                    className={`flex items-start gap-2.5 ${fromCurrentUser ? "justify-end" : ""}`}
                  >
                    {!fromCurrentUser ? <MessageAvatar actor={m.sender as MessageActor} size="sm" /> : null}
                    <article
                      className={`group relative w-fit min-w-[10rem] max-w-[min(30rem,82%)] rounded-2xl border px-3.5 py-2.5 shadow-sm ${bubbleTone}`}
                    >
                      <span
                        aria-hidden="true"
                        className={`absolute top-4 h-3 w-3 rotate-45 ${bubbleTone} ${
                          fromCurrentUser ? "-right-1.5 border-r border-t" : "-left-1.5 border-b border-l"
                        }`}
                      />
                      <div className="relative mb-2 flex flex-wrap items-center justify-between gap-2 text-xs text-[var(--color-text-muted)]">
                        <span className="truncate font-semibold text-[var(--color-text)]">
                          {actorDisplayName(m.sender)}
                          {fromAgent ? " / agent" : ""}
                        </span>
                        <div className="flex items-center gap-2">
                          <MessageTimestamp value={m.createdAt} />
                          <form action={deleteChatMessage}>
                            <input type="hidden" name="projectSlug" value={props.projectSlug} />
                            <input type="hidden" name="messageId" value={m.id} />
                            <button
                              type="submit"
                              aria-label="Delete message"
                              title="Delete message"
                              className="text-[var(--color-text-muted)] opacity-0 transition group-hover:opacity-100 hover:text-[var(--color-crit)]"
                            >
                              x
                            </button>
                          </form>
                        </div>
                      </div>
                      <div className="relative md md-compact" dangerouslySetInnerHTML={renderFullMarkdown(m.body)} />
                    </article>
                    {fromCurrentUser ? <MessageAvatar actor={m.sender as MessageActor} size="sm" /> : null}
                  </div>
                );
              })
            )}
            {selected && pendingChatReply ? (
              <StreamingAgentReply
                targetKind="task-chat"
                agentSlug={selected.agentSlug}
                taskId={props.taskId}
                messageId={pendingChatReply.id}
                label={selected.username}
              />
            ) : null}
          </div>

          <AgentChatInput
            projectSlug={props.projectSlug}
            taskId={props.taskId}
            epicId={props.epicId}
            agentSlug={selected.agentSlug}
            agentUsername={selected.username}
          />
        </>
      ) : (
        <p className="text-xs text-[var(--color-text-muted)]">
          Select an agent to open the task chat.
        </p>
      )}
    </section>
  );
}
