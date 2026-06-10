import { mkdir, rename, writeFile } from "fs/promises";
import { dirname, join } from "path";
import { connect } from "net";
import type { SendPmChannelTurnArgs } from "@/lib/agents/openclaw-pm-channel";

export const PM_CHANNEL_BUS_SCHEMA_VERSION = 1 as const;

export interface PmChannelBusEvent {
  schema: typeof PM_CHANNEL_BUS_SCHEMA_VERSION;
  id: string;
  kind: "openclaw.pm_channel_turn";
  occurredAt: string;
  target: SendPmChannelTurnArgs["replyTarget"];
  payload: Omit<SendPmChannelTurnArgs, "fetchImpl" | "timeoutMs"> & { timeoutMs?: number };
}

export interface PmChannelBusPublishResult {
  ok: boolean;
  driver: "pm-channel-bus";
  status?: number;
  receipt?: unknown;
  error?: string;
  skipped?: "disabled";
}

function flagEnabled(value: string | undefined) {
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

function makeEvent(args: SendPmChannelTurnArgs): PmChannelBusEvent {
  const { fetchImpl: _fetchImpl, ...payload } = args;
  return {
    schema: PM_CHANNEL_BUS_SCHEMA_VERSION,
    id: args.replyTarget.messageId,
    kind: "openclaw.pm_channel_turn",
    occurredAt: new Date().toISOString(),
    target: args.replyTarget,
    payload,
  };
}

function busDisabled(): PmChannelBusPublishResult {
  return {
    ok: false,
    driver: "pm-channel-bus",
    skipped: "disabled",
    error: "PM channel bus disabled: set PM_CHANNEL_BUS_SOCKET, PM_CHANNEL_BUS_DROP_DIR, or PM_CHANNEL_BUS_HTTP_URL",
  };
}

function safeFilePart(value: string) {
  return value.replace(/[^A-Za-z0-9_.:-]/g, "_");
}

async function publishFileDrop(event: PmChannelBusEvent, dir: string): Promise<PmChannelBusPublishResult> {
  await mkdir(dir, { recursive: true });
  const name = `${event.occurredAt.replace(/[:.]/g, "-")}-${safeFilePart(event.id)}.json`;
  const finalPath = join(dir, name);
  const tmpPath = `${finalPath}.${process.pid}.tmp`;
  await writeFile(tmpPath, `${JSON.stringify(event)}\n`, "utf8");
  await rename(tmpPath, finalPath);
  return { ok: true, driver: "pm-channel-bus", status: 202, receipt: { path: finalPath } };
}

async function publishUnixSocket(event: PmChannelBusEvent, path: string): Promise<PmChannelBusPublishResult> {
  await mkdir(dirname(path), { recursive: true }).catch(() => undefined);
  await new Promise<void>((resolve, reject) => {
    const socket = connect(path);
    socket.setTimeout(5_000);
    socket.once("connect", () => {
      socket.end(`${JSON.stringify(event)}\n`);
    });
    socket.once("error", reject);
    socket.once("timeout", () => {
      socket.destroy(new Error("PM channel bus socket timeout"));
    });
    socket.once("close", (hadError) => {
      if (!hadError) resolve();
    });
  });
  return { ok: true, driver: "pm-channel-bus", status: 202, receipt: { socketPath: path } };
}

async function publishHttp(event: PmChannelBusEvent, url: string): Promise<PmChannelBusPublishResult> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(event),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    return { ok: false, driver: "pm-channel-bus", status: res.status, error: body.trim() || `HTTP ${res.status}` };
  }
  return { ok: true, driver: "pm-channel-bus", status: res.status, receipt: { url } };
}

export function pmChannelHttpFallbackEnabled(env: NodeJS.ProcessEnv = process.env) {
  return flagEnabled(env.PM_OPENCLAW_CHANNEL_HTTP_FALLBACK);
}

export async function publishPmChannelTurnToBus(
  args: SendPmChannelTurnArgs,
  env: NodeJS.ProcessEnv = process.env,
): Promise<PmChannelBusPublishResult> {
  const event = makeEvent(args);
  try {
    if (env.PM_CHANNEL_BUS_SOCKET) {
      return await publishUnixSocket(event, env.PM_CHANNEL_BUS_SOCKET);
    }
    if (env.PM_CHANNEL_BUS_DROP_DIR) {
      return await publishFileDrop(event, env.PM_CHANNEL_BUS_DROP_DIR);
    }
    if (env.PM_CHANNEL_BUS_HTTP_URL) {
      return await publishHttp(event, env.PM_CHANNEL_BUS_HTTP_URL);
    }
    return busDisabled();
  } catch (err) {
    return {
      ok: false,
      driver: "pm-channel-bus",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
