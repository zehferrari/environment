import { db } from "@/lib/db";
import type { BillingLedger, BillingLedgerDay } from "@/lib/billing/git-ledger";
import { formatBillingDay } from "@/lib/billing/period";

export const DEFAULT_BILLING_PROMPT = [
  "For each day below, write one or two sentences describing what was actually done,",
  "in terms a paying client would recognise — the feature or defect, not the file names.",
  "Then estimate how long that day's work took.",
  "Also write a short client-facing paragraph covering the main updates across the whole period; return it in notes.",
  "Commit timestamps are a lower bound: they miss the investigation before the first commit,",
  "so a small diff that took a long hunt should be estimated on the hunt, not the diff.",
].join(" ");

export function cleanBillingPrompt(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

export function resolveBillingPromptValue(projectPrompt: unknown, systemPrompt: unknown) {
  return (
    cleanBillingPrompt(projectPrompt) ??
    cleanBillingPrompt(systemPrompt) ??
    DEFAULT_BILLING_PROMPT
  );
}

export async function resolveBillingPrompt(projectId: string) {
  const [project, system] = await Promise.all([
    db.project.findUnique({ where: { id: projectId }, select: { billingPrompt: true } }),
    db.systemSettings.findUnique({ where: { id: "system" }, select: { billingPrompt: true } }),
  ]);
  return resolveBillingPromptValue(project?.billingPrompt, system?.billingPrompt);
}

// sendDirectAgentMessage refuses a body over 8000 characters, so the dispatch
// carries a COMPACT ledger and a URL for the rest. The compact form is enough to
// summarise and estimate from; the full commit list is one authenticated GET away
// when a day needs a closer look.
export const BODY_LIMIT = 8000;
// The ledger gets whatever the instructions and the prompt leave over, measured
// rather than guessed — a longer project prompt must not push the body past the
// cap and turn a run into a silent no-op.
const BODY_SAFETY_MARGIN = 200;
const SUBJECTS_PER_DAY = 6;

function compactDay(day: BillingLedgerDay, subjectLimit: number) {
  const span =
    day.firstCommitAt && day.lastCommitAt
      ? `${day.firstCommitAt.slice(11, 16)}–${day.lastCommitAt.slice(11, 16)}`
      : "";
  const head = [
    `${day.day} (${formatBillingDay(day.day)})`,
    `${day.commitCount} commit${day.commitCount === 1 ? "" : "s"}`,
    span,
    `+${day.insertions} -${day.deletions}`,
    `${day.filesTouched} file${day.filesTouched === 1 ? "" : "s"}`,
  ]
    .filter(Boolean)
    .join(" · ");

  const subjects = day.commits.slice(0, subjectLimit).map((commit) => `    - ${commit.subject}`);
  if (day.commits.length > subjectLimit) {
    subjects.push(`    - …${day.commits.length - subjectLimit} more`);
  }
  return [`  ${head}`, ...subjects].join("\n");
}

export function compactLedger(ledger: BillingLedger, budget: number) {
  // Trim the per-day subject list rather than dropping days: a missing day would
  // be billed at zero, while a shorter subject list only costs the agent detail
  // it can fetch if it needs it.
  for (let limit = SUBJECTS_PER_DAY; limit >= 1; limit -= 1) {
    const text = ledger.days.map((day) => compactDay(day, limit)).join("\n");
    if (text.length <= budget) return text;
  }
  return ledger.days.map((day) => compactDay(day, 0)).join("\n");
}

export type BillingDispatchArgs = {
  agentSlug: string;
  projectName: string;
  repositoryPath: string;
  ledger: BillingLedger;
  prompt: string;
  ledgerUrl: string;
  callbackUrl: string;
  token: string;
};

export function buildBillingDispatchBody(args: BillingDispatchArgs) {
  // Render once with no ledger to measure the fixed part, then give the ledger
  // exactly the room that is left.
  const fixed = renderDispatchBody(args, "");
  const budget = Math.max(0, BODY_LIMIT - fixed.length - BODY_SAFETY_MARGIN);
  return renderDispatchBody(args, compactLedger(args.ledger, budget));
}

function renderDispatchBody(args: BillingDispatchArgs, ledgerText: string) {
  const { ledger } = args;
  const authors = ledger.authorEmails.length > 0 ? ledger.authorEmails.join(", ") : "every author";

  return [
    `PM billing request for @${args.agentSlug}:`,
    "",
    `Project: ${args.projectName}`,
    `Repository: ${args.repositoryPath}`,
    `Period: ${ledger.from} to ${ledger.to} (inclusive)`,
    `Author: ${authors}`,
    `Branch: ${ledger.ref === "--all" ? "all refs" : ledger.ref}`,
    "",
    "PM has already read the repository. These facts are authoritative — do not",
    "recompute them, and do not report a day that is not listed here:",
    "",
    ledgerText,
    "",
    `Totals: ${ledger.totals.days} days · ${ledger.totals.commits} commits · +${ledger.totals.insertions} -${ledger.totals.deletions} · ${ledger.totals.filesTouched} file changes`,
    "(Line counts exclude lockfiles, minified assets and build output.)",
    "",
    "Your task:",
    args.prompt,
    "",
    "The full commit list, including every subject, is available at:",
    `  GET ${args.ledgerUrl}`,
    `  Authorization: Bearer ${args.token}`,
    "",
    "When you are done, POST your answer:",
    `  POST ${args.callbackUrl}`,
    `  Authorization: Bearer ${args.token}`,
    "  Content-Type: application/json",
    "  {",
    '    "days": [',
    '      { "day": "YYYY-MM-DD", "summary": "one or two sentences",',
    '        "estimatedMinutes": 120, "rationale": "why that long" }',
    "    ],",
    '    "notes": "short client-facing paragraph with the main updates across the period"',
    "  }",
    "",
    "One entry per day listed above, using the same YYYY-MM-DD keys. estimatedMinutes",
    "is a whole number of minutes. A day you omit is recorded at zero and flagged for",
    "a human, so omit nothing. Do not reply with an acknowledgement — POST the result.",
  ].join("\n");
}
