"use server";

// Write side of the switchable-single-site feature. Admin-only. Writes a
// request file into the spool dir; the privileged pm-switch-runner (as zeh)
// picks it up. The web app never builds or restarts anything itself.

import { writeFile, rename } from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { auth } from "@/lib/auth";
import { readSwitchState, SWITCH_DIR } from "@/lib/deploy/worktrees";

export async function requestWorktreeSwitch(target: string): Promise<{ id: string }> {
  const session = await auth();
  if (session?.user?.name !== "zeh") throw new Error("Forbidden");

  const state = await readSwitchState();
  if (!state.available) {
    throw new Error("Worktree switcher is not installed on this host.");
  }
  const wt = state.worktrees.find((w) => w.name === target || w.path === target);
  if (!wt) throw new Error(`Unknown worktree: ${target}`);
  if (wt.served) throw new Error(`${wt.name} is already live.`);
  if (!wt.ready) {
    throw new Error(`${wt.name} has no node_modules — run 'pnpm install' in its ai/web first.`);
  }

  const id = `${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
  const body = JSON.stringify(
    { id, target: wt.name, requestedBy: session.user.name, requestedAt: new Date().toISOString() },
    null,
    2
  );
  // Atomic publish: write to a temp file then rename into place.
  const tmp = path.join(SWITCH_DIR, `request.json.tmp-${id}`);
  await writeFile(tmp, body, { mode: 0o664 });
  await rename(tmp, path.join(SWITCH_DIR, "request.json"));
  return { id };
}
