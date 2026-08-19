import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

type BoundaryRegistry = {
  schemaVersion: number;
  counterContract: { activityKind: string; payloadFields: string[] };
  kernelInternals: Array<{ file: string; reason: string }>;
  boundaries: Array<{
    id: string;
    files: string[];
    expectedDirectMutationCounts: Record<string, number>;
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

assert.equal(registry.schemaVersion, 2, "boundary registry schemaVersion must be 2");
assert.ok(registry.boundaries.length > 0, "boundary registry must list legacy boundaries");
assert.equal(
  registry.counterContract.activityKind,
  "task.workflow.legacy_boundary.invoked",
  "legacy invocation activity kind is a stable Phase E contract",
);
assert.deepEqual(
  registry.counterContract.payloadFields,
  ["legacyBoundary", "entryPoint"],
  "legacy invocation payload fields are a stable Phase E contract",
);

const roots = ["app", "lib", "scripts"];
const kernelInternals = new Set<string>();
const registeredFiles = new Map<string, { boundaryId: string; expectedCount: number }>();
for (const internal of registry.kernelInternals) {
  kernelInternals.add(path.normalize(internal.file));
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
  assert.deepEqual(
    Object.keys(boundary.expectedDirectMutationCounts).sort(),
    [...boundary.files].sort(),
    `${boundary.id} must freeze an expected direct-mutation count for every registered file`,
  );
  const instrumentationSources: string[] = [];
  for (const file of boundary.files) {
    const normalized = path.normalize(file);
    assert.ok(!registeredFiles.has(normalized), `${normalized} must belong to only one legacy boundary`);
    const expectedCount = boundary.expectedDirectMutationCounts[file];
    assert.ok(Number.isInteger(expectedCount) && expectedCount >= 0, `${boundary.id}:${file} expected count must be a non-negative integer`);
    registeredFiles.set(normalized, { boundaryId: boundary.id, expectedCount });
    instrumentationSources.push(readFileSync(normalized, "utf8"));
  }
  const escapedId = boundary.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  assert.match(
    instrumentationSources.join("\n"),
    new RegExp(`legacyBoundary\\s*:\\s*["']${escapedId}["']`),
    `${boundary.id} must emit its injective legacyBoundary label from a registered file`,
  );
}

const PROTECTED_TASK_FIELDS = new Set(["status", "workflowVersion", "activeWorkflowCycleId"]);
const PROTECTED_REVIEW_RUN_FIELDS = new Set([
  "status",
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
const WRITE_METHODS = new Set(["create", "createMany", "update", "updateMany", "upsert", "delete", "deleteMany"]);
const TRANSITION_KERNEL_CALLS = new Set(["applyTaskTransition", "transitionTask"]);

function isScannedSourceFile(name: string) {
  if (!/\.(?:ts|tsx)$/.test(name) || /\.d\.ts$/.test(name)) return false;
  // Product code uses both foo-test.ts and foo.test.ts conventions. Exclude
  // both (plus *.spec.ts) explicitly so fixtures cannot affect the freeze.
  return !/(?:^|[.-])(?:test|spec)\.tsx?$/.test(name);
}
assert.equal(isScannedSourceFile("writer.ts"), true);
assert.equal(isScannedSourceFile("writer-test.ts"), false);
assert.equal(isScannedSourceFile("writer.test.ts"), false);
assert.equal(isScannedSourceFile("writer.spec.ts"), false);

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (name === "node_modules" || name === ".next") return [];
    if (statSync(full).isDirectory()) return files(full);
    return isScannedSourceFile(name) ? [full] : [];
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
  return data.initializer.properties
    .map((item) => propertyName(item))
    .filter((name): name is string => Boolean(name && PROTECTED_TASK_FIELDS.has(name)));
}

function directReviewRunFieldWrite(call: ts.CallExpression): string[] {
  const member = calledMember(call);
  if (!member || member.model !== "reviewRun" || !["update", "updateMany", "upsert"].includes(member.method)) return [];
  const args = call.arguments[0];
  if (!args || !ts.isObjectLiteralExpression(args)) return [];
  const data = args.properties.find((item) => ["data", "create", "update"].includes(propertyName(item) ?? ""));
  if (!data || !ts.isPropertyAssignment(data) || !ts.isObjectLiteralExpression(data.initializer)) return [];
  return data.initializer.properties
    .map((item) => propertyName(item))
    .filter((name): name is string => Boolean(name && PROTECTED_REVIEW_RUN_FIELDS.has(name)));
}

function protectedWorkflowModelWrite(call: ts.CallExpression): string | null {
  const member = calledMember(call);
  if (!member || !PROTECTED_WORKFLOW_MODELS.has(member.model) || !WRITE_METHODS.has(member.method)) return null;
  return `${member.model}.${member.method}`;
}

function transitionKernelBindings(parsed: ts.SourceFile) {
  const direct = new Map<string, string>();
  const namespaces = new Set<string>();
  for (const statement of parsed.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    if (!statement.moduleSpecifier.text.endsWith("/tasks/transition-kernel")) continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) {
      namespaces.add(bindings.name.text);
    } else if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        const imported = element.propertyName?.text ?? element.name.text;
        if (TRANSITION_KERNEL_CALLS.has(imported)) direct.set(element.name.text, imported);
      }
    }
  }
  return { direct, namespaces };
}

