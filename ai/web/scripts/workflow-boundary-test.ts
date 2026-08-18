import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

const roots = ["app", "lib"];
// Modules allowed to write Task.status, Task.workflowVersion,
// Task.activeWorkflowCycleId, and ReviewRun.status (decision fields).
const allowed = new Set([
  path.normalize("lib/tasks/transition-kernel.ts"),
  // The orchestrator's execute module writes taskData (approvedOn etc.) via
  // the kernel; it also writes reviewRun decision fields (accepted/
  // changes_requested) in the same transaction as the transition.
  path.normalize("lib/tasks/orchestrator/execute.ts"),
  // The cycle module writes Task.activeWorkflowCycleId.
  path.normalize("lib/tasks/workflow-cycle.ts"),
  // The procedure runner writes procedure/step status (not Task.status), but
  // it is the approved module for procedure state.
  path.normalize("lib/tasks/orchestrator/procedure-runner.ts"),
  // The reconciler repairs stale state through the kernel, not directly.
  // It does update Task.alertReporter directly, which is allowed (not a
  // status/workflowVersion/cycle field).
  path.normalize("lib/tasks/workflow-reconciler.ts"),
  // Legacy modules that write ReviewRun decision fields. These are existing
  // entry points that will be migrated to the orchestrator in a future
  // phase. The boundary test enforces that NEW code does not write these
  // fields directly.
  path.normalize("lib/tasks/review-handoff.ts"),
  path.normalize("lib/tasks/review-automation.ts"),
  path.normalize("lib/tasks/orchestrator/handlers/review-decisions.ts"),
  path.normalize("lib/deploy/epic-merge.ts"),
  // The agent workflow route is the legacy entry point that will be migrated.
  path.normalize("app/api/agent/tasks/[taskId]/workflow/route.ts"),
]);
// Fields that only the allowed modules may write to.
const PROTECTED_TASK_FIELDS = new Set([
  "status",
  "workflowVersion",
  "activeWorkflowCycleId",
]);
const PROTECTED_REVIEW_RUN_FIELDS = new Set([
  "status", // review decision: awaiting_review -> accepted/changes_requested
  "reviewerId",
  "reviewedAt",
]);
const violations: string[] = [];

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

// Detect direct writes to protected Task fields via prisma.task.update/updateMany.
function directTaskFieldWrite(call: ts.CallExpression): string[] {
  if (!ts.isPropertyAccessExpression(call.expression)) return [];
  if (call.expression.name.text !== "update" && call.expression.name.text !== "updateMany") return [];
  const model = call.expression.expression;
  if (!ts.isPropertyAccessExpression(model) || model.name.text !== "task") return [];
  const args = call.arguments[0];
  if (!args || !ts.isObjectLiteralExpression(args)) return [];
  const data = args.properties.find((item) => propertyName(item) === "data");
  if (!data || !ts.isPropertyAssignment(data) || !ts.isObjectLiteralExpression(data.initializer)) return [];
  const found: string[] = [];
  for (const item of data.initializer.properties) {
    const name = propertyName(item);
    if (name && PROTECTED_TASK_FIELDS.has(name)) {
      found.push(name);
    }
  }
  return found;
}

// Detect direct writes to protected ReviewRun fields via prisma.reviewRun.update/updateMany.
function directReviewRunFieldWrite(call: ts.CallExpression): string[] {
  if (!ts.isPropertyAccessExpression(call.expression)) return [];
  if (call.expression.name.text !== "update" && call.expression.name.text !== "updateMany") return [];
  const model = call.expression.expression;
  if (!ts.isPropertyAccessExpression(model) || model.name.text !== "reviewRun") return [];
  const args = call.arguments[0];
  if (!args || !ts.isObjectLiteralExpression(args)) return [];
  const data = args.properties.find((item) => propertyName(item) === "data");
  if (!data || !ts.isPropertyAssignment(data) || !ts.isObjectLiteralExpression(data.initializer)) return [];
  const found: string[] = [];
  for (const item of data.initializer.properties) {
    const name = propertyName(item);
    if (name && PROTECTED_REVIEW_RUN_FIELDS.has(name)) {
      found.push(name);
    }
  }
  return found;
}

for (const root of roots) {
  for (const filename of files(root)) {
    const relative = path.normalize(filename);
    if (allowed.has(relative)) continue;
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
        const taskFields = directTaskFieldWrite(node);
        for (const field of taskFields) {
          const line = parsed.getLineAndCharacterOfPosition(node.getStart()).line + 1;
          violations.push(`${filename}:${line} Task.${field}`);
        }
        const reviewFields = directReviewRunFieldWrite(node);
        for (const field of reviewFields) {
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
  `Protected workflow fields are owned by transition-kernel/workflow-cycle/orchestrator; direct writes found:\n${violations.join("\n")}`,
);
console.log("[workflow-boundary] PASS");