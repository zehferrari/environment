import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

const roots = ["app", "lib"];
const allowed = new Set([path.normalize("lib/tasks/transition-kernel.ts")]);
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

function directStatusWrite(call: ts.CallExpression) {
  if (!ts.isPropertyAccessExpression(call.expression)) return false;
  if (call.expression.name.text !== "update" && call.expression.name.text !== "updateMany") return false;
  const model = call.expression.expression;
  if (!ts.isPropertyAccessExpression(model) || model.name.text !== "task") return false;
  const args = call.arguments[0];
  if (!args || !ts.isObjectLiteralExpression(args)) return false;
  const data = args.properties.find((item) => propertyName(item) === "data");
  if (!data || !ts.isPropertyAssignment(data) || !ts.isObjectLiteralExpression(data.initializer)) return false;
  return data.initializer.properties.some((item) => propertyName(item) === "status");
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
      if (ts.isCallExpression(node) && directStatusWrite(node)) {
        const line = parsed.getLineAndCharacterOfPosition(node.getStart()).line + 1;
        violations.push(`${filename}:${line}`);
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
  `Task.status is owned by lib/tasks/transition-kernel.ts; route writes found:\n${violations.join("\n")}`,
);
console.log("[workflow-boundary] PASS");
