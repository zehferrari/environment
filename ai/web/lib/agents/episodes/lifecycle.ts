// ENV-121 — bounded execution episodes.
//
// The problem: one stable OpenClaw session carried a whole task. Every
// continuation inherited the entire transcript — task body, every comment,
// every browser trace, every previous tool loop — until the only remaining
// memory strategy was compaction. Compaction is lossy AND unobservable: PM
// cannot tell what the agent still knows, and neither can the agent.
//
// The replacement is an EPISODE: a bounded run of tool/action cycles that ends
// with a structured, durable checkpoint. The next episode starts from that
// checkpoint in a FRESH model session. Compaction becomes what it was always
// meant to be — a fallback for a single oversized turn, not the memory model.
//
// Two properties the ENV-121 plan review specifically asked for:
//
//   1. Rollover is driven by an OBSERVABLE server-side cycle counter, not by
//      the agent's self-report. `cycleCount` is incremented by PM inside the
//      same transaction that records the workflow action, so it counts what
//      actually happened.
//   2. Checkpoint closure is ATOMIC and retry-safe. Closing episode N and
//      opening episode N+1 happen in one transaction, and
//      @@unique([taskId, agentSlug, episodeNo]) makes a duplicate rollover
//      fail loudly instead of minting a second episode with the same number.

import type { Prisma } from "@prisma/client";

import { db } from "@/lib/db";
import { intEnv } from "@/lib/agents/context/caps";
import { workflowActionCheckpoint } from "@/lib/agents/workflow/action-effect";

/**
 * Cycles an episode may accrue before PM closes it and hands the next turn a
 * fresh session. One cycle == one continuation-required workflow action, which
 * is the only server-observable unit of agent progress inside a turn.
 *
 * The default is deliberately small. An episode that needs more than a handful
 * of durable workflow actions is exactly the runaway conversation this task
 * exists to bound; it should roll over and re-enter with a compact brief.
 */
export const EPISODE_CYCLE_BUDGET_DEFAULT = 6;

export function episodeCycleBudget() {
  return intEnv("PM_EPISODE_MAX_CYCLES", EPISODE_CYCLE_BUDGET_DEFAULT, 1, 100);
}

export const EPISODE_STATUS = {
  open: "open",
  closed: "closed",
} as const;

export const EPISODE_CLOSE_REASON = {
  budgetExhausted: "cycle_budget_exhausted",
  terminalAction: "episode_terminal_action",
  superseded: "superseded",
} as const;

/**
 * The structured checkpoint the task description specifies. Every field is
 * optional on the wire — an agent that only knows its next action should be
 * able to persist that alone rather than being forced to invent the rest.
 */
export interface EpisodeCheckpoint {
  completedWork?: string[] | null;
  evidence?: string[] | null;
  openChecklist?: string[] | null;
  nextAction?: string | null;
  risks?: string[] | null;
}

export interface TaskExecutionEpisodeSummary {
  id: string;
  episodeNo: number;
  agentSlug: string;
  status: string;
  cycleCount: number;
  cycleBudget: number;
  sessionKey: string | null;
  messageId: string | null;
  runId: string | null;
  startedAt: Date;
  closedAt: Date | null;
  closeReason: string | null;
  checkpointAt: Date | null;
  checkpoint: {
    completedWork: string[];
    evidence: string[];
    openChecklist: string[];
    nextAction: string | null;
    risks: string[];
  };
}

const MAX_CHECKPOINT_ITEMS = 20;
const MAX_CHECKPOINT_ITEM_CHARS = 600;
const MAX_NEXT_ACTION_CHARS = 1200;

function normalizeList(value: unknown): string[] | null {
  if (value === null) return [];
  if (value === undefined) return null;
  const raw = Array.isArray(value) ? value : [value];
  const items = raw
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter((entry) => entry.length > 0)
    .slice(0, MAX_CHECKPOINT_ITEMS)
    .map((entry) => entry.slice(0, MAX_CHECKPOINT_ITEM_CHARS));
  return items;
}

function normalizeText(value: unknown): string | null {
  if (value === null) return "";
  if (typeof value !== "string") return null;
  return value.trim().slice(0, MAX_NEXT_ACTION_CHARS);
}

