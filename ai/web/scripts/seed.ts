import { seedZehUser } from "@/lib/agents/seed-zeh";
import { syncAgents } from "@/lib/agents/sync";

async function main() {
  const zeh = await seedZehUser();
  console.log("[seed] zeh:", zeh.seeded ? "seeded" : "already present");

  const sync = await syncAgents();
  console.log("[seed] agent sync:", sync);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
