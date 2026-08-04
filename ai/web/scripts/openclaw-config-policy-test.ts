import assert from "node:assert/strict";
import { renderOpenClawJson } from "../lib/agents/management/provisioning";

const rendered = renderOpenClawJson({
  user: "test-agent",
  email: "test-agent@example.test",
  reasoning: "medium",
  primary: "ollama/qwen2.5:3b-instruct",
  fallbacks: [],
  selectedModels: [],
  gatewayPort: 19001,
  now: "2026-07-27T00:00:00.000Z",
});

const config = JSON.parse(rendered) as {
  browser?: {
    enabled?: boolean;
    executablePath?: string;
    headless?: boolean;
    noSandbox?: boolean;
    defaultProfile?: string;
  };
  diagnostics?: { memoryPressureSnapshot?: boolean };
  agents?: { defaults?: { compaction?: { mode?: string; reserveTokensFloor?: number } } };
  gateway?: { port?: number };
  meta?: { lastTouchedVersion?: string };
};

assert.equal(
  config.diagnostics?.memoryPressureSnapshot,
  true,
  "new and updated agents must retain a pre-OOM gateway stability bundle",
);
assert.equal(
  config.meta?.lastTouchedVersion,
  "2026.7.1-2",
  "new and updated agents must record the deployed OpenClaw schema version",
);
assert.deepEqual(
  config.browser,
  {
    enabled: true,
    executablePath: "/usr/bin/chromium",
    headless: true,
    noSandbox: false,
    defaultProfile: "openclaw",
  },
  "every provisioned agent must receive the isolated host-managed Chromium policy",
);
assert.equal(
  config.gateway?.port,
  19001,
  "provisioned agents must connect their CLI/browser tools to their own gateway",
);
assert.deepEqual(
  config.agents?.defaults?.compaction,
  { mode: "safeguard", reserveTokensFloor: 50_000 },
  "long-lived PM sessions must reserve enough context for auto-compaction recovery",
);

const codexConfig = JSON.parse(renderOpenClawJson({
  user: "codex-agent",
  email: "codex-agent@example.test",
  reasoning: "medium",
  primary: "openai-codex/gpt-5.5",
  fallbacks: [],
  selectedModels: [{ provider: "openai-codex", id: "gpt-5.5", name: "gpt-5.5" }],
  now: "2026-07-27T00:00:00.000Z",
})) as {
  models?: { providers?: Record<string, { api?: string }> };
  auth?: { profiles?: Record<string, { provider?: string }> };
  agents?: { defaults?: { model?: { primary?: string } } };
};

assert.equal(
  codexConfig.models?.providers?.openai?.api,
  "openai-chatgpt-responses",
  "provisioned Codex agents must use the current ChatGPT Responses adapter",
);
assert.equal(
  codexConfig.agents?.defaults?.model?.primary,
  "openai/gpt-5.5",
  "provisioned Codex model refs must use the canonical OpenAI namespace",
);
assert.equal(
  codexConfig.auth?.profiles?.["openai:default"]?.provider,
  "openai",
  "provisioned Codex auth metadata must use the canonical OpenAI provider id",
);

console.log("openclaw-config-policy-test: ok");
