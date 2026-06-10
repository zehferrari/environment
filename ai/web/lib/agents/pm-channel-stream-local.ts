import { mkdir, unlink } from "fs/promises";
import { dirname } from "path";
import { createServer, type Server } from "net";
import { applyPmChannelStreamCallback } from "@/lib/agents/pm-channel-stream-callback";

const GLOBAL_CALLBACK = "__vixiPmChannelStreamCallback";
const GLOBAL_UDS_SERVER = "__vixiPmChannelStreamUdsServer";

declare global {
  // Direct in-process callback used when the OpenClaw PM channel runtime and
  // PM web server are hosted in the same Node process.
  // eslint-disable-next-line no-var
  var __vixiPmChannelStreamCallback: ((payload: Record<string, unknown>) => Promise<unknown>) | undefined;
  // eslint-disable-next-line no-var
  var __vixiPmChannelStreamUdsServer: Server | undefined;
}

function socketPathFromEnv(env: NodeJS.ProcessEnv = process.env) {
  return env.PM_PM_CHANNEL_STREAM_SOCKET
    ?? env.PM_OPENCLAW_CHANNEL_STREAM_SOCKET
    ?? env.PM_CHANNEL_STREAM_SOCKET
    ?? null;
}

function streamTransportFromEnv(env: NodeJS.ProcessEnv = process.env) {
  const raw = (env.PM_PM_CHANNEL_TRANSPORT ?? env.PM_OPENCLAW_CHANNEL_TRANSPORT ?? "http")
    .trim()
    .toLowerCase();
  return raw === "uds" || raw === "inproc" ? raw : "http";
}

export function registerPmChannelInprocStreamCallback() {
  globalThis[GLOBAL_CALLBACK] = async (payload: Record<string, unknown>) => applyPmChannelStreamCallback({
    payload,
    transportMode: "inproc",
    rateLimit: true,
  });
}

export async function startPmChannelStreamUdsListener(path: string): Promise<Server> {
  if (globalThis[GLOBAL_UDS_SERVER]) return globalThis[GLOBAL_UDS_SERVER]!;

  await mkdir(dirname(path), { recursive: true });
  await unlink(path).catch(() => undefined);

  const server = createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += chunk;
    });
    socket.on("end", async () => {
      for (const line of buffer.split("\n")) {
        if (!line.trim()) continue;
        try {
          const payload = JSON.parse(line) as Record<string, unknown>;
          const result = await applyPmChannelStreamCallback({
            payload,
            transportMode: "uds",
            rateLimit: true,
          });
          if (result.status >= 400) {
            console.warn("[pm-channel] UDS stream callback rejected", JSON.stringify(result.body));
          }
        } catch (err) {
          console.warn("[pm-channel] UDS stream callback failed", err);
        }
      }
    });
    socket.on("error", (err) => {
      console.warn("[pm-channel] UDS stream socket error", err);
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => {
      server.off("error", reject);
      resolve();
    });
  });
  globalThis[GLOBAL_UDS_SERVER] = server;
  return server;
}

export async function startPmChannelLocalStreamTransports(env: NodeJS.ProcessEnv = process.env) {
  registerPmChannelInprocStreamCallback();

  const path = socketPathFromEnv(env);
  if (streamTransportFromEnv(env) !== "uds" && !path) {
    return { inproc: true, uds: false as const };
  }
  if (!path) {
    console.warn("[pm-channel] UDS stream transport selected but no PM_CHANNEL_STREAM_SOCKET path is configured");
    return { inproc: true, uds: false as const };
  }

  await startPmChannelStreamUdsListener(path);
  return { inproc: true, uds: true as const, path };
}
