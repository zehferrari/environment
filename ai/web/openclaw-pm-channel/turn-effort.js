/** Select only an advertised level; do not send an invalid effort to a model. */
export function selectPmEffort(mode, levels) {
  const available = new Set(levels.map((level) => typeof level === "string" ? level : level.id));
  const preference = mode === "manager" ? ["xhigh", "max", "high"] : ["high"];
  return preference.find((level) => available.has(level)) ?? null;
}

export async function resolvePmTurnEffort({ runtime, cfg, agentId, sessionKey, policy, logger }) {
  const mode = policy?.mode === "manager" ? "manager" : "normal";
  try {
    const metadata = await runtime.gateway.request("sessions.list", {
      agentId, search: sessionKey, limit: 1, includeDerivedTitles: false, includeLastMessage: false,
    }, { timeoutMs: 5000 });
    const session = metadata.sessions?.find((row) => row.key === sessionKey);
    const main = cfg.agents?.list?.find((row) => row.id === agentId);
    const mainPrimary = typeof main?.model === "string" ? main.model : main?.model?.primary;
    const defaultPrimary = typeof cfg.agents?.defaults?.model === "string" ? cfg.agents.defaults.model : cfg.agents?.defaults?.model?.primary;
    // Global defaults cannot describe an auxiliary agent with a different model.
    let selected = session ?? (!mainPrimary || mainPrimary === defaultPrimary ? metadata.defaults : null);
    if (!selected) {
      const agents = await runtime.gateway.request("agents.list", {}, { timeoutMs: 5000 });
      selected = agents.agents?.find((row) => row.id === agentId);
    }
    const levels = selected?.thinkingLevels ?? [];
    const provider = selected?.modelProvider ?? (mainPrimary ?? defaultPrimary ?? "").split("/")[0];
    const model = typeof selected?.model === "string" ? selected.model.replace(/^claude-cli\//, "") : (mainPrimary ?? defaultPrimary ?? "").split("/").slice(1).join("/");
    const cli = cfg.agents?.defaults?.cliBackends?.["claude-cli"];
    // OpenClaw's older Fable CLI policy hardcodes thinking=off. Claude Code
    // 2.1.251+ supports effort independently via its documented environment
    // setting. Opt in only when that backend setting has been provisioned.
    if (provider === "claude-cli" && model === "claude-fable-5-1" && cli?.env?.CLAUDE_CODE_EFFORT_LEVEL) {
      const configured = cfg.models?.providers?.[provider]?.models?.find((row) => row.id === model);
      const cliEffort = selectPmEffort(mode, configured?.compat?.supportedReasoningEfforts ?? ["high"]);
      logger.info?.(`[pm-channel] effort role=${mode} selected=${cliEffort ?? "high"} control=CLAUDE_CODE_EFFORT_LEVEL`);
      return { cliEffort: cliEffort ?? "high" };
    }
    const level = selectPmEffort(mode, levels);
    logger.info?.(`[pm-channel] effort role=${mode} selected=${level ?? "runtime-default"} supported=${levels.map((row) => row.id).join(",")}`);
    if (level) return { thinkingLevelOverride: level, ...(provider === "claude-cli" && cli?.env?.CLAUDE_CODE_EFFORT_LEVEL ? { cliEffort: level } : {}) };
    logger.warn?.("[pm-channel] requested effort unavailable; using High default with runtime compatibility normalization");
  } catch {
    logger.warn?.("[pm-channel] effort metadata unavailable; using High default with runtime compatibility normalization");
  }
  return {};
}

// Per-turn clone only. This does not persist manager effort into agent config
// or session state. The runtime normalizes High for non-reasoning models.
/** @param {any} cfg @param {string} agentId @param {string | undefined} [cliEffort] */
export function withPmHighDefault(cfg, agentId, cliEffort = undefined) {
  const cli = cfg.agents?.defaults?.cliBackends?.["claude-cli"];
  const cliBackends = cli?.env?.CLAUDE_CODE_EFFORT_LEVEL ? {
    ...cfg.agents.defaults.cliBackends,
    "claude-cli": { ...cli, env: { ...cli.env, CLAUDE_CODE_EFFORT_LEVEL: cliEffort ?? "high" } },
  } : undefined;
  return { ...cfg, agents: { ...cfg.agents, defaults: { ...cfg.agents?.defaults, thinkingDefault: "high", ...(cliBackends ? { cliBackends } : {}) },
    ...(cfg.agents?.list ? { list: cfg.agents.list.map((row) => row.id === agentId ? { ...row, thinkingDefault: "high" } : row) } : {}) } };
}
