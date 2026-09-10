export type ModelState = { active: string | null; defaultModel: string | null; fallbacks: string[] };

export function modelReference(provider: string, model: string) {
  if (!/^[a-z][a-z0-9-]*$/.test(provider)) throw new Error("Invalid provider namespace");
  const id = model.trim();
  if (!id || id.length > 160 || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/.test(id)) throw new Error("Invalid model ID");
  return id.startsWith(`${provider}/`) ? id : `${provider}/${id}`;
}

/** Exact namespace matching: anthropic and claude-cli are distinct transports. */
export function rotateProviderModel(before: ModelState, provider: string, model: string) {
  const target = modelReference(provider, model);
  const belongs = (id: string | null) => id?.startsWith(`${provider}/`) ?? false;
  if (!belongs(before.defaultModel)) throw new Error("The agent default does not belong to this provider");
  if (before.active && !belongs(before.active)) throw new Error("Active and default providers differ; reconcile them in the model editor first");
  if (before.defaultModel === target) return { before, after: { ...before, active: target }, removed: null, changed: before.active !== target };
  const last = before.fallbacks.findLastIndex(belongs);
  const removed = last >= 0 ? before.fallbacks[last] : null;
  const fallbacks = [before.defaultModel!, ...before.fallbacks.filter((id, i) => i !== last && id !== target && id !== before.defaultModel)];
  if (fallbacks.length > 12) throw new Error("Rotation would exceed 12 fallbacks; remove one manually first");
  return { before, after: { active: target, defaultModel: target, fallbacks }, removed, changed: true };
}
