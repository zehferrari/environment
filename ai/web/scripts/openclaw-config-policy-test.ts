import assert from "node:assert/strict";
import { renderOpenClawJson } from "../lib/agents/management/provisioning";

const rendered = renderOpenClawJson({
  user: "test-agent",
  email: "test-agent@example.test",
  reasoning: "medium",
  primary: "ollama/qwen2.5:3b-instruct",
  fallbacks: [],
  selectedModels: [],
  now: "2026-07-27T00:00:00.000Z",
});

const config = JSON.parse(rendered) as {
  diagnostics?: { memoryPressureSnapshot?: boolean };
};

assert.equal(
  config.diagnostics?.memoryPressureSnapshot,
  true,
  "new and updated agents must retain a pre-OOM gateway stability bundle",
);

console.log("openclaw-config-policy-test: ok");
