#!/usr/bin/env node
// Deliberately read-only SQLite access: no .env loading, Prisma or default live DB.
import { DatabaseSync } from "node:sqlite";
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
const parse = (value) => { try { return JSON.parse(value ?? "null"); } catch { return null; } };
const ms = (value) => value == null ? null : typeof value === "number" ? value : new Date(value).getTime();
const span = (from, to) => from == null || to == null || ms(to) < ms(from) ? null : ms(to) - ms(from);
const stats = (values) => {
  const sorted = values.filter((v) => v != null && Number.isFinite(v)).sort((a, b) => a - b);
  const percentile = (p) => sorted.length ? sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)] : null;
  return { samples: sorted.length, p50: percentile(0.5), p95: percentile(0.95) };
};

export function taskWorkflowReport(databasePath, taskId) {
  if (!isAbsolute(databasePath) || !taskId) throw new Error("An explicit absolute SQLite path and task ID are required.");
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const task = db.prepare('SELECT id, status, workflow_version AS workflowVersion FROM Task WHERE id = ?').get(taskId);
    if (!task) throw new Error("Task not found in the supplied database.");
    const runs = db.prepare('SELECT * FROM PmChannelRun WHERE taskId = ? ORDER BY createdAt').all(taskId);
    const activities = db.prepare('SELECT kind, payload FROM ActivityLog WHERE taskId = ? AND kind IN (?, ?, ?) ORDER BY createdAt').all(taskId, "pm.task.runtime.prepared", "pm.task.model_usage", "pm.session.rotated");
    const runtimeByMessage = new Map();
    const usageByRun = new Map();
    for (const row of activities) {
      const payload = parse(row.payload);
      if (!payload) continue;
      if (row.kind === "pm.task.runtime.prepared") runtimeByMessage.set(payload.messageId, payload);
      if (row.kind === "pm.task.model_usage") {
        const modelRuns = usageByRun.get(payload.runId) ?? new Map();
        modelRuns.set(payload.modelRunId, payload); // replayed callbacks are one sample
        usageByRun.set(payload.runId, modelRuns);
      }
    }
    const toolQuery = db.prepare('SELECT toolName, startedAt FROM PmChannelToolCall WHERE runId = ? ORDER BY startedAt');
    const rows = runs.map((run) => {
      const runtime = runtimeByMessage.get(run.messageId);
      const tools = toolQuery.all(run.id);
      const modelRuns = [...(usageByRun.get(run.id)?.values() ?? [])];
      const tokenTotal = (key) => {
        const known = modelRuns.filter((row) => typeof row[key] === "number");
        return known.length ? known.reduce((sum, row) => sum + row[key], 0) : null;
      };
      return {
        runId: run.id, messageId: run.messageId, agent: run.agentSlug,
        contract: runtime?.contractVersion ?? "legacy-or-unmeasured", role: runtime?.role ?? null,
        provider: run.provider, model: run.model, status: run.status, settledByAction: run.settledByAction,
        queueToAdmissionMs: span(run.createdAt, run.admittedAt ?? run.acceptedAt),
        admissionToFirstToolMs: span(run.admittedAt ?? run.acceptedAt, tools[0]?.startedAt),
        // lastActionAt is explicitly the last recorded workflow action, not a guessed first useful action.
        admissionToLastWorkflowActionMs: span(run.admittedAt ?? run.acceptedAt, run.lastActionAt),
        totalMs: span(run.createdAt, run.completedAt ?? run.failedAt ?? run.finishedAt),
        promptChars: runtime?.promptChars ?? null, legacyPromptChars: runtime?.originalPromptChars ?? null,
        toolCalls: tools.length, pmToolCalls: tools.filter((tool) => tool.toolName.startsWith("pm_")).length,
        modelUsageSamples: modelRuns.length,
        tokens: Object.fromEntries(["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "totalTokens"].map((key) => [key, tokenTotal(key)])),
      };
    });
    const groups = new Map();
    for (const row of rows) {
      const key = [row.contract, row.role ?? "unknown-role", row.provider ?? "unknown-provider", row.model ?? "unknown-model"].join("/");
      groups.set(key, [...(groups.get(key) ?? []), row]);
    }
    const episodeRows = db.prepare('SELECT episode_no, status, close_reason, cycle_count, tool_cycle_count FROM task_execution_episodes WHERE task_id = ? ORDER BY episode_no').all(taskId);
    return {
      task, notes: ["Times are milliseconds; null means unavailable, never zero-cost.", "Prompt sizes are characters, not tokenizer counts; model usage is provider-reported and includes non-PM context.", "Tool calls measure interaction volume; first-tool timing does not prove the action was useful.", "Compare matched tasks by role/provider/model; this report alone does not establish causation."],
      workflowSignals: {
        rejectedCommands: db.prepare('SELECT count(*) AS n FROM ActivityLog WHERE taskId = ? AND kind = ?').get(taskId, "task.workflow.command_rejected").n,
        permissionRequests: db.prepare('SELECT payload FROM ActivityLog WHERE taskId = ? AND kind = ?').all(taskId, "task.blocker").filter(row => parse(row.payload)?.permissionRequest).length,
        humanComments: db.prepare('SELECT count(*) AS n FROM Comment c JOIN User u ON u.id = c.userId WHERE c.taskId = ? AND c.deletedAt IS NULL AND u.kind = ?').get(taskId, "human").n,
        completedRuns: rows.filter(run => run.status === "completed").length,
        supersededRuns: rows.filter(run => run.status === "superseded").length,
        runsWithoutToolsOrWorkflowAction: rows.filter(run => run.toolCalls === 0 && !run.settledByAction).length,
        hardBudgetClosures: episodeRows.filter(episode => /tool.*budget|context.*budget/.test(episode.close_reason ?? "")).length,
        // Missing pre-deployment rejection/usage telemetry is not proof of zero friction.
        measurementsStartedWithContract: "pm-task/4",
      },
      planRevisions: db.prepare('SELECT count(*) AS n FROM ActionPlanRevision WHERE taskId = ?').get(taskId).n,
      sessionRotations: activities.filter((row) => row.kind === "pm.session.rotated").length,
      episodes: episodeRows,
      groups: Object.fromEntries([...groups].map(([key, group]) => [key, {
        runs: group.length, failures: group.filter((run) => ["failed", "timed_out"].includes(run.status)).length,
        cancellations: group.filter((run) => ["cancelled", "superseded"].includes(run.status)).length,
        totalMs: stats(group.map((run) => run.totalMs)), firstToolMs: stats(group.map((run) => run.admissionToFirstToolMs)),
        promptChars: stats(group.map((run) => run.promptChars)), inputTokens: stats(group.map((run) => run.tokens.inputTokens)),
        toolCalls: stats(group.map((run) => run.toolCalls)),
      }])),
      runs: rows,
    };
  } finally { db.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const arg = (name) => process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3);
  try { console.log(JSON.stringify(taskWorkflowReport(arg("database") ?? "", arg("task") ?? ""), null, 2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
