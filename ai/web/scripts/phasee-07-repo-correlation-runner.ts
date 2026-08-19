import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

async function run(command: string, args: readonly string[], env: NodeJS.ProcessEnv): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd: process.cwd(),
      env,
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(" ")} exited with ${code ?? "no status"}`));
    });
  });
}

async function main(): Promise<void> {
  const sandbox = await mkdtemp(path.join(tmpdir(), "phasee-07-repo-correlation-"));
  const env = {
    ...process.env,
    DATABASE_URL: `file:${path.join(sandbox, "test.db")}`,
    PM_BRANCH_VERIFY_DIR: path.join(sandbox, "branch-verify"),
  };

  try {
    await run("pnpm", ["prisma", "migrate", "deploy", "--schema=prisma/schema.prisma"], env);
    await run("pnpm", ["exec", "tsx", "scripts/phasee-07-repo-correlation-test.ts"], env);
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error("[phasee-07-runner] FAIL:", error);
  process.exit(1);
});