function encodeList(value: string[] | null): string | undefined {
  if (value === null) return undefined;
  return JSON.stringify(value);
}

function decodeList(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : [];
  } catch {
    // A hand-edited or legacy row is evidence, not a crash: surface it as one
    // opaque line rather than dropping the episode's whole checkpoint.
    return [value];
  }
}

/**
 * Coerce a caller-supplied checkpoint (agent JSON, or PM-derived) into the
 * column shape. Fields the caller omitted come back `undefined` so a partial
 * checkpoint UPDATES only what it names instead of blanking the rest.
 */
export function checkpointUpdateData(checkpoint: EpisodeCheckpoint | null | undefined) {
  if (!checkpoint) return {};
  const data: Prisma.TaskExecutionEpisodeUpdateInput = {};
  const completedWork = encodeList(normalizeList(checkpoint.completedWork));
  const evidence = encodeList(normalizeList(checkpoint.evidence));
  const openChecklist = encodeList(normalizeList(checkpoint.openChecklist));
  const risks = encodeList(normalizeList(checkpoint.risks));
  const nextAction = normalizeText(checkpoint.nextAction);
  if (completedWork !== undefined) data.completedWork = completedWork;
  if (evidence !== undefined) data.evidence = evidence;
  if (openChecklist !== undefined) data.openChecklist = openChecklist;
  if (risks !== undefined) data.risks = risks;
  if (nextAction !== null) data.nextAction = nextAction;
  if (Object.keys(data).length > 0) data.checkpointAt = new Date();
  return data;
}

export function summarizeEpisode(row: {
  id: string;
  episodeNo: number;
  agentSlug: string;
  status: string;
  cycleCount: number;
  cycleBudget: number;
  sessionKey: string | null;
  messageId: string | null;
  runId: string | null;
  startedAt: Date;
  closedAt: Date | null;
  closeReason: string | null;
  checkpointAt: Date | null;
  completedWork: string | null;
  evidence: string | null;
  openChecklist: string | null;
  nextAction: string | null;
  risks: string | null;
}): TaskExecutionEpisodeSummary {
  return {
    id: row.id,
    episodeNo: row.episodeNo,
    agentSlug: row.agentSlug,
    status: row.status,
    cycleCount: row.cycleCount,
    cycleBudget: row.cycleBudget,
    sessionKey: row.sessionKey,
    messageId: row.messageId,
    runId: row.runId,
    startedAt: row.startedAt,
    closedAt: row.closedAt,
    closeReason: row.closeReason,
    checkpointAt: row.checkpointAt,
    checkpoint: {
      completedWork: decodeList(row.completedWork),
      evidence: decodeList(row.evidence),
      openChecklist: decodeList(row.openChecklist),
      nextAction: row.nextAction,
      risks: decodeList(row.risks),
    },
  };
}

const EPISODE_SELECT = {
  id: true,
  episodeNo: true,
  agentSlug: true,
  status: true,
  cycleCount: true,
  cycleBudget: true,
  sessionKey: true,
  messageId: true,
  runId: true,
  startedAt: true,
  closedAt: true,
  closeReason: true,
  checkpointAt: true,
  completedWork: true,
  evidence: true,
  openChecklist: true,
  nextAction: true,
  risks: true,
} as const;

async function openEpisodeRow(
  tx: Prisma.TransactionClient,
  args: { taskId: string; agentSlug: string },
) {
  return tx.taskExecutionEpisode.findFirst({
    where: { taskId: args.taskId, agentSlug: args.agentSlug, status: EPISODE_STATUS.open },
    orderBy: { episodeNo: "desc" },
    select: EPISODE_SELECT,
  });
}

/**
 * Allocate the next episode number for (task, agent).
 *
 * `max+1` under the unique index is the whole duplicate-rollover guard: two
 * concurrent rollovers both read N and both try to write N+1, and exactly one
 * of them survives. The loser's transaction aborts, which is the correct
 * outcome — its domain mutation is rolled back with it and the agent retries
 * against the episode that actually exists.
 */
async function allocateEpisodeNo(
  tx: Prisma.TransactionClient,
  args: { taskId: string; agentSlug: string },
) {
  const highest = await tx.taskExecutionEpisode.aggregate({
    where: { taskId: args.taskId, agentSlug: args.agentSlug },
    _max: { episodeNo: true },
  });
  return (highest._max.episodeNo ?? 0) + 1;
}

