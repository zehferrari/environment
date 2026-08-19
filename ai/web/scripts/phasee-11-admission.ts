#!/usr/bin/env tsx

import { readFileSync } from "node:fs";
import { db } from "@/lib/db";
import {
  getProjectAdmissionReport,
  runProjectAdmission,
  unpinQuiescentTask,
} from "@/lib/tasks/orchestrator/admission";
import {
  assertRolloutEvidence,
  evaluateRolloutGates,
  type RolloutEvidence,
} from "@/lib/tasks/orchestrator/rollout-gates";

function option(name: string): string | null {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length) ?? null;
}

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function requiredOption(name: string): string {
  const value = option(name);
  if (!value) throw new Error(`Missing required --${name}=... option.`);
  return value;
}

function loadEvidence(filePath: string): RolloutEvidence {
  const value: unknown = JSON.parse(readFileSync(filePath, "utf8"));
  assertRolloutEvidence(value);
  return value;
}

async function ownerId(username: string): Promise<string> {
  const owner = await db.user.findUnique({
    where: { username },
    select: { id: true, kind: true, status: true, isOwner: true },
  });
  if (!owner || owner.kind !== "human" || owner.status !== "active" || !owner.isOwner) {
    throw new Error(`Active Mission Control owner not found: ${username}`);
  }
  return owner.id;
}

async function main() {
  const command = process.argv[2];
  if (!command || flag("help")) {
    console.log([
      "Usage:",
      "  pnpm phasee:admission preflight --evidence=<json>",
      "  pnpm phasee:admission report --project=<slug>",
      "  pnpm phasee:admission admit --project=<slug> --operator=<owner-username> --evidence=<json> [--dry-run] [--include-done]",
      "  pnpm phasee:admission unpin --project=<slug> --task=<id-or-key> --operator=<owner-username>",
    ].join("\n"));
    return;
  }

  if (command === "preflight") {
    const report = evaluateRolloutGates(loadEvidence(requiredOption("evidence")));
    console.log(JSON.stringify(report, null, 2));
    if (!report.ready) process.exitCode = 2;
    return;
  }

  if (command === "report") {
    console.log(JSON.stringify(await getProjectAdmissionReport(requiredOption("project")), null, 2));
    return;
  }

  if (command === "admit") {
    const username = requiredOption("operator");
    const result = await runProjectAdmission({
      projectSlug: requiredOption("project"),
      operatorUserId: await ownerId(username),
      evidence: loadEvidence(requiredOption("evidence")),
      dryRun: flag("dry-run"),
      includeDone: flag("include-done"),
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (command === "unpin") {
    const username = requiredOption("operator");
    const result = await unpinQuiescentTask({
      projectSlug: requiredOption("project"),
      taskIdOrKey: requiredOption("task"),
      operatorUserId: await ownerId(username),
    });
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 2;
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.$disconnect();
  });
