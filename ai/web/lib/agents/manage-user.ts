import { execFile } from "child_process";
import { promisify } from "util";
import { writeFile, unlink } from "fs/promises";
import path from "path";
import os from "os";
import { randomBytes } from "crypto";

const execFileP = promisify(execFile);

/**
 * The single privileged boundary. The PM web layer (running as the monitor
 * user) shells out to this root helper via a tightly-scoped NOPASSWD sudoers
 * rule. We pass arguments as an array (never a shell string) and hand any
 * provisioning payload through a 0600 temp file rather than argv/stdin.
 */
const HELPER = "/usr/local/sbin/openclaw-manage-user";

export class ManageUserError extends Error {
  constructor(message: string, readonly stderr?: string) {
    super(message);
    this.name = "ManageUserError";
  }
}

export async function runManageUser(positional: string[], payload?: unknown): Promise<void> {
  let payloadPath: string | undefined;
  const args = ["-n", HELPER, ...positional];
  try {
    if (payload !== undefined) {
      payloadPath = path.join(
        os.tmpdir(),
        `openclaw-provision-${process.pid}-${randomBytes(6).toString("hex")}.json`,
      );
      await writeFile(payloadPath, JSON.stringify(payload), { mode: 0o600 });
      args.push(payloadPath);
    }
    await execFileP("sudo", args, { timeout: 300_000, maxBuffer: 8 * 1024 * 1024 });
  } catch (err: any) {
    const stderr = typeof err?.stderr === "string" ? err.stderr.trim() : undefined;
    throw new ManageUserError(stderr || err?.message || "openclaw-manage-user failed", stderr);
  } finally {
    if (payloadPath) await unlink(payloadPath).catch(() => undefined);
  }
}
