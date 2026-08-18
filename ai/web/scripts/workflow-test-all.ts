// The aggregate pre-deploy workflow gate: one command (`pnpm test:workflow`)
// that runs every workflow-related suite on this branch in a fixed order and
// fails if any member fails.
//
// Sibling of workflow-regression-test.ts (which aggregates only the Epic's
// twelve regression cases and remains the LAST member here). Differences are
// deliberate:
//   - Members run via `pnpm run <script>` so each suite keeps the exact
//     invocation package.json documents (`tsx` vs `node --import tsx`) and a
//     failure names a command a developer can rerun verbatim.
//   - Execution is SERIAL. Most members provision their own throwaway sqlite
//     database (`prisma migrate deploy`/`db push`); one at a time keeps output
//     readable and failure attribution unambiguous.
//   - The boundary AST lint runs FIRST: it is fast, structural, and the one
//     member that guards the codebase itself (no `task.status` writes outside
//     the transition kernel) rather than runtime behaviour.
//
// `--only=<name>[,<name>...]` runs a subset; the `test:` prefix is optional.

import { spawn } from "node:child_process";

const SUITES: readonly string[] = [
  // Structural guard first — fast, no database.
  "test:workflow-boundary",
  // Kernel + invariants.
  "test:workflow-invariants",
  "test:workflow-invariants-db",
  "test:workflow-action-effect",
  "test:workflow-transition-kernel",
  // Orchestration project (ORCH-01..ORCH-10).
  "test:orch-01-cycle",
  "test:orch-02-orchestrator",
  "test:orch-03-procedure",
  "test:workflow-reconciler",
  "test:workflow-agent-rules",
  "test:repository-workflow",
  "test:review-handoff-cycle",
  "test:review-finalization-retry",
  "test:epic-completion-review",
  // Watchdog family.
  "test:workflow-watchdog",
  "test:workflow-watchdog-db",
  "test:workflow-watchdog-visibility",
  // Execution episodes + PM-channel lifecycle.
  "test:pm-execution-episode",
  "test:task-execution-episode",
  "test:pm-channel-lifecycle",
  "test:agent-system-messages",
  "test:pm-channel-lease-lifecycle",
  // Blockers, plans, comment provenance.
  "test:formal-blocker-validation",
  "test:blocker-permission-grant",
  "test:action-plan-structured",
  "test:env122-comment-metadata",
  "test:env122-comment-provenance",
  // The twelve-case regression family, via its own aggregate runner.
  "test:workflow-regression",
];

interface SuiteResult {
  name: string;
  code: number;
  ms: number;
}

function runSuite(name: string): Promise<SuiteResult> {
  const startedAt = Date.now();
  return new Promise((resolve) => {
    const child = spawn("pnpm", ["run", name], {
      cwd: process.cwd(),
      env: { ...process.env },
      stdio: "inherit",
    });
    child.on("error", (error) => {
      console.error(`[workflow-test-all] failed to spawn pnpm run ${name}: ${String(error)}`);
      resolve({ name, code: 1, ms: Date.now() - startedAt });
    });
    child.on("close", (code) => {
      resolve({ name, code: code ?? 1, ms: Date.now() - startedAt });
    });
  });
}

async function main(): Promise<void> {
  const only = process.argv
    .filter((arg) => arg.startsWith("--only="))
    .flatMap((arg) => arg.slice("--only=".length).split(","))
    .filter(Boolean)
    .map((name) => (name.startsWith("test:") ? name : `test:${name}`));

  const selected = only.length
    ? SUITES.filter((name) => only.includes(name))
    : SUITES;

  if (!selected.length) {
    console.error(
      `[workflow-test-all] no suites matched --only=${only.join(",")}; known suites: ${SUITES.join(", ")}`,
    );
    process.exit(1);
  }

  console.log(`[workflow-test-all] running ${selected.length} suite(s) serially`);

  const results: SuiteResult[] = [];
  for (const name of selected) {
    console.log(`\n--- ${name} ---`);
    results.push(await runSuite(name));
  }

  const failed = results.filter((result) => result.code !== 0);

  console.log("");
  for (const result of results) {
    const mark = result.code === 0 ? "PASS" : "FAIL";
    const seconds = (result.ms / 1000).toFixed(1);
    console.log(`[workflow-test-all] ${mark} ${result.name.padEnd(38)} (${seconds}s)`);
  }

  if (failed.length) {
    console.error(
      `\n[workflow-test-all] FAIL — ${failed.length}/${results.length} suite(s) failed: ${failed
        .map((result) => result.name)
        .join(", ")}`,
    );
    process.exit(1);
  }

  console.log(`\n[workflow-test-all] OK — ${results.length}/${results.length} suite(s) passed.`);
}

main().catch((error) => {
  console.error("[workflow-test-all] FAIL:", error);
  process.exit(1);
});
