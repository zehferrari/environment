import { isLikelyStaleBuildError } from "../lib/client/stale-build";

function assert(condition: unknown, message: string) {
  if (!condition) throw new Error(message);
}

const staleBuildSamples = [
  new Error("ChunkLoadError: Loading chunk app/projects failed."),
  new Error("Loading CSS chunk 281 failed."),
  new Error("Failed to fetch dynamically imported module: https://agents.vixi.au/_next/static/chunks/app.js"),
  "error loading dynamically imported module",
  "https://agents.vixi.au/_next/static/chunks/abc123.js",
];

for (const sample of staleBuildSamples) {
  assert(isLikelyStaleBuildError(sample), `must recognize stale build error: ${String(sample)}`);
}

const unrelatedSamples = [
  new Error("Cannot read properties of undefined"),
  new Error("fetch failed"),
  "ResizeObserver loop completed with undelivered notifications",
  "",
];

for (const sample of unrelatedSamples) {
  assert(!isLikelyStaleBuildError(sample), `must not reload for unrelated error: ${String(sample)}`);
}

console.log("client recovery stale-build detection ok");
