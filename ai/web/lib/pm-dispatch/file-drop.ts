// File-drop driver. Writes one JSON file per event into a flat
// directory, atomic via write-to-tmp + rename. Consumers (the harness
// in scripts/pm-dispatch-receiver.ts, or any future poller) read in
// filename order — occurredAt-prefixed names give monotonic ordering
// per producer.

import { mkdir, rename, writeFile } from "fs/promises";
import path from "path";
import type { PmEvent } from "@/lib/pm-events";
import type { DispatchDriver, DispatchResult } from "./index";

export interface FileDropDriverOptions {
  dir: string;
}

function safeStamp(occurredAt: string): string {
  // Filenames must be POSIX-portable: replace colons and dots.
  return occurredAt.replace(/[:.]/g, "-");
}

// Defence-in-depth: builders today use UUIDs, but the wire-parser only
// requires a non-empty string id. Restrict whatever lands in the
// filename to a safe alphabet so a hostile or malformed id can never
// escape the drop dir (no "/", "..", NUL, etc.).
function safeId(id: string): string {
  const cleaned = id.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 64);
  return cleaned.length > 0 ? cleaned : "id";
}

export function createFileDropDriver(
  opts: FileDropDriverOptions,
): DispatchDriver {
  let dirEnsured = false;
  return {
    name: "file-drop",
    async send(event: PmEvent): Promise<DispatchResult> {
      try {
        if (!dirEnsured) {
          await mkdir(opts.dir, { recursive: true });
          dirEnsured = true;
        }
        const base = `${safeStamp(event.occurredAt)}-${safeId(event.id)}.json`;
        const tmp = path.join(opts.dir, `.${base}.tmp`);
        const dst = path.join(opts.dir, base);
        await writeFile(tmp, JSON.stringify(event) + "\n", { mode: 0o640 });
        await rename(tmp, dst);
        return { ok: true, driver: "file-drop", receipt: { path: dst } };
      } catch (err) {
        return {
          ok: false,
          driver: "file-drop",
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  };
}
