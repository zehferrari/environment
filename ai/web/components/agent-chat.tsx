import Link from "next/link";
import { db } from "@/lib/db";
import { listChatTargets } from "@/lib/agents/chat-targets";
import {
  deleteChatMessage,
  sendAgentChatMessage,
} from "@/lib/agents/chat-actions";
import { renderFullMarkdown } from "@/lib/markdown";
import StreamingAgentReply from "@/components/streaming-agent-reply";

interface CommonProps {
  projectSlug: string;
  selectedAgentSlug: string | null;
  parentPath: string;
}

type TargetProps =
  | (CommonProps & { taskId: string; epicId?: undefined })
  | (CommonProps & { epicId: string; taskId?: undefined });

function timeAgo(d: Date): string {
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return d.toISOString().slice(0, 16).replace("T", " ");
}

function dispatchIsDisabled(): boolean {
  return !process.env.PM_DISPATCH_SOCKET && !process.env.PM_DISPATCH_DROP_DIR;
}

export default async function AgentChatSidebar(props: TargetProps) {
  const targets = await listChatTargets();
  const selected = props.selectedAgentSlug
    ? targets.find((t) => t.agentSlug === props.selectedAgentSlug) ?? null
    : null;
  const isTaskChat = "taskId" in props && props.taskId !== undefined;

  const rows = selected
    ? await db.agentChatMessage.findMany({
        where: {
          agentSlug: selected.agentSlug,
          ...(props.taskId ? { taskId: props.taskId } : { epicId: props.epicId }),
        },
        orderBy: { createdAt: "desc" },
        take: 50,
        include: { sender: { select: { username: true, kind: true } } },
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
                return (
                  <article
                    key={m.id}
                    className={`group rounded-xl border px-3 py-2 ${
                      fromAgent
                        ? "border-[var(--color-accent)]/40 bg-[var(--color-accent)]/10"
                        : "border-[var(--color-line)] bg-[var(--color-panel-soft)]"
                    }`}
                  >
                    <div className="mb-1 flex items-center justify-between gap-2 text-[10px] uppercase tracking-wider text-[var(--color-text-muted)]">
                      <span>
                        {m.sender.username}
                        {fromAgent ? " / agent" : ""}
                      </span>
                      <div className="flex items-center gap-2">
                        <time dateTime={m.createdAt.toISOString()} title={m.createdAt.toISOString()}>
                          {timeAgo(m.createdAt)}
                        </time>
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
                    <div className="md md-compact" dangerouslySetInnerHTML={renderFullMarkdown(m.body)} />
                    {m.allowDescriptionEdit ? (
                      <div className="mt-1 inline-block rounded-full border border-[var(--color-line)] bg-[var(--color-bg)] px-2 py-0.5 text-[10px] uppercase tracking-wider">
                        {m.editGrantUsedAt ? "edit grant used" : "edit grant active"}
                      </div>
                    ) : null}
                  </article>
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

          <form action={sendAgentChatMessage} className="space-y-2">
            <input type="hidden" name="projectSlug" value={props.projectSlug} />
            {props.taskId ? (
              <input type="hidden" name="taskId" value={props.taskId} />
            ) : (
              <input type="hidden" name="epicId" value={props.epicId} />
            )}
            <input type="hidden" name="agentSlug" value={selected.agentSlug} />
            <textarea
              name="body"
              required
              rows={3}
              maxLength={8000}
              placeholder={`Message @${selected.username}...`}
              className="w-full rounded-lg border border-[var(--color-line)] bg-[var(--color-bg)] px-3 py-2 text-xs outline-none focus:border-[var(--color-accent)]"
            />
            {isTaskChat ? (
              <label className="flex items-center gap-2 text-[11px] text-[var(--color-text-muted)]">
                <input
                  type="checkbox"
                  name="allowDescriptionEdit"
                  className="h-3.5 w-3.5 accent-[var(--color-accent)]"
                />
                Allow description edit
              </label>
            ) : null}
            <div className="flex justify-end">
              <button
                type="submit"
                className="rounded-lg bg-[var(--color-accent)] px-3 py-1 text-xs font-medium text-[var(--color-bg)] hover:opacity-90"
              >
                Send
              </button>
            </div>
          </form>
        </>
      ) : (
        <p className="text-xs text-[var(--color-text-muted)]">
          Select an agent to open the task chat.
        </p>
      )}
    </section>
  );
}
