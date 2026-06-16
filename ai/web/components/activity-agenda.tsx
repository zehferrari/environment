// Agenda-style renderer for an activity feed (HOMELAB-41). Groups rows
// by calendar day with a date heading on top, and lays each event out
// with its time in a left column prefixing the label. Server component:
// formatting is done from the ISO string slices so output is fully
// deterministic (no locale/timezone hydration drift).

import { MessageAvatar, type MessageActor } from "@/components/message-avatar";

export type AgendaItem = {
  id: string;
  createdAt: string; // ISO 8601
  label: string;
  actor?: MessageActor | null;
};

const systemActor: MessageActor = {
  id: null,
  username: "system",
  kind: "system",
  name: "System",
  avatarUpdatedAt: null,
  agent: null,
};

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

function formatDay(dayKey: string): string {
  const [y, m, d] = dayKey.split("-").map(Number);
  if (!y || !m || !d) return dayKey;
  return `${MONTHS[m - 1]} ${d}, ${y}`;
}

export default function ActivityAgenda({
  feed,
  emptyMessage = "No activity yet.",
}: {
  feed: AgendaItem[];
  emptyMessage?: string;
}) {
  if (feed.length === 0) {
    return (
      <div className="rounded border border-dashed border-line px-3 py-4 text-xs text-text-muted">
        {emptyMessage}
      </div>
    );
  }

  // feed arrives newest-first; collapse consecutive same-day rows into a
  // single dated group.
  const groups: { day: string; items: AgendaItem[] }[] = [];
  for (const item of feed) {
    const day = item.createdAt.slice(0, 10);
    const last = groups[groups.length - 1];
    if (last && last.day === day) last.items.push(item);
    else groups.push({ day, items: [item] });
  }

  return (
    <div className="space-y-5">
      {groups.map((group) => (
        <div key={group.day}>
          <h3 className="mb-2 border-b border-line pb-1 text-xs font-semibold uppercase tracking-wider text-text">
            {formatDay(group.day)}
          </h3>
          <ul className="space-y-1.5">
            {group.items.map((item) => (
              <li key={item.id} className="flex items-center gap-3">
                <time
                  dateTime={item.createdAt}
                  className="w-12 shrink-0 text-right text-xs font-medium tabular-nums text-accent"
                >
                  {item.createdAt.slice(11, 16)}
                </time>
                <MessageAvatar actor={item.actor ?? systemActor} size="sm" />
                <span className="text-sm leading-snug">{item.label}</span>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}
