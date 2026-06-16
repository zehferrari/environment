import {
  actorDisplayName,
  MessageAvatar,
  MessageTimestamp,
  type MessageActor,
} from "@/components/message-avatar";

type ActivityActor = {
  id: string;
  username: string;
  kind: string;
  name?: string | null;
  avatarUpdatedAt?: Date | string | null;
  agent?: { slug: string; name: string; avatar: string | null } | null;
} | null;

export type ActivityTimelineRow = {
  id: string;
  kind: string;
  payload: string | null;
  targetAgent?: string | null;
  createdAt: Date | string;
  user: ActivityActor;
};

function parsePayload(raw: string | null): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function payloadSummary(payload: unknown): string | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return typeof payload === "string" ? payload : null;
  }
  const p = payload as Record<string, unknown>;
  const parts: string[] = [];
  if (typeof p.from === "string" || p.from === null) parts.push(`from ${p.from ?? "none"}`);
  if (typeof p.to === "string" || p.to === null) parts.push(`to ${p.to ?? "none"}`);
  if (typeof p.action === "string") parts.push(`action ${p.action}`);
  if (typeof p.reason === "string") parts.push(`reason ${p.reason}`);
  if (typeof p.agentSlug === "string") parts.push(`agent @${p.agentSlug}`);
  if (typeof p.branchName === "string") parts.push(`branch ${p.branchName}`);
  if (typeof p.error === "string") parts.push(`error ${p.error}`);
  return parts.length ? parts.join(" · ") : null;
}

const systemActor: MessageActor = {
  id: null,
  username: "system",
  kind: "system",
  name: "System",
  avatarUpdatedAt: null,
  agent: null,
};

export default function ActivityTimeline({ rows }: { rows: ActivityTimelineRow[] }) {
  if (rows.length === 0) {
    return <p className="text-caption text-text-muted">No activity yet.</p>;
  }

  return (
    <ul className="space-y-3">
      {rows.map((row) => {
        const actor = row.user ?? systemActor;
        const parsed = parsePayload(row.payload);
        const summary = payloadSummary(parsed);
        return (
          <li key={row.id} className="text-body">
            <div className="min-w-0 rounded-card border border-line bg-panel-soft px-3 py-2">
              <div className="mb-1 flex min-w-0 flex-wrap items-center gap-2 text-caption text-text-muted">
                <MessageTimestamp value={row.createdAt} />
                <MessageAvatar actor={actor} size="sm" />
                <strong className="truncate font-medium text-text">
                  {actorDisplayName(actor)}
                </strong>
                <span className="font-mono text-micro text-text-muted">
                  {row.kind}
                </span>
                {row.targetAgent ? <span>@{row.targetAgent}</span> : null}
              </div>
              {summary ? (
                <p className="break-words text-caption text-text-muted">{summary}</p>
              ) : null}
              {row.payload ? (
                <details className="mt-2">
                  <summary className="cursor-pointer text-micro text-text-muted hover:text-accent">
                    Payload
                  </summary>
                  <pre className="mt-2 max-h-64 overflow-auto rounded-lg bg-bg p-2 text-micro text-text-muted">
                    {typeof parsed === "string" ? parsed : JSON.stringify(parsed, null, 2)}
                  </pre>
                </details>
              ) : null}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
