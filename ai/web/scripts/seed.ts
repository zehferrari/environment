import { bootstrapOwner } from "@/lib/agents/auth/bootstrap-owner";
import { syncAgents } from "@/lib/agents/management/sync";
import { seedDefaultWorkspaceFromProjects } from "@/lib/workspaces/service";

async function main() {
  const ownerBootstrap = await bootstrapOwner();
  console.log("[seed] owner bootstrap:", ownerBootstrap.status);

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
