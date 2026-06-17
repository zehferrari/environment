import { seedZehUser } from "@/lib/agents/auth/seed-zeh";
import { syncAgents } from "@/lib/agents/management/sync";
import { seedDefaultWorkspaceFromProjects } from "@/lib/workspaces/service";

async function main() {
  const zeh = await seedZehUser();
  console.log("[seed] zeh:", zeh.seeded ? "seeded" : "already present");

  const sync = await syncAgents();
  console.log("[seed] agent sync:", sync);

  const workspace = await seedDefaultWorkspaceFromProjects();
  console.log("[seed] default workspace:", workspace ? "seeded" : "skipped");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
