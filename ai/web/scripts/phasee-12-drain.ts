#!/usr/bin/env tsx

import { db } from "@/lib/db";
import {
  getLegacyDefaultCutoverReport,
  runLegacyDefaultCutover,
} from "@/lib/tasks/orchestrator/default-cutover";

function option(name: string) {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length) ?? null;
}

function requiredOption(name: string) {
  const value = option(name);
  if (!value) throw new Error(`Missing required --${name}=... option.`);
  return value;
}

async function ownerId(username: string) {
  const owner = await db.user.findUnique({ where: { username }, select: { id: true } });
  if (!owner) throw new Error(`Mission Control user not found: ${username}`);
  return owner.id;
}

async function main() {
  const command = process.argv[2];
  if (!command || process.argv.includes("--help")) {
    console.log([
      "Usage:",
      "  pnpm phasee:drain report [--since=<ISO timestamp>]",
      "  pnpm phasee:drain apply --operator=<owner-username> [--dry-run]",
      "  pnpm phasee:drain gate --since=<ISO timestamp>",
    ].join("\n"));
    return;
  }
  if (command === "apply") {
    console.log(JSON.stringify(await runLegacyDefaultCutover({
      operatorUserId: await ownerId(requiredOption("operator")),
      dryRun: process.argv.includes("--dry-run"),
    }), null, 2));
    return;
  }
  const sinceValue = option("since");
  const since = sinceValue ? new Date(sinceValue) : undefined;
  if (since && Number.isNaN(since.getTime())) throw new Error("--since must be a valid ISO timestamp.");
  if (command === "gate" && !since) throw new Error("gate requires --since=<ISO timestamp>.");
  if (command === "report" || command === "gate") {
    const report = await getLegacyDefaultCutoverReport({ since });
    console.log(JSON.stringify(report, null, 2));
    if (command === "gate" && !report.gate.ready) process.exitCode = 2;
    return;
  }
  throw new Error(`Unknown command: ${command}`);
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => db.$disconnect());
