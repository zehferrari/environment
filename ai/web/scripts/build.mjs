import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
const require = createRequire(import.meta.url);
// One identifier for every phase/worker in this build, including same-commit rebuilds.
const env = { ...process.env, PM_DEPLOYMENT_ID: process.env.PM_DEPLOYMENT_ID || randomUUID() };
for (const args of [[require.resolve("prisma/build/index.js"), "generate"], [require.resolve("next/dist/bin/next"), "build"], ["scripts/copy-standalone-assets.mjs"]]) {
    const result = spawnSync(process.execPath, args, { env, stdio: "inherit" });
    if (result.error)
        throw result.error;
    if (result.status !== 0)
        process.exit(result.status ?? 1);
}
