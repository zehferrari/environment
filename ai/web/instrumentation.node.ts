import { seedZehUser } from "@/lib/agents/seed-zeh";
import { syncAgents } from "@/lib/agents/sync";
import { purgeBin } from "@/lib/bin/purge";
import { purgeProjectBin } from "@/lib/bin/purge-projects";

try {
  const zeh = await seedZehUser();
  const result = await syncAgents();
  console.log("[pm] boot sync:", JSON.stringify({ zeh, result }));
} catch (err) {
  console.error("[pm] boot sync failed:", err);
}

const intervalMin = Number(process.env.AGENT_SYNC_INTERVAL_MIN ?? "5");
const intervalMs = Math.max(1, intervalMin) * 60_000;
setInterval(async () => {
  try {
    const result = await syncAgents();
    console.log("[pm] periodic sync:", JSON.stringify(result));
  } catch (err) {
    console.error("[pm] periodic sync failed:", err);
  }
}, intervalMs).unref();

// Hourly bin purge (HOMELAB-48). Hard-deletes Task/Epic rows whose
// deletedAt is older than PM_BIN_TTL_DAYS (default 7). Runs once at
// boot so a long downtime doesn't park bin entries past their TTL.
const purgeIntervalMin = Number(process.env.PM_BIN_PURGE_INTERVAL_MIN ?? "60");
const purgeIntervalMs = Math.max(1, purgeIntervalMin) * 60_000;
try {
  const r = await purgeBin();
  console.log("[pm] boot bin purge:", JSON.stringify(r));
} catch (err) {
  console.error("[pm] boot bin purge failed:", err);
}
try {
  const r = await purgeProjectBin();
  console.log("[pm] boot project bin purge:", JSON.stringify(r));
} catch (err) {
  console.error("[pm] boot project bin purge failed:", err);
}
setInterval(async () => {
  try {
    const r = await purgeBin();
    console.log("[pm] periodic bin purge:", JSON.stringify(r));
  } catch (err) {
    console.error("[pm] periodic bin purge failed:", err);
  }
  try {
    const r = await purgeProjectBin();
    console.log("[pm] periodic project bin purge:", JSON.stringify(r));
  } catch (err) {
    console.error("[pm] periodic project bin purge failed:", err);
  }
}, purgeIntervalMs).unref();
