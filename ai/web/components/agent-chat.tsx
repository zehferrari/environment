// Agent chat sidebar (HOMELAB-48).
//
// Used by the Task and Epic editors. Renders the per-(target, agent)
// thread for the currently-selected chat target and the compose form.
// Selection is driven by the URL search param `chat=<agentSlug>` so the
// rest of the page stays a server component and the back/forward
// buttons survive.

import Link from "next/link";
import { db } from "@/lib/db";
import { listChatTargets } from "@/lib/agents/chat-targets";
import { sendAgentChatMessage } from "@/lib/agents/chat-actions";

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

export default async function AgentChatSidebar(props: TargetProps) {
  const targets = await listChatTargets();
  const selected =
    props.selectedAgentSlug !== null
      ? targets.find((t) => t.agentSlug === props.selectedAgentSlug) ?? null
      : null;

  let messages: Array<{
    id: string;
    body: string;
    senderUsername: string;
    senderKind: string;
    allowDescriptionEdit: boolean;
    editGrantUsedAt: Date | null;
    createdAt: Date;
  }> = [];

  if (selected) {
    const rows = await db.agentChatMessage.findMany({
      where: {
        agentSlug: selected.agentSlug,
        ...(props.taskId
          ? { taskId: props.taskId }
          : { epicId: props.epicId }),
      },
      orderBy: { createdAt: "desc" },
      take: 50,
      include: { sender: { select: { username: true, kind: true } } },
    });
    messages = rows
      .map((r) => ({
        id: r.id,
        body: r.body,
        senderUsername: r.sender.username,
        senderKind: r.sender.kind,
        allowDescriptionEdit: r.allowDescriptionEdit,
        editGrantUsedAt: r.editGrantUsedAt,
        createdAt: r.createdAt,
      }))
      .reverse();
  }

  return (
    <div className="space-y-3 rounded-2xl border border-[var(--color-line)] bg-[var(--color-panel)] p-4 shadow-sm">
      <div className="text-[11px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
        Talk to an agent
      </div>

      {targets.length === 0 ? (
        <p className="text-xs text-[var(--color-text-muted)]">
          No agents available. The boot sync seeds agents from
          /srv/agents/index.json.
        </p>
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
                <span className="ml-1 text-[10px] opacity-75">
                  {t.agentRole}
                </span>
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
                No messages yet. Say hi.
              </p>
            ) : (
              messages.map((m) => {
                const fromAgent = m.senderKind === "agent";
                return (
                  <div
                    key={m.id}
                    className={`rounded-xl border px-3 py-2 text-xs ${
                      fromAgent
                        ? "border-[var(--color-accent)]/40 bg-[var(--color-accent)]/10"
                        : "border-[var(--color-line)] bg-[var(--color-panel-soft)]"
                    }`}
                  >
                    <div className="mb-1 flex items-center justify-between gap-2 text-[10px] uppercase tracking-wider text-[var(--color-text-muted)]">
                      <span>
                        {m.senderUsername}
                        {fromAgent ? " · agent" : ""}
                      </span>
                      <time
                        dateTime={m.createdAt.toISOString()}
                        title={m.createdAt.toISOString()}
                      >
                        {timeAgo(m.createdAt)}
                      </time>
                    </div>
                    <div className="whitespace-pre-wrap text-sm leading-relaxed">
                      {m.body}
                    </div>
                    {m.allowDescriptionEdit ? (
                      <div className="mt-1 inline-block rounded-full border border-[var(--color-line)] bg-[var(--color-bg)] px-2 py-0.5 text-[10px] uppercase tracking-wider">
                        {m.editGrantUsedAt
                          ? "edit grant used"
                          : "edit grant active"}
                      </div>
                    ) : null}
                  </div>
                );
              })
            )}
          </div>

          <form action={sendAgentChatMessage} className="space-y-2">
            <input
              type="hidden"
              name="projectSlug"
              value={props.projectSlug}
            />
            {props.taskId ? (
              <input type="hidden" name="taskId" value={props.taskId} />
            ) : (
              <input type="hidden" name="epicId" value={props.epicId} />
            )}
            <input
              type="hidden"
              name="agentSlug"
              value={selected.agentSlug}
            />
            <textarea
              name="body"
              required
              rows={3}
              maxLength={8000}
              placeholder={`Message @${selected.username}…`}
              className="w-full rounded-lg border border-[var(--color-line)] bg-[var(--color-bg)] px-3 py-2 text-xs outline-none focus:border-[var(--color-accent)]"
            />
            <label className="flex items-center gap-2 text-[11px] text-[var(--color-text-muted)]">
              <input
                type="checkbox"
                name="allowDescriptionEdit"
                className="h-3.5 w-3.5 accent-[var(--color-accent)]"
              />
              Allow @{selected.username} to edit the description for this
              message
            </label>
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
          Pick an agent above to start (or continue) a conversation.
        </p>
      )}
    </div>
  );
}
