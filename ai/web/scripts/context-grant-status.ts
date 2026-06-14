import { db } from "@/lib/db";
import { summarizeContextGrants } from "@/lib/agents/context/grants";

// Read-only token age/rotation visibility for context grants (ENV-28 item 5).
// Usage: pnpm tsx scripts/context-grant-status.ts [--json]

function formatAge(ms: number | null): string {
  if (ms === null) return "n/a";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

async function main() {
  const summary = await summarizeContextGrants();

  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  console.log("Context grant status");
  console.log("--------------------");
  console.log(`total            ${summary.total}`);
  console.log(`active           ${summary.active}`);
  console.log(`expired          ${summary.expired}`);
  console.log(`revoked          ${summary.revoked}`);
  console.log(`exhausted        ${summary.exhausted}`);
  console.log(`oldest active    ${formatAge(summary.oldestActiveAgeMs)}`);
  console.log(`max used count   ${summary.maxUsedCount}`);
}

main()
  .then(async () => {
    await db.$disconnect();
  })
  .catch(async (err) => {
    await db.$disconnect();
    console.error(err);
    process.exit(1);
  });