function directTransitionKernelCall(call: ts.CallExpression, bindings: ReturnType<typeof transitionKernelBindings>) {
  if (ts.isIdentifier(call.expression)) return bindings.direct.get(call.expression.text) ?? null;
  if (
    ts.isPropertyAccessExpression(call.expression)
    && ts.isIdentifier(call.expression.expression)
    && bindings.namespaces.has(call.expression.expression.text)
    && TRANSITION_KERNEL_CALLS.has(call.expression.name.text)
  ) return call.expression.name.text;
  return null;
}

function violationsForSource(filename: string, source: string): string[] {
  const parsed = ts.createSourceFile(
    filename,
    source,
    ts.ScriptTarget.Latest,
    true,
    filename.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const transitionBindings = transitionKernelBindings(parsed);
  const found: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const line = parsed.getLineAndCharacterOfPosition(node.getStart()).line + 1;
      const transitionCall = directTransitionKernelCall(node, transitionBindings);
      if (transitionCall) found.push(`${filename}:${line} direct ${transitionCall} call`);
      for (const field of directTaskFieldWrite(node)) found.push(`${filename}:${line} Task.${field}`);
      for (const field of directReviewRunFieldWrite(node)) found.push(`${filename}:${line} ReviewRun.${field}`);
      const modelWrite = protectedWorkflowModelWrite(node);
      if (modelWrite) found.push(`${filename}:${line} ${modelWrite}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  if (/UPDATE\s+["`']?(?:tasks|Task)["`']?\s+SET\s+[\s\S]{0,200}\bstatus\b/i.test(source)) {
    found.push(`${filename}: raw SQL task status update`);
  }
  return found;
}

const fixtureViolations = violationsForSource(
  "__unregistered_workflow_writer_fixture__.ts",
  `
    import { applyTaskTransition } from "@/lib/tasks/transition-kernel";
    import { transitionTask as move } from "@/lib/tasks/transition-kernel";
    import * as kernel from "@/lib/tasks/transition-kernel";
    export async function bad(tx: any) {
      await applyTaskTransition(tx, {} as any);
      await move({} as any);
      await kernel.applyTaskTransition(tx, {} as any);
      await tx.task.update({ where: { id: "t" }, data: { status: "Done" } });
      await tx.taskWorkflowCycle.create({ data: { taskId: "t", sequence: 1 } });
    }
  `,
);
assert.ok(
  fixtureViolations.filter((line) => line.includes("direct applyTaskTransition")).length === 2
    && fixtureViolations.some((line) => line.includes("direct transitionTask"))
    && fixtureViolations.some((line) => line.includes("Task.status"))
    && fixtureViolations.some((line) => line.includes("taskWorkflowCycle.create")),
  "boundary test fixture must prove direct, aliased, and namespaced unregistered writers fail",
);

const violations: string[] = [];
for (const root of roots) {
  for (const filename of files(root)) {
    const relative = path.normalize(filename);
    const found = violationsForSource(filename, readFileSync(filename, "utf8"));
    if (kernelInternals.has(relative)) continue;
    const registered = registeredFiles.get(relative);
    if (!registered) {
      violations.push(...found);
    } else if (found.length !== registered.expectedCount) {
      violations.push(
        `${filename}: boundary ${registered.boundaryId} expected ${registered.expectedCount} direct mutation finding(s), found ${found.length}`,
        ...found,
      );
    }
  }
}

assert.deepEqual(
  violations,
  [],
  `Protected workflow mutation boundaries must be registered at their frozen direct-mutation count or moved behind the orchestrator command adapter; findings:\n${violations.join("\n")}`,
);
console.log(`[workflow-boundary] PASS — ${registry.boundaries.length} registered legacy boundaries frozen`);
