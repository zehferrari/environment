// File-drop listener — fallback transport per HOMELAB-45 memo. Polls
// the drop dir on a short interval, processes *.json envelopes in
// filename order (the producer prefixes occurredAt for monotonic
// ordering), and moves consumed files to a sibling `.processed/`
// directory so the same envelope isn't re-handled after a restart.
//
// We intentionally don't use fs.watch — it's edge-triggered and known
// to drop events on some filesystems. Polling is fine here: HOMELAB-45
// classed file-drop as fallback, not the hot path.

import { mkdir, readdir, readFile, rename } from "fs/promises";
import path from "path";
import type { ConsumerHandler, HandleOutcome } from "./handler";

export interface FileDropListenerOptions {
  dir: string;
  handler: ConsumerHandler;
  intervalMs?: number;
  onOutcome?: (outcome: HandleOutcome, file: string) => void;
  processedDirName?: string;
}

export async function startFileDropListener(
  opts: FileDropListenerOptions,
): Promise<{ stop: () => Promise<void>; runOnce: () => Promise<void> }> {
  const intervalMs = opts.intervalMs ?? 250;
  const processedDir = path.join(
    opts.dir,
    opts.processedDirName ?? ".processed",
  );
  await mkdir(opts.dir, { recursive: true });
  await mkdir(processedDir, { recursive: true });

  let running = true;
  let inFlight: Promise<void> | null = null;

  async function pass(): Promise<void> {
    const entries = await readdir(opts.dir);
    const files = entries
      .filter((f) => f.endsWith(".json") && !f.startsWith("."))
      .sort();
    for (const file of files) {
      const src = path.join(opts.dir, file);
      const dest = path.join(processedDir, file);
      // Claim-then-process: move the envelope OUT of the inbox BEFORE handling.
      // If the process crashes mid-dispatch, the file is already claimed and is
      // never re-handled on restart — so a native pm_channel_turn (which is not
      // idempotent at the dispatch boundary) cannot double-run the agent and
      // post a duplicate reply. A turn lost in the rare crash window is settled
      // by the PmChannelRun watchdog instead, and is resendable.
      try {
        await rename(src, dest);
      } catch {
        // Another pass/consumer already claimed it, or it vanished — skip.
        continue;
      }
      let raw: unknown;
      try {
        const text = await readFile(dest, "utf8");
        raw = JSON.parse(text);
      } catch (err) {
        opts.onOutcome?.(
          {
            kind: "rejected",
            error: `file-drop: invalid JSON in ${file}: ${(err as Error).message}`,
          },
          file,
        );
        continue;
      }
      const outcome = await opts.handler.handle(raw);
      opts.onOutcome?.(outcome, file);
    }
  }

  async function tick(): Promise<void> {
    if (!running) return;
    inFlight = pass().catch((err) => {
      opts.onOutcome?.(
        {
          kind: "rejected",
          error: `file-drop tick error: ${(err as Error).message}`,
        },
        "",
      );
    }) as Promise<void>;
    await inFlight;
    inFlight = null;
    if (running) {
      timer = setTimeout(tick, intervalMs);
    }
  }

  let timer: NodeJS.Timeout | null = setTimeout(tick, intervalMs);

  return {
    async runOnce() {
      await pass();
    },
    async stop() {
      running = false;
      if (timer) clearTimeout(timer);
      timer = null;
      if (inFlight) {
        try {
          await inFlight;
        } catch {
          // already reported via onOutcome
        }
      }
    },
  };
}
