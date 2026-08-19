import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { INTENT_EXECUTORS } from "@/lib/tasks/orchestrator/intents";
import { TASK_WORKFLOW_INTENTS } from "@/lib/tasks/orchestrator/types";

const roots = ["app", "lib"];
// Legacy drain seams plus the kernel/cycle owners. V2 decision-owned writes
// are allowed only below lib/tasks/orchestrator/intents/.
const allowed = new Set([
  path.normalize("lib/tasks/transition-kernel.ts"),
  path.normalize("lib/tasks/workflow-cycle.ts"),
  path.normalize("lib/tasks/orchestrator/procedure-runner.ts"),
  path.normalize("lib/tasks/workflow-reconciler.ts"),
  path.normalize("lib/tasks/review-handoff.ts"),
  path.normalize("lib/tasks/review-automation.ts"),
  path.normalize("lib/tasks/orchestrator/handlers/review-decisions.ts"),
  path.normalize("lib/deploy/epic-merge.ts"),
  path.normalize("app/api/agent/tasks/[taskId]/workflow/route.ts"),
]);
const PROTECTED_TASK_FIELDS = new Set(["status", "workflowVersion", "activeWorkflowCycleId"]);
const PROTECTED_REVIEW_RUN_FIELDS = new Set(["status", "reviewerId", "reviewedAt"]);
const violations: string[] = [];
const intentRoot = `${path.normalize("lib/tasks/orchestrator/intents")}${path.sep}`;

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory()
      ? files(full)
      : /\.(?:ts|tsx)$/.test(name)
        ? [full]
        : [];
  });
}

function propertyName(node: ts.ObjectLiteralElementLike) {
  if (!node.name) return null;
  return ts.isIdentifier(node.name) || ts.isStringLiteral(node.name) ? node.name.text : null;
}

function directModelFieldWrite(
  call: ts.CallExpression,
  modelName: string,
  protectedFields: Set<string>,
): string[] {
  if (!ts.isPropertyAccessExpression(call.expression)) return [];
  if (call.expression.name.text !== "update" && call.expression.name.text !== "updateMany") return [];
  const model = call.expression.expression;
  if (!ts.isPropertyAccessExpression(model) || model.name.text !== modelName) return [];
  const args = call.arguments[0];
  if (!args || !ts.isObjectLiteralExpression(args)) return [];
  const data = args.properties.find((item) => propertyName(item) === "data");
  if (!data || !ts.isPropertyAssignment(data) || !ts.isObjectLiteralExpression(data.initializer)) return [];
  const found: string[] = [];
  for (const item of data.initializer.properties) {
    const name = propertyName(item);
    if (name && protectedFields.has(name)) found.push(name);
  }
  return found;
}

for (const root of roots) {
  for (const filename of files(root)) {
    const relative = path.normalize(filename);
    if (allowed.has(relative) || relative.startsWith(intentRoot)) continue;
    const source = readFileSync(filename, "utf8");
    const parsed = ts.createSourceFile(
      filename,
      source,
      ts.ScriptTarget.Latest,
      true,
      filename.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node)) {
        for (const field of directModelFieldWrite(node, "task", PROTECTED_TASK_FIELDS)) {
          const line = parsed.getLineAndCharacterOfPosition(node.getStart()).line + 1;
          violations.push(`${filename}:${line} Task.${field}`);
        }
        for (const field of directModelFieldWrite(node, "reviewRun", PROTECTED_REVIEW_RUN_FIELDS)) {
          const line = parsed.getLineAndCharacterOfPosition(node.getStart()).line + 1;
          violations.push(`${filename}:${line} ReviewRun.${field}`);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(parsed);
    if (/UPDATE\s+["`']?(?:tasks|Task)["`']?\s+SET\s+[\s\S]{0,200}\bstatus\b/i.test(source)) {
      violations.push(`${filename}: raw SQL task status update`);
    }
  }
}

assert.deepEqual(
  violations,
  [],
  `Protected workflow fields are owned by transition-kernel/workflow-cycle/intents; direct writes found:\n${violations.join("\n")}`,
);

assert.deepEqual(
  Object.keys(INTENT_EXECUTORS).sort(),
  [...TASK_WORKFLOW_INTENTS].sort(),
  "Every TaskWorkflowIntent must have exactly one registered executor",
);

const executeSource = readFileSync("lib/tasks/orchestrator/execute.ts", "utf8");
assert.equal(
  (executeSource.match(/getIntentExecutor\(/g) ?? []).length,
  1,
  "execute.ts must resolve exactly one registered executor",
);
assert.equal(
  /\btx\.[A-Za-z]\w*\.(?:create|createMany|update|updateMany|upsert|delete|deleteMany)\s*\(/.test(executeSource),
  false,
  "execute.ts must not perform direct domain writes",
);

const forbiddenIntentImports = [
  "@/lib/db",
  "node:fs",
  "node:http",
  "node:https",
  "node:child_process",
  "next/cache",
  "repository-runner",
  "openclaw",
  "spool",
];
for (const filename of files("lib/tasks/orchestrator/intents")) {
  const source = readFileSync(filename, "utf8");
  for (const forbidden of forbiddenIntentImports) {
    assert.equal(
      source.includes(`from \"${forbidden}`) || source.includes(`from '${forbidden}`),
      false,
      `${filename} must not import ${forbidden}`,
    );
  }
}

const sharedSource = readFileSync("lib/tasks/orchestrator/intents/shared.ts", "utf8");
const openPosition = sharedSource.indexOf("openTaskWorkflowCycle(");
const updatePosition = sharedSource.indexOf("updateTaskWorkflowCycleCandidate(");
const transitionPosition = sharedSource.indexOf("applyTaskTransition(");
const closePosition = sharedSource.indexOf("closeTaskWorkflowCycle(");
assert.ok(openPosition >= 0 && openPosition < transitionPosition, "cycle open must precede the kernel transition");
assert.ok(updatePosition >= 0 && updatePosition < transitionPosition, "cycle update must precede the kernel transition");
assert.ok(closePosition > transitionPosition, "cycle close must follow the kernel transition");

console.log("[workflow-boundary] PASS");
