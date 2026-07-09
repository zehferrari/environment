// Activity-stream categorisation. One place decides which bucket an
// ActivityLog `kind` belongs to, so the chart, the feed filter chips and the
// Prisma `where` clauses can never disagree.
//
// "system" is the plumbing/heartbeat tier (agent.sync every 5 minutes,
// dispatch/notify echoes, pm.* internals). It dwarfs real activity ~10:1 in
// row count, so the default views exclude it and surface it behind its own
// filter instead.

import type { Prisma } from "@prisma/client";

export type ActivityCategory = "work" | "chat" | "agents" | "system";
export type ActivityScope = ActivityCategory | "all";

export const ACTIVITY_CATEGORIES: Array<{
  key: ActivityCategory;
  label: string;
  hint: string;
}> = [
  { key: "work", label: "Work items", hint: "Tasks, epics, checklists, proposals, projects" },
  { key: "chat", label: "Chat", hint: "Task/epic chat rooms and direct agent chats" },
  { key: "agents", label: "Agent ops", hint: "Agent control changes recorded by PM (mission control)" },
  { key: "system", label: "System", hint: "Heartbeats, dispatch plumbing and PM internals" },
];

export function activityCategoryLabel(category: ActivityCategory): string {
  return ACTIVITY_CATEGORIES.find((c) => c.key === category)?.label ?? category;
}

// --- classification -------------------------------------------------------
// Keep these three predicates in sync with `activityScopeWhere` below.

const SYSTEM_EXACT = new Set(["agent.sync"]);
const SYSTEM_PREFIXES = ["pm.", "system.", "task.workflow."];
const SYSTEM_SUFFIXES = [".dispatch", ".notify"];

function isSystemKind(kind: string): boolean {
  if (SYSTEM_EXACT.has(kind)) return true;
  if (SYSTEM_PREFIXES.some((p) => kind.startsWith(p))) return true;
  return SYSTEM_SUFFIXES.some((s) => kind.endsWith(s));
}

function isChatKind(kind: string): boolean {
  return kind.includes(".chat.") || kind.includes("direct_chat");
}

export function categorizeActivityKind(kind: string): ActivityCategory {
  if (isSystemKind(kind)) return "system";
  if (isChatKind(kind)) return "chat";
  if (kind.startsWith("agent.")) return "agents";
  return "work";
}

// --- Prisma filters -------------------------------------------------------

const systemKindConditions: Prisma.ActivityLogWhereInput[] = [
  { kind: { in: [...SYSTEM_EXACT] } },
  ...SYSTEM_PREFIXES.map((p) => ({ kind: { startsWith: p } })),
  ...SYSTEM_SUFFIXES.map((s) => ({ kind: { endsWith: s } })),
];

const chatKindConditions: Prisma.ActivityLogWhereInput[] = [
  { kind: { contains: ".chat." } },
  { kind: { contains: "direct_chat" } },
];

// Where-clause for a feed scope. "all" means every non-system event — the
// default reading view; plumbing stays reachable via the explicit "system"
// scope.
export function activityScopeWhere(scope: ActivityScope): Prisma.ActivityLogWhereInput {
  switch (scope) {
    case "system":
      return { OR: systemKindConditions };
    case "chat":
      return { AND: [{ NOT: systemKindConditions }, { OR: chatKindConditions }] };
    case "agents":
      return {
        AND: [
          { NOT: systemKindConditions },
          { NOT: chatKindConditions },
          { kind: { startsWith: "agent." } },
        ],
      };
    case "work":
      return {
        AND: [
          { NOT: systemKindConditions },
          { NOT: chatKindConditions },
          { NOT: { kind: { startsWith: "agent." } } },
        ],
      };
    case "all":
    default:
      return { NOT: systemKindConditions };
  }
}

export function parseActivityScope(value: string | undefined): ActivityScope {
  if (value === "work" || value === "chat" || value === "agents" || value === "system") return value;
  return "all";
}
