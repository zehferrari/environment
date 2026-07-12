// Local PM dispatch receiver harness (HOMELAB-46 Slice 1).
//
// Exercises the producer → dispatch → consume loop without requiring
// the OpenClaw-side listener to be merged or running. Two modes:
//
//   socket   spin up an in-process AF_UNIX listener at $PM_DISPATCH_SOCKET,
//            send a synthetic event through createDispatcher(), and
//            assert the line arrived intact.
//
//   filedrop create a temp directory, route a synthetic event through
//            the file-drop driver, read it back, assert round-trip.
//
// Run with:
//   pnpm tsx scripts/pm-dispatch-receiver.ts socket
//   pnpm tsx scripts/pm-dispatch-receiver.ts filedrop
//
// Exit 0 on success, non-zero on assertion or transport failure. This
// is a smoke harness, not a test runner — kept under scripts/ so it
// stays out of the production bundle.

import { createServer } from "net";
import { mkdtemp, readdir, readFile, rm } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { randomUUID } from "crypto";
import {
  buildTaskAssigned,
  parsePmEvent,
  type PmEvent,
} from "@/lib/pm-events";
import {
  createDispatcher,
  createFileDropDriver,
  notifyDispatch,
  __resetPmDispatchNotifierForTests,
} from "@/lib/pm-dispatch";

function synthEvent(): PmEvent {
  return buildTaskAssigned(
    {
      id: randomUUID(),
      occurredAt: new Date().toISOString(),
      actor: { id: "owner", kind: "human", name: "Mission Control owner" },
      task: {
        id: "t-1",
        key: "HOMELAB-99",
        projectKey: "HOMELAB",
        title: "Harness smoke task",
      },
    },
    {
      assignee: { id: "barekbaal", kind: "agent", name: "Baals" },
      previousAssignee: null,
    },
  );
}

function fail(msg: string): never {
  console.error(`[receiver] FAIL: ${msg}`);
  process.exit(1);
}

async function runSocket(): Promise<void> {
  const sockDir = await mkdtemp(path.join(tmpdir(), "pm-dispatch-"));
  const sockPath = path.join(sockDir, "events.sock");
  process.env.PM_DISPATCH_DRIVER = "unix-socket";
  process.env.PM_DISPATCH_SOCKET = sockPath;

  const received: PmEvent[] = [];
  const server = createServer((conn) => {
    let buf = "";
    conn.setEncoding("utf8");
    conn.on("data", (chunk) => {
      buf += chunk;
    });
    conn.on("end", () => {
      for (const line of buf.split("\n")) {
        if (!line.trim()) continue;
        try {
          received.push(parsePmEvent(JSON.parse(line)));
        } catch (err) {
          fail(`parse error on socket line: ${(err as Error).message}`);
        }
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(sockPath, resolve));

  try {
    const event = synthEvent();
    const dispatcher = createDispatcher();
    const result = await dispatcher.send(event);
    if (!result.ok) fail(`dispatch result not ok: ${result.error}`);

    // Wait briefly for listener to flush.
    await new Promise((r) => setTimeout(r, 50));
    if (received.length !== 1) {
      fail(`expected 1 received event, got ${received.length}`);
    }
    if (received[0].id !== event.id) {
      fail(`event id round-trip mismatch`);
    }
    console.log("[receiver] socket OK", { id: event.id });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(sockDir, { recursive: true, force: true });
  }
}

async function runFileDrop(): Promise<void> {
  const dropDir = await mkdtemp(path.join(tmpdir(), "pm-dispatch-drop-"));
  try {
    const driver = createFileDropDriver({ dir: dropDir });
    const event = synthEvent();
    const result = await driver.send(event);
    if (!result.ok) fail(`file-drop result not ok: ${result.error}`);

    const files = (await readdir(dropDir)).filter((f) => f.endsWith(".json"));
    if (files.length !== 1) {
      fail(`expected 1 dropped file, got ${files.length}`);
    }
    const raw = await readFile(path.join(dropDir, files[0]), "utf8");
    const parsed = parsePmEvent(JSON.parse(raw));
    if (parsed.id !== event.id) {
      fail(`file-drop round-trip id mismatch`);
    }
    console.log("[receiver] filedrop OK", { id: event.id, file: files[0] });
  } finally {
    await rm(dropDir, { recursive: true, force: true });
  }
}


async function runNotifier(): Promise<void> {
  // Notifier path: HOMELAB-46 Slice 2. Two contracts to assert:
  //   1. With no PM_DISPATCH_* env set, notifyDispatch must NOT throw
  //      and must return ok=false with skipped="disabled".
  //   2. With PM_DISPATCH_DROP_DIR pointed at a temp dir, the same
  //      synthetic event must land on disk via the file-drop driver.
  delete process.env.PM_DISPATCH_SOCKET;
  delete process.env.PM_DISPATCH_DROP_DIR;
  delete process.env.PM_DISPATCH_DRIVER;
  __resetPmDispatchNotifierForTests();
  const disabled = await notifyDispatch(synthEvent());
  if (disabled.ok || disabled.skipped !== "disabled") {
    fail(`notifier disabled-state contract broken: ${JSON.stringify(disabled)}`);
  }

  const dropDir = await mkdtemp(path.join(tmpdir(), "pm-dispatch-notify-"));
  try {
    process.env.PM_DISPATCH_DRIVER = "file-drop";
    process.env.PM_DISPATCH_DROP_DIR = dropDir;
    __resetPmDispatchNotifierForTests();
    const event = synthEvent();
    const result = await notifyDispatch(event);
    if (!result.ok) fail(`notifier file-drop send failed: ${result.error}`);
    const files = (await readdir(dropDir)).filter((f) => f.endsWith(".json"));
    if (files.length !== 1) fail(`notifier expected 1 file, got ${files.length}`);
    console.log("[receiver] notifier OK", { disabled: true, fileDrop: true });
  } finally {
    await rm(dropDir, { recursive: true, force: true });
    delete process.env.PM_DISPATCH_DRIVER;
    delete process.env.PM_DISPATCH_DROP_DIR;
    __resetPmDispatchNotifierForTests();
  }
}

async function main(): Promise<void> {
  const mode = process.argv[2];
  if (mode === "socket") return runSocket();
  if (mode === "filedrop") return runFileDrop();
  if (mode === "notifier") return runNotifier();
  if (mode === "all" || !mode) {
    await runFileDrop();
    await runSocket();
    await runNotifier();
    return;
  }
  fail(`unknown mode: ${mode} (expected socket|filedrop|notifier|all)`);
}

main().catch((err) => fail((err as Error).stack ?? String(err)));
