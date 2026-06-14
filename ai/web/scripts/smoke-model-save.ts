import { readAgentModelSettings, updateAgentModelSettings } from "../lib/agents/management/model-settings";

async function main() {
  const agent = process.argv[2] ?? "karen";
  const before = await readAgentModelSettings(agent);
  if (!before.readable || !before.defaultModel) {
    throw new Error(`Cannot read model settings for ${agent}: ${before.error ?? "missing default model"}`);
  }
  const result = await updateAgentModelSettings(agent, {
    active: before.active ?? before.defaultModel,
    defaultModel: before.defaultModel,
    fallbacks: before.fallbacks,
  }, null);
  const after = await readAgentModelSettings(agent);
  if (!after.readable) throw new Error(`Cannot re-read model settings for ${agent}: ${after.error}`);
  if (after.defaultModel !== before.defaultModel) throw new Error("default model changed during no-op smoke");
  if ((after.active ?? after.defaultModel) !== (before.active ?? before.defaultModel)) throw new Error("active model changed during no-op smoke");
  if (JSON.stringify(after.fallbacks) !== JSON.stringify(before.fallbacks)) throw new Error("fallbacks changed during no-op smoke");
  console.log(JSON.stringify({ ok: true, agent, restart: result.restart, active: after.active, defaultModel: after.defaultModel, fallbacks: after.fallbacks }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
