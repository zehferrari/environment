import { syncAgents } from "@/lib/agents/sync";

async function main() {
  const result = await syncAgents();
  console.log(JSON.stringify(result, null, 2));
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
