import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

type BoundaryRegistry = {
  schemaVersion: number;
  kernelInternals: Array<{ file: string; reason: string }>;
  boundaries: Array<{
    id: string;
    files: string[];
    entryPoints: string[];
    currentOwner: string;
    phaseEMigrationDestination: string;
    instrumentation: { kind: string; labels: string[] };
    responseParity: string;
    sideEffectParity: string;
  }>;
};

const registry = JSON.parse(
  readFileSync("lib/tasks/legacy-workflow-boundary-registry.json", "utf8"),
) as BoundaryRegistry;

assert.equal(registry.schemaVersion, 1, "boundary registry schemaVersion must be 1");
assert.ok(registry.boundaries.length > 0, "boundary registry must list legacy boundaries");

const roots = ["app", "lib", "scripts"];
const allowed = new Set<string>();
for (const internal of registry.kernelInternals) {
  allowed.add(path.normalize(internal.file));
}
for (const boundary of registry.boundaries) {
  assert.match(boundary.id, /^[a-z0-9]+(?:-[a-z0-9]+)*$/, `boundary id ${boundary.id} is stable kebab-case`);
  assert.ok(boundary.files.length > 0, `${boundary.id} must name at least one file`);
  assert.ok(boundary.entryPoints.length > 0, `${boundary.id} must name file/function entry points`);
  assert.ok(boundary.currentOwner.trim(), `${boundary.id} must name a current owner`);
  assert.ok(boundary.phaseEMigrationDestination.trim(), `${boundary.id} must name a Phase E migration destination`);
  assert.ok(boundary.instrumentation.kind.trim(), `${boundary.id} must name an instrumentation kind`);
  assert.ok(boundary.instrumentation.labels.length > 0, `${boundary.id} must name stable instrumentation labels`);
  assert.ok(boundary.responseParity.trim(), `${boundary.id} must document response parity`);
  assert.ok(boundary.sideEffectParity.trim(), `${boundary.id} must document side-effect parity`);
  for (const file of boundary.files) {
    allowed.add(path.normalize(file));
  }
}

// Fields/models that remain frozen while Phase E drains direct writers. New
// direct writers must either go through the orchestrator command adapter/kernel
// or be deliberately registered above with owner, migration destination, and
// stable instrumentation labels.
const PROTECTED_TASK_FIELDS = new Set([
  "status",
  "workflowVersion",
  "activeWorkflowCycleId",
]);
const PROTECTED_REVIEW_RUN_FIELDS = new Set([
  "status", // review decision: awaiting_review -> accepted/changes_requested/invalidated
  "reviewerId",
  "reviewedAt",
  "validationOutcome",
  "invalidatedAt",
  "invalidatedReason",
]);
const PROTECTED_WORKFLOW_MODELS = new Set([
  "taskWorkflowCycle",
  "taskProcedureRun",
  "taskProcedureStep",
  "taskRepositoryRun",
  "workflowTransition",
  "workflowOutbox",
]);
const WRITE_METHODS = new Set([
  "create",
  "createMany",
  "update",
  "updateMany",
  "upsert",
  "delete",
  "deleteMany",
]);
const TRANSITION_KERNEL_CALLS = new Set(["applyTaskTransition", "transitionTask"]);

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (name === "node_modules" || name === ".next") return [];
    if (statSync(full).isDirectory()) return files(full);
    if (!/\.(?:ts|tsx)$/.test(name)) return [];
    if (/\.d\.ts$/.test(name) || /(?:^|-)test\.tsx?$/.test(name)) return [];
    return [full];
  });
}

function propertyName(node: ts.ObjectLiteralElementLike) {
  if (!node.name) return null;
  return ts.isIdentifier(node.name) || ts.isStringLiteral(node.name) ? node.name.text : null;
}

function calledMember(call: ts.CallExpression): { model: string; method: string } | null {
  if (!ts.isPropertyAccessExpression(call.expression)) return null;
  const method = call.expression.name.text;
  const modelNode = call.expression.expression;
  if (!ts.isPropertyAccessExpression(modelNode)) return null;
  return { model: modelNode.name.text, method };
}

