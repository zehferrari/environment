import { db } from "@/lib/db";
import { generateClientMessageId } from "@/lib/agents/ops/client-message-id";
import { absolutePublicUrl } from "@/lib/http/public-origin";
import { buildBillingDispatchBody } from "@/lib/billing/prompt";
import { resolveBillingPrompt } from "@/lib/billing/prompt";
import { createBillingCallbackToken } from "@/lib/billing/token";
import { markBillingRunFailed, markBillingRunRunning, parseLedger } from "@/lib/billing/report";

export type BillingAgentOption = {
  slug: string;
  name: string;
  role: string;
};

// Any active agent may be asked, because a different perspective is the point of
// the picker. Monitor agents lead the list because one of them is the default.
export async function listBillingAgents(): Promise<BillingAgentOption[]> {
  const agents = await db.agent.findMany({
    where: { deactivatedAt: null, user: { is: { status: "active" } } },
    orderBy: [{ role: "asc" }, { name: "asc" }],
    select: { slug: true, name: true, role: true },
  });
  return agents.sort((a, b) => {
    if (a.role === b.role) return a.name.localeCompare(b.name);
    return a.role === "monitor" ? -1 : b.role === "monitor" ? 1 : a.role.localeCompare(b.role);
  });
}

// Same resolution as lib/epics/deploy-review.ts: the oldest active monitor agent.
export async function resolveMonitorAgentSlug(): Promise<string | null> {
  const monitor = await db.agent.findFirst({
    where: { role: "monitor", deactivatedAt: null, user: { is: { status: "active" } } },
    orderBy: { createdAt: "asc" },
    select: { slug: true },
  });
  return monitor?.slug ?? null;
}

export async function selectBillingAgentSlug(requested: string | null | undefined) {
  const wanted = requested?.trim();
  if (wanted) {
    const agent = await db.agent.findFirst({
      where: { slug: wanted, deactivatedAt: null, user: { is: { status: "active" } } },
      select: { slug: true },
    });
    if (agent) return agent.slug;
  }
  return resolveMonitorAgentSlug();
}

export type TriggerBillingRunArgs = {
  reportId: string;
  runId: string;
  actorId: string;
  origin: string | null;
};

export type TriggerBillingRunResult = { ok: true; agentSlug: string } | { ok: false; error: string };

// Hands the run to the agent. The ledger is already stored, so a dispatch that
// fails leaves a report with facts and no estimate — recoverable by re-running,
// rather than a report that has to be rebuilt from scratch.
export async function triggerBillingRun(args: TriggerBillingRunArgs): Promise<TriggerBillingRunResult> {
  const run = await db.billingRun.findUnique({
    where: { id: args.runId },
    select: {
      id: true,
      status: true,
      ledger: true,
      report: {
        select: {
          id: true,
          agentSlug: true,
          status: true,
          project: { select: { id: true, name: true, slug: true, repositoryPath: true } },
        },
      },
    },
  });
  if (!run || run.report.id !== args.reportId) return { ok: false, error: "Billing run not found." };
  const report = run.report;
  if (report.status === "final") return { ok: false, error: "This report is finalized." };

  const ledger = parseLedger(run.ledger);
  if (!ledger) return { ok: false, error: "This report has no readable ledger." };
  if (ledger.days.length === 0) {
    await markBillingRunFailed(run.id, "No commits in this period, so there is nothing to summarise.");
    return { ok: false, error: "No commits were found in this period." };
  }

  const agent = await db.agent.findFirst({
      where: { slug: report.agentSlug, deactivatedAt: null, user: { is: { status: "active" } } },
    select: { slug: true },
  });
  if (!agent) {
    await markBillingRunFailed(run.id, `Agent ${report.agentSlug} is not available.`);
    return { ok: false, error: `Agent ${report.agentSlug} is not active.` };
  }

  const prompt = await resolveBillingPrompt(report.project.id);
  const token = createBillingCallbackToken(report.project.id, run.id, agent.slug);
  const base = `/api/agent/projects/${report.project.id}/billing/${report.id}/runs/${run.id}`;

  const body = buildBillingDispatchBody({
    agentSlug: agent.slug,
    projectName: report.project.name,
    repositoryPath: report.project.repositoryPath ?? "(not configured)",
    ledger,
    prompt,
    ledgerUrl: absolutePublicUrl(base, args.origin),
    callbackUrl: absolutePublicUrl(base, args.origin),
    token,
  });

  const messageId = generateClientMessageId();
  const form = new FormData();
  form.set("agentSlug", agent.slug);
  form.set("projectId", report.project.id);
  form.set("clientMessageId", messageId);
  form.set("billingRunId", run.id);
  form.set("body", body);

  try {
    const { sendDirectAgentMessage } = await import("@/lib/agents/chat/direct/actions");
    await sendDirectAgentMessage(form);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to reach the agent.";
    await markBillingRunFailed(run.id, message);
    return { ok: false, error: message };
  }

  await markBillingRunRunning(run.id, messageId);
  await db.activityLog.create({
    data: {
      projectId: report.project.id,
      userId: args.actorId,
      kind: "project.billing.dispatch",
      targetAgent: agent.slug,
      payload: JSON.stringify({
        reportId: report.id,
        runId: run.id,
        from: ledger.from,
        to: ledger.to,
        days: ledger.totals.days,
        commits: ledger.totals.commits,
      }),
    },
  });

  return { ok: true, agentSlug: agent.slug };
}
