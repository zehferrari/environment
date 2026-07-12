import { writeFile, readFile, rename, unlink, mkdir } from "fs/promises";
import path from "path";
import { randomBytes } from "crypto";

/**
 * Privileged provisioning hand-off.
 *
 * pm.service runs `NoNewPrivileges=true`, so the web app cannot `sudo`. Instead
 * it spools a request into a directory watched by `openclaw-agent-runner`
 * (the monitor agent's system identity, NoNewPrivileges=no, with the
 * NOPASSWD grant for `openclaw-manage-user`). That runner is the deterministic
 * executor — the only command it ever runs is the single privileged boundary,
 * `openclaw-manage-user` — and it writes back a result we poll for here, so the
 * route still resolves synchronously.
 */
const SPOOL = process.env.PM_AGENT_PROVISION_DIR ?? "/var/lib/pm/agent-provision";
const POLL_MS = Number(process.env.PM_AGENT_PROVISION_POLL_MS ?? 1000);
const TIMEOUT_MS = Number(process.env.PM_AGENT_PROVISION_TIMEOUT_MS ?? 360_000);

export class ManageUserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManageUserError";
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type RunnerResult = { id: string; ok: boolean; error?: string | null };

export async function runManageUser(positional: string[], payload?: unknown): Promise<void> {
  const id = `${Date.now().toString(36)}-${randomBytes(6).toString("hex")}`;
  const reqPath = path.join(SPOOL, `${id}.req.json`);
  const tmpPath = path.join(SPOOL, `.${id}.req.tmp`);
  const resPath = path.join(SPOOL, `${id}.res.json`);
  const job = { id, args: positional, payload: payload ?? null, requestedAt: new Date().toISOString() };

  try {
    await mkdir(SPOOL, { recursive: true }).catch(() => undefined);
    // Write then rename so the runner never sees a partial request file.
    await writeFile(tmpPath, JSON.stringify(job), { mode: 0o600 });
    await rename(tmpPath, reqPath);
  } catch (err) {
    await unlink(tmpPath).catch(() => undefined);
    throw new ManageUserError(`failed to enqueue provisioning job: ${(err as Error).message}`);
  }

  const deadline = Date.now() + TIMEOUT_MS;
  try {
    while (Date.now() < deadline) {
      let res: RunnerResult | null = null;
      try {
        res = JSON.parse(await readFile(resPath, "utf8")) as RunnerResult;
      } catch {
        await sleep(POLL_MS);
        continue;
      }
      if (!res.ok) throw new ManageUserError(res.error || "provisioning failed");
      return;
    }
    throw new ManageUserError(
      "provisioning timed out waiting for openclaw-agent-runner (is the service running?)",
    );
  } finally {
    await unlink(resPath).catch(() => undefined);
    await unlink(reqPath).catch(() => undefined);
  }
}