export async function openTaskExecutionEpisode(
  tx: Prisma.TransactionClient,
  args: {
    taskId: string;
    projectId?: string | null;
    agentSlug: string;
    sessionKey?: string | null;
    messageId?: string | null;
    runId?: string | null;
    cycleBudget?: number;
  },
) {
  const row = await tx.taskExecutionEpisode.create({
    data: {
      taskId: args.taskId,
      projectId: args.projectId ?? null,
      agentSlug: args.agentSlug,
      episodeNo: await allocateEpisodeNo(tx, args),
      sessionKey: args.sessionKey ?? null,
      messageId: args.messageId ?? null,
      runId: args.runId ?? null,
      cycleBudget: args.cycleBudget ?? episodeCycleBudget(),
      status: EPISODE_STATUS.open,
    },
    select: EPISODE_SELECT,
  });
  return summarizeEpisode(row);
}

export async function closeTaskExecutionEpisode(
  tx: Prisma.TransactionClient,
  args: {
    episodeId: string;
    closeReason: string;
    checkpoint?: EpisodeCheckpoint | null;
  },
) {
  const now = new Date();
  const row = await tx.taskExecutionEpisode.update({
    where: { id: args.episodeId },
    data: {
      ...checkpointUpdateData(args.checkpoint),
      status: EPISODE_STATUS.closed,
      closeReason: args.closeReason,
      closedAt: now,
    },
    select: EPISODE_SELECT,
  });
  return summarizeEpisode(row);
}

export interface EpisodeCycleOutcome {
  /** The episode the cycle was counted against. */
  episode: TaskExecutionEpisodeSummary;
  /** True when this cycle exhausted the budget and PM rolled the episode over. */
  rolledOver: boolean;
  /** The freshly opened successor, when a rollover happened. */
  nextEpisode: TaskExecutionEpisodeSummary | null;
}

/**
 * Count one observable cycle against the agent's open episode, folding in
 * whatever checkpoint material the caller has, and roll the episode over when
 * the budget is spent.
 *
 * Runs on the CALLER'S transaction so the cycle, the checkpoint, and the
 * workflow action's own domain mutation commit together or not at all. A
 * partial application here would be the same split ENV-118 closed for the
 * continuation outbox.
 */
export async function recordTaskExecutionEpisodeCycle(
  tx: Prisma.TransactionClient,
  args: {
    taskId: string;
    projectId?: string | null;
    agentSlug: string;
    action?: string | null;
    sessionKey?: string | null;
    messageId?: string | null;
    runId?: string | null;
    checkpoint?: EpisodeCheckpoint | null;
    /** Set false for an explicit checkpoint write that should not spend budget. */
    countsAgainstBudget?: boolean;
  },
): Promise<EpisodeCycleOutcome> {
  const existing = await openEpisodeRow(tx, args);
  const episode = existing
    ? summarizeEpisode(existing)
    : await openTaskExecutionEpisode(tx, args);

  const countsAgainstBudget = args.countsAgainstBudget !== false;
  // A derived checkpoint is strictly worse than the agent's own words, so it
  // only ever ADDS a completed-work line; an explicit `checkpoint` action
  // overwrites the named fields through `args.checkpoint`.
  const derived = args.action
    ? [
        ...episode.checkpoint.completedWork,
        `${workflowActionCheckpoint(args.action)} (${args.action})`,
      ].slice(-MAX_CHECKPOINT_ITEMS)
    : null;

  const updated = await tx.taskExecutionEpisode.update({
    where: { id: episode.id },
    data: {
      ...(derived ? { completedWork: JSON.stringify(derived), checkpointAt: new Date() } : {}),
      ...checkpointUpdateData(args.checkpoint),
      ...(countsAgainstBudget ? { cycleCount: { increment: 1 } } : {}),
      ...(args.sessionKey && !episode.sessionKey ? { sessionKey: args.sessionKey } : {}),
      ...(args.runId && !episode.runId ? { runId: args.runId } : {}),
    },
    select: EPISODE_SELECT,
  });
  const counted = summarizeEpisode(updated);

  if (!countsAgainstBudget || counted.cycleCount < counted.cycleBudget) {
    return { episode: counted, rolledOver: false, nextEpisode: null };
  }

  // Budget spent. Close with the checkpoint we now hold and open the successor
  // in the SAME transaction, so a retry can never observe a task whose agent
  // has no open episode.
  const closed = await closeTaskExecutionEpisode(tx, {
    episodeId: counted.id,
    closeReason: EPISODE_CLOSE_REASON.budgetExhausted,
  });
  const nextEpisode = await openTaskExecutionEpisode(tx, {
    taskId: args.taskId,
    projectId: args.projectId ?? null,
    agentSlug: args.agentSlug,
    cycleBudget: counted.cycleBudget,
  });
  return { episode: closed, rolledOver: true, nextEpisode };
}

