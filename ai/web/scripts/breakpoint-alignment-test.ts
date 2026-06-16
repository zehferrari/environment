import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const root = process.cwd();
const sourceDirs = ["app", "components"];
const sourceExtensions = new Set([".ts", ".tsx", ".css"]);

function assert(condition: unknown, message: string) {
  if (!condition) {
    throw new Error(message);
  }
}

function walk(dir: string, files: string[] = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next" || entry === ".git") continue;
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      walk(path, files);
    } else if (sourceExtensions.has(path.slice(path.lastIndexOf(".")))) {
      files.push(path);
    }
  }
  return files;
}

const globals = readFileSync(join(root, "app/globals.css"), "utf8");
assert(!globals.includes("--breakpoint-"), "globals.css must not declare custom Tailwind breakpoints");
assert(!globals.includes("@custom-media"), "globals.css must not declare custom media breakpoints");

const tailwindConfigCandidates = [
  "tailwind.config.js",
  "tailwind.config.cjs",
  "tailwind.config.mjs",
  "tailwind.config.ts",
];
for (const candidate of tailwindConfigCandidates) {
  const path = join(root, candidate);
  if (!existsSync(path)) continue;
  const source = readFileSync(path, "utf8");
  assert(!/screens\s*:/.test(source), `${candidate} must not configure custom screens`);
}

const arbitraryBreakpointPattern = /(?:^|[\s"'`{])(?:min|max)-\[[^\]]+\]:/g;
const customBreakpointPrefixPattern = /(?:^|[\s"'`{])(xs|mobile|phablet|tablet|laptop|desktop|wide):/g;
const arbitraryBreakpointFiles: string[] = [];
const customBreakpointFiles: string[] = [];

for (const dir of sourceDirs) {
  for (const path of walk(join(root, dir))) {
    const source = readFileSync(path, "utf8");
    if (arbitraryBreakpointPattern.test(source)) {
      arbitraryBreakpointFiles.push(relative(root, path));
    }
    if (customBreakpointPrefixPattern.test(source)) {
      customBreakpointFiles.push(relative(root, path));
    }
  }
}

assert(arbitraryBreakpointFiles.length === 0, `arbitrary min/max breakpoint variants are not allowed: ${arbitraryBreakpointFiles.join(", ")}`);
assert(customBreakpointFiles.length === 0, `non-default breakpoint prefixes found: ${customBreakpointFiles.join(", ")}`);

const appLayout = readFileSync(join(root, "app/(app)/layout.tsx"), "utf8");
assert(
  appLayout.includes("mx-auto w-full min-w-0 max-w-[1480px]"),
  "app shell content wrapper must be width-constrained without forcing document horizontal scroll",
);

console.log("breakpoint alignment contract ok");
