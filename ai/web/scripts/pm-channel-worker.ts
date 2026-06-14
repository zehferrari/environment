import { runPmChannelWorkerOnce } from "@/lib/agents/pm-channel/jobs";

const POLL_MS = Number.parseInt(process.env.PM_CHANNEL_WORKER_POLL_MS ?? "1000", 10);
const WORKER_ID = process.env.PM_CHANNEL_WORKER_ID ?? `pm-channel-worker:${process.pid}`;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const once = process.argv.includes("--once");
  while (true) {
    const outcome = await runPmChannelWorkerOnce(WORKER_ID);
    if (outcome.claimed) {
      console.log(JSON.stringify({ at: new Date().toISOString(), workerId: WORKER_ID, outcome }));
    }
    if (once) return;
    if (!outcome.claimed) await sleep(Number.isFinite(POLL_MS) && POLL_MS > 0 ? POLL_MS : 1000);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
