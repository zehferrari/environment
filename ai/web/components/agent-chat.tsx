import Link from "next/link";
import { db } from "@/lib/db";
import { auth } from "@/lib/auth";
import { listChatTargets } from "@/lib/agents/chat/targets";
import {
  deleteChatMessage,
  restoreChatMessage,
} from "@/lib/agents/chat/actions";
import { renderChatMarkdown } from "@/lib/markdown";
import StreamingAgentReply from "@/components/streaming-agent-reply";
import AgentChatInput from "./agent-chat-input";
import NativePmNotificationToggle from "@/components/native-pm-notification-toggle";
import ConfirmedDeleteButton from "@/components/confirmed-delete-button";
import DeletedMessageDivider from "@/components/deleted-message-divider";
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
        // Soft-deleted bubbles (HOMELAB-41 / item 2) stay in this list
        // so the agent-chat sidebar can render the collapsed dotted
        // divider. Agent context queries filter them out upstream.
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
          deletedBy: { select: { username: true, name: true, kind: true } },
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
    <section className="space-y-3 rounded-2xl border border-line bg-panel p-4 shadow-sm">
      <div className="flex items-center justify-between gap-2">
        <div className="text-[11px] font-semibold uppercase tracking-wider text-text-muted">
          Agent chat
        </div>
        <div className="flex items-center gap-2">
          <NativePmNotificationToggle compact />
          {dispatchIsDisabled() ? (
          <span className="rounded-full border border-line px-2 py-0.5 text-[10px] uppercase tracking-wider text-text-muted">
            Stored
          </span>
          ) : null}
        </div>
      </div>

      {targets.length === 0 ? (
        <p className="text-xs text-text-muted">No active agents.</p>
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
                    ? "rounded-full bg-accent px-2.5 py-1 text-[11px] font-medium text-bg"
                    : "rounded-full border border-line bg-panel-soft px-2.5 py-1 text-[11px] text-text-muted hover:border-accent hover:text-text"
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
          <div className="max-h-[630px] space-y-2 overflow-y-auto pr-1">
            {messages.length === 0 ? (
              <p className="text-xs text-text-muted">
                No messages for @{selected.username}.
              </p>
            ) : (
              messages.map((m) => {
                if (m.deletedAt) {
                  // Soft-deleted (HOMELAB-41 / item 2). Collapsed dotted
                  // divider with restore (↺) for humans on the live view.
                  return (
                    <DeletedMessageDivider
                      key={m.id}
                      deletedAt={m.deletedAt}
                      deletedBy={m.deletedBy}
                      restore={{
                        action: restoreChatMessage,
                        fields: { projectSlug: props.projectSlug, messageId: m.id },
                      }}
                    >
                      <span>{m.body}</span>
                    </DeletedMessageDivider>
                  );
                }
                const fromAgent = m.sender.kind === "agent";
                const fromCurrentUser = Boolean(currentUserId && m.sender.id === currentUserId);
                const bubbleTone = fromCurrentUser
                  ? "border-accent/35 bg-accent/[0.09]"
                  : fromAgent
                    ? "border-accent/25 bg-panel-soft"
                    : "border-line bg-panel-soft";
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
                      <div className="relative mb-2 flex flex-wrap items-center justify-between gap-2 text-xs text-text-muted">
                        <span className="truncate font-semibold text-text">
                          {actorDisplayName(m.sender)}
                          {fromAgent ? " / agent" : ""}
                        </span>
                        <div className="flex items-center gap-2">
                          <MessageTimestamp value={m.createdAt} />
                          <ConfirmedDeleteButton
                            action={deleteChatMessage}
                            fields={{ projectSlug: props.projectSlug, messageId: m.id }}
                            label="x"
                            title="Delete message"
                            description="The bubble will be hidden behind a collapsed dotted divider that humans can expand. Agents will never see it in their context again."
                            confirmLabel="Delete message"
                            buttonTitle="Delete message"
                            ariaLabel="Delete message"
                            className="text-text-muted opacity-0 transition group-hover:opacity-100 hover:text-crit cursor-pointer"
                          />
                        </div>
                      </div>
                      <div className="relative md md-compact" dangerouslySetInnerHTML={renderChatMarkdown(m.body)} />
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
        <p className="text-xs text-text-muted">
          Select an agent to open the task chat.
        </p>
      )}
    </section>
  );
}