function directTaskFieldWrite(call: ts.CallExpression): string[] {
  const member = calledMember(call);
  if (!member || member.model !== "task" || (member.method !== "update" && member.method !== "updateMany")) return [];
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

function directReviewRunFieldWrite(call: ts.CallExpression): string[] {
  const member = calledMember(call);
  if (!member || member.model !== "reviewRun" || (member.method !== "update" && member.method !== "updateMany" && member.method !== "upsert")) return [];
  const args = call.arguments[0];
  if (!args || !ts.isObjectLiteralExpression(args)) return [];
  const data = args.properties.find((item) => propertyName(item) === "data" || propertyName(item) === "create" || propertyName(item) === "update");
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

function protectedWorkflowModelWrite(call: ts.CallExpression): string | null {
  const member = calledMember(call);
  if (!member || !PROTECTED_WORKFLOW_MODELS.has(member.model) || !WRITE_METHODS.has(member.method)) return null;
  return `${member.model}.${member.method}`;
}

function directTransitionKernelCall(call: ts.CallExpression): string | null {
  if (ts.isIdentifier(call.expression) && TRANSITION_KERNEL_CALLS.has(call.expression.text)) {
    return call.expression.text;
  }
  return null;
}

function violationsForSource(filename: string, source: string, allowFile: boolean): string[] {
  const parsed = ts.createSourceFile(
    filename,
    source,
    ts.ScriptTarget.Latest,
    true,
    filename.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const found: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const line = parsed.getLineAndCharacterOfPosition(node.getStart()).line + 1;
      const transitionCall = directTransitionKernelCall(node);
      if (transitionCall && !allowFile) {
        found.push(`${filename}:${line} direct ${transitionCall} call is not registered`);
      }
      const taskFields = directTaskFieldWrite(node);
      for (const field of taskFields) {
        if (!allowFile) found.push(`${filename}:${line} Task.${field}`);
      }
      const reviewFields = directReviewRunFieldWrite(node);
      for (const field of reviewFields) {
        if (!allowFile) found.push(`${filename}:${line} ReviewRun.${field}`);
      }
      const modelWrite = protectedWorkflowModelWrite(node);
      if (modelWrite && !allowFile) {
        found.push(`${filename}:${line} ${modelWrite}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  if (!allowFile && /UPDATE\s+["`']?(?:tasks|Task)["`']?\s+SET\s+[\s\S]{0,200}\bstatus\b/i.test(source)) {
    found.push(`${filename}: raw SQL task status update`);
  }
  return found;
}

const fixtureViolations = violationsForSource(
  "__unregistered_workflow_writer_fixture__.ts",
  `
    import { applyTaskTransition } from "@/lib/tasks/transition-kernel";
    export async function bad(tx: any) {
      await applyTaskTransition(tx, {} as any);
      await tx.task.update({ where: { id: "t" }, data: { status: "Done" } });
      await tx.taskWorkflowCycle.create({ data: { taskId: "t", sequence: 1 } });
    }
  `,
  false,
);
assert.ok(
  fixtureViolations.some((line) => line.includes("direct applyTaskTransition"))
    && fixtureViolations.some((line) => line.includes("Task.status"))
    && fixtureViolations.some((line) => line.includes("taskWorkflowCycle.create")),
  "boundary test fixture must prove unregistered direct callers/writers fail",
);

const violations: string[] = [];
for (const root of roots) {
  for (const filename of files(root)) {
    const relative = path.normalize(filename);
    const source = readFileSync(filename, "utf8");
    violations.push(...violationsForSource(filename, source, allowed.has(relative)));
  }
}

assert.deepEqual(
  violations,
  [],
  `Protected workflow mutation boundaries must be registered in lib/tasks/legacy-workflow-boundary-registry.json or moved behind the orchestrator command adapter; direct writes/callers found:\n${violations.join("\n")}`,
);
console.log(`[workflow-boundary] PASS — ${registry.boundaries.length} registered legacy boundaries frozen`);
