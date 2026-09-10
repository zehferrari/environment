import { readAgentIndex } from "../lib/agents/management/index-loader";
import { readAgentModelSettings, previewAgentModelRotation, promoteAgentModel, assertAgentIdle } from "../lib/agents/management/model-settings";
import { modelReference } from "../lib/agents/management/model-rotation";
import { db } from "../lib/db";

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args[0] === "--dry-run";
  if (dryRun) args.shift();
  if (args.length !== 2) throw new Error("Expected provider and new model");
  const [provider, model] = args;
  modelReference(provider, model);
  const index = await readAgentIndex();
  const plans = [];
  // Preflight every selected agent before writing any configuration.
  for (const agent of index.agents.filter((a) => a.enabled !== false)) {
    const settings = await readAgentModelSettings(agent.user);
    if (!settings.readable) throw new Error(`Cannot inspect ${agent.user}; no models updated`);
    if (!settings.defaultModel?.startsWith(`${provider}/`)) continue;
    const plan = await previewAgentModelRotation(agent.user, provider, model);
    if (plan.changed && !dryRun) await assertAgentIdle(agent.user);
    plans.push({ agent: agent.user, plan });
  }
  if (!plans.length) throw new Error(`No enabled agents have a ${provider} default model`);
  for (const { agent, plan } of plans) {
    console.log(JSON.stringify({ agent, dryRun, before: { active: plan.before.active, defaultModel: plan.before.defaultModel, fallbacks: plan.before.fallbacks }, after: plan.after, removed: plan.removed, changed: plan.changed }, null, 2));
  }
  if (dryRun) return;
  for (const { agent, plan } of plans) {
    try {
      const result = await promoteAgentModel(agent, provider, model, plan.revision);
      console.log(JSON.stringify({ agent, changed: result.changed, restart: result.restart }));
      if (result.restart?.some((r) => !r.ok)) throw new Error(`${agent}: configuration saved but restart failed; inspect service status`);
    } catch (err) {
      // Earlier agents may already be updated; do not claim transactional fleet writes.
      throw new Error(`Stopped at ${agent}. Earlier successful updates remain applied. ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
main().catch((err) => { console.error(err instanceof Error ? err.message : String(err)); process.exitCode = 1; }).finally(() => db.$disconnect());
