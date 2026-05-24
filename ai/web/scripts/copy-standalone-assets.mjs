import { cp, mkdir, stat } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const standaloneRoot = path.join(root, ".next", "standalone");

async function exists(file) {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

async function copyDir(source, target) {
  if (!(await exists(source))) return;
  await mkdir(path.dirname(target), { recursive: true });
  await cp(source, target, { recursive: true, force: true });
  console.log(`[postbuild] copied ${path.relative(root, source)} -> ${path.relative(root, target)}`);
}

await copyDir(path.join(root, ".next", "static"), path.join(standaloneRoot, ".next", "static"));
await copyDir(path.join(root, "public"), path.join(standaloneRoot, "public"));