/**
 * End the agent's open episode because the turn reached an episode-terminal
 * action. No successor is opened: the next execution turn (if there is one)
 * opens episode N+1 on its first cycle.
 */
export async function closeOpenTaskExecutionEpisode(
  tx: Prisma.TransactionClient,
  args: {
    taskId: string;
    agentSlug: string;
    closeReason: string;
    checkpoint?: EpisodeCheckpoint | null;
  },
) {
  const existing = await openEpisodeRow(tx, args);
  if (!existing) return null;
  return closeTaskExecutionEpisode(tx, {
    episodeId: existing.id,
    closeReason: args.closeReason,
    checkpoint: args.checkpoint,
  });
}

/**
 * The checkpoint a continuation brief starts from: the most recent episode for
 * this (task, agent) that actually carries checkpoint material. An episode that
 * was opened and rolled over without ever recording anything is skipped rather
 * than rendering an empty "latest checkpoint" block.
 */
export async function latestTaskExecutionCheckpoint(args: {
  taskId: string;
  agentSlug: string;
}): Promise<TaskExecutionEpisodeSummary | null> {
  const row = await db.taskExecutionEpisode.findFirst({
    where: {
      taskId: args.taskId,
      agentSlug: args.agentSlug,
      checkpointAt: { not: null },
    },
    orderBy: { episodeNo: "desc" },
    select: EPISODE_SELECT,
  });
  return row ? summarizeEpisode(row) : null;
}

/** Every episode for (task, agent), newest first. Used by the brief header. */
export async function taskExecutionEpisodeHistory(args: {
  taskId: string;
  agentSlug: string;
  take?: number;
}): Promise<TaskExecutionEpisodeSummary[]> {
  const rows = await db.taskExecutionEpisode.findMany({
    where: { taskId: args.taskId, agentSlug: args.agentSlug },
    orderBy: { episodeNo: "desc" },
    take: args.take ?? 5,
    select: EPISODE_SELECT,
  });
  return rows.map(summarizeEpisode);
}

/**
 * True when this (task, agent) is mid-execution — i.e. a prior episode already
 * checkpointed. That, not the workflow reason, is what makes a turn a
 * CONTINUATION and therefore eligible for the bounded brief.
 */
export async function hasTaskExecutionCheckpoint(args: {
  taskId: string;
  agentSlug: string;
}) {
  const row = await db.taskExecutionEpisode.findFirst({
    where: { taskId: args.taskId, agentSlug: args.agentSlug, checkpointAt: { not: null } },
    select: { id: true },
  });
  return row !== null;
}

export function renderEpisodeCheckpoint(episode: TaskExecutionEpisodeSummary): string[] {
  const lines = [
    `Episode ${episode.episodeNo} (${episode.status}, ${episode.cycleCount}/${episode.cycleBudget} cycles${episode.closeReason ? `, closed: ${episode.closeReason}` : ""})`,
  ];
  const section = (label: string, items: string[]) => {
    if (items.length === 0) return;
    lines.push(`${label}:`);
    for (const item of items) lines.push(`- ${item}`);
  };
  section("Completed work", episode.checkpoint.completedWork);
  section("Evidence / artifacts", episode.checkpoint.evidence);
  section("Open checklist", episode.checkpoint.openChecklist);
  lines.push(`Next exact action: ${episode.checkpoint.nextAction || "(not recorded — derive it from the open checklist)"}`);
  section("Current risks", episode.checkpoint.risks);
  return lines;
}
