import { seedZehUser } from "@/lib/agents/seed-zeh";
import { syncAgents } from "@/lib/agents/sync";

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
