// ENV-124 — the aggregate runner for the PM workflow regression suite.
//
// The Epic's twelve regression cases are split across five scenario files. This
// runner exists so there is one command that proves all twelve, and so a
// failure names the group and the case rather than a stack trace.
//
// Each group runs as a SEPARATE CHILD PROCESS, and that is not an optimisation
// — it is required for correctness. Every scenario repoints `DATABASE_URL` at
// its own throwaway database before importing `@/lib/db`, which reads the
// variable once at module-eval time. Two groups sharing a process would share
// whichever database happened to be imported first, and the second group would
// silently assert against the first group's rows. Separate processes give each
// group its own module registry and its own env.
//
// Groups are independent by construction (no shared rows, no shared fixtures),
// so they run concurrently by default. `--serial` exists for debugging a
// failure without interleaved output, and for hosts where five concurrent
// `prisma migrate deploy` invocations are more IO than they are worth.

import { spawn } from "node:child_process";
import path from "node:path";

interface Group {
  /** Short id used in the summary table. */
  id: string;
  /** Which of the Epic's twelve cases this group covers. */
  cases: string;
  script: string;
}

const GROUPS: readonly Group[] = [
  {
    id: "lifecycle",
    cases: "1, 2, 3, 4, 5, 10",
    script: "scripts/workflow-regression-lifecycle-test.ts",
  },
  {
    id: "plan-steps",
    cases: "6, 7",
    script: "scripts/workflow-regression-plan-steps-test.ts",
  },
  {
    id: "blocker",
    cases: "8, 9",
    script: "scripts/workflow-regression-blocker-test.ts",
  },
  {
    id: "concurrency",
    cases: "11, 12",
    script: "scripts/workflow-regression-concurrency-test.ts",
  },
  {
    id: "fixture",
    cases: "Patricia E6 outage-drill replay",
    script: "scripts/workflow-regression-fixture-test.ts",
  },
];

interface GroupResult {
  group: Group;
  code: number;
  ms: number;
  output: string;
}

function runGroup(group: Group, streamLive: boolean): Promise<GroupResult> {
  const startedAt = Date.now();
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [path.join("node_modules", "tsx", "dist", "cli.mjs"), group.script],
      {
        cwd: process.cwd(),
        env: { ...process.env },
        // Captured either way: a passing group prints one line, and a failing
        // group's full output is replayed in the summary so a concurrent run is
        // still diagnosable.
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    let output = "";
    const collect = (chunk: Buffer) => {
      const text = chunk.toString();
      output += text;
      if (streamLive) process.stdout.write(text);
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);

    child.on("error", (error) => {
      resolve({
        group,
        code: 1,
        ms: Date.now() - startedAt,
        output: `${output}\nfailed to spawn: ${String(error)}`,
      });
    });
    child.on("close", (code) => {
      resolve({ group, code: code ?? 1, ms: Date.now() - startedAt, output });
    });
  });
}

async function main(): Promise<void> {
  const serial = process.argv.includes("--serial");
  const only = process.argv
    .filter((arg) => arg.startsWith("--only="))
    .flatMap((arg) => arg.slice("--only=".length).split(","))
    .filter(Boolean);

  const selected = only.length
    ? GROUPS.filter((group) => only.includes(group.id))
    : GROUPS;

  if (!selected.length) {
    console.error(
      `[workflow-regression] no groups matched --only=${only.join(",")}; known ids: ${GROUPS.map((g) => g.id).join(", ")}`,
    );
    process.exit(1);
  }

  console.log(
    `[workflow-regression] running ${selected.length} group(s) ${serial ? "serially" : "concurrently"}`,
  );

  const results: GroupResult[] = [];
  if (serial) {
    for (const group of selected) {
      console.log(`\n--- ${group.id} (cases ${group.cases}) ---`);
      results.push(await runGroup(group, true));
    }
  } else {
    results.push(...(await Promise.all(selected.map((group) => runGroup(group, false)))));
  }

  const failed = results.filter((result) => result.code !== 0);

  if (!serial) {
    console.log("");
    for (const result of results) {
      const mark = result.code === 0 ? "PASS" : "FAIL";
      const seconds = (result.ms / 1000).toFixed(1);
      console.log(
        `[workflow-regression] ${mark} ${result.group.id.padEnd(12)} cases ${result.group.cases} (${seconds}s)`,
      );
    }
  }

  if (failed.length) {
    for (const result of failed) {
      console.error(`\n=== ${result.group.id} FAILED (exit ${result.code}) ===`);
      console.error(result.output.trimEnd());
    }
    console.error(
      `\n[workflow-regression] FAIL — ${failed.length}/${results.length} group(s) failed: ${failed
        .map((result) => result.group.id)
        .join(", ")}`,
    );
    process.exit(1);
  }

  console.log(
    `\n[workflow-regression] OK — ${results.length}/${results.length} group(s) passed, covering all twelve Epic regression cases.`,
  );
}

main().catch((error) => {
  console.error("[workflow-regression] FAIL:", error);
  process.exit(1);
});
