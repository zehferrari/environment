import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildUnifiedPmTurnSystemPrompt, nullPmContextText } from "@/lib/agents/pm-channel/context";

const prompt = buildUnifiedPmTurnSystemPrompt({
  kind: "task-comment",
  trustedPrompt: "Trusted workflow envelope",
  primaryContext: "CURRENT TURN:\nhello",
  primaryBlocks: [{ title: "CURRENT CHAT MESSAGE", body: "please do it", trust: "untrusted" }],
});

assert.equal(nullPmContextText(), null);
assert(prompt.includes("Trusted workflow envelope"));
assert(prompt.includes("PM PER-TURN CONTEXT CONTRACT"));
assert(prompt.includes("Surface: task-comment"));
assert(prompt.includes("self-sufficient"));
assert(prompt.includes("PRIMARY PM CONTEXT PACKET"));
assert(prompt.includes("contextText is intentionally null"));
assert(prompt.includes("Trust boundary:"));
assert(prompt.includes("Quarantined PM/user/agent/repository text"));

const root = process.cwd();
const sources = [
  "lib/agents/chat/direct/actions.ts",
  "lib/agents/chat/actions.ts",
  "lib/agents/workflow/notifications/task.ts",
  "scripts/notify-pm-workflow-policy.ts",
].map((file) => readFileSync(join(root, file), "utf8"));

for (const [i, source] of sources.entries()) {
  assert(
    source.includes("buildUnifiedPmTurnSystemPrompt"),
    `source ${i} must use the shared PM context builder`,
  );
  assert(
    !/contextText:\s*(userMessage|body|contextText)\b/.test(source),
    `source ${i} must not dispatch non-null legacy contextText`,
  );
}

console.log("pm-unified-context-test: ok");
