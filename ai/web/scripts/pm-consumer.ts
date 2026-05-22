// Long-running PM consumer process (HOMELAB-46 Slice 4).
//
// Reads transport config from env, starts AF_UNIX + file-drop +
// optional HTTP listeners, and runs until SIGINT/SIGTERM.
//
// Run with one of:
//   PM_CONSUMER_SOCKET=/run/pm/events.sock pnpm tsx scripts/pm-consumer.ts
//   PM_CONSUMER_DROP_DIR=/var/lib/pm/drop pnpm tsx scripts/pm-consumer.ts
// Combined (matching HOMELAB-45 "primary + fallback" deployment):
//   PM_CONSUMER_SOCKET=... PM_CONSUMER_DROP_DIR=... pnpm tsx scripts/pm-consumer.ts

import { readServiceConfigFromEnv, startService } from "@/lib/pm-consumer";

async function main(): Promise<void> {
  const cfg = readServiceConfigFromEnv();
  const handle = await startService({
    ...cfg,
    onOutcome: (outcome, source) => {
      console.log(
        JSON.stringify({
          at: new Date().toISOString(),
          source,
          outcome,
        }),
      );
    },
  });
  for (const leg of handle.legs) {
    console.log(`[pm-consumer] listening: ${leg.name} ${leg.detail}`);
  }

  const shutdown = async (sig: NodeJS.Signals) => {
    console.log(`[pm-consumer] ${sig} — shutting down`);
    await handle.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
